# Run Thumbdrive in Portainer

This sets up Thumbdrive as a Portainer stack: one container, one named volume, port 8484. It takes about five minutes.

After that, see the [Web UI guide](web-ui.md) for each screen, [configuration.md](configuration.md) for every setting and CLI command, and [security.md](security.md) before you open it beyond your LAN.

## 0. Let Portainer pull the image (private package only)

The image is `ghcr.io/hkrlogic/thumbdrive-mcp`. While the repository and package are private, Portainer needs credentials to pull it. Pick one:

- **Add a registry.** In GitHub, create a **classic** personal access token (Settings → Developer settings → Personal access tokens → Tokens (classic)) with only the `read:packages` scope. Fine-grained tokens do not work for ghcr.io. Then in Portainer go to **Registries → Add registry → Custom registry**:
  - Name: `ghcr`
  - Registry URL: `ghcr.io`
  - Authentication: on
  - Username: your GitHub username
  - Password: the token
- **Or make the package public.** On GitHub, open the hkrlogic organization → **Packages → thumbdrive-mcp → Package settings → Change visibility → Public**. The repository stays private. Your organization may have to allow public packages first.

## 1. Add the stack

1. Go to **Stacks → Add stack**.
2. Enter the name `thumbdrive`.
3. Choose **Web editor** and paste the compose file below, which is the same as [`docker-compose.yml`](../docker-compose.yml).

```yaml
services:
  thumbdrive:
    image: ghcr.io/hkrlogic/thumbdrive-mcp:m3
    container_name: thumbdrive
    restart: unless-stopped
    init: true
    environment:
      THUMBDRIVE_HOST: 0.0.0.0
      PORT: "8484"
      DATA_DIR: /data
      ALLOWED_HOSTS: ""
      # THUMBDRIVE_ADMIN_PASSWORD: "change-me-to-something-long"
      # THUMBDRIVE_PUBLIC_URL: "https://thumbdrive.example.com"
    ports:
      - "127.0.0.1:8484:8484"
    volumes:
      - thumbdrive-data:/data
      # - /srv/thumbdrive-import:/import:ro

volumes:
  thumbdrive-data:
```

Decide who can connect before you deploy:

| `ports` value | Who can reach Thumbdrive |
| --- | --- |
| `"127.0.0.1:8484:8484"` (default) | Only the Docker host itself |
| `"8484:8484"` | Any device on your home network, e.g. `http://192.168.1.20:8484/` |

Plain HTTP works from localhost and private network addresses. Requests from public addresses are refused. To use Thumbdrive from outside your home, put it behind HTTPS (Caddy, Traefik, or Cloudflare Tunnel) rather than forwarding the port on your router.

Browsers and clients that connect by IP address work as is. If they use a hostname such as `nas.local` or `thumbdrive.example.com`, list it in `ALLOWED_HOSTS` (comma separated), or set `THUMBDRIVE_PUBLIC_URL` to the full address. The web UI and `/mcp` share these rules.

`THUMBDRIVE_ADMIN_PASSWORD` is optional. If you leave it out, you set the password in the browser on first run (step 3).

## 2. Deploy

Click **Deploy the stack**. Within about 15 seconds, **Containers → thumbdrive** shows the status `healthy`. If the pull fails with `unauthorized` or `denied`, go back to step 0.

The logs should show something like:

```
thumbdrive-mcp 0.0.1: web UI http://HOST:8484/  MCP http://HOST:8484/mcp  (data: /data)
First run: open http://HOST:8484/ in a browser and set the admin password (or set THUMBDRIVE_ADMIN_PASSWORD, or run: node dist/admin.js set-password).
```

## 3. First run: set the admin password

Open **http://HOST:8484** in a browser. `HOST` is `127.0.0.1` on the Docker host itself, or the host's LAN IP if you published `8484:8484`. Choose an admin password of at least 8 characters. You are signed in and land on the dashboard.

<img src="images/setup.png" alt="The first-run screen" width="340">

Until a password is set, anyone who can reach the port can set it, so do this right after deploying (or set `THUMBDRIVE_ADMIN_PASSWORD` in the stack). See [the first-run caveat](security.md#first-run-caveat).

Forgot it? In **Containers → thumbdrive → Console** (`/bin/sh`), run `node dist/admin.js set-password`. That also signs out every browser session.

## 4. Put files on the drive

Agents can only read. You add files in the web UI:

- **Files** → drag files or whole folders onto the drop area, or use **Choose files** / **Choose a folder**. Up to `MAX_FILE_MB` (50 MB by default) per file.
- **New folder**, and each row's **⋯** menu for download, rename or move, history and delete. Uploading a file with the same name adds a new version, and every older version can be restored from the file's page.

![The Files page](images/files.png)

## 5. Create a key and connect an agent

![A new key with its Cursor snippet (key masked)](images/keys-new-key.png)

Go to **Agent keys**, enter a name (e.g. `laptop-cursor`), tick the folders it may read, and click **Create key**. The key (`td_...`) is shown once with a copy button, and so are ready-to-paste configs for:

- **Cursor** (`~/.cursor/mcp.json`) and other clients that support Streamable HTTP with headers
- **Claude Desktop** through the `mcp-remote` bridge, which needs Node on that machine. `--allow-http` is added automatically for plain-HTTP LAN addresses.
- **Claude Code**, and a generic URL plus `Authorization: Bearer` header

The snippets use the address you opened the UI on. If agents reach the server some other way (a hostname or an HTTPS proxy), set `THUMBDRIVE_PUBLIC_URL`. Claude's **Settings → Connectors → Add custom connector** connects from Anthropic's cloud, so it only works with a public HTTPS URL.

Only a hash of the key is stored. If you lose it, revoke the key and create another. **Edit** changes a key's folders without changing the key.

Restart the client and ask it to "list my Thumbdrive". It should see four read-only tools: `list`, `read`, `search` and `history`. Each read appears under **Activity**.

## Sharing a folder with a person

**Share links** (or **Share** on a folder) creates a read-only link to one folder for 1 hour, 1 day (the default), 7 days or 30 days. Anyone with the link can browse and download that folder until it expires or you revoke it. The link is shown once. More in the [Web UI guide](web-ui.md#share-links).

## The CLI still works

Everything above can also be done from **Containers → thumbdrive → Console** (`/bin/sh`, user `node`) or from the Docker host with `docker exec -it thumbdrive ...`:

```sh
node dist/admin.js key create my-agent --folder /team   # prints td_... once
node dist/admin.js import /import /team                 # needs the /import mount
node dist/admin.js set-password
node dist/admin.js                                      # lists every command
```

Every command is described in [configuration.md](configuration.md#admin-cli).

To import a host folder, uncomment the `/import` line in the stack, set its host path, click **Update the stack**, and run the `import` command above. To copy one file from the Docker host:

```sh
docker cp ./handbook.pdf thumbdrive:/tmp/handbook.pdf
docker exec thumbdrive node dist/admin.js put /tmp/handbook.pdf /team/handbook.pdf
```

## Updating and backups

- **Update.** Open **Stacks → thumbdrive → Editor**, turn on **Re-pull image**, and click **Update the stack**. Your data and keys are in the volume, so they survive.
- **Image tags.** `:m3` follows the m3-web-ui branch (with the web UI) and `:m1` the m1-core-drive branch; after the merge use `:edge` (main), and after releases use a version tag (`:0.1`) or `:latest`. Every build also gets `:sha-<commit>`.
- **Back up** the `thumbdrive_thumbdrive-data` volume. It holds `files/` (the current files, as plain files), `versions/` (every stored version) and `thumbdrive.db` (version history, hashed keys and share links, the admin password hash and the activity log). Stop the stack before you copy it, or copy all three together.
- **HTTPS.** For access from outside your home, put a proxy such as Caddy, Traefik or Cloudflare Tunnel in front, and set `THUMBDRIVE_PUBLIC_URL`. See [security.md](security.md#https).
- **Bind mount instead of a volume.** If you mount a host folder at `/data`, it must be writable by uid 1000: `chown -R 1000:1000 /srv/thumbdrive`.
