/**
 * HTTP surface: /healthz, the Streamable HTTP MCP endpoint at /mcp, and the
 * admin web UI (src/web/ui.tsx) on everything else.
 * Every route but /healthz first passes the Host/Origin and transport checks.
 * Then /mcp checks body size, key and rate limit; the UI checks CSRF and the
 * admin session.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Reader } from "../agent/reader.ts";
import type { KeyStore } from "../auth/keys.ts";
import type { Config } from "../config.ts";
import { DatasetReader } from "../cyberdrive/agent.ts";
import type { DatasetStore } from "../cyberdrive/datasets.ts";
import { createDatasetStore } from "../cyberdrive/index.ts";
import { createMcpServer } from "../mcp/server.ts";
import type { Drive } from "../storage/drive.ts";
import { TableReader } from "../tables/agent.ts";
import { TableStore } from "../tables/store.ts";
import { APP_NAME, APP_VERSION } from "../version.ts";
import { AdminAuth, LoginLimiter } from "../web/auth.ts";
import { ShareStore } from "../web/shares.ts";
import { registerUi } from "../web/ui.tsx";

export interface AppDeps {
  drive: Drive;
  keys: KeyStore;
  config: Config;
  /** CyberDrive datasets; created from the drive when omitted. */
  datasets?: DatasetStore;
  /** User tables; created from the drive when omitted. */
  tables?: TableStore;
}

/** Loopback and private (RFC 1918, CGNAT, ULA, link-local) addresses: plain HTTP is acceptable there. */
export function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase().replace(/^::ffff:/, "");
  if (a === "::1" || a === "localhost") return true;
  const v4 = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [o1, o2] = [Number(v4[1]), Number(v4[2])];
    return (
      o1 === 127 ||
      o1 === 10 ||
      (o1 === 172 && o2 >= 16 && o2 <= 31) ||
      (o1 === 192 && o2 === 168) ||
      (o1 === 169 && o2 === 254) ||
      (o1 === 100 && o2 >= 64 && o2 <= 127)
    );
  }
  return a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80:");
}

/** Hostname part of a Host header or URL authority: "[fd00::1]:8484" -> "fd00::1". */
export function hostnameOf(authority: string): string {
  const a = authority.trim().toLowerCase();
  if (a.startsWith("[")) return a.slice(1, a.indexOf("]") === -1 ? undefined : a.indexOf("]"));
  const colons = a.split(":").length - 1;
  return colons === 1 ? a.slice(0, a.indexOf(":")) : a; // bare IPv6 has many colons
}

const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|:/;

/**
 * DNS-rebinding guard for Host and Origin. Accepted: localhost names, names
 * listed in ALLOWED_HOSTS, and loopback or private IP literals (so
 * http://192.168.1.20:8484/mcp works on a home network with no setup).
 * Other names, e.g. nas.local or a public domain, must be listed in ALLOWED_HOSTS.
 */
export function isAllowedHostname(hostname: string, allowedHosts: string[]): boolean {
  if (!hostname) return false;
  if (hostname === "localhost" || allowedHosts.includes(hostname)) return true;
  return IP_LITERAL.test(hostname) && isLocalAddress(hostname);
}

function hostOriginRejection(req: Request, allowedHosts: string[]): Response | undefined {
  const host = req.headers.get("host");
  if (!host || !isAllowedHostname(hostnameOf(host), allowedHosts)) {
    return jsonError(403, "Host not allowed. Add it to ALLOWED_HOSTS.");
  }
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = hostnameOf(new URL(origin).host);
    } catch {
      originHost = "";
    }
    if (!isAllowedHostname(originHost, allowedHosts)) return jsonError(403, "Origin not allowed.");
  }
  return undefined;
}

/**
 * Plain HTTP is fine on loopback and private networks. Anything else must
 * come through an HTTPS proxy that runs on a local or private address and
 * sets X-Forwarded-Proto: https. X-Forwarded-Proto from a public peer is
 * ignored, since anyone can send that header.
 */
export function plainHttpRejected(peer: string | undefined, forwardedProto: string | undefined): boolean {
  const proto = forwardedProto?.split(",")[0].trim().toLowerCase();
  if (peer !== undefined && !isLocalAddress(peer)) return true;
  return proto !== undefined && proto !== "https";
}

function remoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // in-process requests (tests) have no socket
  }
}

/** Fixed one-minute windows per key. Small and good enough for one drive. */
class RateLimiter {
  private windows = new Map<number, { start: number; count: number }>();
  constructor(private readonly perMinute: number) {}
  allow(keyId: number, now = Date.now()): boolean {
    const w = this.windows.get(keyId);
    if (!w || now - w.start >= 60_000) {
      this.windows.set(keyId, { start: now, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= this.perMinute;
  }
}

function jsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Whether the request reached us over HTTPS: only a local or private proxy is trusted to say so. */
function viaHttps(c: Context): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  const peer = remoteAddress(c);
  if (peer !== undefined && !isLocalAddress(peer)) return false;
  return c.req.header("x-forwarded-proto")?.split(",")[0].trim().toLowerCase() === "https";
}

export interface App {
  app: Hono;
  auth: AdminAuth;
  datasets: DatasetStore;
  tables: TableStore;
  close: () => Promise<void>;
}

export function createApp({ drive, keys, config, datasets = createDatasetStore(drive, config), tables = new TableStore(drive) }: AppDeps): App {
  const app = new Hono();
  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const allowedHosts = config.allowedHosts.map(hostnameOf);
  if (config.publicUrl) allowedHosts.push(hostnameOf(new URL(config.publicUrl).host));
  const auth = new AdminAuth(drive.db);

  const handler = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as { folders?: string[]; datasets?: string[] } | undefined;
      const folders = extra?.folders ?? [];
      const actor = `key:${ctx.authInfo?.clientId ?? "unknown"}`;
      const reader = new Reader(drive, folders, actor, {
        pageBytes: config.readPageBytes,
        pageRows: config.readPageRows,
      });
      const datasetReader = new DatasetReader(datasets, extra?.datasets ?? [], actor);
      return createMcpServer(reader, datasetReader, new TableReader(tables, reader.scope, actor, datasetReader));
    },
    { onerror: (error) => console.error("[thumbdrive] mcp:", error.message) },
  );

  app.get("/healthz", (c) => c.json({ ok: true, name: APP_NAME, version: APP_VERSION }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/healthz") return next();
    const rejected = hostOriginRejection(c.req.raw, allowedHosts);
    if (rejected) return rejected;

    if (!config.allowInsecureHttp && plainHttpRejected(remoteAddress(c), c.req.header("x-forwarded-proto"))) {
      return jsonError(
        403,
        "Plain HTTP is only allowed from localhost and private networks. Put Thumbdrive behind HTTPS for anything else.",
      );
    }
    await next();
  });

  app.use("/mcp", bodyLimit({ maxSize: 1024 * 1024, onError: () => jsonError(413, "Request body too large") }));

  app.all("/mcp", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.match(/^Bearer\s+(\S+)$/i)?.[1];
    const key = keys.verify(token);
    if (!key) {
      return jsonError(401, "A valid Thumbdrive key is required (Authorization: Bearer td_...)", {
        "WWW-Authenticate": `Bearer realm="${APP_NAME}"`,
      });
    }
    if (!limiter.allow(key.id)) {
      return jsonError(429, "Too many requests for this key; slow down.", { "Retry-After": "60" });
    }
    return handler.fetch(c.req.raw, {
      authInfo: {
        token: token as string,
        clientId: key.name,
        scopes: ["read"],
        extra: { keyId: key.id, folders: key.folders, datasets: key.datasets },
      },
    });
  });

  registerUi(app, {
    drive,
    keys,
    datasets,
    tables,
    config,
    auth,
    shares: new ShareStore(drive.db),
    loginLimiter: new LoginLimiter(),
    isHttps: viaHttps,
    clientAddress: (c) => remoteAddress(c) ?? "local",
  });

  return { app, auth, datasets, tables, close: () => handler.close() };
}
