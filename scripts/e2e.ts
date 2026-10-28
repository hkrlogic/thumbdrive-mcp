/**
 * End-to-end check of a running server, the way a user and an agent use it:
 * web UI over HTTP (setup, login, CSRF, folders, uploads, keys, share links,
 * password change, the CyberDrive dataset pages: OUI, Windows events, NIST
 * SP 800-53, CSF 2.0 and the CSF map), MCP over Streamable HTTP with the official SDK client, and
 * the Host-header guard. Used by .github/workflows/deploy-qa.yml against the
 * published image, and runnable against a local server.
 *
 *   tsx scripts/e2e.ts <base-url> <phase>
 *
 * Phases:
 *   first-run      fresh drive, no password: /setup flow, then the full check
 *   env-password   THUMBDRIVE_ADMIN_PASSWORD is set: no setup, login works
 *   after-restart  same drive after a restart: data, keys, links survived
 *
 * Env: TD_ADMIN_PASSWORD (required), TD_STATE (state file, default
 * ./e2e-state.json), TD_EXEC (command prefix that runs `node` next to the
 * server's DATA_DIR, e.g. "docker exec -i td"; used to age a share link).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { csf2Catalog, csf2MapWorkbook, sp80053Catalog } from "../test/fixtures/controls.ts";
import { xlsx } from "../test/xlsx.ts";

const base = (process.argv[2] ?? "http://127.0.0.1:8484").replace(/\/+$/, "");
const phase = process.argv[3] ?? "first-run";
const password = process.env.TD_ADMIN_PASSWORD ?? "";
const stateFile = process.env.TD_STATE ?? "e2e-state.json";
const exec = (process.env.TD_EXEC ?? "").split(" ").filter(Boolean);
if (password.length < 8) throw new Error("Set TD_ADMIN_PASSWORD (at least 8 characters)");

let failures = 0;
let checks = 0;
function check(ok: unknown, what: string, detail = ""): void {
  checks++;
  if (ok) console.log(`  ok   ${what}`);
  else {
    failures++;
    console.log(`  FAIL ${what}${detail ? ` (${detail})` : ""}`);
  }
}
const section = (name: string) => console.log(`\n## ${name}`);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// ---------- a tiny browser: cookies, CSRF, redirects by hand ----------

class Browser {
  cookies = new Map<string, string>();
  csrf = "";
  async req(path: string, init: RequestInit & { form?: Record<string, string | string[]> } = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    let body = init.body;
    if (init.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(init.form)) for (const x of [v].flat()) p.append(k, x);
      if (!p.has("_csrf")) p.set("_csrf", this.csrf);
      body = p;
    }
    if (init.method === "POST") {
      headers.set("origin", base);
      headers.set("sec-fetch-site", "same-origin");
    }
    const res = await fetch(base + path, { ...init, headers, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (v === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    return res;
  }
  async page(path: string) {
    const res = await this.req(path);
    const html = await res.text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { res, html };
  }
  async post(path: string, form: Record<string, string | string[]>) {
    return this.req(path, { method: "POST", form });
  }
  /** POST, follow one redirect, return the page it lands on. */
  async submit(path: string, form: Record<string, string | string[]>) {
    const res = await this.post(path, form);
    const loc = res.headers.get("location");
    if (res.status === 303 && loc) return { status: res.status, ...(await this.page(new URL(loc, base).pathname + new URL(loc, base).search)) };
    return { status: res.status, res, html: await res.text() };
  }
  async upload(dir: string, files: Array<{ name: string; bytes: Uint8Array }>, relpath = "") {
    const fd = new FormData();
    fd.set("_csrf", this.csrf);
    fd.set("dir", dir);
    if (relpath) fd.set("relpath", relpath);
    for (const f of files) fd.append("file", new Blob([f.bytes as Uint8Array<ArrayBuffer>]), f.name);
    const res = await this.req("/files/upload", { method: "POST", body: fd, headers: { accept: "application/json" } });
    return { status: res.status, json: (await res.json()) as { ok?: boolean; error?: string; saved?: unknown[] } };
  }
}

async function login(b: Browser, pw: string) {
  await b.page("/login");
  const res = await b.post("/login", { password: pw, next: "/" });
  return res.status === 303 && res.headers.get("location") === "/" && b.cookies.has("td_session");
}

// ---------- MCP ----------

type Block = { type: string; text?: string };
async function mcp(key: string) {
  const client = new Client({ name: "thumbdrive-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const blocks = (r.content as Block[]).map((x) => x.text ?? "");
    return { isError: Boolean(r.isError), blocks, meta: r.isError ? undefined : safeJson(blocks[0]) };
  };
  return { client, call };
}
function safeJson(s: string | undefined) {
  try {
    return JSON.parse(s ?? "");
  } catch {
    return undefined;
  }
}
async function mcpStatus(key: string) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }),
  });
  await res.body?.cancel();
  return res.status;
}

/** Raw request with an arbitrary Host header (fetch will not send a custom Host). */
function rawStatus(path: string, host: string, method = "GET"): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: u.port, path, method, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });
}

// ---------- test files ----------

function fixtures() {
  const txt = new TextEncoder().encode("Remote work policy\nWork from anywhere two days a week.\nThumbdrive e2e marker: zebra-42\n");
  const csv = new TextEncoder().encode(
    `region,quarter,revenue\n${Array.from({ length: 450 }, (_, i) => `r${i % 7},Q${(i % 4) + 1},${1000 + i}`).join("\n")}\n`,
  );
  // Real PDFs carry a binary comment line right after the header.
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n%"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]), Buffer.from(
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  )]);
  // A real (tiny) zip container with the xlsx content-types entry name.
  const xlsx = Buffer.concat([
    Buffer.from("504b0304140000000000", "hex"),
    Buffer.alloc(16),
    Buffer.from([19, 0, 0, 0]),
    Buffer.from("[Content_Types].xml"),
    Buffer.from("504b0506000000000000000000000000000000000000", "hex"),
  ]);
  const bin = randomBytes(150_000); // > 2 pages of 64 KiB
  return { txt, csv, pdf: new Uint8Array(pdf), xlsx: new Uint8Array(xlsx), bin: new Uint8Array(bin) };
}

/** A two-row look-alike of master_oui.db (the real one is ~20 MB and GPL-licensed; users import it). */
function ouiFixture(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "td-e2e-oui-"));
  const file = join(dir, "master_oui.db");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE oui_registry (oui TEXT, manufacturer TEXT, registry TEXT, short_name TEXT, device_type TEXT, registered_date TEXT, address TEXT, sources TEXT, status TEXT, deregistered_date TEXT)",
  );
  db.exec(
    "INSERT INTO oui_registry (oui, manufacturer, registry, short_name, status) VALUES ('00:00:0C', 'Cisco', 'MA-L', 'Cisco', 'current'), ('8C:1F:64:AF:A', 'DATA ELECTRONIC DEVICES, INC', 'MA-S', 'DataElectron', 'current')",
  );
  db.close();
  const bytes = new Uint8Array(readFileSync(file));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

type State = {
  key: string;
  scopedKey: string;
  revokedKey: string;
  cyberKey?: string;
  grcKey?: string;
  tablesKey?: string;
  share: string;
  files: Record<string, string>;
};

// ---------- phases ----------

async function common() {
  section("health and Host guard");
  const h = await fetch(`${base}/healthz`);
  const hj = (await h.json()) as { ok?: boolean };
  check(h.status === 200 && hj.ok === true, "GET /healthz -> 200 {ok:true}");
  check((await rawStatus("/", "evil.example")) === 403, "unknown Host on / -> 403");
  check((await rawStatus("/mcp", "evil.example", "POST")) === 403, "unknown Host on /mcp -> 403");
  check((await rawStatus("/s/tds_x", "evil.example")) === 403, "unknown Host on a share link -> 403");
  check((await rawStatus("/healthz", "evil.example")) === 200, "/healthz answers any Host");
}

async function firstRun() {
  await common();
  const b = new Browser();

  section("first run");
  let r = await b.req("/");
  check(r.status === 303 && r.headers.get("location") === "/setup", "GET / -> 303 /setup before a password exists");
  r = await b.req("/login");
  check(r.status === 303 && r.headers.get("location") === "/setup", "GET /login -> /setup before a password exists");
  const p = await b.page("/setup");
  check(p.res.status === 200 && p.html.includes('action="/setup"'), "setup form renders");
  let s = await b.submit("/setup", { password: "short", confirm: "short" });
  check(s.status === 400 && /at least 8/.test(s.html), "short password refused");
  await b.page("/setup");
  s = await b.submit("/setup", { password, confirm: `${password}x` });
  check(s.status === 400 && /do not match/i.test(s.html), "mismatched confirm refused");
  await b.page("/setup");
  const noCsrf = await b.req("/setup", { method: "POST", form: { password, confirm: password, _csrf: "bad" } });
  check(noCsrf.status === 403, "setup POST with a bad CSRF token -> 403");
  const res = await b.post("/setup", { password, confirm: password });
  check(res.status === 303 && b.cookies.has("td_session"), "setup sets the password and signs in");
  r = await b.req("/setup");
  check(r.status === 303, "/setup closed once a password exists");
  const attacker = new Browser();
  await attacker.page("/login");
  const take = await attacker.post("/setup", { password: "attacker-pass", confirm: "attacker-pass" });
  check(take.status !== 303 || !attacker.cookies.has("td_session"), "a second setup cannot take over");

  await full(b);
}

async function envPassword() {
  await common();
  section("THUMBDRIVE_ADMIN_PASSWORD");
  const b = new Browser();
  const r = await b.req("/");
  check(r.status === 303 && r.headers.get("location") === "/login", "GET / -> /login (no setup screen)");
  const s = await b.req("/setup");
  check(s.status === 303, "/setup is closed");
  const wrong = new Browser();
  await wrong.page("/login");
  const w = await wrong.post("/login", { password: "not-the-password", next: "/" });
  check(w.status === 401 && !wrong.cookies.has("td_session"), "wrong password -> 401");
  check(await login(b, password), "login with the env password");
  const set = await b.page("/settings");
  check(set.html.includes("THUMBDRIVE_ADMIN_PASSWORD is set"), "settings warns that the env password wins");
}

async function full(b: Browser) {
  const f = fixtures();

  section("pages");
  for (const path of ["/", "/files", "/keys", "/shares", "/activity", "/settings"]) {
    const { res, html } = await b.page(path);
    const csp = res.headers.get("content-security-policy") ?? "";
    check(res.status === 200 && html.includes("<main") && csp.includes("frame-ancestors 'none'"), `GET ${path} -> 200 with CSP`);
  }
  for (const a of ["/assets/app.css", "/assets/app.js", "/assets/theme.js", "/assets/icon.svg"]) {
    check((await b.req(a)).status === 200, `asset ${a}`);
  }
  const anon = new Browser();
  const an = await anon.req("/files");
  check(an.status === 303 && an.headers.get("location")?.startsWith("/login"), "signed-out /files -> /login");
  const cross = await b.req("/files/mkdir", { method: "POST", form: { dir: "/", name: "x" }, headers: {} });
  check(cross.status === 303, "same-origin form POST accepted (control)");
  const evil = await fetch(`${base}/files/mkdir`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: `td_session=${b.cookies.get("td_session")}`, origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: b.csrf, dir: "/", name: "evil" }),
  });
  check(evil.status === 403, "cross-origin POST -> 403");
  await b.submit("/files/delete", { path: "/x" });

  section("folders and uploads");
  await b.page("/files");
  let s = await b.submit("/files/mkdir", { dir: "/", name: "team" });
  check(s.html.includes("Created /team"), "create /team");
  await b.submit("/files/mkdir", { dir: "/team", name: "docs" });
  await b.submit("/files/mkdir", { dir: "/", name: "private" });
  let u = await b.upload("/team", [
    { name: "policy.txt", bytes: f.txt },
    { name: "sales.csv", bytes: f.csv },
  ]);
  check(u.status === 200 && u.json.saved?.length === 2, "upload two files in one request");
  u = await b.upload("/team", [{ name: "deck.pdf", bytes: f.pdf }], "docs/deck.pdf");
  check(u.status === 200, "folder upload with relpath docs/deck.pdf");
  u = await b.upload("/team", [{ name: "model.xlsx", bytes: f.xlsx }]);
  check(u.status === 200, "upload xlsx");
  u = await b.upload("/team", [{ name: "blob.bin", bytes: f.bin }]);
  check(u.status === 200, "upload 150 KB binary");
  u = await b.upload("/private", [{ name: "secret.txt", bytes: new TextEncoder().encode("top secret\n") }]);
  check(u.status === 200, "upload into /private");
  u = await b.upload("/team", [{ name: "x.txt", bytes: f.txt }], "../escape.txt");
  check(u.status === 400, "relpath escaping the folder refused");
  const v2 = new TextEncoder().encode("Remote work policy v2\nThumbdrive e2e marker: zebra-42\n");
  u = await b.upload("/team", [{ name: "policy.txt", bytes: v2 }]);
  check(u.status === 200, "re-upload policy.txt -> new version");
  const page = await b.page(`/files/file?path=${encodeURIComponent("/team/policy.txt")}`);
  check(page.html.includes("v2") && page.html.includes(sha(v2)), "file page shows v2 and its SHA-256");
  const dl = await b.req(`/files/download?path=${encodeURIComponent("/team/blob.bin")}`);
  const dlBytes = new Uint8Array(await dl.arrayBuffer());
  check(
    dl.headers.get("content-disposition")?.startsWith("attachment") &&
      dl.headers.get("content-security-policy")?.includes("sandbox") &&
      dl.headers.get("x-thumbdrive-sha256") === sha(f.bin) &&
      sha(dlBytes) === sha(f.bin),
    "download is a sandboxed attachment with the right bytes and SHA header",
  );
  s = await b.submit("/files/restore", { path: "/team/policy.txt", version: "1" });
  check(/Restored/.test(s.html), "restore v1 -> v3");
  s = await b.submit("/files/move", { path: "/team/model.xlsx", to: "forecast.xlsx" });
  check(s.html.includes("forecast.xlsx"), "rename a file");
  s = await b.submit("/files/move", { path: "/team/docs/deck.pdf", to: "/team/deck.pdf" });
  check((await b.page("/files?path=%2Fteam")).html.includes("deck.pdf"), "move a file");
  await b.upload("/team", [{ name: "tmp.txt", bytes: new TextEncoder().encode("temp\n") }]);
  s = await b.submit("/files/delete", { path: "/team/tmp.txt" });
  check(/Deleted/.test(s.html), "delete a file");
  check((await b.page("/files?path=%2Fteam")).html.includes("Deleted from this folder"), "deleted file listed for restore");
  s = await b.submit("/files/restore", { path: "/team/tmp.txt", version: "1" });
  check(/Restored/.test(s.html), "restore a deleted file");
  await b.submit("/files/delete", { path: "/team/tmp.txt" });

  section("agent keys");
  let kp = await b.page("/keys");
  let k = await b.submit("/keys", { name: "e2e-team", folders: ["/team"] });
  const scopedKey = k.html.match(/td_[A-Za-z0-9_-]{43}/)?.[0] ?? "";
  check(scopedKey && k.html.includes("Claude Desktop") && k.html.includes("mcp-remote"), "create a /team key; snippets shown");
  check(k.html.includes(`${base}/mcp`), "snippets use the server URL");
  kp = await b.page("/keys");
  check(!kp.html.includes(scopedKey), "key is not shown again");
  k = await b.submit("/keys", { name: "e2e-all", folders: ["/"] });
  const key = k.html.match(/td_[A-Za-z0-9_-]{43}/)?.[0] ?? "";
  k = await b.submit("/keys", { name: "e2e-revoke", folders: ["/team"] });
  const revokedKey = k.html.match(/td_[A-Za-z0-9_-]{43}/)?.[0] ?? "";
  k = await b.submit("/keys", { name: "bad", folders: [] });
  check(k.status === 400, "a key with no folders is refused");

  section("MCP over HTTP (official SDK client)");
  const { client, call } = await mcp(scopedKey);
  const { tools } = await client.listTools();
  check(
    tools.map((t) => t.name).sort().join(",") === "describe_table,history,list,list_tables,lookup_row,query_table,read,search" && tools.every((t) => t.annotations?.readOnlyHint),
    "exactly eight read-only tools (drive + tables)",
  );
  const ls = await call("list", { path: "/" });
  const names = JSON.stringify(ls.meta);
  check(names.includes("team") && !names.includes("private"), "list / shows /team only");
  let rd = await call("read", { path: "/team/policy.txt" });
  check(rd.meta?.sha256 === sha(f.txt) && rd.blocks[1] === new TextDecoder().decode(f.txt), "read text (restored v1) byte-exact");
  rd = await call("read", { path: "/team/policy.txt", base64: true });
  check(rd.meta?.encoding === "base64" && Buffer.from(rd.blocks[1], "base64").equals(Buffer.from(f.txt)), "read base64");
  const parts: Buffer[] = [];
  let pageNo = 1;
  let more = true;
  while (more && pageNo < 10) {
    const r = await call("read", { path: "/team/blob.bin", page: pageNo });
    parts.push(Buffer.from(r.blocks[1], "base64"));
    more = Boolean(r.meta?.has_more);
    pageNo++;
  }
  check(pageNo - 1 >= 3 && sha(Buffer.concat(parts)) === sha(f.bin), `binary read in ${pageNo - 1} base64 pages reassembles to the same SHA-256`);
  rd = await call("read", { path: "/team/sales.csv", format: "text" });
  const rows = safeJson(rd.blocks[1]);
  check(
    rd.meta?.encoding === "json" && rows?.header?.join() === "region,quarter,revenue" && rows.rows.length === 200 && rd.meta?.has_more,
    "CSV rows view, 200 rows per page",
  );
  rd = await call("read", { path: "/team/sales.csv", format: "text", page: 3 });
  check(safeJson(rd.blocks[1])?.rows.length === 50 && rd.meta?.has_more === false, "CSV last page has the remaining 50 rows");
  rd = await call("read", { path: "/team/deck.pdf" });
  check(rd.meta?.encoding === "base64" && Buffer.from(rd.blocks[1], "base64").equals(Buffer.from(f.pdf)), "PDF raw read as base64");
  rd = await call("read", { path: "/team/forecast.xlsx", format: "text" });
  check(rd.isError && /not.*(supported|built|yet)|text view/i.test(rd.blocks.join(" ")), "xlsx text view says not supported yet");
  rd = await call("read", { path: "/team/forecast.xlsx" });
  check(Buffer.from(rd.blocks[1] ?? "", "base64").equals(Buffer.from(f.xlsx)), "xlsx raw read byte-exact");
  const se = await call("search", { query: "zebra-42" });
  check(JSON.stringify(se.meta).includes("/team/policy.txt") && !JSON.stringify(se.meta).includes("/private"), "search finds content in scope");
  const hi = await call("history", { path: "/team/policy.txt" });
  check(JSON.stringify(hi.meta).match(/"version":\s*\d/g)?.length === 3, "history has 3 versions");
  rd = await call("read", { path: "/team/policy.txt", version: 2 });
  check(rd.blocks[1] === new TextDecoder().decode(v2), "read an older version");
  for (const [tool, args] of [
    ["read", { path: "/private/secret.txt" }],
    ["list", { path: "/private" }],
    ["history", { path: "/private/secret.txt" }],
    ["read", { path: "/team/../private/secret.txt" }],
  ] as const) {
    const r = await call(tool, args);
    check(r.isError && /not found|not allowed/i.test(r.blocks.join(" ")), `out of scope ${tool} ${args.path} -> error`, r.blocks.join(" ").slice(0, 80));
  }
  const nf = await call("read", { path: "/private/secret.txt" });
  const missing = await call("read", { path: "/team/nope.txt" });
  check(nf.blocks.join() .replace("/private/secret.txt", "P") === missing.blocks.join().replace("/team/nope.txt", "P"), "hidden file looks exactly like a missing one");
  const se2 = await call("search", { query: "top secret" });
  check(!JSON.stringify(se2).includes("secret.txt"), "search does not leak out-of-scope files");
  await client.close();
  check((await mcpStatus("td_" + "A".repeat(43))) === 401, "unknown key -> 401");
  check((await mcpStatus(revokedKey)) === 200, "key works before revoke");
  kp = await b.page("/keys");
  const ids = [...kp.html.matchAll(/action="\/keys\/(\d+)\/revoke"/g)].map((m) => m[1]);
  const revokeId = ids[2];
  await b.submit(`/keys/${revokeId}/revoke`, {});
  check((await mcpStatus(revokedKey)) === 401, "revoked key -> 401");
  // Edit a key's folders: the /team key gets /private too, then back.
  await b.page("/keys");
  await b.submit(`/keys/${ids[0]}/folders`, { folders: ["/team", "/private"] });
  {
    const m = await mcp(scopedKey);
    const r = await m.call("read", { path: "/private/secret.txt" });
    check(!r.isError, "edit key folders: /private now readable");
    await m.client.close();
  }
  await b.page("/keys");
  await b.submit(`/keys/${ids[0]}/folders`, { folders: ["/team"] });
  const act = await b.page("/activity?key=e2e-team");
  check(act.html.includes("/team/policy.txt") && act.html.includes("e2e-team"), "activity shows the agent's reads, filtered by key");

  section("CyberDrive OUI database");
  const cyberKey = await cyberdrive(b, key);

  section("CyberDrive Windows events and NIST control frameworks");
  const grcKey = await moreDatasets(b, cyberKey);

  section("CyberDrive tables (grid, draft, publish, rollback, import, agent tools)");
  const tablesKey = await tablesFlow(b);

  section("share links");
  await b.page("/shares");
  let sh = await b.submit("/shares", { folder: "/team", hours: "1", label: "for Sam" });
  const share = sh.html.match(/https?:\/\/[^"<\s]+\/s\/tds_[A-Za-z0-9_-]{43}/)?.[0] ?? "";
  check(share && /Works until/.test(sh.html), "create a 1-hour share link for /team");
  const sp = await fetch(share);
  const sph = await sp.text();
  check(sp.status === 200 && sph.includes("policy.txt") && sph.includes("for Sam") && !sph.includes("secret"), "share page lists /team");
  const sd = await fetch(`${share}/download?path=${encodeURIComponent("/blob.bin")}`);
  check(sd.status === 200 && sha(new Uint8Array(await sd.arrayBuffer())) === sha(f.bin), "download through the share link");
  for (const bad of ["/../private/secret.txt", "../private/secret.txt", "/%2e%2e/private/secret.txt"]) {
    const r = await fetch(`${share}/download?path=${encodeURIComponent(bad)}`);
    check(r.status === 404, `share link cannot escape its folder (${bad})`);
  }
  const sub = await fetch(`${share}?path=${encodeURIComponent("/docs")}`);
  check(sub.status === 200, "share link opens a subfolder");
  // A second link, aged past its expiry in the database.
  await b.page("/shares");
  sh = await b.submit("/shares", { folder: "/team", hours: "24", label: "expires" });
  const expiring = sh.html.match(/https?:\/\/[^"<\s]+\/s\/tds_[A-Za-z0-9_-]{43}/)?.[0] ?? "";
  check((await fetch(expiring)).status === 200, "second link works");
  if (exec.length || process.env.TD_EXEC === "") {
    const sql = "UPDATE share_links SET expires_at='2000-01-01T00:00:00.000Z' WHERE label='expires'";
    const js = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(require('node:path').join(process.env.DATA_DIR||'./data','thumbdrive.db'));db.exec(${JSON.stringify(sql)});`;
    const [cmd, ...args] = exec.length ? exec : ["node"];
    execFileSync(cmd, [...args, ...(exec.length ? ["node"] : []), "-e", js], { stdio: "inherit", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    check((await fetch(expiring)).status === 404, "expired link -> 404");
    const listHtml = (await b.page("/shares")).html;
    const inactive = listHtml.slice(listHtml.indexOf("Expired and revoked"));
    check(listHtml.includes("Expired and revoked") && inactive.includes("expires") && inactive.includes("expired "), "expired link moves to the Expired list");
  } else console.log("  skip expiry (set TD_EXEC)");
  for (const h of ["0", "2", "abc", "721"]) {
    await b.page("/shares");
    const bad = await b.submit("/shares", { folder: "/team", hours: h });
    check(!/tds_[A-Za-z0-9_-]{43}/.test(bad.html) && /offered expiry/.test(bad.html), `expiry ${h} hours refused`);
  }

  section("password change signs out other sessions");
  const other = new Browser();
  check(await login(other, password), "second browser signs in");
  await b.page("/settings");
  const wrongCur = await b.submit("/settings/password", { current: "nope-nope", password: `${password}-2`, confirm: `${password}-2` });
  check(/wrong|incorrect/i.test(wrongCur.html), "wrong current password refused");
  await b.page("/settings");
  const ch = await b.submit("/settings/password", { current: password, password: `${password}-2`, confirm: `${password}-2` });
  check(/changed|saved/i.test(ch.html), "password changed");
  check((await b.req("/")).status === 200, "this browser stays signed in");
  check((await other.req("/")).status === 303, "the other browser is signed out");
  await b.page("/settings");
  await b.submit("/settings/password", { current: `${password}-2`, password, confirm: password });
  const lo = await b.submit("/logout", {});
  check((await b.req("/")).status === 303 && lo.html.includes("Signed out"), "logout");

  const state: State = { key, scopedKey, revokedKey, cyberKey, grcKey, tablesKey, share, files: { "/team/blob.bin": sha(f.bin), "/team/sales.csv": sha(f.csv) } };
  writeFileSync(stateFile, JSON.stringify(state));
}

async function lookupCisco(cyberKey: string) {
  const { client, call } = await mcp(cyberKey);
  const r = await call("lookup_mac", { macs: ["00-00-0c-12-34-56", "8c1f.64af.a000", "02:00:00:00:00:01"] });
  await client.close();
  return r.meta as { version: number; results: Array<{ result: string; match?: { manufacturer: string; citation: string } }> } | undefined;
}

async function cyberdrive(b: Browser, wholeDriveKey: string): Promise<string> {
  let page = await b.page("/datasets/oui");
  check(page.res.status === 200 && page.html.includes("Refresh from source"), "OUI database page renders");
  const fd = new FormData();
  fd.set("_csrf", b.csrf);
  fd.append("file", new Blob([ouiFixture() as Uint8Array<ArrayBuffer>]), "master_oui.db");
  const up = await b.req("/datasets/oui/import", { method: "POST", body: fd });
  page = await b.page("/datasets/oui");
  check(up.status === 303 && /Imported version \d+: 2 rows/.test(page.html), "upload a fixture OUI database");
  const bad = new FormData();
  bad.set("_csrf", b.csrf);
  bad.append("file", new Blob(["not a database"]), "bad.db");
  await b.req("/datasets/oui/import", { method: "POST", body: bad });
  check(/Not a SQLite database file/.test((await b.page("/datasets/oui")).html), "a non-SQLite upload is refused");
  await b.page("/keys");
  const k = await b.submit("/keys", { name: "e2e-cyber", datasets: "oui" });
  const cyberKey = k.html.match(/td_[A-Za-z0-9_-]{43}/)?.[0] ?? "";
  check(cyberKey && k.html.includes("cyberdrive:oui"), "create a dataset-only key");
  const out = await lookupCisco(cyberKey);
  const [cisco, mas, local] = out?.results ?? [];
  check(cisco?.match?.manufacturer === "Cisco" && /^cyberdrive:oui@v\d+#00:00:0C$/.test(cisco.match.citation), "lookup_mac finds Cisco with a citation");
  check(mas?.match?.manufacturer === "DATA ELECTRONIC DEVICES, INC", "lookup_mac prefers the MA-S block");
  check(local?.result === "locally administered" && !local.match, "locally administered MAC gets no vendor");
  const plain = await mcp(wholeDriveKey);
  const tools = (await plain.client.listTools()).tools.map((t) => t.name);
  await plain.client.close();
  check(!tools.includes("lookup_mac"), "a whole-drive key without the grant does not see lookup_mac");
  const act = await b.page("/activity?key=e2e-cyber");
  check(act.html.includes("lookup_mac"), "lookups show in activity");
  return cyberKey;
}

/** Upload a fixture through a dataset page; returns the page's text after the redirect. */
async function importDataset(b: Browser, name: string, bytes: Uint8Array, filename: string) {
  await b.page(`/datasets/${name}`);
  const fd = new FormData();
  fd.set("_csrf", b.csrf);
  fd.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>]), filename);
  const up = await b.req(`/datasets/${name}/import`, { method: "POST", body: fd });
  const loc = up.headers.get("location") ?? `/datasets/${name}`;
  return { status: up.status, html: (await b.page(new URL(loc, base).pathname + new URL(loc, base).search)).html };
}

function wineventFixture() {
  return xlsx({
    "Security Audit Events": [
      ["Category", "Subcategory", "Event ID", "Message Summary", "Minimum Operating System Requirement"],
      ["Logon/Logoff", "Logon", 4624, "An account was successfully logged on.", "Windows Vista, Windows Server 2008"],
      ["Account Management", "User Account Management", 4720, "A user account was created.", "Windows Vista, Windows Server 2008"],
    ],
    "Complete Event Messages": [
      ["Event ID", "Version", "Detailed Message", "Minimum Operating System Requirement"],
      [4624, 0, "An account was successfully logged on.\r\n\r\nSubject:\r\n\tSecurity ID:\t\t%1", "Windows Vista, Windows Server 2008"],
      [4720, 0, "A user account was created.", "Windows Vista, Windows Server 2008"],
    ],
  });
}

type Found = { result: string; id?: string; title?: string; citation?: string; withdrawn?: boolean; maps_to?: Array<{ id: string }> };
async function grcLookups(grcKey: string) {
  const { client, call } = await mcp(grcKey);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const ev = (await call("lookup_windows_event", { ids: [4624, 9999] })).meta as { results: Array<{ result: string; summary?: string; citation?: string }> } | undefined;
  const ctl = (await call("lookup_control", { ids: ["ac-2(1)", "AC-13", "PR.AA-01", "AC-99"] })).meta as { results: Found[] } | undefined;
  const map = (await call("map_control", { ids: ["PR.AA-01", "AC-2(1)"] })).meta as { results: Found[] } | undefined;
  await client.close();
  return { tools, ev: ev?.results ?? [], ctl: ctl?.results ?? [], map: map?.results ?? [] };
}

function checkGrc(r: Awaited<ReturnType<typeof grcLookups>>, when: string) {
  const [logon, none] = r.ev;
  check(logon?.result === "match" && /^cyberdrive:winevent@v\d+#4624$/.test(logon.citation ?? ""), `${when}: lookup_windows_event explains 4624 with a citation`);
  check(none?.result === "No match", `${when}: an unknown event ID is an explicit No match`);
  const [enh, withdrawn, csf, missing] = r.ctl;
  check(enh?.id === "AC-2(1)" && /^cyberdrive:nist80053@v\d+#AC-2\(1\)$/.test(enh.citation ?? ""), `${when}: lookup_control finds ac-2(1) with a citation`);
  check(withdrawn?.withdrawn === true, `${when}: AC-13 shows as withdrawn`);
  check(csf?.id === "PR.AA-01" && /^cyberdrive:csf2@v\d+#PR\.AA-01$/.test(csf.citation ?? ""), `${when}: lookup_control finds CSF PR.AA-01`);
  check(missing?.result === "No match", `${when}: an unknown control is an explicit No match`);
  const [fwd, back] = r.map;
  const fwdIds = (fwd?.maps_to ?? []).map((m) => m.id);
  check(fwdIds.includes("AC-2") && fwdIds.includes("IA-2"), `${when}: map_control maps PR.AA-01 to SP 800-53`);
  check((back?.maps_to ?? []).some((m) => m.id === "PR.AA-01"), `${when}: map_control maps AC-2(1) back to PR.AA-01 via AC-2`);
}

async function moreDatasets(b: Browser, ouiOnlyKey: string): Promise<string> {
  const win = await importDataset(b, "winevent", wineventFixture(), "audit-events.xlsx");
  check(win.status === 303 && /Imported version \d+: 2 events/.test(win.html), "upload a fixture Windows events workbook");
  const nist = await importDataset(b, "nist80053", sp80053Catalog(), "NIST_SP-800-53_rev5_catalog.json");
  check(nist.status === 303 && /Imported version \d+: 7 controls/.test(nist.html), "upload a fixture SP 800-53 OSCAL catalog");
  const csf = await importDataset(b, "csf2", csf2Catalog(), "NIST_CSF_v2.0_catalog.json");
  check(csf.status === 303 && /Imported version \d+: 10 items/.test(csf.html), "upload a fixture CSF 2.0 OSCAL catalog");
  const map = await importDataset(b, "csf2map", csf2MapWorkbook(), "csf2.xlsx");
  check(map.status === 303 && /Imported version \d+: 7 mappings/.test(map.html), "upload a fixture CSF 2.0 Reference Tool workbook");
  const bad = await importDataset(b, "nist80053", csf2Catalog(), "wrong.json");
  check(/Not an SP 800-53 catalog/.test(bad.html), "a CSF catalog uploaded as SP 800-53 is refused (the imported version stays, checked by the lookups below)");
  await b.page("/keys");
  const k = await b.submit("/keys", { name: "e2e-grc", datasets: ["winevent", "nist80053", "csf2", "csf2map"] });
  const grcKey = k.html.match(/td_[A-Za-z0-9_-]{43}/)?.[0] ?? "";
  check(grcKey !== "" && k.html.includes("cyberdrive:nist80053"), "create a key granted Windows events and the NIST datasets");
  const r = await grcLookups(grcKey);
  check(["lookup_windows_event", "lookup_control", "search_controls", "map_control"].every((t) => r.tools.includes(t)) && !r.tools.includes("lookup_mac"), "the key sees exactly its granted dataset tools");
  checkGrc(r, "first run");
  const oui = await mcp(ouiOnlyKey);
  const ouiTools = (await oui.client.listTools()).tools.map((t) => t.name);
  await oui.client.close();
  check(!ouiTools.includes("lookup_control") && !ouiTools.includes("lookup_windows_event"), "the OUI-only key does not see the new tools");
  const act = await b.page("/activity?key=e2e-grc");
  check(["lookup_windows_event", "lookup_control", "map_control"].every((t) => act.html.includes(t)), "dataset lookups show in activity");
  return grcKey;
}

type Lookup = { version: number; results: Array<{ input: string; result: string; row?: { row: number; citation: string; values: Record<string, unknown> } }> };
async function tableLookups(key: string) {
  const { client, call } = await mcp(key);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const listed = (await call("list_tables", {})).meta as { tables: Array<{ table: string; version: number }> } | undefined;
  const servers = (await call("lookup_row", { table: "/inventory/servers", values: ["WEB01.example.com", "web02.example.com", "nope.example.com"] })).meta as Lookup | undefined;
  const vlans = (await call("lookup_row", { table: "/inventory/vlans", values: ["10.1.2.3"] })).meta as Lookup | undefined;
  const q = (await call("query_table", { table: "/inventory/servers", filters: [{ column: "Environment", op: "eq", value: "production" }] })).meta as
    | { total: number; rows: Array<{ citation: string }> }
    | undefined;
  const inj = (await call("query_table", { table: "/inventory/servers", filters: [{ column: "OS", op: "eq", value: "x' OR 1=1 --" }] })).meta as { total: number; result?: string } | undefined;
  await client.close();
  return { tools, listed: listed?.tables ?? [], servers, vlans, q, inj };
}

/** POST JSON to the grid endpoints the way tables.js does (x-csrf-token header). */
async function gridPost(b: Browser, path: string, body: unknown, csrf = b.csrf) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  const res = await b.req(path, { method: "POST", body: JSON.stringify(body), headers });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as { added?: Array<{ id: number; errors: Record<string, string> }>; summary?: { issues: number } } };
}

async function tablesFlow(b: Browser): Promise<string> {
  await b.page("/files");
  await b.submit("/files/mkdir", { dir: "/", name: "inventory" });
  await b.page("/tables");
  const made = await b.post("/tables", { folder: "/inventory", template: "server-inventory", name: "servers", title: "Servers" });
  const url = made.headers.get("location") ?? "";
  const id = url.match(/^\/tables\/(\d+)$/)?.[1];
  check(made.status === 303 && id, "create a table from the Server inventory template");
  const grid = await b.page(url);
  check(
    grid.res.status === 200 && grid.html.includes("/assets/vendor/tabulator-6.7.1.min.js") && !/<script(?![^>]*\bsrc=)[^>]*>/.test(grid.html),
    "grid page loads vendored Tabulator, no inline scripts",
  );
  check(!/unsafe-inline|https?:/.test(grid.res.headers.get("content-security-policy") ?? ""), "grid page keeps the strict CSP");
  const js = await b.req("/assets/vendor/tabulator-6.7.1.min.js");
  check(js.status === 200 && /javascript/.test(js.headers.get("content-type") ?? "") && (await js.text()).length > 100_000, "Tabulator asset served by the app");
  const edits = `${url}/edits`;
  check((await gridPost(b, edits, { adds: [{ values: { c1: "x" } }] }, "")).status === 403, "grid edit without the CSRF header -> 403");
  const add = await gridPost(b, edits, {
    adds: [
      { values: { c1: "web01.example.com", c2: "10.0.0.10", c3: "production", c6: "ops@example.com" } },
      { values: { c1: "web02.example.com", c2: "10.0.0.300", c3: "production" } },
      { values: { c1: "db01.example.com", c2: "10.0.1.5", c3: "staging" } },
    ],
  });
  const rows = add.json.added ?? [];
  check(add.status === 200 && rows.length === 3 && rows[1].errors.c2 && add.json.summary?.issues === 1, "edit cells; an invalid IP is flagged");
  const pub = await b.page(`${url}/publish`);
  check(/1 problem must be fixed/.test(pub.html) && /disabled/.test(pub.html), "publish page shows the diff and blocks the invalid IP");
  const blocked = await b.submit(`${url}/publish`, { note: "try" });
  check(!/Published v1/.test(blocked.html), "publishing with invalid cells is refused");
  await gridPost(b, edits, { updates: [{ row: rows[1].id, values: { c2: "10.0.0.11" } }] });
  await b.page(`${url}/publish`);
  const v1 = await b.submit(`${url}/publish`, { note: "initial servers" });
  check(/Published v1: \+3/.test(v1.html), "publish v1 with a note");

  await b.page("/keys");
  const k = await b.submit("/keys", { name: "e2e-tables", folders: ["/inventory"] });
  const tablesKey = k.html.match(/td_[A-Za-z0-9_-]{43}/)?.[0] ?? "";
  check(tablesKey !== "", "create a key scoped to /inventory");

  // A draft change is invisible to agents until published.
  await b.page(url);
  await gridPost(b, edits, { deletes: [rows[1].id] });
  let r = await tableLookups(tablesKey);
  check(["list_tables", "describe_table", "lookup_row", "query_table"].every((t) => r.tools.includes(t)), "the folder key sees the table tools");
  const [web01, web02, nope] = r.servers?.results ?? [];
  check(web01?.result === "match" && web01.row?.citation === `cyberdrive:/inventory/servers@v1#r${rows[0].id}`, "lookup_row is case-insensitive and cites @v1#r");
  check(web02?.result === "match", "a draft delete is invisible to agents");
  check(nope?.result === "No match", "an unknown hostname is an explicit No match");
  check(r.q?.total === 2 && r.inj?.total === 0, "query_table filters; SQL in a value is just a value");
  await b.page(`${url}/publish`);
  const v2 = await b.submit(`${url}/publish`, { note: "retire web02" });
  check(/Published v2: \+0 ~0 −1/.test(v2.html), "publish v2 removes web02");
  r = await tableLookups(tablesKey);
  check(r.servers?.results[1]?.result === "No match" && r.servers.version === 2, "agents see v2 immediately");
  const roll = await b.submit(`${url}/rollback`, { version: "1" });
  check(/Rolled back: v3 has v1/.test(roll.html), "one-click rollback to v1 creates v3");
  r = await tableLookups(tablesKey);
  check(r.servers?.results[1]?.result === "match" && /@v3#r/.test(r.servers.results[1].row?.citation ?? ""), "after rollback web02 is back at @v3");

  // Import an IP plan from an xlsx built in memory.
  const book = xlsx({
    VLANs: [
      ["CIDR", "VLAN", "Name", "Site"],
      ["10.0.0.0/8", 1, "corp", "HQ"],
      ["10.1.0.0/16", 110, "servers", "HQ"],
      ["10.2.0.0/33", 120, "bad", "DR"],
    ],
  });
  await b.page("/tables");
  const fd = new FormData();
  fd.set("_csrf", b.csrf);
  fd.set("target", "new");
  fd.append("file", new Blob([book as Uint8Array<ArrayBuffer>]), "vlans.xlsx");
  const prev = await b.req("/tables/import", { method: "POST", body: fd });
  const prevHtml = await prev.text();
  const stage = prevHtml.match(/action="\/tables\/import\/([A-Za-z0-9_-]+)"/)?.[1];
  check(prev.status === 200 && stage && /<option value="cidr" selected/.test(prevHtml) && /<option value="number" selected/.test(prevHtml), "xlsx import preview suggests CIDR and number types");
  const imp = await b.submit(`/tables/import/${stage}`, {
    _csrf: prevHtml.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? b.csrf,
    action: "import",
    sheet: "0",
    folder: "/inventory",
    name: "vlans",
    map_0: "new",
    type_0: "cidr",
    map_1: "new",
    type_1: "number",
    map_2: "new",
    type_2: "text",
    map_3: "new",
    type_3: "text",
    key: "0",
  });
  check(/Imported into the draft: 3 added/.test(imp.html) && /1 row\(s\) have invalid cells/.test(imp.html), "import lands as a draft and reports the invalid row");
  const vtable = `/tables/${imp.html.match(/\/tables\/(\d+)\/(?:publish|edits)/)?.[1]}`;
  const draft = (await (await b.req(`${vtable}/draft.json`)).json()) as { rows: Array<{ id: number; data: Record<string, unknown> }> };
  const bad = draft.rows.find((x) => x.data.c1 === "10.2.0.0/33");
  await b.page(vtable);
  await gridPost(b, `${vtable}/edits`, { deletes: [bad?.id] });
  await b.page(`${vtable}/publish`);
  const pv = await b.submit(`${vtable}/publish`, { note: "imported" });
  check(/Published v1: \+2/.test(pv.html), "fix and publish the imported table");
  r = await tableLookups(tablesKey);
  check(r.vlans?.results[0]?.row?.values.CIDR === "10.1.0.0/16", "lookup_row on a CIDR table returns the longest containing prefix");
  check(r.listed.some((t) => t.table === "/inventory/vlans") && r.listed.some((t) => t.table === "/inventory/servers" && t.version === 3), "list_tables shows both published tables");
  const act = await b.page("/activity?key=e2e-tables");
  check(["list_tables", "lookup_row", "query_table"].every((t) => act.html.includes(t)), "table tool calls show in activity");
  return tablesKey;
}

async function afterRestart() {
  await common();
  const st = JSON.parse(readFileSync(stateFile, "utf8")) as State;
  section("after restart (volume persistence)");
  const b = new Browser();
  check(await login(b, password), "admin password survived");
  const { client, call } = await mcp(st.key);
  for (const [p, h] of Object.entries(st.files)) {
    const r = await call("list", { path: "/team" });
    check(JSON.stringify(r.meta).includes(h), `${p} still there with the same SHA-256`);
  }
  const hi = await call("history", { path: "/team/policy.txt" });
  check(JSON.stringify(hi.meta).match(/"version":\s*\d/g)?.length === 3, "version history survived");
  await client.close();
  check((await mcpStatus(st.scopedKey)) === 200, "scoped key still works");
  check((await mcpStatus(st.revokedKey)) === 401, "revoked key still revoked");
  check((await fetch(st.share)).status === 200, "share link still works");
  if (st.cyberKey) {
    const out = await lookupCisco(st.cyberKey);
    check(out?.results[0]?.match?.manufacturer === "Cisco", "OUI database and the dataset grant survived");
  }
  if (st.grcKey) checkGrc(await grcLookups(st.grcKey), "after restart");
  if (st.tablesKey) {
    const r = await tableLookups(st.tablesKey);
    check(r.servers?.version === 3 && r.servers.results[0]?.result === "match", "published tables and versions survived");
    check(r.vlans?.results[0]?.row?.values.CIDR === "10.1.0.0/16", "imported table survived");
  }
  await b.page("/shares");
  const id = (await b.page("/shares")).html.match(/action="\/shares\/(\d+)\/revoke"/)?.[1];
  await b.submit(`/shares/${id}/revoke`, {});
  check((await fetch(st.share)).status === 404, "revoked share link -> 404");
}

const run = { "first-run": firstRun, "env-password": envPassword, "after-restart": afterRestart }[phase];
if (!run) throw new Error(`Unknown phase ${phase}`);
await run();
console.log(`\n${checks - failures}/${checks} checks passed (${phase})`);
process.exit(failures ? 1 : 0);
