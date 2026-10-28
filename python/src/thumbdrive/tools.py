"""The four read-only MCP tools: list, read, search, history.

Every call runs with one key's Scope. Anything outside it answers "Not found",
exactly like a missing file. Every call is written to the activity log.
"""

import json
import math
import mimetypes
from dataclasses import asdict
from typing import Annotated

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import TextContent, ToolAnnotations
from pydantic import Field

from . import paths
from .drive import Drive, DriveError, NotFound, is_text, sha256_hex
from .keys import Key

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
SCOPE_KEY = "thumbdrive.key"  # where app.py puts the authenticated Key in the ASGI scope

INSTRUCTIONS = (
    "Thumbdrive is a read-only shared drive. Folders you cannot see do not exist for you. "
    "Start with list (path '/'), then read files. Large text files come back in pages: "
    "keep calling read with page+1 while has_more is true. Each read returns metadata JSON "
    "(including the file's sha256) followed by the content. You cannot change files."
)

PathArg = Annotated[str, Field(max_length=1024, description="Drive path, e.g. '/' or '/team/notes.md'")]


def _key(ctx: Context) -> Key:
    request = ctx.request_context.request
    key = getattr(request, "scope", {}).get(SCOPE_KEY)
    if key is None:  # app.py rejects unauthenticated requests before this; never trust that alone
        raise ToolError("Unauthorized")
    return key


def _clean(path: str) -> str:
    try:
        return paths.normalize(path)
    except paths.InvalidPath as e:
        raise ToolError(str(e)) from None


def _text(*parts: object) -> list[TextContent]:
    return [TextContent(type="text", text=p if isinstance(p, str) else json.dumps(p, indent=2)) for p in parts]


def _page_bounds(data: bytes, page: int, size: int) -> tuple[int, int]:
    """Byte range of a page, moved back so it never splits a UTF-8 character."""

    def boundary(i: int) -> int:
        while 0 < i < len(data) and (data[i] & 0xC0) == 0x80:
            i -= 1
        return i

    return boundary((page - 1) * size), boundary(min(page * size, len(data)))


def build(drive: Drive, page_bytes: int) -> MCPServer:
    server = MCPServer("thumbdrive", version="0.1.0", instructions=INSTRUCTIONS)

    @server.tool(name="list", title="List folder", annotations=READ_ONLY, structured_output=False)
    def list_folder(ctx: Context, path: PathArg = "/") -> list[TextContent]:
        """List files and folders in a folder: name, path, type, size, sha256, modified. Start with '/'."""
        key, p = _key(ctx), _clean(path)
        scope = paths.Scope(key.folders)
        try:
            if scope.can_see(p):
                entries = [asdict(e) for e in drive.list(p)]
            elif scope.leads_to(p) and drive.kind(p) == "folder":
                toward = scope.leads_to(p)
                entries = [asdict(e) for e in drive.list(p) if e.type == "folder" and e.name in toward]
            else:
                raise NotFound(p)
        except NotFound as e:
            drive.log(key.name, "list", p, "not found")
            raise ToolError(str(e)) from None
        drive.log(key.name, "list", p)
        return _text({"path": p, "entries": entries})

    @server.tool(name="read", title="Read file", annotations=READ_ONLY, structured_output=False)
    def read_file(
        ctx: Context,
        path: PathArg,
        page: Annotated[int, Field(ge=1, description="1-based page number")] = 1,
        version: Annotated[int | None, Field(ge=1, description="Read this version from history")] = None,
    ) -> list[TextContent]:
        """Read a file. Text files come back as text in pages; binary files return metadata only.
        Returns metadata JSON (path, version, size, sha256, mime, page, pages, has_more), then the content."""
        key, p = _key(ctx), _clean(path)
        try:
            if not paths.Scope(key.folders).can_see(p):
                raise NotFound(p)
            data, number = drive.read(p, version)
        except NotFound as e:
            drive.log(key.name, "read", p, "not found")
            raise ToolError(str(e)) from None
        meta = {
            "path": p,
            "version": number,
            "size": len(data),
            "sha256": sha256_hex(data),
            "mime": mimetypes.guess_type(p)[0] or "application/octet-stream",
        }
        if not is_text(data):
            drive.log(key.name, "read", p, "binary, metadata only")
            meta |= {
                "encoding": "binary",
                "note": "Binary file: only metadata is returned. Ask the admin for a download.",
            }
            return _text(meta)
        pages = max(1, math.ceil(len(data) / page_bytes))
        if page > pages:
            raise ToolError(f"page {page} is past the end (the file has {pages} page(s))")
        start, end = _page_bounds(data, page, page_bytes)
        meta |= {"encoding": "utf-8", "page": page, "pages": pages, "has_more": page < pages}
        drive.log(key.name, "read", p, f"page {page}/{pages}" + (f", version {version}" if version else ""))
        return _text(meta, data[start:end].decode("utf-8"))

    @server.tool(name="search", title="Search drive", annotations=READ_ONLY, structured_output=False)
    def search(
        ctx: Context,
        query: Annotated[str, Field(min_length=1, max_length=200, description="Text to look for")],
        path: PathArg = "/",
    ) -> list[TextContent]:
        """Find files whose name or text content contains the query (case-insensitive). Up to 50 hits,
        with the first matching line for content hits."""
        key, p = _key(ctx), _clean(path)
        roots = paths.Scope(key.folders).search_roots(p)
        if not roots or all(drive.kind(r) is None for r in roots):
            drive.log(key.name, "search", p, "not found")
            raise ToolError(str(NotFound(p)))
        hits = drive.search(roots, query.strip())
        drive.log(key.name, "search", p, f"query {json.dumps(query)}, {len(hits)} hit(s)")
        return _text({"query": query, "path": p, "hits": hits})

    @server.tool(name="history", title="File history", annotations=READ_ONLY, structured_output=False)
    def history(ctx: Context, path: PathArg) -> list[TextContent]:
        """Stored versions of a file, newest first. Read one with read(path, version=N)."""
        key, p = _key(ctx), _clean(path)
        versions = drive.history(p) if paths.Scope(key.folders).can_see(p) else []
        if not versions:
            drive.log(key.name, "history", p, "not found")
            raise ToolError(str(NotFound(p)))
        drive.log(key.name, "history", p)
        return _text({"path": p, "versions": versions})

    return server


__all__ = ["build", "SCOPE_KEY", "DriveError"]
