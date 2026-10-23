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
npm start            # listens on http://127.0.0.1:8484
```

With Docker:

```sh
docker build -t thumbdrive-mcp .
docker run --init -p 127.0.0.1:8484:8484 -v "$PWD/data:/data" thumbdrive-mcp
```

The server binds to localhost by default. To reach it from elsewhere, put HTTPS in front (Caddy or Cloudflare Tunnel).

## Development

```sh
npm run typecheck
npm run lint
npm test
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The license does not grant rights to the Thumbdrive name.
