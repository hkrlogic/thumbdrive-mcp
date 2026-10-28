# Changelog

All notable changes to this project are recorded here. Dates are in ISO format.

## Unreleased

### Added
- CyberDrive tables ([docs/tables.md](docs/tables.md)): typed, user-edited tables stored in SQLite at a folder path, so keys and share links that cover the folder cover the table (dataset grants only add OUI vendor and NIST control titles to lookups). Column types are text, long text, number, date, checkbox, single select, URL and email, plus hostname, IP address, CIDR, MAC, CVE ID and control ID, all validated and normalized. Row IDs are never reused, and each row has a history.
- Draft and publish: edits go to a draft; **Review and publish** shows added, changed and removed rows, column changes, and the problems that block publishing (any invalid cell, or duplicate or empty keys). Publishing with a note creates a numbered version. **Versions** lists them, and **Roll back** republishes an old version as a new one.
- Grid UI built on Tabulator 6.7.1 (MIT, vendored under `src/web/static/vendor/tabulator`, pinned and hashed in [docs/third-party-licenses.md](docs/third-party-licenses.md), served same-origin under the existing strict CSP). It covers keyboard navigation and editing, add and delete rows, paste from Excel or the clipboard (header detection, key-aware updates), sort and filter, red invalid cells with reasons, column add, rename, reorder, retype and delete with a key column choice, CSV export with a formula-injection guard, light and dark themes, and mobile layout.
- CSV and XLSX import (via `read-excel-file`) into a new or existing table: preview, suggested column types, key column, column mapping, a report of invalid rows; the import lands in the draft.
- Templates **Server inventory** and **IP plan / VLANs**, defined in `src/tables/templates.ts`.
- MCP tools `list_tables`, `describe_table`, `lookup_row` (type-aware matching, longest-prefix CIDR match for IPs, explicit `No match`, citations like `cyberdrive:/inventory/servers@v3#r12`) and `query_table` (a fixed operator list, parameterized, paged). Read-only, published versions only, every call logged.
- Share links show the folder's published tables (read-only, CSV download).
- `scripts/e2e.ts` covers creating a table from a template, editing, publish, `lookup_row` and `query_table`, rollback, an XLSX import and persistence after restart.
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
- Light theme success colour darkened to `#166b3f` (WCAG AA contrast for badges).
- The drive tools check ("exactly four read-only tools") in `scripts/e2e.ts` now expects eight: the drive tools plus the table tools.
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
