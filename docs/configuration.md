# Configuration and CLI reference

Thumbdrive reads its settings from environment variables once, at start. To change a setting, restart the server. In Portainer, edit the stack and click **Update the stack**. A number that is not a positive integer, or a bad `THUMBDRIVE_PUBLIC_URL`, stops the server at start with a message that names the variable.

- [Environment variables](#environment-variables)
- [Examples](#examples)
- [Admin CLI](#admin-cli)
- [Other commands](#other-commands)

See also: [web-ui.md](web-ui.md) for the screens, [security.md](security.md) for the security model and [portainer.md](portainer.md) for a Portainer setup.

## Environment variables

### Server

| Variable | Default | What it does |
| --- | --- | --- |
| `DATA_DIR` | `./data` (`/data` in the image) | The data folder. It holds `files/`, `versions/`, `tmp/` and `thumbdrive.db`. Relative paths are resolved from the working directory. |
| `PORT` | `8484` | TCP port for the web UI, `/mcp` and `/healthz`. |
| `THUMBDRIVE_HOST` | `127.0.0.1` | Interface to listen on. The default is localhost, including inside a container. Set `0.0.0.0` in a container so the published port can reach it (the compose file does). |
| `BIND_HOST` | | Same as `THUMBDRIVE_HOST`, which wins if both are set. |
| `THUMBDRIVE_PUBLIC_URL` | (from each request) | The address people and agents use, such as `https://drive.example.com`. It must start with `http://` or `https://`, and a trailing slash is removed. The UI uses it for the MCP URL, key snippets and share links, and its host is accepted like `ALLOWED_HOSTS`. Without it, the UI uses the address you opened it on. |

### Access rules

| Variable | Default | What it does |
| --- | --- | --- |
| `ALLOWED_HOSTS` | (empty) | Host names accepted in the `Host` and `Origin` headers, comma separated and case-insensitive, such as `nas.local,thumbdrive.example.com`. `localhost`, `127.0.0.1`, `::1` and private IP addresses are always accepted. This applies to every route except `/healthz`. |
| `ALLOW_INSECURE_HTTP` | (off) | Set it to `1` to accept plain HTTP from public addresses. Plain HTTP from localhost and private networks always works. Not recommended; put HTTPS in front instead. |
| `RATE_LIMIT_PER_MINUTE` | `120` | MCP requests allowed per agent key per minute. Above that, the server answers `429`. |

### Files and reads

| Variable | Default | What it does |
| --- | --- | --- |
| `MAX_FILE_MB` | `50` | Largest file, in MB, that you can upload or `put`. |
| `READ_PAGE_BYTES` | `65536` | Bytes per page for the `read` tool. Larger files come back in pages. |
| `READ_PAGE_ROWS` | `200` | Rows per page when `read` returns CSV or TSV as rows (`format: "text"`). |

### Admin and agents

| Variable | Default | What it does |
| --- | --- | --- |
| `THUMBDRIVE_ADMIN_PASSWORD` | | The admin password, at least 8 characters. It is applied at every start. If it differs from the stored password, the stored one is replaced and every session is signed out. Without it, the UI asks for a password on first run. See [security.md](security.md#the-admin-password). |
| `THUMBDRIVE_KEY` | | The agent key for stdio mode (`--stdio`), and for `npm run smoke`. Not used by the HTTP server. |

### Set by the Docker image

You normally leave these alone.

| Variable | Value in the image | What it does |
| --- | --- | --- |
| `THUMBDRIVE_IN_CONTAINER` | `1` | Makes the start-up hints show container commands (`node dist/admin.js ...`) instead of `npm run admin`. |
| `NODE_ENV` | `production` | Standard Node setting. |
| `NODE_OPTIONS` | `--disable-warning=ExperimentalWarning` | Hides Node's warning about the built-in SQLite module. |

## Examples

Local, from a checkout:

```sh
DATA_DIR=~/thumbdrive-data MAX_FILE_MB=200 npm start
```

On a home server, reachable from the LAN by IP and by name:

```yaml
environment:
  THUMBDRIVE_HOST: 0.0.0.0
  DATA_DIR: /data
  ALLOWED_HOSTS: "nas.local"
ports:
  - "8484:8484"
```

Behind an HTTPS proxy (Caddy, Traefik, Cloudflare Tunnel):

```yaml
environment:
  THUMBDRIVE_HOST: 0.0.0.0
  DATA_DIR: /data
  THUMBDRIVE_PUBLIC_URL: "https://drive.example.com"
```

## Admin CLI

The CLI changes the same drive as the web UI. Every change is versioned and logged. Run it:

- from a checkout: `npm run admin -- <command>`
- in the container: `node dist/admin.js <command>` (Portainer: **Containers → thumbdrive → Console**, or `docker exec -it thumbdrive node dist/admin.js <command>`)

It reads `DATA_DIR` and `MAX_FILE_MB` like the server. It can run while the server is up. Run it with no command to print the usage.

Drive paths start with `/`, such as `/team/handbook.pdf`.

### Files and folders

| Command | What it does |
| --- | --- |
| `put <local-file> <drive-path>` | Store one file. If the path exists, this adds a new version. Prints the version, size and SHA-256. |
| `import <local-folder> <drive-folder>` | Store every file in a local folder and its subfolders. Prints the number of files. Hidden files and symlinks are skipped. |
| `mkdir <drive-path>` | Create a folder, and any missing parents. |
| `rm <drive-path>` | Delete a file. The delete is recorded as a version and older versions are kept, so `restore` can bring it back. To delete a whole folder, use the web UI. |
| `mv <drive-path> <new-drive-path>` | Rename or move a file or folder. Moving a folder also updates the agent keys and share links that point into it. |
| `ls [drive-path]` | List a folder (default `/`): folders end in `/`; files show size and the first 12 characters of the SHA-256. |
| `history <drive-path>` | List every version of a file: version, action (`put` or `delete`), time (UTC), who, size and SHA-256. |
| `restore <drive-path> <version>` | Make an older version current again, as a new version. Also works for deleted files. |

### Agent keys

| Command | What it does |
| --- | --- |
| `key create <name> --folder <drive-folder> [--folder ...]` | Create a read-only key for one or more folders (use `--folder /` for the whole drive). The key is printed **once**; only its hash is stored. |
| `key list` | List keys: name, prefix, folders, and last use or revocation time. |
| `key revoke <name>` | Turn a key off at once. |

To change a key's folders without changing the key, use **Edit** on the **Agent keys** page.

### Activity and the admin password

| Command | What it does |
| --- | --- |
| `activity [count]` | The last `count` entries (default 50) of the activity log, oldest first: time (UTC), actor, action, path and details. |
| <a id="set-password"></a>`set-password` | Set or reset the admin password, at least 8 characters. In a terminal, it asks twice without echoing. Otherwise it reads the first line of stdin. It signs out every web session. |

```sh
# Reset a forgotten password in the container
docker exec -it thumbdrive node dist/admin.js set-password

# Non-interactive, e.g. from a script (keep it out of shell history)
printf '%s\n' "$NEW_PASSWORD" | node dist/admin.js set-password
```

Share links are created and revoked in the web UI only.

## Other commands

| Command | What it does |
| --- | --- |
| `npm start` | Start the server from a checkout (TypeScript via `tsx`). The image runs `node dist/index.js`. |
| `npm start -- --stdio` | Speak MCP over stdin/stdout instead of HTTP, for clients that start the server themselves. Needs `THUMBDRIVE_KEY`. No web UI. |
| `THUMBDRIVE_KEY=td_... npm run smoke -- <mcp-url>` | Check a running server end to end: it connects with the key, checks for the four read-only tools, then lists, reads and searches. It exits non-zero on a failure. |
| `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` | Development checks; `build` compiles to `dist/`. |
| `GET /healthz` | Returns `{"ok":true,...}` with the name and version. The image's health check uses it. It needs no key and is open to any host. |
