"""Read-only MCP tools for tables: list_tables, describe_table, lookup_row, query_table.

Agents only ever see the latest published version of a table; drafts are invisible.
Scoping and logging work exactly as for files: a table outside the key's folders is "Not found".
Every row comes with a citation like thumbdrive:/inventory/servers@v3#r12.
"""

import ipaddress
import json
import re
from collections.abc import Callable
from typing import Annotated, Literal

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import TextContent, ToolAnnotations
from pydantic import BaseModel, Field

from . import paths
from .drive import Drive, NotFound
from .keys import Key
from .table_types import TYPES, check, key_of
from .tables import Row, Table, Tables, Version, citation

TableArg = Annotated[
    str, Field(max_length=1100, description="Table path, e.g. '/inventory/servers', or a citation from a result")
]
_CITATION = re.compile(r"(?:thumbdrive:)?(?P<path>/[^@#]*)(?:@v\d+)?(?:#r\d+)?")
Op = Literal["eq", "neq", "contains", "starts_with", "gt", "lt", "in", "is_empty"]


class Condition(BaseModel):
    column: str = Field(max_length=100, description="Column name")
    op: Op = Field(description="eq, neq, contains, starts_with, gt, lt, in (value is a list), is_empty")
    value: str | float | bool | list[str | float] | None = None


def register(  # noqa: C901 - the four tools share these helpers
    server: MCPServer,
    drive: Drive,
    tables: Tables,
    key_of_ctx: Callable[[Context], Key],
    text: Callable[..., list[TextContent]],
    read_only: ToolAnnotations,
) -> None:
    def open_table(ctx: Context, table_arg: str, tool: str) -> tuple[Key, Table, Version]:
        key = key_of_ctx(ctx)
        m = _CITATION.fullmatch(table_arg.strip())
        try:
            path = paths.normalize(m["path"] if m else table_arg)
        except paths.InvalidPath as e:
            raise ToolError(str(e)) from None
        table = tables.by_path(path) if paths.Scope(key.folders).can_see(path) else None
        latest = tables.latest(table) if table else None
        if table is None or latest is None:
            drive.log(key.name, tool, path, "not found")
            raise ToolError(str(NotFound(path)))
        return key, table, latest

    def named(version: Version, name: str) -> dict:
        column = next((c for c in version.columns if c["name"].casefold() == name.strip().casefold()), None)
        if column is None:
            names = ", ".join(c["name"] for c in version.columns)
            raise ToolError(f"No column named {name!r}. Columns: {names}")
        return column

    def shown(table: Table, version: Version, row_id: int, data: Row) -> dict:
        values = {c["name"]: data.get(c["id"]) for c in version.columns}
        return {"row_id": row_id, "citation": citation(table.path, version.version, row_id), "values": values}

    def summary(table: Table, version: Version) -> dict:
        key = version.column(version.key_column) if version.key_column else None
        return {
            "path": table.path,
            "description": table.description,
            "version": version.version,
            "citation": citation(table.path, version.version),
            "rows": version.row_count,
            "key_column": key["name"] if key else None,
            "published_at": version.published_at,
        }

    @server.tool(name="list_tables", title="List tables", annotations=read_only, structured_output=False)
    def list_tables(
        ctx: Context, path: Annotated[str, Field(max_length=1024, description="Folder to look in")] = "/"
    ) -> list[TextContent]:
        """Published tables in a folder and its subfolders: path, version, row count, key column, columns."""
        key = key_of_ctx(ctx)
        try:
            folder = paths.normalize(path)
        except paths.InvalidPath as e:
            raise ToolError(str(e)) from None
        scope, found = paths.Scope(key.folders), []
        for table in tables.all():
            latest = tables.latest(table) if paths.is_within(table.path, folder) and scope.can_see(table.path) else None
            if latest:
                columns = [f"{c['name']} ({TYPES[c['type']]})" for c in latest.columns]
                found.append(summary(table, latest) | {"columns": columns})
        drive.log(key.name, "list_tables", folder, f"{len(found)} table(s)")
        return text({"path": folder, "tables": found})

    @server.tool(name="describe_table", title="Describe table", annotations=read_only, structured_output=False)
    def describe_table(ctx: Context, table: TableArg) -> list[TextContent]:
        """A table's columns (name, type, select options), key column, version, publish note and 5 sample rows."""
        key, t, latest = open_table(ctx, table, "describe_table")
        columns = []
        for c in latest.columns:
            columns.append(
                {"name": c["name"], "type": c["type"], "key": c["id"] == latest.key_column}
                | ({"options": c.get("options", [])} if c["type"] == "select" else {})
            )
        sample = [shown(t, latest, i, d) for i, d in list(tables.rows(t, latest.version).items())[:5]]
        drive.log(key.name, "describe_table", t.path, f"v{latest.version}")
        return text(summary(t, latest) | {"note": latest.note, "columns": columns, "sample_rows": sample})

    @server.tool(name="lookup_row", title="Look up rows", annotations=read_only, structured_output=False)
    def lookup_row(
        ctx: Context,
        table: TableArg,
        values: Annotated[list[str], Field(min_length=1, max_length=50, description="1-50 values to look up")],
        column: Annotated[str | None, Field(max_length=100, description="Column to match (default: key)")] = None,
    ) -> list[TextContent]:
        """Find rows by value, e.g. hostnames or IPs. Values are normalized by the column type
        (case, IP and MAC formats). In a CIDR column an IP address finds the most specific range that
        contains it. A short hostname matches a unique full name. Each result is match, no_match,
        ambiguous or invalid; matches carry a citation."""
        key, t, latest = open_table(ctx, table, "lookup_row")
        if column:
            target = named(latest, column)
        elif latest.key_column:
            target = latest.column(latest.key_column) or {}
        else:
            raise ToolError("This table has no key column; pass column=")
        rows = tables.rows(t, latest.version)
        results = [_lookup(target, value, rows) for value in values]
        for r in results:
            if "rows" in r:
                r["rows"] = [shown(t, latest, i, rows[i]) for i in r["rows"]]
        matched = sum(r["result"] == "match" for r in results)
        drive.log(key.name, "lookup_row", t.path, f"v{latest.version}, {matched}/{len(values)} matched")
        return text({"table": t.path, "version": latest.version, "column": target["name"], "results": results})

    @server.tool(name="query_table", title="Query table", annotations=read_only, structured_output=False)
    def query_table(
        ctx: Context,
        table: TableArg,
        where: Annotated[list[Condition], Field(max_length=10, description="Conditions, all must hold")] = [],  # noqa: B006
        order_by: Annotated[str | None, Field(max_length=100, description="Column name to sort by")] = None,
        descending: bool = False,
        limit: Annotated[int, Field(ge=1, le=200)] = 50,
        offset: Annotated[int, Field(ge=0)] = 0,
    ) -> list[TextContent]:
        """Filter rows of the latest version. Conditions: eq, neq, contains, starts_with, gt, lt,
        in (value is a list), is_empty. Text comparisons ignore case. Returns rows with citations,
        the total and next_offset (null when there are no more)."""
        key, t, latest = open_table(ctx, table, "query_table")
        sql, params = ["table_id = ? AND version = ?"], [t.id, latest.version]
        for condition in where:
            clause, args = _condition(named(latest, condition.column), condition)
            sql.append(clause)
            params += args
        order = "row_id"
        if order_by:
            order = f"json_extract(data, ?) {'DESC' if descending else 'ASC'}, row_id"
        base = f"FROM table_version_rows WHERE {' AND '.join(sql)}"
        total = tables.db.execute(f"SELECT count(*) {base}", params).fetchone()[0]
        order_args = [_json_path(named(latest, order_by))] if order_by else []
        found = tables.db.execute(
            f"SELECT row_id, data {base} ORDER BY {order} LIMIT ? OFFSET ?", [*params, *order_args, limit, offset]
        ).fetchall()
        rows = [shown(t, latest, r["row_id"], json.loads(r["data"])) for r in found]
        next_offset = offset + len(rows) if offset + len(rows) < total else None
        drive.log(key.name, "query_table", t.path, f"v{latest.version}, {len(where)} condition(s), {total} row(s)")
        return text(
            {"table": t.path, "version": latest.version, "total": total, "rows": rows, "next_offset": next_offset}
        )


def _json_path(column: dict) -> str:
    return f'$."{column["id"]}"'  # column ids are c1, c2, ...: nothing to escape


def _lookup(column: dict, raw: str, rows: dict[int, Row]) -> dict:
    out: dict = {"value": raw}
    cid = column["id"]
    if column["type"] == "cidr" and "/" not in raw:
        try:
            ip = ipaddress.ip_address(raw.strip())
        except ValueError:
            return out | {"result": "invalid", "error": "not an IP address or CIDR range"}
        best: list[tuple[int, int]] = []
        for row_id, data in rows.items():
            if data.get(cid):
                net = ipaddress.ip_network(data[cid])
                if net.version == ip.version and ip in net:
                    best.append((net.prefixlen, row_id))
        if not best:
            return out | {"result": "no_match"}
        top = max(best)[0]
        ids = [row_id for length, row_id in best if length == top]
        return out | _result(ids) | {"matched_by": "IP in CIDR"}
    value, error = check(column, raw)
    if error:
        return out | {"result": "invalid", "error": error}
    wanted = key_of(value)
    ids = [row_id for row_id, data in rows.items() if key_of(data.get(cid)) == wanted]
    if not ids and column["type"] == "hostname" and wanted and "." not in wanted:
        ids = [i for i, d in rows.items() if str(d.get(cid) or "").casefold().split(".")[0] == wanted]
        if ids:
            return out | _result(ids) | {"matched_by": "short hostname"}
    return out | _result(ids)


def _result(ids: list[int]) -> dict:
    if not ids:
        return {"result": "no_match"}
    return {"result": "match" if len(ids) == 1 else "ambiguous", "rows": ids[:10]}


_TEXTY = {"text", "longtext", "select", "url", "email", "hostname", "ip", "cidr", "mac", "date"}


def _condition(column: dict, condition: Condition) -> tuple[str, list]:
    field = "json_extract(data, ?)"
    path = _json_path(column)
    op, value = condition.op, condition.value
    if op == "is_empty":
        return f"({field} IS NULL OR {field} = '')", [path, path]
    if value is None:
        raise ToolError(f"{op} needs a value")
    if op in ("contains", "starts_with"):
        pattern = str(value).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = ("%" if op == "contains" else "") + pattern + "%"
        return f"CAST({field} AS TEXT) LIKE ? ESCAPE '\\'", [path, pattern]
    items = value if isinstance(value, list) else [value]
    if op == "in" and not 1 <= len(items) <= 50:
        raise ToolError("in takes a list of 1-50 values")
    if op != "in" and isinstance(value, list):
        raise ToolError(f"{op} takes a single value")
    canonical = []
    for item in items:
        v, error = check(column, item)
        if error:
            raise ToolError(f"{item!r} is not valid for {column['name']}: {error}")
        canonical.append(int(v) if isinstance(v, bool) else v)
    lowered = column["type"] in _TEXTY
    left = f"lower({field})" if lowered else field
    marks = ["lower(?)" if lowered else "?"] * len(canonical)
    if op == "in":
        return f"{left} IN ({', '.join(marks)})", [path, *canonical]
    if op == "neq":
        return f"({field} IS NULL OR {left} != {marks[0]})", [path, path, canonical[0]]
    symbol = {"eq": "=", "gt": ">", "lt": "<"}[op]
    return f"{left} {symbol} {marks[0]}", [path, canonical[0]]
