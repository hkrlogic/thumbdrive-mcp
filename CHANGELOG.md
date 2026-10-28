# Changelog

All notable changes to this project are recorded here. Dates are in ISO format.

## Unreleased

### Added
- CyberDrive, read-only security reference datasets for agents ([docs/cyberdrive.md](docs/cyberdrive.md)). First dataset: the MAC vendor (OUI) database, imported by the user from Ringmast4r's `master_oui.db` (not bundled: it includes GPLv2 Wireshark and Nmap data). SQLite storage with normalized prefixes and nibble lengths, validated imports, atomic replace, and a version history with time, source, SHA-256 and row count.
- MCP tools `lookup_mac` (up to 50 MACs in any common format, longest-prefix match over MA-S, MA-M and MA-L, locally administered and multicast flags, explicit `No match`, citations like `cyberdrive:oui@v3#00:00:0C`) and `search_oui_vendor`. Both are read-only, offered only to keys with an explicit dataset grant (whole-drive keys need one too), and every call is logged in Activity.
- **OUI database** admin page (upload, **Refresh from source**, version and history, keys with access), dataset checkboxes on **Agent keys**, and dataset-only keys.
- Admin CLI: `cyberdrive oui import|status|lookup|search`, `key create --dataset`, `key datasets`.
- `DATASET_MAX_MB` (default 100) for dataset uploads, and opt-in monthly refresh with `CYBERDRIVE_AUTO_REFRESH=1`.
- CyberDrive dataset `winevent`: Microsoft's Windows Security Audit Events catalog (2016, `WindowsSecurityAuditEvents.xlsx`), imported by the user from the Microsoft Download Center (not bundled). It is parsed with `read-excel-file` (not npm `xlsx` 0.18). The import validates the sheets and columns, merges summaries with every message version and removes Microsoft's message indentation.
- MCP tools `lookup_windows_event` (1 to 50 IDs: category > subcategory, `also_listed_under`, summary, minimum OS, all detailed message versions, citations like `cyberdrive:winevent@v1#4624`, explicit `No match` that notes the 2016 coverage) and `search_windows_events` (text search, optional category filter, limit). They are granted per key, separately from `oui`, and logged.
- **Windows events** admin page and the CLI commands `cyberdrive winevent import|status|lookup|search`.
- CyberDrive NIST control frameworks: datasets `nist80053` (SP 800-53 Rev 5 from NIST's OSCAL catalog; release 5.2.0 today), `csf2` (CSF 2.0 from NIST's OSCAL catalog) and `csf2map` (NIST's CSF 2.0 informative references to SP 800-53, from the CSF 2.0 Reference Tool export; only the newest 800-53 revision and no third-party references). Public domain, downloaded from NIST with **Refresh from source**, not bundled. Parameters are rendered as `[Assignment: ...]` and `[Selection (one or more): ...]`; statements keep their item structure.
- MCP tools `lookup_control` (1 to 50 IDs in either framework and any common spelling, such as `ac-2(1)`, `AC-2.1`, `PR.AA-01`, `GV.OC`; statement, discussion, enhancements or children, related controls, CSF examples, withdrawn status and targets, citations like `cyberdrive:nist80053@v1#AC-2(1)`, explicit `No match`), `search_controls` (keyword, framework and family filters, withdrawn opt-in, limit) and `map_control` (both directions, with category roll-ups, base-control and whole-family matches). Granted per dataset and logged.
- **NIST SP 800-53**, **NIST CSF 2.0** and **CSF ↔ 800-53 map** admin pages, and the CLI commands `cyberdrive nist80053|csf2 import|status|lookup|search` and `cyberdrive csf2map import|status|map`.
- `scripts/e2e.ts` covers the OUI page, a dataset-only key, `lookup_mac`, the Windows events and NIST dataset pages, `lookup_windows_event`, `lookup_control` and `map_control`, and persistence after restart.
- Documentation: README Web UI section with screenshots and a quick start; [Web UI guide](docs/web-ui.md); [configuration and CLI reference](docs/configuration.md) covering every environment variable and admin command; [security notes](docs/security.md) (sign-in, sessions, CSRF, CSP, first-run caveat, HTTPS, read-only agents, hashed keys and share links); screenshots in `docs/images/` with keys and links masked; Portainer guide links and screenshots.
- M3 web UI at `/` (server-rendered Hono JSX plus a small vanilla script, no build chain): dashboard with a copyable MCP URL; file browser with folder create/rename/move/delete, drag-and-drop multi-file and folder upload, download, rename/move/delete, version history and restore, and restore of deleted files; agent keys (create for one or more folders, token shown once with copy buttons and Cursor / Claude Desktop / Claude Code / generic snippets built from the real server URL, edit folders, revoke); per-folder share links (1 h, 24 h default, 7 d, 30 d; hashed 256-bit tokens; revoke; download count); activity log with filters; password settings; light and dark themes; mobile layout.
- Single admin login: first-run setup, `THUMBDRIVE_ADMIN_PASSWORD`, or `admin set-password`; scrypt hashes; `HttpOnly` `SameSite=Strict` session cookie (`Secure` over HTTPS); CSRF tokens plus Origin and Sec-Fetch-Site checks on every POST; login rate limit; strict CSP, no framing, sandboxed downloads.
- `THUMBDRIVE_PUBLIC_URL` for the address shown in the UI, snippets and share links.
- Admin CLI: `mv` and `set-password`. Moving a folder also moves the keys and share links that point into it.
- Image tag `:m3` built from the m3-web-ui branch.
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
- Deploy QA workflow (`.github/workflows/deploy-qa.yml`): deploys the image with `docker-compose.yml` (built on pull requests, or a published tag on manual runs) and runs `scripts/e2e.ts` against it: setup, uploads, keys, MCP over HTTP, share links, restart persistence, `THUMBDRIVE_ADMIN_PASSWORD`, Host checks and the admin CLI. On main it runs twice: once on an image built from source, and once on the image the Docker workflow published to GHCR (`:sha-<commit>`, checked against `:edge`).

### Changed
- `docker-compose.yml`, the Portainer guide and the README now use `:edge` (main). `:m3` and `:m1` still work.

### Fixed
- Files inside a deleted folder were not listed anywhere in the web UI, so they could not be restored there. They are now listed under **Deleted from this folder** on the nearest folder that still exists, with their folder path; restoring one recreates its folder.
- Admin pages and share links now send `X-Robots-Tag: noindex, nofollow` and a robots meta tag.

### Changed
- The Host/Origin allow-list and HTTPS rules now cover every route (the web UI as well as `/mcp`), except `/healthz`.
- Host and Origin checks accept private IP literals (e.g. `192.168.1.20:8484`) so LAN clients work with no setup; other names go in `ALLOWED_HOSTS`.
- `X-Forwarded-Proto` is only trusted from local or private peers, and plain HTTP from public peers is always refused unless `ALLOW_INSECURE_HTTP=1`.

### Not yet
- Text views for Excel, PDF and Word files (raw/base64 reads work).
