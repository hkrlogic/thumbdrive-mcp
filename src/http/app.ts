/**
 * HTTP surface: /healthz and the Streamable HTTP MCP endpoint at /mcp.
 * Order of checks on /mcp: Host and Origin, transport security, key, rate
 * limit, body size. Only then does the request reach the MCP handler.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Reader } from "../agent/reader.ts";
import type { KeyStore } from "../auth/keys.ts";
import type { Config } from "../config.ts";
import { createMcpServer } from "../mcp/server.ts";
import type { Drive } from "../storage/drive.ts";
import { APP_NAME, APP_VERSION } from "../version.ts";

export interface AppDeps {
  drive: Drive;
  keys: KeyStore;
  config: Config;
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

export function createApp({ drive, keys, config }: AppDeps): { app: Hono; close: () => Promise<void> } {
  const app = new Hono();
  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const allowedHosts = [...localhostAllowedHostnames(), ...config.allowedHosts];
  const allowedOrigins = [...localhostAllowedOrigins(), ...config.allowedHosts];

  const handler = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as { folders?: string[] } | undefined;
      const folders = extra?.folders ?? [];
      const reader = new Reader(drive, folders, `key:${ctx.authInfo?.clientId ?? "unknown"}`, {
        pageBytes: config.readPageBytes,
        pageRows: config.readPageRows,
      });
      return createMcpServer(reader);
    },
    { onerror: (error) => console.error("[thumbdrive] mcp:", error.message) },
  );

  app.get("/healthz", (c) => c.json({ ok: true, name: APP_NAME, version: APP_VERSION }));

  app.use("/mcp", async (c, next) => {
    const rejected =
      hostHeaderValidationResponse(c.req.raw, allowedHosts) ?? originValidationResponse(c.req.raw, allowedOrigins);
    if (rejected) return rejected;

    if (!config.allowInsecureHttp) {
      const forwardedProto = c.req.header("x-forwarded-proto");
      const address = remoteAddress(c);
      const insecureProxy = forwardedProto !== undefined && forwardedProto.split(",")[0].trim() !== "https";
      const insecureDirect = forwardedProto === undefined && address !== undefined && !isLocalAddress(address);
      if (insecureProxy || insecureDirect) {
        return jsonError(403, "Plain HTTP is only allowed on localhost and private networks. Put Thumbdrive behind HTTPS.");
      }
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
        extra: { keyId: key.id, folders: key.folders },
      },
    });
  });

  return { app, close: () => handler.close() };
}
