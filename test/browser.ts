/** An in-process browser for the admin UI: a cookie jar, a Host header and CSRF-aware form posts. */
import assert from "node:assert/strict";
import type { Hono } from "hono";

export const PASSWORD = "correct horse battery";

/** A minimal browser: a cookie jar, Host header, and helpers to post forms with the page's CSRF token. */
export class Browser {
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

export async function signedIn(app: Hono): Promise<Browser> {
  const b = new Browser(app);
  const setupPage = await b.page("/setup");
  const res = await b.post("/setup", { password: PASSWORD, confirm: PASSWORD }, { csrf: setupPage.csrf });
  assert.equal(res.status, 303, "setup should succeed");
  return b;
}

