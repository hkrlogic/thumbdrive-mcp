# Run Thumbdrive in Portainer

This sets up Thumbdrive as a Portainer stack: one container, one named volume, port 8484. It takes about five minutes.

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
    image: ghcr.io/hkrlogic/thumbdrive-mcp:m1
    container_name: thumbdrive
    restart: unless-stopped
    init: true
    environment:
      THUMBDRIVE_HOST: 0.0.0.0
      PORT: "8484"
      DATA_DIR: /data
      ALLOWED_HOSTS: ""
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
| `"8484:8484"` | Any device on your home network, e.g. `http://192.168.1.20:8484/mcp` |

Plain HTTP works from localhost and private network addresses. Requests from public addresses are refused. To use Thumbdrive from outside your home, put it behind HTTPS (Caddy, Traefik, or Cloudflare Tunnel) rather than forwarding the port on your router.

Clients that connect by IP address work as is. If they use a hostname such as `nas.local` or `thumbdrive.example.com`, list it in `ALLOWED_HOSTS` (comma separated).

## 2. Deploy

Click **Deploy the stack**. Within about 15 seconds, **Containers → thumbdrive** shows the status `healthy`. If the pull fails with `unauthorized` or `denied`, go back to step 0.

The logs should show:

```
thumbdrive-mcp 0.0.1 on http://0.0.0.0:8484/mcp (data: /data)
No active keys yet. Create one: docker exec -it <container> node dist/admin.js key create my-agent --folder /
```

## 3. Create the first key

Open **Containers → thumbdrive → Console**, keep the command `/bin/sh` (the default user is `node`) and click **Connect**. Then run:

```sh
node dist/admin.js key create my-agent --folder /
```

The full key (`td_...`) is printed once. Copy it now. Only a hash is stored, so the key cannot be shown again; if you lose it, revoke it and create another.

From a shell on the Docker host, the same command is:

```sh
docker exec -it thumbdrive node dist/admin.js key create my-agent --folder /
```

To give an agent only part of the drive, use `--folder /team` and repeat `--folder` for more folders. Other key commands: `key list` and `key revoke <name>`.

## 4. Put files on the drive

Agents can only read. You add files with the admin CLI in the same console:

- **From a host folder.** Uncomment the `/import` line in the stack, set its host path, click **Update the stack**, then run:

  ```sh
  node dist/admin.js import /import /team
  ```

- **One file from the Docker host:**

  ```sh
  docker cp ./handbook.pdf thumbdrive:/tmp/handbook.pdf
  docker exec thumbdrive node dist/admin.js put /tmp/handbook.pdf /team/handbook.pdf
  ```

Run `node dist/admin.js` with no arguments to see every command (`ls`, `mkdir`, `rm`, `history`, `restore`, `activity`). Every change keeps the previous version.

## 5. Connect an agent

Replace `HOST` with `127.0.0.1` on the Docker host itself, or with the host's LAN IP if you published `8484:8484`.

**Cursor** (`~/.cursor/mcp.json`) and other clients that support Streamable HTTP with headers:

```json
{
  "mcpServers": {
    "thumbdrive": {
      "url": "http://HOST:8484/mcp",
      "headers": { "Authorization": "Bearer td_..." }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`) starts local servers over stdio. Use the `mcp-remote` bridge, which needs Node on the machine running Claude Desktop:

```json
{
  "mcpServers": {
    "thumbdrive": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://HOST:8484/mcp", "--allow-http", "--header", "Authorization:${THUMBDRIVE_AUTH}"],
      "env": { "THUMBDRIVE_AUTH": "Bearer td_..." }
    }
  }
}
```

`--allow-http` is needed for plain-HTTP URLs other than localhost; drop it if you use HTTPS. Claude's **Settings → Connectors → Add custom connector** connects from Anthropic's cloud, so it only works with a public HTTPS URL.

Restart the client and ask it to "list my Thumbdrive". It should see four read-only tools: `list`, `read`, `search` and `history`.

## Updating and backups

- **Update.** Open **Stacks → thumbdrive → Editor**, turn on **Re-pull image**, and click **Update the stack**. Your data and keys are in the volume, so they survive.
- **Image tags.** `:m1` follows the m1-core-drive branch; after the merge use `:edge` (main), and after releases use a version tag (`:0.1`) or `:latest`. Every build also gets `:sha-<commit>`.
- **Back up** the `thumbdrive_thumbdrive-data` volume. It holds `files/` (the current files, as plain files), `versions/` (every stored version) and `thumbdrive.db` (version history, hashed keys and the activity log). Stop the stack before you copy it, or copy all three together.
- **Bind mount instead of a volume.** If you mount a host folder at `/data`, it must be writable by uid 1000: `chown -R 1000:1000 /srv/thumbdrive`.
