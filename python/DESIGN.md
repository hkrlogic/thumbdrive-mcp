# Design

Goal: something one person can read in an afternoon and still run in 20 years. Fewer moving parts beat features.

## Choices

- **Standard library first.** `sqlite3`, `hashlib.scrypt`, `secrets`, `hmac`, `ipaddress`, `tempfile`. No ORM, no auth library, no frontend build.
- **Server-rendered HTML.** Jinja2 templates, plain forms. `app.js` (15 lines) only adds copy buttons and delete confirmations; every page works without it.
- **One process.** Starlette serves the UI and mounts the MCP SDK's Streamable HTTP app at `/mcp` (stateless, JSON responses).
- **Small flat modules.** `paths` (path rules and key scope), `drive` (files, versions, search, activity), `keys`, `auth`, `tools` (MCP), `web` (UI), `app` (wiring and security middleware), `config`, `db`.

## Dependencies

| Package | Why | How to replace |
| --- | --- | --- |
| `mcp` | Official MCP SDK: protocol, Streamable HTTP | Only `tools.py` and `app.py` touch it. The protocol is JSON-RPC over HTTP POST and could be hand-written |
| `starlette` | Routing, requests, forms, static files. Already required by `mcp` | Any ASGI framework; only `web.py`/`app.py` use it |
| `uvicorn` | ASGI server. Already required by `mcp` | Hypercorn, Granian |
| `jinja2` | Templates with auto-escaping | Any auto-escaping template engine; seven small templates |
| `python-multipart` | Starlette's form/upload parser. Already required by `mcp` | Comes with Starlette's replacement |

Dev only: `pytest`, `ruff`, `httpx`. Versions are pinned in `uv.lock`.

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
| `file_text` | FTS5 trigram index of text files for search; rebuilt from disk at every start, so it is disposable |

Times are UTC ISO-8601 strings. Paths are absolute, `/`-separated, without a trailing slash.
