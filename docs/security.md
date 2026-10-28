# Security

Thumbdrive has two kinds of users:

- **You, the admin.** You sign in to the web UI, or use the CLI on the server, to change the drive.
- **Agents.** They connect to `/mcp` with a key. A key can only read, and only the folders it was given.

Share links are a third, narrower way in: a person with a link can browse and download one folder until the link expires.

This page explains how each of these is protected, and what you should set up yourself. Settings are in [configuration.md](configuration.md); the screens are in [web-ui.md](web-ui.md).

## Checklist

1. **Set the admin password before anyone else can reach the port.** Set `THUMBDRIVE_ADMIN_PASSWORD`, or run `set-password`, or open the UI right after the first start. See [First run](#first-run-caveat).
2. **Publish the port no wider than you need.** The compose file publishes it on `127.0.0.1` only. Use `8484:8484` for your home network.
3. **Use HTTPS for anything beyond your LAN.** Don't forward the port on your router. See [HTTPS](#https).
4. **Give each agent its own key with only the folders it needs.** Revoke keys you no longer use.
5. **Pick the shortest share-link expiry that works**, and revoke links when you are done.
6. **Back up the data folder.** It holds your files, every version and `thumbdrive.db`.

## The admin password

There is one admin account with one password, at least 8 characters long. The password is stored as a scrypt hash (`N=32768, r=8, p=1`, random 16-byte salt), never in plain text. It can be set three ways:

| How | When it applies |
| --- | --- |
| The **Welcome** screen on first run, or **Settings → Admin password** | At once. Changing it in Settings needs the current password. |
| `node dist/admin.js set-password` (`npm run admin -- set-password`) | At once. Use this if you forgot the password. |
| `THUMBDRIVE_ADMIN_PASSWORD` | At every start. If it differs from the stored password, the stored one is replaced. While it is set, a password changed in the UI only lasts until the next restart. |

Any password change, through any of the three, signs out **every** web session. A change in Settings then signs you back in on that browser.

### First-run caveat

Until a password exists, the UI shows the **Welcome** screen, and **whoever reaches it first can set the password**. The server logs a reminder at start. To close that gap, do one of these:

- set `THUMBDRIVE_ADMIN_PASSWORD` in the stack or compose file before the first start;
- run `node dist/admin.js set-password` before you publish the port;
- keep the port on `127.0.0.1` or your LAN (the default) and open the UI yourself right after deploying.

Before a password exists, agents can still connect with keys made with the CLI, but no one can make changes through the UI except by setting the password.

## Sessions

- Signing in creates a random 256-bit session token in the `td_session` cookie. The database stores only its SHA-256 hash.
- The cookie is `HttpOnly` (scripts cannot read it) and `SameSite=Strict` (other sites cannot send it). It is also `Secure` when the request came over HTTPS, directly or through a trusted proxy.
- A session lasts 7 days. **Sign out** ends it on the server, not only in the browser.
- Failed sign-ins are limited to **10 per 15 minutes per client address**. After that, the sign-in page asks you to wait.

## CSRF and same-origin checks

Every `POST` to the UI (forms, uploads, moves, deletes) must pass all of these:

1. **`Sec-Fetch-Site`**, when the browser sends it, must be `same-origin` or `none`.
2. **`Origin`**, when present, must have the same host as the request. `Origin: null` is refused.
3. **A CSRF token**, in the `X-CSRF-Token` header or the `_csrf` form field. The token is an HMAC, made with a server secret stored in the database, of the session cookie. Before sign-in it is bound to a random `td_pre` browser-session cookie instead. A token from another session doesn't work.

A request that fails any check gets `403`.

## Browser hardening

Every UI page is sent with:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `same-origin` |
| `Cache-Control` | `no-store` (static assets: one hour) |

The UI has no inline scripts or styles, so the CSP doesn't need `unsafe-inline`. Pages are rendered on the server, and every value is escaped.

**Tables** ([docs/tables.md](tables.md)): every grid save, paste, import, publish, rollback and column change is a POST with the CSRF token (the `x-csrf-token` header for the grid's JSON requests). The grid script and Tabulator are served from the app's own origin, so the CSP is unchanged. Agents can only read published versions. `query_table` filters use a fixed operator list, column names are resolved against the table's own columns, and values are bound as SQL parameters. CSV exports guard against formula injection.

**Downloads** from the UI and from share links are always sent as `application/octet-stream` attachments with `Content-Security-Policy: sandbox; default-src 'none'`. An uploaded HTML or SVG file can't run in Thumbdrive's origin. Each download also carries its SHA-256 in `X-Thumbdrive-SHA256`.

**Body limits.** Uploads may be up to `MAX_FILE_MB` plus 1 MB. Dataset and table imports may be up to `DATASET_MAX_MB`, and table grid saves and pastes up to 8 MB. Other forms are limited to 256 KB, and `/mcp` requests to 1 MB.

## Host and Origin allow-list

Every route except `/healthz` checks the `Host` header, and the `Origin` header when present. This blocks DNS-rebinding attacks, where a web page you visit tries to reach a server on your network. Accepted:

- `localhost`, `127.0.0.1`, `::1`
- private and link-local IP addresses (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, IPv6 `fc00::/7` and `fe80::/10`), with any port
- names in `ALLOWED_HOSTS`
- the host of `THUMBDRIVE_PUBLIC_URL`

If you open the UI as `http://nas.local:8484`, add `nas.local` to `ALLOWED_HOSTS`. Otherwise you get `403`.

## HTTPS

Thumbdrive itself speaks plain HTTP. That is accepted only from **local and private addresses**:

- A request from a public address is refused, unless `ALLOW_INSECURE_HTTP=1`.
- For use beyond your LAN, run an HTTPS proxy on the same host or LAN, such as Caddy, Traefik or Cloudflare Tunnel. It must send `X-Forwarded-Proto: https`.
- `X-Forwarded-Proto` is trusted only from local or private peers, since anyone could send that header. A proxy that says `http` is refused.
- Set `THUMBDRIVE_PUBLIC_URL=https://...` so the UI shows the HTTPS address in snippets and share links.

Over HTTPS, the session cookie gets the `Secure` flag.

Example Caddy site:

```text
drive.example.com {
  reverse_proxy 127.0.0.1:8484
}
```

## Agents are read-only

- `/mcp` offers exactly four tools: `list`, `read`, `search` and `history`. All four are annotated `readOnlyHint: true`. No tool, parameter or route lets a key write, rename or delete.
- A key opens only its folders and their subfolders. Any other path answers `Not found`, exactly like a missing file, so a key can't even tell that other folders exist.
- Path traversal (`..`) and symlinks are refused. Symlinks inside the drive are ignored.
- Each key is limited to `RATE_LIMIT_PER_MINUTE` requests per minute (120 by default).
- Every read is logged with the key name, so you can see it under **Activity**.
- Agents can't use the web UI. A key isn't a session.

## Keys and share tokens are stored hashed

| | Format | Stored | Shown |
| --- | --- | --- | --- |
| Agent key | `td_` + 43 base64url characters (256 random bits) | SHA-256 hash, plus the first 6 characters to tell keys apart | Once, when created |
| Share link | `/s/tds_` + 43 base64url characters (256 random bits) | SHA-256 hash, plus a short prefix | Once, when created |
| Session | 256 random bits | SHA-256 hash | Never; it lives only in the cookie |

Someone who copies `thumbdrive.db` can't use the keys or links in it.

**Share links:**

- Each link opens one folder and its subfolders, read-only.
- A link expires after 1 hour, 1 day (the default), 7 days or 30 days, and can be revoked at any time. An expired or revoked link answers `Not found`.
- Downloads through a link are logged as `share:#<id>`.
- Anyone who has the link can use it, so send it the way you would send the files.

## Screenshots in these docs

The screenshots were taken on a throwaway drive. The keys and links in them were masked (`td_••••`, `tds_••••`) before capture.

## Reporting a problem

Please report security issues privately to the maintainers, not in a public issue.
