/**
 * The admin web UI and public share links, mounted next to /mcp.
 *
 *   /setup, /login, /logout        single admin, scrypt password, server-side sessions
 *   /, /files, /keys, /shares,     admin pages (session required)
 *   /activity, /settings
 *   /s/<token>                     read-only browser access to one shared folder
 *   /assets/*                      CSS and JS (no inline script or style)
 *
 * Every POST needs a CSRF token bound to the session (or, before login, to a
 * pre-login cookie) and a same-origin Origin / Sec-Fetch-Site. All writes go
 * through Drive, KeyStore and ShareStore, so they are versioned and logged.
 */
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { JSX } from "hono/jsx/jsx-runtime";
import { randomBytes } from "node:crypto";
import type { KeyStore } from "../auth/keys.ts";
import type { Config } from "../config.ts";
import { moveEntry } from "../ops.ts";
import { DriveError, type Drive, NotFoundError } from "../storage/drive.ts";
import { InvalidPathError, isWithin, joinDrivePath, normalizeDrivePath, parentOf, segmentsOf } from "../storage/paths.ts";
import { APP_CSS, APP_JS, ICON_SVG, THEME_JS } from "./assets.ts";
import { type AdminAuth, type LoginLimiter, MIN_PASSWORD_LENGTH } from "./auth.ts";
import { DEFAULT_SHARE_HOURS, type ShareStore } from "./shares.ts";
import { connectionSnippets } from "./snippets.ts";
import {
  ActivityPage,
  DashboardPage,
  type Flash,
  FilePage,
  FolderPage,
  fileUrl,
  filesUrl,
  KeysPage,
  LoginPage,
  MessagePage,
  type PageCtx,
  SettingsPage,
  SetupPage,
  SharePage,
  SharesPage,
} from "./views.tsx";

export interface UiDeps {
  drive: Drive;
  keys: KeyStore;
  config: Config;
  auth: AdminAuth;
  shares: ShareStore;
  loginLimiter: LoginLimiter;
  /** Request arrived over HTTPS (directly, or via a trusted local proxy). */
  isHttps: (c: Context) => boolean;
  /** Client address for rate limiting. */
  clientAddress: (c: Context) => string;
}

const SESSION_COOKIE = "td_session";
const PRE_COOKIE = "td_pre";
const FLASH_COOKIE = "td_flash";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

const isPublicPath = (p: string) =>
  p === "/login" || p === "/setup" || p.startsWith("/assets/") || p === "/s" || p.startsWith("/s/");

type FormValue = string | File | Array<string | File>;
type Form = Record<string, FormValue>;

function str(form: Form, name: string): string {
  const v = form[name];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" ? first : "";
}

function strings(form: Form, name: string): string[] {
  const v = form[name];
  const all = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return all.filter((x): x is string => typeof x === "string");
}

function files(form: Form, name: string): File[] {
  const v = form[name];
  const all = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return all.filter((x): x is File => typeof x !== "string" && x.size >= 0 && x.name !== "");
}

/** A message that is safe and useful to show the admin. Unknown errors are logged and summarised. */
function userMessage(error: unknown): string {
  if (error instanceof DriveError || error instanceof NotFoundError || error instanceof InvalidPathError) return error.message;
  if (error instanceof Error && /UNIQUE constraint failed: keys\.name/.test(error.message)) {
    return "A key with that name already exists";
  }
  if (error instanceof Error && error.constructor === Error && !("code" in error)) return error.message;
  console.error("[thumbdrive] ui:", error);
  return "Something went wrong; see the server log";
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Downloads are always attachments with a sandbox CSP, so an uploaded HTML file can never run in this origin. */
function downloadResponse(name: string, bytes: Uint8Array, sha256: string): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": contentDisposition(name),
      "content-length": String(bytes.length),
      "content-security-policy": "sandbox; default-src 'none'",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "x-thumbdrive-sha256": sha256,
    },
  });
}

export function registerUi(app: Hono, deps: UiDeps): void {
  const { drive, keys, config, auth, shares, loginLimiter } = deps;

  // ---------- plumbing ----------

  const cookieOpts = (c: Context) => ({
    httpOnly: true,
    sameSite: "Strict" as const,
    secure: deps.isHttps(c),
    path: "/",
  });

  const sessionToken = (c: Context): string | undefined => {
    const token = getCookie(c, SESSION_COOKIE);
    return auth.sessionValid(token) ? token : undefined;
  };

  /** The cookie value CSRF tokens are bound to: the session, else a pre-login cookie (created on demand). */
  const csrfBinding = (c: Context, create: boolean): string | undefined => {
    const session = sessionToken(c);
    if (session) return session;
    let pre = getCookie(c, PRE_COOKIE);
    if (!pre && create) {
      pre = randomBytes(24).toString("base64url");
      setCookie(c, PRE_COOKIE, pre, cookieOpts(c));
    }
    return pre;
  };

  const baseUrl = (c: Context): string => {
    if (config.publicUrl) return config.publicUrl;
    return `${deps.isHttps(c) ? "https" : "http"}://${c.req.header("host") ?? `127.0.0.1:${config.port}`}`;
  };

  const flash = (c: Context, kind: Flash["kind"], message: string) => {
    setCookie(c, FLASH_COOKIE, JSON.stringify({ kind, message: message.slice(0, 500) }), { ...cookieOpts(c), maxAge: 60 });
  };

  const takeFlash = (c: Context): Flash | undefined => {
    const raw = getCookie(c, FLASH_COOKIE);
    if (!raw) return undefined;
    deleteCookie(c, FLASH_COOKIE, { path: "/" });
    try {
      const parsed = JSON.parse(raw) as Flash;
      if (["ok", "error", "warn"].includes(parsed.kind) && typeof parsed.message === "string") return parsed;
    } catch {
      // ignore a malformed cookie
    }
    return undefined;
  };

  const ctx = (c: Context, override?: Flash): PageCtx => ({
    csrf: auth.csrfToken(csrfBinding(c, true) as string),
    mcpUrl: `${baseUrl(c)}/mcp`,
    flash: override ?? takeFlash(c),
  });

  const render = (c: Context, node: JSX.Element, status: 200 | 400 | 401 | 403 | 404 | 410 | 413 | 429 = 200) =>
    c.html("<!DOCTYPE html>" + String(node), status);

  const done = (c: Context, to: string, kind: Flash["kind"], message: string) => {
    flash(c, kind, message);
    return c.redirect(to, 303);
  };

  const wantsJson = (c: Context) => (c.req.header("accept") ?? "").includes("application/json");

  const form = async (c: Context): Promise<Form> => (await c.req.parseBody({ all: true })) as Form;

  const forbidden = (c: Context, message: string) =>
    wantsJson(c)
      ? c.json({ error: message }, 403)
      : render(c, <MessagePage title="Request refused" message={message} link={{ href: "/", text: "Back to Thumbdrive" }} />, 403);

  // ---------- middleware ----------

  app.use("*", async (c, next) => {
    await next();
    const p = c.req.path;
    if (p === "/mcp" || p === "/healthz") return;
    const h = c.res.headers;
    if (!h.has("content-security-policy")) {
      h.set(
        "content-security-policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }
    h.set("x-frame-options", "DENY");
    h.set("x-content-type-options", "nosniff");
    // same-origin, not no-referrer: with no-referrer browsers send "Origin: null" on
    // form POSTs, which the Origin check rightly rejects.
    h.set("referrer-policy", "same-origin");
    // Admin pages and share links are private: keep them out of search engines.
    h.set("x-robots-tag", "noindex, nofollow");
    if (!h.has("cache-control")) h.set("cache-control", p.startsWith("/assets/") ? "public, max-age=3600" : "no-store");
  });

  const tooLarge = (c: Context) =>
    wantsJson(c) || c.req.path === "/files/upload"
      ? c.json({ error: `Too large: the limit is ${Math.round(config.maxFileBytes / 1048576)} MB per file` }, 413)
      : c.text("Request body too large", 413);
  const uploadLimit = bodyLimit({ maxSize: config.maxFileBytes + 1024 * 1024, onError: tooLarge });
  const formLimit = bodyLimit({ maxSize: 256 * 1024, onError: tooLarge });
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST" || c.req.path === "/mcp") return next();
    return (c.req.path === "/files/upload" ? uploadLimit : formLimit)(c, next);
  });

  // CSRF and same-origin checks on every POST.
  app.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.path === "/mcp") return next();
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return forbidden(c, "Cross-site requests are not allowed.");
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let originHost = "";
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        // "null" or garbage: refused below
      }
      if (originHost !== (c.req.header("host") ?? "").toLowerCase()) return forbidden(c, "Cross-origin requests are not allowed.");
    }
    let token = c.req.header("x-csrf-token");
    if (!token) token = str(await form(c), "_csrf");
    if (!auth.checkCsrf(csrfBinding(c, false), token)) {
      return forbidden(c, "This form has expired. Go back, reload the page and try again.");
    }
    await next();
  });

  // Sign-in required for everything except /mcp, /healthz, login/setup, assets and share links.
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (p === "/mcp" || p === "/healthz" || isPublicPath(p)) return next();
    if (!auth.hasPassword()) {
      return c.req.method === "GET" ? c.redirect("/setup", 303) : forbidden(c, "Set the admin password first.");
    }
    if (!sessionToken(c)) {
      if (c.req.method !== "GET") return wantsJson(c) ? c.json({ error: "Sign in first" }, 401) : c.redirect("/login", 303);
      const url = new URL(c.req.url);
      const next = url.pathname + url.search;
      return c.redirect(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`, 303);
    }
    await next();
  });

  // ---------- assets ----------

  app.get("/assets/app.css", (c) => c.body(APP_CSS, 200, { "content-type": "text/css; charset=utf-8" }));
  app.get("/assets/app.js", (c) => c.body(APP_JS, 200, { "content-type": "text/javascript; charset=utf-8" }));
  app.get("/assets/theme.js", (c) => c.body(THEME_JS, 200, { "content-type": "text/javascript; charset=utf-8" }));
  app.get("/assets/icon.svg", (c) => c.body(ICON_SVG, 200, { "content-type": "image/svg+xml" }));
  app.get("/favicon.ico", (c) => c.redirect("/assets/icon.svg", 301));

  // ---------- setup, login, logout ----------

  const startSession = (c: Context) => {
    setCookie(c, SESSION_COOKIE, auth.createSession(), { ...cookieOpts(c), maxAge: SESSION_MAX_AGE });
    deleteCookie(c, PRE_COOKIE, { path: "/" });
  };

  app.get("/setup", (c) => {
    if (auth.hasPassword()) return c.redirect(sessionToken(c) ? "/" : "/login", 303);
    return render(c, <SetupPage csrf={ctx(c).csrf} minLength={MIN_PASSWORD_LENGTH} />);
  });

  app.post("/setup", async (c) => {
    if (auth.hasPassword()) return c.redirect("/login", 303);
    const body = await form(c);
    const password = str(body, "password");
    const fail = (message: string) =>
      render(c, <SetupPage csrf={ctx(c).csrf} minLength={MIN_PASSWORD_LENGTH} flash={{ kind: "error", message }} />, 400);
    if (password !== str(body, "confirm")) return fail("The two passwords do not match");
    try {
      await auth.setPassword(password);
    } catch (error) {
      return fail(userMessage(error));
    }
    drive.logActivity("admin", "setup", null, "admin password set in the web UI");
    startSession(c);
    return done(c, "/", "ok", "Password saved. Next: upload files and create a key for your agent.");
  });

  const safeNext = (next: string) => (next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/");

  app.get("/login", (c) => {
    if (!auth.hasPassword()) return c.redirect("/setup", 303);
    if (sessionToken(c)) return c.redirect("/", 303);
    return render(c, <LoginPage csrf={ctx(c).csrf} next={safeNext(c.req.query("next") ?? "/")} flash={takeFlash(c)} />);
  });

  app.post("/login", async (c) => {
    if (!auth.hasPassword()) return c.redirect("/setup", 303);
    const body = await form(c);
    const next = safeNext(str(body, "next") || "/");
    const client = deps.clientAddress(c);
    const csrf = () => ctx(c).csrf;
    if (loginLimiter.blocked(client)) {
      return render(
        c,
        <LoginPage csrf={csrf()} next={next} flash={{ kind: "error", message: "Too many failed attempts. Wait 15 minutes and try again." }} />,
        429,
      );
    }
    if (!(await auth.verifyPassword(str(body, "password")))) {
      loginLimiter.fail(client);
      return render(c, <LoginPage csrf={csrf()} next={next} flash={{ kind: "error", message: "Wrong password." }} />, 401);
    }
    loginLimiter.reset(client);
    startSession(c);
    return c.redirect(next, 303);
  });

  app.post("/logout", (c) => {
    auth.destroySession(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return done(c, "/login", "ok", "Signed out.");
  });

  // ---------- dashboard ----------

  app.get("/", (c) => {
    const host = (c.req.header("host") ?? "").toLowerCase();
    const loopback = !config.publicUrl && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    const data = {
      stats: drive.stats(),
      activeKeys: keys.list().filter((k) => !k.revoked_at).length,
      activeShares: shares.listActive().length,
      agentCalls24h: drive.agentCallsSince(new Date(Date.now() - 86400_000).toISOString()),
      recent: drive.queryActivity({ agentsOnly: true, limit: 8 }),
      loopback,
    };
    return render(c, <DashboardPage ctx={ctx(c)} data={data} />);
  });

  // ---------- files ----------

  const drivePathParam = (c: Context, name = "path"): string => normalizeDrivePath(c.req.query(name) ?? "/");

  app.get("/files", (c) => {
    let path: string;
    try {
      path = drivePathParam(c);
    } catch (error) {
      return done(c, "/files", "error", userMessage(error));
    }
    const kind = drive.kind(path);
    if (kind === "file") return c.redirect(fileUrl(path), 303);
    if (kind === null) {
      if (path === "/") throw new Error("drive root is missing");
      return done(c, filesUrl(parentOf(path)), "error", `Not found: ${path}`);
    }
    const data = { path, entries: drive.list(path), deleted: drive.listDeleted(path), maxFileBytes: config.maxFileBytes };
    return render(c, <FolderPage ctx={ctx(c)} data={data} />);
  });

  app.get("/files/file", (c) => {
    let path: string;
    try {
      path = drivePathParam(c);
    } catch (error) {
      return done(c, "/files", "error", userMessage(error));
    }
    const kind = drive.kind(path);
    if (kind === "folder") return c.redirect(filesUrl(path), 303);
    const history = drive.history(path);
    if (kind === null && history.length === 0) return done(c, filesUrl(parentOf(path)), "error", `Not found: ${path}`);
    if (kind === null) return render(c, <FilePage ctx={ctx(c)} data={{ path, exists: false, history }} />);
    const file = drive.readFile(path);
    const data = {
      path,
      exists: true,
      size: file.bytes.length,
      sha256: file.sha256,
      version: file.version,
      modified: file.modified,
      history,
    };
    return render(c, <FilePage ctx={ctx(c)} data={data} />);
  });

  app.get("/files/download", (c) => {
    try {
      const path = drivePathParam(c);
      const v = c.req.query("version");
      const version = v ? Number(v) : undefined;
      if (version !== undefined && !Number.isInteger(version)) throw new DriveError("Bad version number");
      const file = drive.readFile(path, version);
      const name = segmentsOf(path).at(-1) ?? "download";
      return downloadResponse(version ? name.replace(/(\.[^.]*)?$/, `.v${version}$1`) : name, file.bytes, file.sha256);
    } catch (error) {
      return c.text(userMessage(error), error instanceof NotFoundError ? 404 : 400);
    }
  });

  app.post("/files/mkdir", async (c) => {
    const body = await form(c);
    let dir = "/";
    try {
      dir = normalizeDrivePath(str(body, "dir") || "/");
      const name = str(body, "name").trim();
      if (!name) throw new DriveError("Give the folder a name");
      if (name.includes("/")) throw new DriveError("A folder name cannot contain /");
      const created = drive.makeFolder(joinDrivePath(dir, name));
      return done(c, filesUrl(created), "ok", `Created ${created}`);
    } catch (error) {
      return done(c, filesUrl(dir), "error", userMessage(error));
    }
  });

  /**
   * Upload one or more files into a folder. `relpath` (one file per request,
   * from the drag-and-drop code) may hold subfolders, e.g. "photos/a.jpg";
   * it is normalized and must stay inside `dir`.
   */
  app.post("/files/upload", async (c) => {
    const body = await form(c);
    let dir = "/";
    const saved: Array<{ path: string; version: number }> = [];
    try {
      dir = normalizeDrivePath(str(body, "dir") || "/");
      if (drive.kind(dir) !== "folder") throw new NotFoundError(dir);
      const list = files(body, "file");
      if (list.length === 0) throw new DriveError("Choose at least one file");
      const relpath = list.length === 1 ? str(body, "relpath") : "";
      for (const file of list) {
        if (file.size > config.maxFileBytes) {
          throw new DriveError(`${file.name} is larger than the ${Math.round(config.maxFileBytes / 1048576)} MB limit`);
        }
        const target = normalizeDrivePath(joinDrivePath(dir, relpath || file.name));
        if (target === dir || !isWithin(target, dir)) throw new DriveError(`Refusing to write outside ${dir}`);
        const row = drive.putFile(target, new Uint8Array(await file.arrayBuffer()));
        saved.push({ path: target, version: row.version });
      }
    } catch (error) {
      const message = userMessage(error);
      if (wantsJson(c)) return c.json({ error: message, saved }, 400);
      return done(c, filesUrl(dir), "error", saved.length ? `Saved ${saved.length} file(s), then: ${message}` : message);
    }
    if (wantsJson(c)) return c.json({ ok: true, saved, path: saved[0]?.path, version: saved[0]?.version });
    return done(c, filesUrl(dir), "ok", `Uploaded ${saved.length} file(s)`);
  });

  app.post("/files/move", async (c) => {
    const body = await form(c);
    let from = "/";
    try {
      from = normalizeDrivePath(str(body, "path"));
      const raw = str(body, "to").trim();
      if (!raw) throw new DriveError("Give a new name or path");
      // A bare name renames in place; anything with a slash is a full path.
      const to = raw.includes("/") ? normalizeDrivePath(raw) : normalizeDrivePath(joinDrivePath(parentOf(from), raw));
      const wasFolder = drive.kind(from) === "folder";
      const target = moveEntry(drive, keys, from, to);
      return done(
        c,
        wasFolder ? filesUrl(target) : filesUrl(parentOf(target)),
        "ok",
        `Moved ${from} to ${target}${wasFolder ? ". Keys and share links for it follow the new name." : ""}`,
      );
    } catch (error) {
      const back = drive.kind(from) === "folder" ? filesUrl(from) : filesUrl(parentOf(from));
      return done(c, back, "error", userMessage(error));
    }
  });

  app.post("/files/delete", async (c) => {
    const body = await form(c);
    let path = "/";
    try {
      path = normalizeDrivePath(str(body, "path"));
      if (drive.kind(path) === "folder") {
        const n = drive.deleteFolder(path);
        return done(c, filesUrl(parentOf(path)), "ok", `Deleted ${path} (${n} file(s), history kept)`);
      }
      drive.deleteFile(path);
      return done(c, filesUrl(parentOf(path)), "ok", `Deleted ${path}. Its history is kept; open it under “Deleted” to restore.`);
    } catch (error) {
      return done(c, filesUrl(parentOf(path)), "error", userMessage(error));
    }
  });

  app.post("/files/restore", async (c) => {
    const body = await form(c);
    let path = "/";
    try {
      path = normalizeDrivePath(str(body, "path"));
      const version = Number(str(body, "version"));
      if (!Number.isInteger(version) || version < 1) throw new DriveError("Bad version number");
      const row = drive.restoreVersion(path, version);
      return done(c, fileUrl(path), "ok", `Restored v${version} as v${row.version}`);
    } catch (error) {
      return done(c, fileUrl(path), "error", userMessage(error));
    }
  });

  // ---------- keys ----------

  app.get("/keys", (c) => render(c, <KeysPage ctx={ctx(c)} keys={keys.list()} folders={drive.listFolders()} />));

  app.post("/keys", async (c) => {
    const body = await form(c);
    const name = str(body, "name").trim();
    const folders = strings(body, "folders");
    try {
      const { key, record } = keys.create(name, folders);
      drive.logActivity("admin", "key.create", null, `${record.name}: ${record.folders.join(", ")}`);
      const base = ctx(c);
      const created = { name: record.name, token: key, folders: record.folders, snippets: connectionSnippets(base.mcpUrl, key) };
      return render(c, <KeysPage ctx={base} keys={keys.list()} folders={drive.listFolders()} created={created} />);
    } catch (error) {
      const page = ctx(c, { kind: "error", message: userMessage(error) });
      return render(c, <KeysPage ctx={page} keys={keys.list()} folders={drive.listFolders()} form={{ name, folders }} />, 400);
    }
  });

  const keyId = (c: Context) => {
    const id = Number(c.req.param("id"));
    const record = Number.isInteger(id) ? keys.get(id) : undefined;
    if (!record) throw new NotFoundError(`key ${c.req.param("id")}`);
    return record;
  };

  app.post("/keys/:id/folders", async (c) => {
    try {
      const record = keyId(c);
      if (record.revoked_at) throw new DriveError("That key is revoked");
      const updated = keys.setFolders(record.id, strings(await form(c), "folders"));
      drive.logActivity("admin", "key.folders", null, `${updated.name}: ${updated.folders.join(", ")}`);
      return done(c, "/keys", "ok", `${updated.name} can now read ${updated.folders.join(", ")}`);
    } catch (error) {
      return done(c, "/keys", "error", userMessage(error));
    }
  });

  app.post("/keys/:id/revoke", (c) => {
    try {
      const record = keyId(c);
      keys.revokeById(record.id);
      drive.logActivity("admin", "key.revoke", null, record.name);
      return done(c, "/keys", "ok", `Revoked ${record.name}`);
    } catch (error) {
      return done(c, "/keys", "error", userMessage(error));
    }
  });

  // ---------- share links ----------

  const sharesPage = (c: Context, page: PageCtx, extra: { selected?: string; created?: { url: string; record: ReturnType<ShareStore["create"]>["record"] } } = {}) =>
    render(
      c,
      <SharesPage
        ctx={page}
        active={shares.listActive()}
        inactive={shares.listInactive()}
        folders={drive.listFolders()}
        selected={extra.selected}
        created={extra.created}
      />,
    );

  app.get("/shares", (c) => sharesPage(c, ctx(c), { selected: c.req.query("folder") }));

  app.post("/shares", async (c) => {
    const body = await form(c);
    try {
      const folder = normalizeDrivePath(str(body, "folder") || "/");
      if (drive.kind(folder) !== "folder") throw new NotFoundError(folder);
      const hours = Number(str(body, "hours") || DEFAULT_SHARE_HOURS);
      const { token, record } = shares.create(folder, hours, str(body, "label"));
      drive.logActivity("admin", "share.create", folder, `link #${record.id}, expires ${record.expires_at}`);
      return sharesPage(c, ctx(c), { created: { url: `${baseUrl(c)}/s/${token}`, record } });
    } catch (error) {
      return done(c, "/shares", "error", userMessage(error));
    }
  });

  app.post("/shares/:id/revoke", (c) => {
    const id = Number(c.req.param("id"));
    const record = Number.isInteger(id) ? shares.get(id) : undefined;
    if (!record) return done(c, "/shares", "error", "No such link");
    shares.revoke(id);
    drive.logActivity("admin", "share.revoke", record.folder, `link #${id}`);
    return done(c, "/shares", "ok", `Revoked the link for ${record.folder}`);
  });

  // ---------- activity and settings ----------

  app.get("/activity", (c) => {
    const filter = {
      actor: c.req.query("actor") ?? "",
      action: c.req.query("action") ?? "",
      path: (c.req.query("path") ?? "").slice(0, 200),
      all: c.req.query("all") === "1",
    };
    const rows = drive.queryActivity({
      actor: filter.actor || undefined,
      action: filter.action || undefined,
      path: filter.path || undefined,
      agentsOnly: !filter.all && !filter.actor,
      limit: 200,
    });
    const facets = drive.activityFacets();
    const actors = filter.all ? facets.actors : facets.actors.filter((a) => a.startsWith("key:") || a === filter.actor);
    return render(c, <ActivityPage ctx={ctx(c)} rows={rows} filter={filter} actors={actors} actions={facets.actions} />);
  });

  app.get("/settings", (c) =>
    render(
      c,
      <SettingsPage
        ctx={ctx(c)}
        dataDir={config.dataDir}
        maxFileBytes={config.maxFileBytes}
        envPassword={Boolean(process.env.THUMBDRIVE_ADMIN_PASSWORD)}
      />,
    ),
  );

  app.post("/settings/password", async (c) => {
    const body = await form(c);
    const client = deps.clientAddress(c);
    if (loginLimiter.blocked(client)) return done(c, "/settings", "error", "Too many failed attempts. Wait 15 minutes.");
    if (!(await auth.verifyPassword(str(body, "current")))) {
      loginLimiter.fail(client);
      return done(c, "/settings", "error", "The current password is wrong");
    }
    if (str(body, "password") !== str(body, "confirm")) return done(c, "/settings", "error", "The new passwords do not match");
    try {
      await auth.setPassword(str(body, "password"));
    } catch (error) {
      return done(c, "/settings", "error", userMessage(error));
    }
    drive.logActivity("admin", "password", null, "changed in the web UI");
    startSession(c);
    return done(c, "/settings", "ok", "Password changed. Other browsers were signed out.");
  });

  // ---------- public share links ----------

  const gone = (c: Context) =>
    render(c, <MessagePage title="Link not available" message="This share link has expired, was revoked, or never existed." />, 404);

  /** Resolve `?path=` (relative to the shared folder) to a drive path inside it, or undefined. */
  const shareTarget = (folder: string, rel: string | undefined): { drivePath: string; rel: string } | undefined => {
    try {
      const relPath = normalizeDrivePath(rel ?? "/");
      const drivePath = normalizeDrivePath(folder === "/" ? relPath : relPath === "/" ? folder : folder + relPath);
      return isWithin(drivePath, folder) ? { drivePath, rel: relPath } : undefined;
    } catch {
      return undefined;
    }
  };

  app.get("/s/:token", (c) => {
    const token = c.req.param("token");
    const share = shares.verify(token);
    if (!share) return gone(c);
    const target = shareTarget(share.folder, c.req.query("path"));
    if (!target || drive.kind(target.drivePath) !== "folder") return gone(c);
    return render(c, <SharePage token={token} share={share} rel={target.rel} entries={drive.list(target.drivePath)} />);
  });

  app.get("/s/:token/download", (c) => {
    const share = shares.verify(c.req.param("token"));
    if (!share) return gone(c);
    const target = shareTarget(share.folder, c.req.query("path"));
    if (!target || drive.kind(target.drivePath) !== "file") return gone(c);
    const file = drive.readFile(target.drivePath);
    shares.recordDownload(share.id);
    drive.logActivity(`share:#${share.id}`, "download", target.drivePath, `sha256 ${file.sha256}`);
    return downloadResponse(segmentsOf(target.drivePath).at(-1) ?? "download", file.bytes, file.sha256);
  });
}
