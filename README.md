# Thumbdrive MCP

A USB stick you load for your agents: you put files on it, they read exactly what you put there, with a checksum to prove it, and nothing they do can change it.

Thumbdrive is a small, self-hosted [MCP](https://modelcontextprotocol.io) server. You manage files; any MCP agent (Claude Desktop, Cursor, VS Code and others) reads them byte-for-byte from only the folders you share with it.

- **Read-only for agents.** Four tools: `list`, `read`, `search`, `history`. No agent can write, rename or delete.
- **Exact.** Every read returns the file's SHA-256 so the agent can verify it got the right bytes.
- **Versioned.** Every change you make is kept; nothing is silently overwritten.
- **Plain files.** Current files live as normal files on a mounted folder, plus a small SQLite database. Backup means copying the folder.
- **Folder keys.** Each agent gets its own key that opens only the folders you choose. Everything else is invisible to it.

> Status: early development (milestone M1). The web UI comes in M3; until then a small admin CLI manages files and keys.

## Quick start

Requires Node 22.13 or newer, or Docker.

```sh
git clone https://github.com/hkrlogic/thumbdrive-mcp.git
cd thumbdrive-mcp
npm ci

# put some files on the drive and make a read-only key for one folder
npm run admin -- import ~/Documents/handbook /team
npm run admin -- key create my-agent --folder /team   # prints td_... once

npm start            # serves http://127.0.0.1:8484/mcp
```

With Docker (images for amd64 and arm64 are published to `ghcr.io/hkrlogic/thumbdrive-mcp`):

```sh
docker compose up -d     # uses docker-compose.yml
docker exec -it thumbdrive node dist/admin.js key create my-agent --folder /
```

Or build it yourself:

```sh
docker build -t thumbdrive-mcp .
docker run -d --init --name thumbdrive -e THUMBDRIVE_HOST=0.0.0.0 \
  -p 127.0.0.1:8484:8484 -v thumbdrive-data:/data thumbdrive-mcp
docker exec -it thumbdrive node dist/admin.js key create my-agent --folder /
```

Portainer: see [docs/portainer.md](docs/portainer.md).

The server listens on localhost unless `THUMBDRIVE_HOST` is set, and that includes inside a container. The compose file sets `THUMBDRIVE_HOST=0.0.0.0` and publishes the port on `127.0.0.1` only. Change the port to `8484:8484` to reach it from your home network. Plain HTTP is accepted from localhost and private networks (10/8, 172.16/12, 192.168/16, 100.64/10 and IPv6 ULA). It is refused from public addresses, so for anything beyond the LAN put HTTPS in front (Caddy or Cloudflare Tunnel).

## Connect an agent

Streamable HTTP (most clients):

```json
{
  "mcpServers": {
    "thumbdrive": {
      "url": "http://127.0.0.1:8484/mcp",
      "headers": { "Authorization": "Bearer td_..." }
    }
  }
}
```

stdio (the client starts the server itself):

```json
{
  "mcpServers": {
    "thumbdrive": {
      "command": "npx",
      "args": ["tsx", "/path/to/thumbdrive-mcp/src/index.ts", "--stdio"],
      "env": { "THUMBDRIVE_KEY": "td_...", "DATA_DIR": "/path/to/thumbdrive-mcp/data" }
    }
  }
}
```

Check a running server end to end: `THUMBDRIVE_KEY=td_... npm run smoke -- http://127.0.0.1:8484/mcp`.

## Tools

All four are annotated `readOnlyHint: true`. Anything outside the key's folders answers `Not found`, exactly like a missing file.

| Tool | What it does |
| --- | --- |
| `list(path)` | Files and folders with size, SHA-256 and modified time |
| `read(path, format, page, version, base64)` | Paged read. `raw` gives UTF-8 text, or base64 for binaries (or when `base64` is true). `text` gives CSV/TSV as JSON rows, and text files as text. Returns metadata JSON (sha256, version, page, pages, has_more...) then the content |
| `search(query, path)` | Case-insensitive match on names and text content, up to 50 hits |
| `history(path)` | Stored versions, newest first; read one with `read(path, version)` |

Text views for Excel, PDF and Word files are not built yet: `format: "text"` says so, and `format: "raw"` returns them as base64.

## Admin CLI

```text
npm run admin -- put <local-file> <drive-path>
npm run admin -- import <local-folder> <drive-folder>
npm run admin -- mkdir | rm | ls | history <drive-path>
npm run admin -- restore <drive-path> <version>
npm run admin -- key create <name> --folder <folder> [--folder ...]
npm run admin -- key list | key revoke <name>
npm run admin -- activity [count]
```

## Storage

```text
data/
  files/        current files, as plain files
  versions/     every stored version, named by SHA-256
  thumbdrive.db versions, hashed keys, activity log (SQLite)
```

Every admin change adds a version; deletes keep history. Files you copy into `data/files` by hand are served too, and get their first version on the next admin change. Symlinks inside the drive are ignored.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `DATA_DIR` | `./data` | Mounted data folder |
| `PORT` | `8484` | |
| `THUMBDRIVE_HOST` | `127.0.0.1` | Address to listen on. Set `0.0.0.0` in containers (the compose file does). `BIND_HOST` also works |
| `ALLOWED_HOSTS` | | Host names accepted in `Host`/`Origin` besides localhost and private IPs, comma separated (e.g. `nas.local`) |
| `ALLOW_INSECURE_HTTP` | | `1` accepts plain HTTP from public addresses. Not recommended |
| `MAX_FILE_MB` | `50` | Largest file the admin can store |
| `READ_PAGE_BYTES` | `65536` | Bytes per read page |
| `READ_PAGE_ROWS` | `200` | Rows per CSV page |
| `RATE_LIMIT_PER_MINUTE` | `120` | Requests per key per minute |
| `THUMBDRIVE_KEY` | | Key for `--stdio` mode |

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run build        # compiles to dist/, which is what the image runs
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The license does not grant rights to the Thumbdrive name.
