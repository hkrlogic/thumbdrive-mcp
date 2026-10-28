/**
 * The admin web UI and share links, driven in-process like a browser:
 * cookies are kept per "browser", forms post their CSRF token.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Hono } from "hono";
import { createApp } from "../src/http/app.ts";
import type { Drive } from "../src/storage/drive.ts";
import { hashPassword, verifyPasswordHash } from "../src/web/auth.ts";
import { ShareStore } from "../src/web/shares.ts";
import { connectionSnippets } from "../src/web/snippets.ts";
import { keysFor, tempDrive, testConfig, text } from "./helpers.ts";
import { xlsx } from "./xlsx.ts";

const PASSWORD = "correct horse battery";

/** A minimal browser: a cookie jar, Host header, and helpers to post forms with the page's CSRF token. */
class Browser {
  cookies = new Map<string, string>();
  lastSetCookies: string[] = [];
  constructor(
    private readonly app: Hono,
    private readonly host = "localhost:8484",
  ) {}

  async fetch(pathname: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { host: this.host, ...init.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await this.app.request(`http://${this.host}${pathname}`, { method: init.method ?? "GET", headers, body: init.body });
    this.lastSetCookies = res.headers.getSetCookie();
    for (const line of this.lastSetCookies) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  async page(pathname: string): Promise<{ status: number; html: string; csrf: string; res: Response }> {
    const res = await this.fetch(pathname);
    const html = await res.text();
    return { status: res.status, html, csrf: html.match(/<meta name="csrf" content="([^"]+)"/)?.[1] ?? "", res };
  }

  /** Load `from` for a CSRF token (unless given), then POST the form to `to`. */
  async post(
    to: string,
    fields: Record<string, string | string[] | Blob>,
    opts: { csrf?: string | null; from?: string; headers?: Record<string, string>; files?: Array<[string, Blob, string]> } = {},
  ) {
    const csrf = opts.csrf === undefined ? (await this.page(opts.from ?? "/")).csrf : opts.csrf;
    const form = new FormData();
    if (csrf !== null) form.set("_csrf", csrf);
    for (const [k, v] of Object.entries(fields)) {
      for (const item of Array.isArray(v) ? v : [v]) form.append(k, item);
    }
    for (const [k, blob, name] of opts.files ?? []) form.append(k, blob, name);
    return this.fetch(to, { method: "POST", body: form, headers: opts.headers });
  }
}

function setup(options: { maxFileBytes?: number } = {}) {
  const drive = tempDrive(options);
  const keys = keysFor(drive);
  const config = testConfig(drive, options.maxFileBytes ? { maxFileBytes: options.maxFileBytes } : {});
  const created = createApp({ drive, keys, config });
  after(() => created.close());
  return { drive, keys, config, ...created, shares: new ShareStore(drive.db) };
}

async function signedIn(app: Hono): Promise<Browser> {
  const b = new Browser(app);
  const setupPage = await b.page("/setup");
  const res = await b.post("/setup", { password: PASSWORD, confirm: PASSWORD }, { csrf: setupPage.csrf });
  assert.equal(res.status, 303, "setup should succeed");
  return b;
}

const flashOf = async (b: Browser, location: string | null) => (await b.page(location ?? "/")).html;

// ---------- auth ----------

test("scrypt password hashes verify and do not store the password", async () => {
  const stored = await hashPassword(PASSWORD);
  assert.match(stored, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!stored.includes(PASSWORD));
  assert.equal(await verifyPasswordHash(PASSWORD, stored), true);
  assert.equal(await verifyPasswordHash("wrong password", stored), false);
});

test("first run sends everyone to setup, and setup can only be done once", async () => {
  const { app, drive } = setup();
  const b = new Browser(app);
  for (const p of ["/", "/files", "/keys"]) {
    const res = await b.fetch(p);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/setup");
  }
  const page = await b.page("/setup");
  assert.equal(page.status, 200);
  assert.ok(page.csrf);

  const mismatch = await b.post("/setup", { password: PASSWORD, confirm: "something else" }, { csrf: page.csrf });
  assert.equal(mismatch.status, 400);
  const short = await b.post("/setup", { password: "short", confirm: "short" }, { csrf: page.csrf });
  assert.equal(short.status, 400);

  const ok = await b.post("/setup", { password: PASSWORD, confirm: PASSWORD }, { csrf: page.csrf });
  assert.equal(ok.status, 303);
  const session = b.lastSetCookies.find((c) => c.startsWith("td_session="));
  assert.ok(session);
  assert.match(session, /HttpOnly/i);
  assert.match(session, /SameSite=Strict/i);
  assert.doesNotMatch(session, /Secure/i, "plain-HTTP LAN cookies cannot be Secure");

  const stored = drive.db.prepare("SELECT value FROM settings WHERE name = 'admin_password'").get() as { value: string };
  assert.match(stored.value, /^scrypt\$/);

  // A second visitor cannot claim the drive again.
  const other = new Browser(app);
  const again = await other.page("/setup");
  assert.equal(again.res.status, 303);
  const { csrf: otherCsrf } = await other.page("/login");
  const takeover = await other.post("/setup", { password: "attacker password", confirm: "attacker password" }, { csrf: otherCsrf });
  assert.equal(takeover.status, 303);
  assert.equal(takeover.headers.get("location"), "/login");
  assert.equal(other.cookies.has("td_session"), false);
});

test("the session cookie is Secure behind an HTTPS proxy", async () => {
  const { app } = setup();
  const b = new Browser(app);
  const page = await b.page("/setup");
  await b.post("/setup", { password: PASSWORD, confirm: PASSWORD }, { csrf: page.csrf, headers: { "x-forwarded-proto": "https" } });
  assert.match(b.lastSetCookies.find((c) => c.startsWith("td_session=")) ?? "", /Secure/);
});

test("login, wrong passwords, rate limiting and logout", async () => {
  const { app } = setup();
  await signedIn(app);
  const b = new Browser(app);

  const unauth = await b.fetch("/keys");
  assert.equal(unauth.status, 303);
  assert.equal(unauth.headers.get("location"), "/login?next=%2Fkeys");

  const login = await b.page("/login?next=/keys");
  const wrong = await b.post("/login", { password: "nope nope", next: "/keys" }, { csrf: login.csrf });
  assert.equal(wrong.status, 401);
  assert.equal(b.cookies.has("td_session"), false);

  const right = await b.post("/login", { password: PASSWORD, next: "/keys" }, { csrf: login.csrf });
  assert.equal(right.status, 303);
  assert.equal(right.headers.get("location"), "/keys");
  assert.equal((await b.page("/keys")).status, 200);

  // Open redirects are refused.
  const c = new Browser(app);
  const lp = await c.page("/login");
  const evil = await c.post("/login", { password: PASSWORD, next: "//evil.example/" }, { csrf: lp.csrf });
  assert.equal(evil.headers.get("location"), "/");

  // Logout ends the server-side session: the old cookie stops working.
  const oldCookie = b.cookies.get("td_session") as string;
  const out = await b.post("/logout", {}, { from: "/keys" });
  assert.equal(out.status, 303);
  const replay = new Browser(app);
  replay.cookies.set("td_session", oldCookie);
  assert.equal((await replay.fetch("/keys")).status, 303);

  // Ten failures lock the client out, even for the right password.
  const d = new Browser(app);
  const dp = await d.page("/login");
  for (let i = 0; i < 10; i++) await d.post("/login", { password: `guess ${i} xx` }, { csrf: dp.csrf });
  const locked = await d.post("/login", { password: PASSWORD }, { csrf: dp.csrf });
  assert.equal(locked.status, 429);
  assert.equal(d.cookies.has("td_session"), false);
});

test("changing the password signs out other sessions", async () => {
  const { app } = setup();
  const a = await signedIn(app);
  const b = new Browser(app);
  const lp = await b.page("/login");
  await b.post("/login", { password: PASSWORD }, { csrf: lp.csrf });
  assert.equal((await b.page("/")).status, 200);
  const res = await a.post(
    "/settings/password",
    { current: PASSWORD, password: "a brand new password", confirm: "a brand new password" },
    { from: "/settings" },
  );
  assert.equal(res.status, 303);
  assert.equal((await a.page("/")).status, 200, "the browser that changed it stays signed in");
  assert.equal((await b.fetch("/")).status, 303, "other browsers are signed out");
});

test("THUMBDRIVE_ADMIN_PASSWORD sets the password without the setup page", async () => {
  const { app, auth } = setup();
  assert.equal(await auth.applyEnvPassword("from the environment"), true);
  assert.equal(await auth.applyEnvPassword("from the environment"), false, "unchanged on the next start");
  const b = new Browser(app);
  assert.equal((await b.fetch("/")).headers.get("location"), "/login");
  const lp = await b.page("/login");
  assert.equal((await b.post("/login", { password: "from the environment" }, { csrf: lp.csrf })).status, 303);
});

// ---------- CSRF ----------

test("every POST needs a CSRF token bound to this session and a same-origin request", async () => {
  const { app, drive } = setup();
  const b = await signedIn(app);
  const { csrf } = await b.page("/files");

  const missing = await b.post("/files/mkdir", { dir: "/", name: "a" }, { csrf: null });
  assert.equal(missing.status, 403);
  const forged = await b.post("/files/mkdir", { dir: "/", name: "b" }, { csrf: "forged-token" });
  assert.equal(forged.status, 403);

  // A token from another session does not work here.
  const other = new Browser(app);
  const lp = await other.page("/login");
  await other.post("/login", { password: PASSWORD }, { csrf: lp.csrf });
  const otherCsrf = (await other.page("/files")).csrf;
  assert.notEqual(otherCsrf, csrf);
  assert.equal((await b.post("/files/mkdir", { dir: "/", name: "c" }, { csrf: otherCsrf })).status, 403);

  // Cross-site requests are refused even with a valid token.
  const crossSite = await b.post("/files/mkdir", { dir: "/", name: "d" }, { csrf, headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  const crossOrigin = await b.post("/files/mkdir", { dir: "/", name: "e" }, { csrf, headers: { origin: "http://192.168.1.50:8484" } });
  assert.equal(crossOrigin.status, 403);
  const evilOrigin = await b.post("/files/mkdir", { dir: "/", name: "f" }, { csrf, headers: { origin: "https://evil.example" } });
  assert.equal(evilOrigin.status, 403);
  for (const name of ["a", "b", "c", "d", "e", "f"]) assert.equal(drive.kind(`/${name}`), null);

  // The same request from the page itself works (form field or header).
  const good = await b.post("/files/mkdir", { dir: "/", name: "ok" }, { csrf, headers: { origin: "http://localhost:8484", "sec-fetch-site": "same-origin" } });
  assert.equal(good.status, 303);
  assert.equal(drive.kind("/ok"), "folder");
  const viaHeader = await b.post("/files/mkdir", { dir: "/", name: "ok2" }, { csrf: null, headers: { "x-csrf-token": csrf } });
  assert.equal(viaHeader.status, 303);
  assert.equal(drive.kind("/ok2"), "folder");

  // Login and setup are protected too (login CSRF).
  const fresh = new Browser(app);
  assert.equal((await fresh.post("/login", { password: PASSWORD }, { csrf: null })).status, 403);
});

test("pages send a strict CSP and refuse to be framed", async () => {
  const { app } = setup();
  const b = await signedIn(app);
  const { res } = await b.page("/");
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  // no-referrer would make browsers send "Origin: null" on form POSTs and break every form.
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("the UI keeps the Host allow-list from /mcp", async () => {
  const { app } = setup();
  const b = new Browser(app, "evil.example");
  assert.equal((await b.fetch("/setup")).status, 403);
});

// ---------- files ----------

test("upload, download, move, delete and restore through the UI", async () => {
  const { app, drive } = setup();
  const b = await signedIn(app);
  drive.makeFolder("/docs");
  const { csrf } = await b.page("/files?path=/docs");

  const up = await b.post(
    "/files/upload",
    { dir: "/docs" },
    { csrf, files: [["file", new Blob([text("one")]), "a.txt"], ["file", new Blob([text("<script>alert(1)</script>")]), "page.html"]] },
  );
  assert.equal(up.status, 303);
  assert.equal(drive.readFile("/docs/a.txt").bytes.toString(), "one");

  // Drag-and-drop sends one file at a time with its relative folder path, and wants JSON.
  const dnd = await b.post(
    "/files/upload",
    { dir: "/docs", relpath: "nested/deeper/b.txt" },
    { csrf: null, headers: { "x-csrf-token": csrf, accept: "application/json" }, files: [["file", new Blob([text("bee")]), "b.txt"]] },
  );
  assert.equal(dnd.status, 200);
  assert.deepEqual(await dnd.json(), { ok: true, saved: [{ path: "/docs/nested/deeper/b.txt", version: 1 }], path: "/docs/nested/deeper/b.txt", version: 1 });

  // Downloads are attachments that cannot run in this origin.
  const dl = await b.fetch("/files/download?path=/docs/page.html");
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "application/octet-stream");
  assert.match(dl.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.match(dl.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(await dl.text(), "<script>alert(1)</script>");

  // A new upload of the same name is a new version, and old versions can be restored.
  await b.post("/files/upload", { dir: "/docs" }, { csrf, files: [["file", new Blob([text("two")]), "a.txt"]] });
  assert.equal(drive.readFile("/docs/a.txt").version, 2);
  assert.equal(await (await b.fetch("/files/download?path=/docs/a.txt&version=1")).text(), "one");
  await b.post("/files/restore", { path: "/docs/a.txt", version: "1" }, { csrf });
  assert.equal(drive.readFile("/docs/a.txt").bytes.toString(), "one");
  assert.equal(drive.readFile("/docs/a.txt").version, 3);

  // Rename in place, then delete and restore.
  const mv = await b.post("/files/move", { path: "/docs/a.txt", to: "renamed.txt" }, { csrf });
  assert.equal(mv.status, 303);
  assert.equal(drive.kind("/docs/a.txt"), null);
  assert.equal(drive.readFile("/docs/renamed.txt").bytes.toString(), "one");
  await b.post("/files/delete", { path: "/docs/renamed.txt" }, { csrf });
  assert.equal(drive.kind("/docs/renamed.txt"), null);
  const folderPage = await b.page("/files?path=/docs");
  assert.match(folderPage.html, /Deleted from this folder/);
  const hist = drive.history("/docs/renamed.txt");
  await b.post("/files/restore", { path: "/docs/renamed.txt", version: String(hist.find((v) => v.action === "put")?.version) }, { csrf });
  assert.equal(drive.kind("/docs/renamed.txt"), "file");

  // Folder delete keeps every file's history.
  const del = await b.post("/files/delete", { path: "/docs/nested" }, { csrf });
  assert.equal(del.status, 303);
  assert.equal(drive.kind("/docs/nested"), null);
  assert.equal(drive.history("/docs/nested/deeper/b.txt").length, 2);
  // ...and its files stay findable: the parent lists them for restore.
  const afterDel = await b.page("/files?path=/docs");
  assert.match(afterDel.html, /nested\/deeper\/b\.txt/);
  assert.match(afterDel.html, /href="\/files\/file\?path=%2Fdocs%2Fnested%2Fdeeper%2Fb\.txt"/);

  // The file page and history render, escaping names.
  drive.putFile("/docs/<b>odd</b>.txt", text("x"));
  const filePage = await b.page(`/files/file?path=${encodeURIComponent("/docs/<b>odd</b>.txt")}`);
  assert.equal(filePage.status, 200);
  assert.ok(!filePage.html.includes("<b>odd</b>"));
  assert.ok(filePage.html.includes("&lt;b&gt;odd&lt;/b&gt;"));
});

test("uploads cannot escape their folder, follow symlinks, or exceed the size limit", async () => {
  const { app, drive } = setup({ maxFileBytes: 1024 });
  const b = await signedIn(app);
  drive.makeFolder("/docs");
  drive.putFile("/private/secret.txt", text("secret"));
  const outside = mkdtempSync(path.join(tmpdir(), "thumbdrive-outside-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(drive.filesDir, "docs", "link"));
  mkdirSync(path.join(outside, "sub"));
  const { csrf } = await b.page("/files?path=/docs");
  const json = { "x-csrf-token": csrf, accept: "application/json" };
  const upload = (fields: Record<string, string>, name = "x.txt", body = "data") =>
    b.post("/files/upload", fields, { csrf: null, headers: json, files: [["file", new Blob([text(body)]), name]] });

  for (const relpath of ["../private/secret.txt", "../../etc/passwd", "a/../../x.txt", "..\\x.txt", "a\u0000b"]) {
    const res = await upload({ dir: "/docs", relpath });
    assert.equal(res.status, 400, relpath);
  }
  assert.equal(drive.readFile("/private/secret.txt").bytes.toString(), "secret");

  // A file name with path parts is treated relative to the folder, never absolute.
  const abs = await upload({ dir: "/docs", relpath: "/private/secret.txt" }, "secret.txt", "overwrite?");
  assert.equal(abs.status, 200);
  assert.equal(drive.readFile("/private/secret.txt").bytes.toString(), "secret");
  assert.equal(drive.readFile("/docs/private/secret.txt").bytes.toString(), "overwrite?");

  // Bad target folders and symlinks are refused.
  assert.equal((await upload({ dir: "/../private" })).status, 400);
  assert.equal((await upload({ dir: "/docs/link" })).status, 400);
  assert.equal((await upload({ dir: "/docs", relpath: "link/sub/x.txt" })).status, 400);
  assert.equal((await upload({ dir: "/docs", relpath: "link/x.txt" })).status, 400);
  assert.equal(existsSync(path.join(outside, "x.txt")), false);
  assert.equal(existsSync(path.join(outside, "sub", "x.txt")), false);

  // Too large.
  const big = await upload({ dir: "/docs" }, "big.bin", "x".repeat(2048));
  assert.equal(big.status, 400);
  assert.match(((await big.json()) as { error: string }).error, /limit/);
  assert.equal(drive.kind("/docs/big.bin"), null);

  // Signed-out uploads are refused.
  const anon = new Browser(app);
  const anonRes = await anon.post("/files/upload", { dir: "/docs" }, { csrf: null, files: [["file", new Blob([text("x")]), "anon.txt"]] });
  assert.equal(anonRes.status, 403);
  assert.equal(drive.kind("/docs/anon.txt"), null);
});

test("moving a folder keeps keys and share links pointing at it", async () => {
  const { app, drive, keys, shares } = setup();
  const b = await signedIn(app);
  drive.putFile("/docs/guide.md", text("# guide"));
  const { key } = keys.create("agent", ["/docs"]);
  const { token } = shares.create("/docs", 24);
  const res = await b.post("/files/move", { path: "/docs", to: "/manuals" }, { from: "/files" });
  assert.equal(res.status, 303);
  assert.equal(drive.kind("/docs"), null);
  assert.equal(drive.readFile("/manuals/guide.md").bytes.toString(), "# guide");
  assert.deepEqual(keys.verify(key)?.folders, ["/manuals"]);
  assert.equal(shares.verify(token)?.folder, "/manuals");
});

// ---------- keys ----------

async function mcpList(base: string, key: string, dir: string): Promise<{ isError?: boolean; text: string }> {
  const client = new Client({ name: "web-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  try {
    const result = await client.callTool({ name: "list", arguments: { path: dir } });
    const content = result.content as Array<{ type: string; text: string }>;
    return { isError: result.isError as boolean | undefined, text: content.map((c) => c.text).join("\n") };
  } finally {
    await client.close();
  }
}

test("keys created and edited in the UI are scoped to their folders over MCP", async () => {
  const { app, drive, keys } = setup();
  drive.putFile("/docs/guide.md", text("guide"));
  drive.putFile("/private/secret.txt", text("secret"));
  const b = await signedIn(app);

  const empty = await b.post("/keys", { name: "no-folders" }, { from: "/keys" });
  assert.equal(empty.status, 400);

  const res = await b.post("/keys", { name: "laptop", folders: ["/docs"] }, { from: "/keys" });
  assert.equal(res.status, 200);
  const html = await res.text();
  const token = html.match(/td_[A-Za-z0-9_-]{20,}/)?.[0];
  assert.ok(token, "the new key is shown once");
  assert.match(html, /http:\/\/localhost:8484\/mcp/);
  assert.match(html, /mcp-remote/);
  assert.match(html, /Authorization:\$\{AUTH_HEADER\}/);
  assert.match(html, /claude mcp add --transport http/);
  assert.equal((await b.page("/keys")).html.includes(token), false, "and never again");

  const record = keys.verify(token);
  assert.deepEqual(record?.folders, ["/docs"]);

  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assert.match((await mcpList(base, token, "/docs")).text, /guide\.md/);
  const denied = await mcpList(base, token, "/private");
  assert.ok(denied.isError || !denied.text.includes("secret.txt"));

  // Edit the folders: now /private only.
  const edit = await b.post(`/keys/${record?.id}/folders`, { folders: ["/private"] }, { from: "/keys" });
  assert.equal(edit.status, 303);
  assert.deepEqual(keys.verify(token)?.folders, ["/private"]);
  assert.match((await mcpList(base, token, "/private")).text, /secret\.txt/);
  const nowDenied = await mcpList(base, token, "/docs");
  assert.ok(nowDenied.isError || !nowDenied.text.includes("guide.md"));

  // An edit with no folders is refused and changes nothing.
  await b.post(`/keys/${record?.id}/folders`, {}, { from: "/keys" });
  assert.deepEqual(keys.verify(token)?.folders, ["/private"]);

  // Revoke.
  const revoke = await b.post(`/keys/${record?.id}/revoke`, {}, { from: "/keys" });
  assert.equal(revoke.status, 303);
  assert.equal(keys.verify(token), undefined);
  const after401 = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(after401.status, 401);

  // Admin changes are in the activity log; agent reads are the default view.
  const activity = await b.page("/activity?all=1");
  assert.match(activity.html, /<td>key\.create<\/td>/);
  assert.match(activity.html, /<td>key\.revoke<\/td>/);
  const agentsOnly = await b.page("/activity");
  assert.doesNotMatch(agentsOnly.html, /<td>key\.create<\/td>/);
  assert.match(agentsOnly.html, /<td>list<\/td><td class="mono">\/docs<\/td>/);
  const filtered = await b.page("/activity?path=private");
  assert.doesNotMatch(filtered.html, /<td class="mono">\/docs<\/td>/);
  assert.match(filtered.html, /<td class="mono">\/private<\/td>/);
});

test("key routes need a session", async () => {
  const { app, keys } = setup();
  await signedIn(app);
  const { record } = keys.create("agent", ["/"]);
  const anon = new Browser(app);
  const page = await anon.page("/login");
  const res = await anon.post(`/keys/${record.id}/revoke`, {}, { csrf: page.csrf });
  assert.notEqual(res.status, 200);
  assert.equal(res.headers.get("location"), "/login");
  assert.equal(keys.get(record.id)?.revoked_at, null);
});

// ---------- share links ----------

test("share links: created in the UI, read-only, confined to their folder", async () => {
  const { app, drive, shares } = setup();
  drive.putFile("/docs/guide.md", text("guide"));
  drive.putFile("/docs/sub/deep.txt", text("deep"));
  drive.putFile("/private/secret.txt", text("secret"));
  const b = await signedIn(app);

  const res = await b.post("/shares", { folder: "/docs", hours: "24", label: "for Sam" }, { from: "/shares" });
  assert.equal(res.status, 200);
  const html = await res.text();
  const url = html.match(/http:\/\/localhost:8484\/s\/(tds_[A-Za-z0-9_-]+)/);
  assert.ok(url, "the link is shown once");
  const token = url[1];

  // Only the hash is stored.
  const rows = drive.db.prepare("SELECT * FROM share_links").all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(token));
  const record = shares.verify(token);
  assert.ok(record);
  const hours = (Date.parse(record.expires_at) - Date.parse(record.created_at)) / 3600_000;
  assert.equal(hours, 24);

  // Anyone with the link can browse and download, without signing in.
  const anon = new Browser(app);
  const listing = await anon.page(`/s/${token}`);
  assert.equal(listing.status, 200);
  assert.match(listing.html, /guide\.md/);
  assert.doesNotMatch(listing.html, /secret/);
  // Share links stay out of search engines.
  assert.match(listing.html, /<meta name="robots" content="noindex, nofollow"/);
  const guide = await anon.fetch(`/s/${token}/download?path=/guide.md`);
  assert.equal(guide.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(await guide.text(), "guide");
  assert.equal(await (await anon.fetch(`/s/${token}/download?path=/sub/deep.txt`)).text(), "deep");
  assert.equal(shares.get(record.id)?.downloads, 2);

  // Nothing outside the folder.
  for (const p of ["/../private/secret.txt", "../private/secret.txt", "/sub/../../private/secret.txt", "%2e%2e/private/secret.txt"]) {
    const r = await anon.fetch(`/s/${token}/download?path=${encodeURIComponent(p)}`);
    assert.equal(r.status, 404, p);
  }
  assert.equal((await anon.fetch(`/s/${token}?path=${encodeURIComponent("/../private")}`)).status, 404);
  assert.equal((await anon.fetch(`/s/${token}/download?path=/sub`)).status, 404);

  // A share link opens nothing in the admin UI, and cannot write.
  assert.equal((await anon.fetch("/files")).status, 303);
  assert.equal((await anon.fetch(`/s/${token}`, { method: "POST" })).status, 403);

  // Wrong or truncated tokens.
  assert.equal((await anon.fetch(`/s/${token.slice(0, -2)}`)).status, 404);
  assert.equal((await anon.fetch("/s/td_notashare")).status, 404);

  // Downloads are logged with the link, not a key.
  const activity = drive.queryActivity({ actor: `share:#${record.id}` });
  assert.equal(activity.length, 2);

  // Revoke in the UI: the link stops working at once.
  const revoke = await b.post(`/shares/${record.id}/revoke`, {}, { from: "/shares" });
  assert.equal(revoke.status, 303);
  assert.equal((await anon.fetch(`/s/${token}`)).status, 404);
  assert.equal((await anon.fetch(`/s/${token}/download?path=/guide.md`)).status, 404);
  assert.match((await b.page("/shares")).html, /Expired and revoked \(1\)/);
});

test("share links expire, default to 24 hours and only accept the offered expiries", async () => {
  const { app, drive, shares } = setup();
  drive.putFile("/docs/a.txt", text("a"));
  const b = await signedIn(app);
  const now = Date.now();

  const { token, record } = shares.create("/docs", 1, "", now);
  assert.ok(shares.verify(token, now + 59 * 60_000));
  assert.equal(shares.verify(token, now + 61 * 60_000), undefined);

  const old = shares.create("/docs", 1, "", now - 2 * 3600_000);
  const anon = new Browser(app);
  assert.equal((await anon.fetch(`/s/${old.token}`)).status, 404);
  assert.equal((await anon.fetch(`/s/${old.token}/download?path=/a.txt`)).status, 404);
  assert.equal((await anon.fetch(`/s/${token}`)).status, 200);
  assert.ok(shares.listActive().some((s) => s.id === record.id));
  assert.ok(shares.listInactive().some((s) => s.id === old.record.id));

  const page = await b.page("/shares?folder=/docs");
  assert.match(page.html, /<option value="24" selected="">1 day<\/option>/);

  const bad = await b.post("/shares", { folder: "/docs", hours: "100000" }, { from: "/shares" });
  assert.equal(bad.status, 303);
  assert.match(await flashOf(b, bad.headers.get("location")), /Pick one of the offered expiry times/);
  const missing = await b.post("/shares", { folder: "/nope", hours: "24" }, { from: "/shares" });
  assert.equal(missing.status, 303);
  assert.equal(shares.listActive().filter((s) => s.folder === "/nope").length, 0);
});

// ---------- dashboard ----------

test("the dashboard shows the MCP URL, counts and the public URL when set", async () => {
  const drive: Drive = tempDrive();
  const keys = keysFor(drive);
  drive.putFile("/a/b.txt", text("hello"));
  keys.create("agent", ["/"]);
  const config = testConfig(drive, { publicUrl: "https://drive.example.com" });
  const { app, close } = createApp({ drive, keys, config });
  after(() => close());
  const b = new Browser(app, "drive.example.com");
  const page = await b.page("/setup");
  await b.post("/setup", { password: PASSWORD, confirm: PASSWORD }, { csrf: page.csrf, headers: { "x-forwarded-proto": "https" } });
  const dash = await b.page("/");
  assert.equal(dash.status, 200);
  assert.match(dash.html, /https:\/\/drive\.example\.com\/mcp/);
  assert.match(dash.html, /<span class="value">1<\/span><span class="label">Files<\/span>/);
  assert.match(dash.html, /<span class="value">1<\/span><span class="label">Active keys<\/span>/);
});

test("connection snippets use the real URL and add --allow-http only for plain HTTP off this machine", () => {
  const find = (url: string, id: string) => connectionSnippets(url, "td_abc").find((s) => s.id === id)?.code ?? "";
  const lan = JSON.parse(find("http://192.168.1.20:8484/mcp", "claude"));
  assert.deepEqual(lan.mcpServers.thumbdrive.args, [
    "-y",
    "mcp-remote",
    "http://192.168.1.20:8484/mcp",
    "--header",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal mcp-remote syntax
    "Authorization:${AUTH_HEADER}",
    "--allow-http",
  ]);
  assert.equal(lan.mcpServers.thumbdrive.env.AUTH_HEADER, "Bearer td_abc");
  assert.ok(!JSON.parse(find("http://localhost:8484/mcp", "claude")).mcpServers.thumbdrive.args.includes("--allow-http"));
  assert.ok(!JSON.parse(find("https://drive.example.com/mcp", "claude")).mcpServers.thumbdrive.args.includes("--allow-http"));
  const cursor = JSON.parse(find("https://drive.example.com/mcp", "cursor"));
  assert.deepEqual(cursor.mcpServers.thumbdrive, { url: "https://drive.example.com/mcp", headers: { Authorization: "Bearer td_abc" } });
});

// ---------- CyberDrive datasets ----------

function ouiFixture(rows: Array<[string, string]>): Blob {
  const dir = mkdtempSync(path.join(tmpdir(), "oui-fx-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "master_oui.db");
  const db = new DatabaseSync(file);
  const cols = "oui, manufacturer, registry, short_name, device_type, registered_date, address, sources, status, deregistered_date";
  db.exec(`CREATE TABLE oui_registry (${cols.split(", ").map((c) => `${c} TEXT`).join(", ")})`);
  const insert = db.prepare("INSERT INTO oui_registry (oui, manufacturer, registry, status) VALUES (?, ?, 'MA-L', 'current')");
  for (const [oui, m] of rows) insert.run(oui, m);
  db.close();
  return new Blob([readFileSync(file)]);
}

test("OUI database page: upload imports a new version, bad files are rejected, CSRF is required", async () => {
  const { app, datasets } = setup();
  const b = await signedIn(app);
  const empty = await b.page("/datasets/oui");
  assert.equal(empty.status, 200);
  assert.match(empty.html, /Not imported yet/);
  assert.match(empty.html, /Refresh from source/);
  assert.match(empty.html, /href="\/datasets\/oui"/, "nav links the page");

  const up = await b.post("/datasets/oui/import", {}, { from: "/datasets/oui", files: [["file", ouiFixture([["00:00:0C", "Cisco"]]), "master_oui.db"]] });
  assert.equal(up.status, 303);
  const after1 = await flashOf(b, up.headers.get("location"));
  assert.match(after1, /Imported version 1: 1 rows/);
  assert.match(after1, /upload:master_oui.db/);
  assert.equal(datasets.current("oui")?.version, 1);

  const bad = await b.post("/datasets/oui/import", {}, { from: "/datasets/oui", files: [["file", new Blob([text("nope")]), "x.db"]] });
  assert.match(await flashOf(b, bad.headers.get("location")), /Not a SQLite database file/);
  assert.equal(datasets.current("oui")?.version, 1);

  const forged = await b.post("/datasets/oui/import", {}, { csrf: "forged", files: [["file", ouiFixture([["00:00:0C", "X"]]), "a.db"]] });
  assert.equal(forged.status, 403);
  assert.equal((await b.fetch("/datasets/nope")).status, 404);
});

test("Windows events page imports the Microsoft workbook and counts events", async () => {
  const { app, datasets, keys } = setup();
  const b = await signedIn(app);
  const empty = await b.page("/datasets/winevent");
  assert.equal(empty.status, 200);
  assert.match(empty.html, /Not imported yet/);
  assert.match(empty.html, /Refresh from source/);
  assert.match(empty.html, /href="\/datasets\/winevent"/);
  const book = xlsx({
    "Security Audit Events": [
      ["Category", "Subcategory", "Event ID", "Message Summary", "Minimum Operating System Requirement"],
      ["Logon/Logoff", "Logon", 4624, "An account was successfully logged on.", "Windows Vista"],
    ],
    "Complete Event Messages": [
      ["Event ID", "Version", "Detailed Message", "Minimum Operating System Requirement"],
      [4624, 0, "An account was successfully logged on.", "Windows Vista"],
    ],
  });
  const up = await b.post("/datasets/winevent/import", {}, { from: "/datasets/winevent", files: [["file", new Blob([new Uint8Array(book)]), "WindowsSecurityAuditEvents.xlsx"]] });
  assert.equal(up.status, 303);
  assert.match(await flashOf(b, up.headers.get("location")), /Imported version 1: 1 events/);
  assert.equal(datasets.current("winevent")?.rows, 1);
  const bad = await b.post("/datasets/winevent/import", {}, { from: "/datasets/winevent", files: [["file", new Blob([text("nope")]), "x.xlsx"]] });
  assert.match(await flashOf(b, bad.headers.get("location")), /xlsx/i);
  const page = await b.page("/keys");
  assert.match(page.html, /name="datasets" value="winevent"/);
  await b.post("/keys", { name: "win-agent", datasets: "winevent" }, { from: "/keys" });
  assert.deepEqual(keys.list().find((k) => k.name === "win-agent")?.datasets, ["winevent"]);
});

test("dataset uploads have their own size limit", async () => {
  const drive = tempDrive();
  const keys = keysFor(drive);
  const { app, close } = createApp({ drive, keys, config: testConfig(drive, { datasetMaxBytes: 4096 }) });
  after(() => close());
  const b = await signedIn(app);
  const res = await b.post("/datasets/oui/import", {}, { from: "/datasets/oui", files: [["file", new Blob([new Uint8Array(64 * 1024 + 2 * 1024 * 1024)]), "big.db"]] });
  assert.equal(res.status, 413);
  assert.match(await res.text(), /DATASET_MAX_MB/);
});

test("keys page grants datasets, and the grant reaches MCP", async () => {
  const { app, keys } = setup();
  const b = await signedIn(app);
  const page = await b.page("/keys");
  assert.match(page.html, /name="datasets" value="oui"/);
  const res = await b.post("/keys", { name: "cyber-agent", datasets: "oui" }, { from: "/keys" });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /cyberdrive:oui/);
  const record = keys.list().find((k) => k.name === "cyber-agent");
  assert.deepEqual(record?.datasets, ["oui"]);
  assert.deepEqual(record?.folders, []);
  const edit = await b.post(`/keys/${record?.id}/folders`, { folders: "/" }, { from: "/keys" });
  assert.equal(edit.status, 303);
  assert.deepEqual(keys.get(record?.id ?? 0)?.datasets, [], "unchecked datasets are removed");
});
