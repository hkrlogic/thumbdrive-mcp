"""Tables: typed rows edited as a draft and published as numbered, immutable versions.

Storage (see migrations/002_tables.sql): the draft is one JSON object per row, keyed by
column id; each published version is a full snapshot of the columns and rows. Snapshots
cost space but make publish, rollback and "what did version 3 say" trivial and obviously
correct. Row ids come from a counter that only goes up, so a citation like
thumbdrive:/inventory/servers@v3#r12 always names the same row.
"""

from __future__ import annotations

import csv
import io
import json
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass, field

from . import paths
from .db import now, transaction
from .table_types import KEY_TYPES, MAX_OPTIONS, TYPES, Value, check, key_of

MAX_ROWS, MAX_COLUMNS = 50_000, 100
Row = dict[str, Value]  # column id -> value


class TableError(ValueError):
    """A problem the admin can fix; the message is shown as is."""


@dataclass
class Table:
    id: int
    path: str
    description: str
    columns: list[dict]
    key_column: str | None
    next_row_id: int
    next_column_id: int

    @property
    def name(self) -> str:
        return paths.name_of(self.path)

    def column(self, column_id: str) -> dict | None:
        return next((c for c in self.columns if c["id"] == column_id), None)

    def column_named(self, name: str) -> dict | None:
        return next((c for c in self.columns if c["name"].casefold() == name.strip().casefold()), None)


@dataclass
class Version:
    version: int
    columns: list[dict]
    key_column: str | None
    note: str
    published_at: str
    row_count: int
    added: int
    changed: int
    removed: int

    def column(self, column_id: str) -> dict | None:
        return next((c for c in self.columns if c["id"] == column_id), None)


@dataclass
class Diff:
    added: list[int] = field(default_factory=list)
    changed: list[tuple[int, list[str]]] = field(default_factory=list)  # row id, changed column names
    removed: list[int] = field(default_factory=list)
    columns: list[str] = field(default_factory=list)  # readable column changes


def cell_errors(columns: list[dict], data: Row) -> dict[str, str]:
    """column id -> why the stored value is invalid."""
    errors = {}
    for c in columns:
        error = check(c, data.get(c["id"]))[1]
        if error:
            errors[c["id"]] = error
    return errors


def citation(path: str, version: int, row_id: int | None = None) -> str:
    return f"thumbdrive:{path}@v{version}" + (f"#r{row_id}" if row_id is not None else "")


class Tables:
    def __init__(self, db: sqlite3.Connection) -> None:
        self.db = db

    # --- tables -----------------------------------------------------------

    def all(self) -> list[Table]:
        return [_table(r) for r in self.db.execute("SELECT * FROM tables ORDER BY path")]

    def get(self, table_id: int) -> Table:
        row = self.db.execute("SELECT * FROM tables WHERE id = ?", (table_id,)).fetchone()
        if row is None:
            raise TableError("No such table")
        return _table(row)

    def by_path(self, path: str) -> Table | None:
        row = self.db.execute("SELECT * FROM tables WHERE path = ?", (path,)).fetchone()
        return _table(row) if row else None

    def create(self, path: str, columns: list[dict] | None = None, description: str = "") -> Table:
        """columns: [{"name", "type", "options"?, "key"?}]."""
        try:
            path = paths.normalize(path)
        except paths.InvalidPath as e:
            raise TableError(str(e)) from None
        if path == "/":
            raise TableError("Give the table a name")
        if self.by_path(path):
            raise TableError(f"A table already exists at {path}")
        stamp = now()
        cur = self.db.execute(
            "INSERT INTO tables (path, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (path, description.strip()[:500], stamp, stamp),
        )
        table = self.get(cur.lastrowid or 0)
        for spec in columns or []:
            column = self.add_column(table, spec["name"], spec["type"], spec.get("options") or [])
            if spec.get("key"):
                self.set_key(table, column["id"])
        return self.get(table.id)

    def delete(self, table: Table) -> None:
        self.db.execute("DELETE FROM tables WHERE id = ?", (table.id,))

    def _save(self, table: Table) -> None:
        self.db.execute(
            "UPDATE tables SET columns = ?, key_column = ?, next_row_id = ?, next_column_id = ?, updated_at = ?"
            " WHERE id = ?",
            (json.dumps(table.columns), table.key_column, table.next_row_id, table.next_column_id, now(), table.id),
        )

    # --- columns ----------------------------------------------------------

    def add_column(self, table: Table, name: str, kind: str, options: list[str] | None = None) -> dict:
        name = _column_name(table, name)
        if kind not in TYPES:
            raise TableError(f"Unknown column type {kind}")
        if len(table.columns) >= MAX_COLUMNS:
            raise TableError(f"A table has at most {MAX_COLUMNS} columns")
        options = list(dict.fromkeys(o.strip() for o in options or [] if o.strip()))
        if len(options) > MAX_OPTIONS:
            raise TableError(f"At most {MAX_OPTIONS} options")
        column = {"id": f"c{table.next_column_id}", "name": name, "type": kind}
        if kind == "select":
            column["options"] = options
        table.columns.append(column)
        table.next_column_id += 1
        self._save(table)
        return column

    def rename_column(self, table: Table, column_id: str, name: str) -> None:
        column = self._column(table, column_id)
        column["name"] = _column_name(table, name, ignore=column_id)
        self._save(table)

    def delete_column(self, table: Table, column_id: str) -> None:
        self._column(table, column_id)
        table.columns = [c for c in table.columns if c["id"] != column_id]
        if table.key_column == column_id:
            table.key_column = None
        with transaction(self.db):
            self._save(table)
            for row_id, data in self.draft(table).items():
                data.pop(column_id, None)
                self._put_row(table, row_id, data)

    def set_key(self, table: Table, column_id: str | None) -> None:
        if column_id and self._column(table, column_id)["type"] not in KEY_TYPES:
            raise TableError("That column type cannot be the key")
        table.key_column = column_id or None
        self._save(table)

    def _column(self, table: Table, column_id: str) -> dict:
        column = table.column(column_id)
        if column is None:
            raise TableError("No such column")
        return column

    # --- draft rows -------------------------------------------------------

    def draft(self, table: Table) -> dict[int, Row]:
        rows = self.db.execute(
            "SELECT row_id, data FROM table_draft_rows WHERE table_id = ? ORDER BY row_id", (table.id,)
        )
        return {r["row_id"]: json.loads(r["data"]) for r in rows}

    def _put_row(self, table: Table, row_id: int, data: Row) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO table_draft_rows (table_id, row_id, data) VALUES (?, ?, ?)",
            (table.id, row_id, json.dumps(data, ensure_ascii=False)),
        )

    def _set_values(self, table: Table, data: Row, values: dict[str, object]) -> None:
        """Validated where possible; invalid input is kept as typed and shown in red."""
        for column_id, raw in values.items():
            column = table.column(column_id)
            if column is None:
                continue
            value = check(column, raw)[0]
            if value is None:
                data.pop(column_id, None)
            else:
                data[column_id] = value

    def edit(
        self,
        table: Table,
        updates: Sequence[dict] = (),
        adds: Sequence[dict] = (),
        deletes: Sequence[int] = (),
    ) -> tuple[list[int], list[int], list[int]]:
        """Apply grid edits. Returns (touched row ids, added row ids, deleted row ids)."""
        draft = self.draft(table)
        if len(draft) + len(adds) > MAX_ROWS:
            raise TableError(f"A table has at most {MAX_ROWS} rows")
        touched, added, deleted = [], [], []
        with transaction(self.db):
            for update in updates:
                row_id = int(update.get("row", 0))
                if row_id in draft:
                    self._set_values(table, draft[row_id], dict(update.get("values") or {}))
                    self._put_row(table, row_id, draft[row_id])
                    touched.append(row_id)
            for add in adds:
                data: Row = {}
                self._set_values(table, data, dict(add.get("values") or {}))
                row_id = table.next_row_id
                table.next_row_id += 1
                self._put_row(table, row_id, data)
                touched.append(row_id)
                added.append(row_id)
            for row_id in deletes:
                if int(row_id) in draft:
                    self.db.execute(
                        "DELETE FROM table_draft_rows WHERE table_id = ? AND row_id = ?", (table.id, int(row_id))
                    )
                    deleted.append(int(row_id))
            self._save(table)
        return touched, added, deleted

    def paste(self, table: Table, text: str) -> tuple[list[int], list[int]]:
        """Rows copied from a spreadsheet (TSV) or CSV. A first row of column names is a header;
        otherwise values fill the columns in order. Rows whose key matches update that row.
        Returns (added row ids, updated row ids)."""
        lines = [r for r in csv.reader(io.StringIO(text), delimiter="\t" if "\t" in text else ",") if any(r)]
        if not lines:
            return [], []
        header = [table.column_named(h) for h in lines[0]]
        if any(header) and all(c or not h.strip() for c, h in zip(header, lines[0], strict=True)):
            ids = [c["id"] if c else None for c in header]
            lines = lines[1:]
        else:
            ids = [c["id"] for c in table.columns]
        return self._upsert(table, [{i: v for i, v in zip(ids, line, strict=False) if i} for line in lines])

    def _upsert(self, table: Table, rows: list[dict[str, object]]) -> tuple[list[int], list[int]]:
        by_key: dict[str, int] = {}
        if table.key_column:
            for row_id, data in self.draft(table).items():
                k = key_of(data.get(table.key_column))
                if k is not None:
                    by_key.setdefault(k, row_id)
        updates, adds = [], []
        for values in rows:
            match = None
            if table.key_column and table.key_column in values:
                column = self._column(table, table.key_column)
                match = by_key.get(key_of(check(column, values[table.key_column])[0]) or "")
            if match:
                updates.append({"row": match, "values": values})
            else:
                adds.append({"values": values})
        _, added, _ = self.edit(table, updates=updates, adds=adds)
        return added, [u["row"] for u in updates]

    def discard(self, table: Table) -> None:
        """Reset the draft to the latest published version (or empty)."""
        latest = self.latest(table)
        with transaction(self.db):
            self.db.execute("DELETE FROM table_draft_rows WHERE table_id = ?", (table.id,))
            if latest:
                table.columns, table.key_column = latest.columns, latest.key_column
                for row_id, data in self.rows(table, latest.version).items():
                    self._put_row(table, row_id, data)
            self._save(table)

    # --- review and publish ------------------------------------------------

    def problems(self, table: Table, draft: dict[int, Row] | None = None) -> list[str]:
        """Everything that blocks publishing."""
        draft = self.draft(table) if draft is None else draft
        problems = []
        if not table.columns:
            problems.append("Add at least one column")
        for row_id, data in draft.items():
            for column_id, error in cell_errors(table.columns, data).items():
                name = (table.column(column_id) or {}).get("name", column_id)
                problems.append(f"Row {row_id}, {name}: {data.get(column_id)!r} is {error}")
        if table.key_column:
            name = self._column(table, table.key_column)["name"]
            seen: dict[str, int] = {}
            for row_id, data in draft.items():
                k = key_of(data.get(table.key_column))
                if k is None:
                    problems.append(f"Row {row_id}: the key column {name} is empty")
                elif k in seen:
                    problems.append(f"Rows {seen[k]} and {row_id} have the same {name}: {data[table.key_column]}")
                else:
                    seen[k] = row_id
        return problems

    def diff(self, table: Table, draft: dict[int, Row] | None = None) -> Diff:
        """What publishing the draft would change, compared with the latest version."""
        draft = self.draft(table) if draft is None else draft
        latest = self.latest(table)
        published = self.rows(table, latest.version) if latest else {}
        old_columns = {c["id"]: c for c in latest.columns} if latest else {}
        diff = Diff()
        for c in table.columns:
            old = old_columns.get(c["id"])
            if old is None:
                diff.columns.append(f"Added column {c['name']} ({TYPES[c['type']]})")
            elif old != c:
                renamed = f" to {c['name']}" if old["name"] != c["name"] else ""
                diff.columns.append(f"Changed column {old['name']}{renamed}")
        diff.columns += [f"Removed column {c['name']}" for i, c in old_columns.items() if not table.column(i)]
        if latest and latest.key_column != table.key_column:
            diff.columns.append("Changed the key column")
        for row_id, data in draft.items():
            if row_id not in published:
                diff.added.append(row_id)
            elif data != published[row_id]:
                changed = {k for k in data.keys() | published[row_id].keys() if data.get(k) != published[row_id].get(k)}
                diff.changed.append((row_id, [c["name"] for c in table.columns if c["id"] in changed]))
        diff.removed = [row_id for row_id in published if row_id not in draft]
        return diff

    def publish(self, table: Table, note: str) -> int:
        note = note.strip()
        if not note:
            raise TableError("Write a short note about what changed")
        draft = self.draft(table)
        problems = self.problems(table, draft)
        if problems:
            raise TableError(f"Fix {len(problems)} problem(s) first: {problems[0]}")
        diff = self.diff(table, draft)
        latest = self.latest(table)
        version = (latest.version if latest else 0) + 1
        with transaction(self.db):
            self.db.execute(
                "INSERT INTO table_versions (table_id, version, columns, key_column, note, published_at,"
                " row_count, added, changed, removed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    table.id,
                    version,
                    json.dumps(table.columns),
                    table.key_column,
                    note[:500],
                    now(),
                    len(draft),
                    len(diff.added),
                    len(diff.changed),
                    len(diff.removed),
                ),
            )
            self.db.executemany(
                "INSERT INTO table_version_rows (table_id, version, row_id, data) VALUES (?, ?, ?, ?)",
                [(table.id, version, row_id, json.dumps(data, ensure_ascii=False)) for row_id, data in draft.items()],
            )
        return version

    def rollback(self, table: Table, version: int) -> int:
        """Publish an old version again as a new version; the draft becomes that content."""
        old = self.version(table, version)
        if old is None:
            raise TableError(f"No version {version}")
        with transaction(self.db):
            self.db.execute("DELETE FROM table_draft_rows WHERE table_id = ?", (table.id,))
            table.columns, table.key_column = old.columns, old.key_column
            for row_id, data in self.rows(table, version).items():
                self._put_row(table, row_id, data)
            self._save(table)
        return self.publish(table, f"Rollback to v{version}")

    # --- published versions -------------------------------------------------

    def versions(self, table: Table) -> list[Version]:
        rows = self.db.execute(
            "SELECT * FROM table_versions WHERE table_id = ? ORDER BY version DESC", (table.id,)
        ).fetchall()
        return [_version(r) for r in rows]

    def version(self, table: Table, version: int) -> Version | None:
        row = self.db.execute(
            "SELECT * FROM table_versions WHERE table_id = ? AND version = ?", (table.id, version)
        ).fetchone()
        return _version(row) if row else None

    def latest(self, table: Table) -> Version | None:
        row = self.db.execute(
            "SELECT * FROM table_versions WHERE table_id = ? ORDER BY version DESC LIMIT 1", (table.id,)
        ).fetchone()
        return _version(row) if row else None

    def rows(self, table: Table, version: int) -> dict[int, Row]:
        rows = self.db.execute(
            "SELECT row_id, data FROM table_version_rows WHERE table_id = ? AND version = ? ORDER BY row_id",
            (table.id, version),
        )
        return {r["row_id"]: json.loads(r["data"]) for r in rows}

    def move(self, old: str, new: str) -> None:
        """A folder was renamed: move the tables inside it."""
        for table in self.all():
            if paths.is_within(table.path, old):
                self.db.execute("UPDATE tables SET path = ? WHERE id = ?", (new + table.path[len(old) :], table.id))


def _column_name(table: Table, name: str, ignore: str | None = None) -> str:
    name = " ".join(name.split())
    if not name or len(name) > 100:
        raise TableError("Column names need 1-100 characters")
    other = table.column_named(name)
    if other and other["id"] != ignore:
        raise TableError(f"There is already a column named {name}")
    return name


def _table(row: sqlite3.Row) -> Table:
    return Table(
        id=row["id"],
        path=row["path"],
        description=row["description"],
        columns=json.loads(row["columns"]),
        key_column=row["key_column"],
        next_row_id=row["next_row_id"],
        next_column_id=row["next_column_id"],
    )


def _version(row: sqlite3.Row) -> Version:
    return Version(
        version=row["version"],
        columns=json.loads(row["columns"]),
        key_column=row["key_column"],
        note=row["note"],
        published_at=row["published_at"],
        row_count=row["row_count"],
        added=row["added"],
        changed=row["changed"],
        removed=row["removed"],
    )
