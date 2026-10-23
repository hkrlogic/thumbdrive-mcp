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
- Admin CLI (`npm run admin`, or `node dist/admin.js` in the container) and smoke client (`npm run smoke`).
- Production Docker image: multi-stage build to `dist/`, Node 22, non-root, `/data` volume, healthcheck. Listens on localhost unless `THUMBDRIVE_HOST` is set.
- Multi-arch (amd64, arm64) image workflow publishing to `ghcr.io/hkrlogic/thumbdrive-mcp` (`:edge` from main, `:m1` from m1-core-drive, semver and `:latest` from `v*` tags, `:sha-<sha>`), with an end-to-end smoke test of the image before push.
- `docker-compose.yml` for Portainer Stacks and `docs/portainer.md`.
- Project scaffold: TypeScript on Node 22, Hono, official MCP TypeScript SDK, Apache 2.0 license, CI (typecheck, lint, tests).

### Changed
- Host and Origin checks accept private IP literals (e.g. `192.168.1.20:8484`) so LAN clients work with no setup; other names go in `ALLOWED_HOSTS`.
- `X-Forwarded-Proto` is only trusted from local or private peers, and plain HTTP from public peers is always refused unless `ALLOW_INSECURE_HTTP=1`.

### Not yet
- Text views for Excel, PDF and Word files (raw/base64 reads work).
