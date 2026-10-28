"""Admin pages for tables: list, grid (Tabulator), columns, review + publish, versions, CSV import.

Reuses Web's sign-in, CSRF and rendering. The grid's JSON endpoints go through the same
`_post` check: a JSON body is not parsed as a form, so the token comes from X-CSRF-Token.
"""

import csv
import io
import json
import secrets
import time
from urllib.parse import quote

from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.routing import Route

from . import paths
from .drive import DriveError
from .table_templates import TEMPLATES
from .table_types import KEY_TYPES, TYPES, suggest
from .tables import MAX_COLUMNS, MAX_ROWS, Table, TableError, Tables, cell_errors
from .web import Web

MAX_JSON_BYTES = 8 * 1024 * 1024
IMPORT_TTL = 30 * 60


class TablesWeb:
    def __init__(self, web: Web, tables: Tables) -> None:
        self.web, self.tables, self.drive = web, tables, web.drive
        self.imports: dict[str, tuple[float, str, list[str], list[list[str]]]] = {}  # token -> parsed CSV

    def routes(self) -> list[Route]:
        admin, post = self.web._admin, self.web._post
        t = "/tables/{id:int}"

        def form(path: str, handler) -> Route:
            return Route(path, admin(post(handler)), methods=["POST"])

        return [
            Route("/tables", admin(self.index)),
            form("/tables/create", self.create),
            form("/tables/import", self.import_upload),
            form("/tables/import/confirm", self.import_confirm),
            Route(t, admin(self.grid)),
            Route(t + "/draft.json", admin(self.draft_json)),
            form(t + "/edits", self.edits),
            form(t + "/paste", self.paste),
            form(t + "/columns/add", self.add_column),
            form(t + "/columns/rename", self.rename_column),
            form(t + "/columns/delete", self.delete_column),
            form(t + "/columns/key", self.set_key),
            Route(t + "/review", admin(self.review)),
            form(t + "/publish", self.publish),
            form(t + "/discard", self.discard),
            Route(t + "/versions", admin(self.versions)),
            Route(t + "/versions/{version:int}", admin(self.version)),
            form(t + "/rollback", self.rollback),
            form(t + "/delete", self.delete),
        ]

    # --- helpers -----------------------------------------------------------

    def _table(self, request: Request) -> Table:
        return self.tables.get(int(request.path_params["id"]))

    @staticmethod
    def _go(url: str, error: str | None = None, notice: str | None = None) -> Response:
        if error:
            url += f"?error={quote(error)}"
        elif notice:
            url += f"?notice={quote(notice)}"
        return RedirectResponse(url, 303)

    def _summary(self, table: Table) -> dict:
        draft = self.tables.draft(table)
        diff = self.tables.diff(table, draft)
        problems = self.tables.problems(table, draft)
        return {
            "added": len(diff.added),
            "changed": len(diff.changed),
            "removed": len(diff.removed),
            "columns": len(diff.columns),
            "issues": len(problems),
        }

    def _rows(self, table: Table, ids: list[int] | None = None) -> list[dict]:
        draft = self.tables.draft(table)
        chosen = draft if ids is None else {i: draft[i] for i in ids if i in draft}
        return [{"id": i, "data": d, "errors": cell_errors(table.columns, d)} for i, d in chosen.items()]

    async def _json(self, request: Request) -> dict:
        if int(request.headers.get("content-length") or 0) > MAX_JSON_BYTES:
            raise TableError("Too much data in one request")
        try:
            body = json.loads(await request.body())
        except ValueError:
            raise TableError("Expected a JSON body") from None
        if not isinstance(body, dict):
            raise TableError("Expected a JSON object")
        return body

    def _parse_path(self, folder: str, name: str) -> str:
        name = name.strip()
        if not name or "/" in name:
            raise TableError("Table names cannot be empty or contain '/'")
        try:
            path = paths.join(paths.normalize(folder or "/"), name)
        except paths.InvalidPath as e:
            raise TableError(str(e)) from None
        if self.drive.kind(path) is not None:
            raise TableError(f"There is already a file or folder at {path}")
        return path

    def _ensure_folder(self, path: str) -> None:
        """Tables live in drive folders, so keys and renames treat them like files."""
        folder = paths.parent(path)
        if folder != "/" and self.drive.kind(folder) is None:
            self.drive.mkdir(folder)

    # --- list and create -----------------------------------------------------

    async def index(self, request: Request) -> Response:
        items = []
        for table in self.tables.all():
            latest = self.tables.latest(table)
            items.append({"table": table, "latest": latest, "summary": self._summary(table)})
        return self.web._render(request, "tables.html", items=items, templates=TEMPLATES, max_rows=MAX_ROWS)

    async def create(self, request: Request) -> Response:
        form = await request.form()
        template = TEMPLATES.get(str(form.get("template", "")))
        try:
            path = self._parse_path(str(form.get("folder", "/")), str(form.get("name", "")))
            self._ensure_folder(path)
            table = self.tables.create(
                path, template["columns"] if template else [], template["description"] if template else ""
            )
        except (TableError, DriveError) as e:
            return self._go("/tables", error=str(e))
        self.drive.log("admin", "table create", path, template["label"] if template else "blank")
        return self._go(f"/tables/{table.id}", notice="Created. Add rows, then review and publish.")

    async def delete(self, request: Request) -> Response:
        table = self._table(request)
        self.tables.delete(table)
        self.drive.log("admin", "table delete", table.path)
        return self._go("/tables", notice=f"Deleted {table.path}")

    # --- grid -----------------------------------------------------------------

    async def grid(self, request: Request) -> Response:
        try:
            table = self._table(request)
        except TableError as e:
            return self._go("/tables", error=str(e))
        return self.web._render(
            request,
            "table_grid.html",
            table=table,
            latest=self.tables.latest(table),
            types=TYPES,
            key_types=KEY_TYPES,
            max_columns=MAX_COLUMNS,
        )

    async def draft_json(self, request: Request) -> Response:
        table = self._table(request)
        return JSONResponse(
            {
                "table": {"columns": table.columns, "keyColumn": table.key_column},
                "types": [{"id": k, "label": v} for k, v in TYPES.items()],
                "rows": self._rows(table),
                "summary": self._summary(table),
            }
        )

    async def edits(self, request: Request) -> Response:
        try:
            table = self._table(request)
            body = await self._json(request)
            touched, added, deleted = self.tables.edit(
                table,
                updates=list(body.get("updates") or []),
                adds=list(body.get("adds") or []),
                deletes=[int(i) for i in body.get("deletes") or []],
            )
        except (TableError, TypeError, ValueError, AttributeError) as e:
            return JSONResponse({"error": str(e) or "Invalid edit"}, 400)
        return JSONResponse(
            {
                "rows": self._rows(table, touched),
                "added": [{"id": i} for i in added],
                "deleted": deleted,
                "summary": self._summary(table),
            }
        )

    async def paste(self, request: Request) -> Response:
        try:
            table = self._table(request)
            text = str((await self._json(request)).get("text") or "")
            added, updated = self.tables.paste(table, text)
        except (TableError, csv.Error) as e:
            return JSONResponse({"error": str(e)}, 400)
        rows = self._rows(table)
        invalid = sum(1 for r in rows if r["errors"] and r["id"] in set(added) | set(updated))
        self.drive.log("admin", "table paste", table.path, f"{len(added)} added, {len(updated)} updated")
        return JSONResponse(
            {
                "rows": rows,
                "added": len(added),
                "updated": len(updated),
                "invalid": invalid,
                "summary": self._summary(table),
            }
        )

    # --- columns ----------------------------------------------------------------

    async def _column_action(self, request: Request, action) -> Response:
        table = self._table(request)
        form = await request.form()
        try:
            message = action(table, {k: str(v).strip() for k, v in form.items() if isinstance(v, str)})
        except TableError as e:
            return self._go(f"/tables/{table.id}", error=str(e))
        self.drive.log("admin", "table columns", table.path, message)
        return self._go(f"/tables/{table.id}", notice=message)

    async def add_column(self, request: Request) -> Response:
        def act(table: Table, f: dict) -> str:
            options = [o for o in f.get("options", "").replace("\r", "").replace(",", "\n").split("\n")]
            column = self.tables.add_column(table, f.get("name", ""), f.get("type", ""), options)
            return f"Added column {column['name']}"

        return await self._column_action(request, act)

    async def rename_column(self, request: Request) -> Response:
        def act(table: Table, f: dict) -> str:
            self.tables.rename_column(table, f.get("column", ""), f.get("name", ""))
            return f"Renamed column to {f.get('name')}"

        return await self._column_action(request, act)

    async def delete_column(self, request: Request) -> Response:
        def act(table: Table, f: dict) -> str:
            column = table.column(f.get("column", ""))
            self.tables.delete_column(table, f.get("column", ""))
            return f"Deleted column {column['name'] if column else ''}"

        return await self._column_action(request, act)

    async def set_key(self, request: Request) -> Response:
        def act(table: Table, f: dict) -> str:
            self.tables.set_key(table, f.get("column") or None)
            column = table.column(table.key_column or "")
            return f"Key column: {column['name']}" if column else "No key column"

        return await self._column_action(request, act)

    # --- review, publish, versions ---------------------------------------------

    async def review(self, request: Request) -> Response:
        table = self._table(request)
        draft = self.tables.draft(table)
        latest = self.tables.latest(table)
        published = self.tables.rows(table, latest.version) if latest else {}
        diff = self.tables.diff(table, draft)
        key = table.key_column or (table.columns[0]["id"] if table.columns else "")

        def label(row_id: int, data: dict) -> str:
            return f"r{row_id} {data.get(key, '') if data.get(key) is not None else ''}".strip()

        return self.web._render(
            request,
            "table_review.html",
            table=table,
            latest=latest,
            diff=diff,
            problems=self.tables.problems(table, draft),
            added=[label(i, draft[i]) for i in diff.added],
            changed=[(label(i, draft[i]), names) for i, names in diff.changed],
            removed=[label(i, published[i]) for i in diff.removed],
        )

    async def publish(self, request: Request) -> Response:
        table = self._table(request)
        try:
            version = self.tables.publish(table, await self.web._field(request, "note"))
        except TableError as e:
            return self._go(f"/tables/{table.id}/review", error=str(e))
        self.drive.log("admin", "table publish", table.path, f"v{version}")
        return self._go(f"/tables/{table.id}/versions", notice=f"Published version {version}")

    async def discard(self, request: Request) -> Response:
        table = self._table(request)
        self.tables.discard(table)
        self.drive.log("admin", "table discard draft", table.path)
        return self._go(f"/tables/{table.id}", notice="Draft reset to the latest published version")

    async def versions(self, request: Request) -> Response:
        table = self._table(request)
        return self.web._render(request, "table_versions.html", table=table, versions=self.tables.versions(table))

    async def version(self, request: Request) -> Response:
        table = self._table(request)
        number = int(request.path_params["version"])
        version = self.tables.version(table, number)
        if version is None:
            return self._go(f"/tables/{table.id}/versions", error=f"No version {number}")
        rows = list(self.tables.rows(table, number).items())
        return self.web._render(
            request, "table_version.html", table=table, version=version, rows=rows[:1000], total=len(rows)
        )

    async def rollback(self, request: Request) -> Response:
        table = self._table(request)
        number = await self.web._field(request, "version")
        try:
            version = self.tables.rollback(table, int(number) if number.isdigit() else 0)
        except TableError as e:
            return self._go(f"/tables/{table.id}/versions", error=str(e))
        self.drive.log("admin", "table rollback", table.path, f"v{number} as v{version}")
        notice = f"Rolled back: v{number} is published again as v{version}"
        return self._go(f"/tables/{table.id}/versions", notice=notice)

    # --- CSV import ----------------------------------------------------------------

    async def import_upload(self, request: Request) -> Response:
        form = await request.form()
        upload = form.get("file")
        try:
            path = self._parse_path(str(form.get("folder", "/")), str(form.get("name", "")))
            if not isinstance(upload, UploadFile) or not upload.filename:
                raise TableError("Choose a CSV file")
            if not upload.filename.lower().endswith((".csv", ".tsv", ".txt")):
                raise TableError("Only CSV files can be imported (save the sheet as CSV)")
            header, rows = parse_csv(await upload.read(self.web.config.max_file_mb * 1024 * 1024))
        except (TableError, UnicodeDecodeError, csv.Error) as e:
            message = "The file is not UTF-8 text" if isinstance(e, UnicodeDecodeError) else str(e)
            return self._go("/tables", error=message)
        now = time.monotonic()
        self.imports = {k: v for k, v in self.imports.items() if v[0] > now}
        token = secrets.token_urlsafe(16)
        self.imports[token] = (now + IMPORT_TTL, path, header, rows)
        columns = []
        for i, name in enumerate(header):
            values = [r[i] if i < len(r) else "" for r in rows]
            columns.append({"name": name, "type": suggest(name, values), "sample": [v for v in values if v][:3]})
        return self.web._render(
            request,
            "table_import.html",
            token=token,
            path=path,
            columns=columns,
            row_count=len(rows),
            types=TYPES,
            key_types=KEY_TYPES,
        )

    async def import_confirm(self, request: Request) -> Response:
        form = await request.form()
        entry = self.imports.pop(str(form.get("token", "")), None)
        if entry is None or entry[0] < time.monotonic():
            return self._go("/tables", error="That import expired; upload the file again")
        _, path, header, rows = entry
        key = str(form.get("key", ""))
        specs, keep = [], []
        for i, name in enumerate(header):
            kind = str(form.get(f"type_{i}", "text"))
            if kind == "skip":
                continue
            specs.append({"name": name, "type": kind, "key": key == str(i)})
            keep.append(i)
        try:
            if not specs:
                raise TableError("Keep at least one column")
            for spec in specs:
                if spec["type"] == "select":  # options come from the data
                    i = keep[specs.index(spec)]
                    spec["options"] = sorted({r[i].strip() for r in rows if i < len(r) and r[i].strip()})[:100]
            self._ensure_folder(path)
            table = self.tables.create(path, specs)
        except (TableError, DriveError) as e:
            return self._go("/tables", error=str(e))
        ids = [c["id"] for c in table.columns]
        self.tables.edit(
            table, adds=[{"values": {cid: r[i] for cid, i in zip(ids, keep, strict=True) if i < len(r)}} for r in rows]
        )
        problems = len(self.tables.problems(table))
        self.drive.log("admin", "table import", path, f"{len(rows)} rows")
        note = f"Imported {len(rows)} rows as a draft."
        if problems:
            note += f" {problems} problem(s) to fix (red cells)."
        return self._go(f"/tables/{table.id}", notice=note)


def parse_csv(data: bytes) -> tuple[list[str], list[list[str]]]:
    """Header + rows from CSV or TSV bytes (UTF-8, optional BOM)."""
    text = data.decode("utf-8-sig")
    first = text.split("\n", 1)[0]
    delimiter = "\t" if first.count("\t") > first.count(",") else (";" if first.count(";") > first.count(",") else ",")
    lines = [r for r in csv.reader(io.StringIO(text), delimiter=delimiter) if any(c.strip() for c in r)]
    if len(lines) < 1:
        raise TableError("The file is empty")
    header = [" ".join(h.split()) or f"Column {i + 1}" for i, h in enumerate(lines[0])]
    seen: dict[str, int] = {}
    for i, h in enumerate(header):  # column names must be unique
        n = seen[h.casefold()] = seen.get(h.casefold(), 0) + 1
        if n > 1:
            header[i] = f"{h} {n}"
    if len(header) > MAX_COLUMNS:
        raise TableError(f"At most {MAX_COLUMNS} columns")
    if len(lines) - 1 > MAX_ROWS:
        raise TableError(f"At most {MAX_ROWS} rows")
    return header, lines[1:]
