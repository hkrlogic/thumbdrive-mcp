# Design

Goal: something one person can read in an afternoon and still run in 20 years. Fewer moving parts beat features.

## Choices

- **Standard library first.** `sqlite3`, `hashlib.scrypt`, `secrets`, `hmac`, `ipaddress`, `tempfile`. No ORM, no auth library, no frontend build.
- **Server-rendered HTML.** Jinja2 templates, plain forms. `app.js` (15 lines) only adds copy buttons and delete confirmations; every page works without it. The one exception is the table grid, which needs JavaScript (see Tables below).
- **One process.** Starlette serves the UI and mounts the MCP SDK's Streamable HTTP app at `/mcp` (stateless, JSON responses).
- **Small flat modules.** `paths` (path rules and key scope), `drive` (files, versions, search, activity), `keys`, `auth`, `tools` (MCP), `web` (UI), `app` (wiring and security middleware), `config`, `db`. Tables add `table_types` (validation), `tables` (store), `table_tools` (MCP), `tables_web` (UI and JSON endpoints) and `table_templates`.

## Dependencies

| Package | Why | How to replace |
| --- | --- | --- |
| `mcp` | Official MCP SDK: protocol, Streamable HTTP | Only `tools.py` and `app.py` touch it. The protocol is JSON-RPC over HTTP POST and could be hand-written |
| `starlette` | Routing, requests, forms, static files. Already required by `mcp` | Any ASGI framework; only `web.py`/`app.py` use it |
| `uvicorn` | ASGI server. Already required by `mcp` | Hypercorn, Granian |
| `jinja2` | Templates with auto-escaping | Any auto-escaping template engine; seven small templates |
| `python-multipart` | Starlette's form/upload parser. Already required by `mcp` | Comes with Starlette's replacement |

Dev only: `pytest`, `ruff`, `httpx`. Versions are pinned in `uv.lock`.

Vendored, not installed: Tabulator 6.7.1 (`static/vendor/tabulator/`, MIT, licence file next to it). It is two static files served from our origin, so the strict CSP (`script-src 'self'`) stays; upgrading means replacing the files and re-running the grid by hand.

## On disk

```
DATA_DIR/
  files/<path>          current files, as normal files; edit or back up with any tool
  versions/<sha256>     every stored version, content-addressed, never modified
  thumbdrive.db         SQLite (WAL)
```

Backup: copy the folder while stopped, or use `sqlite3 thumbdrive.db '.backup backup.db'` plus a copy of `files/` and `versions/`. Files dropped straight into `files/` are picked up at the next start as a new version by `disk`.

## Schema

`migrations/NNN_name.sql`, applied in order at start; the schema version is SQLite's `PRAGMA user_version`. Never edit an applied migration, add the next number.

| Table | Holds |
| --- | --- |
| `versions` | One row per change: path, version number, `put` or `delete`, sha256, size, actor, time |
| `keys`, `key_folders` | Agent keys (name, 9-char prefix, SHA-256 of the key, revoked time) and their folders |
| `activity` | Agent calls and admin changes |
| `settings` | Admin password hash (`scrypt$n$r$p$salt$hash`) and the CSRF secret |
| `sessions` | SHA-256 of session tokens with expiry |
| `tables` | One row per table: path, description, columns (JSON list of `{id, name, type, options}`), key column id, next row id, next column id |
| `table_draft_rows` | The editable draft: `(table_id, row_id, data)`, `data` a JSON object keyed by column id |
| `table_versions`, `table_version_rows` | Each published version: columns, key, note, counts of added/changed/removed rows, and a full copy of its rows |
| `file_text` | FTS5 trigram index of text files for search; rebuilt from disk at every start, so it is disposable |

Times are UTC ISO-8601 strings. Paths are absolute, `/`-separated, without a trailing slash.

## Tables

- **Stable ids.** Rows get ids from a per-table counter (`r1`, `r2`, …) and columns get `c1`, `c2`, …; neither is ever reused, so a citation like `thumbdrive:/path@v3#r12` keeps meaning the same row and renaming a column changes nothing in stored data.
- **Full snapshot per version.** Publishing copies every draft row into `table_version_rows`. Simple to read, roll back (copy vN to the draft, publish) and query, at the cost of space: 50,000 rows × a few versions is still a small SQLite file. Deltas would save space and add a class of bugs; not worth it here.
- **The draft keeps bad input.** A cell holds the canonical value when it validates and the raw text when it does not, so nothing typed or pasted is lost. Errors are recomputed from the column type on every read (`check()` accepts canonical values unchanged), never stored. Publishing is refused while any error, duplicate key or empty key exists.
- **Agents read only published versions**, through the same folder scope as files: a table outside a key's folders, missing, or never published answers `Not found`. `query_table` uses `json_extract` with bound parameters and a fixed list of operators; there is no free-form SQL.
- **Grid**: Tabulator saves each edit through small JSON endpoints (`/tables/{id}/edits`, `/paste`) with the CSRF token in an `X-CSRF-Token` header. Column changes and publishing are ordinary forms.
- **CSV import** uses the standard `csv` module; the parsed file waits in memory for 30 minutes between preview and confirm. XLSX would need a dependency and is left out.
