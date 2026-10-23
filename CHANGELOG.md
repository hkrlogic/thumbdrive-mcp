# Changelog

All notable changes to this project are recorded here. Dates are in ISO format.

## Unreleased

### Added
- M1 core drive: plain-file storage under `DATA_DIR/files`, content-addressed version blobs, SHA-256 checksums, version history with delete and restore (SQLite via `node:sqlite`).
- Four read-only MCP tools (`list`, `read`, `search`, `history`) with `readOnlyHint` annotations; paged reads, base64 for binaries, CSV/TSV row view.
- Read-only keys scoped to folders, stored as SHA-256 hashes; hidden paths answer `Not found`.
- Path traversal and symlink protection.
- Streamable HTTP at `/mcp` (Host/Origin checks, Bearer key, per-key rate limit, body limit, plain HTTP refused off local networks) and stdio (`--stdio`, `THUMBDRIVE_KEY`).
- Activity log of agent reads and admin changes.
- Admin CLI (`npm run admin`) and smoke client (`npm run smoke`).

### Not yet
- Text views for Excel, PDF and Word files (raw/base64 reads work).
- Project scaffold: TypeScript on Node 22, Hono, official MCP TypeScript SDK, Apache 2.0 license, Dockerfile, CI (typecheck, lint, tests).
