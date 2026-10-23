/** Runtime settings, read once from the environment. */
import path from "node:path";

export interface Config {
  /** Root of the mounted data folder: files/, versions/, tmp/ and thumbdrive.db live here. */
  dataDir: string;
  port: number;
  /** Interface to bind. Localhost by default; opening up is an explicit choice. */
  bindHost: string;
  /** Largest file the admin may store, in bytes. */
  maxFileBytes: number;
  /** Bytes per page for raw and text reads. */
  readPageBytes: number;
  /** Rows per page for CSV row views. */
  readPageRows: number;
  /** Extra Host header names accepted on /mcp (besides localhost names). */
  allowedHosts: string[];
  /** Tool calls allowed per key per minute. */
  rateLimitPerMinute: number;
  /** Allow plain HTTP from non-local addresses. Off by default; for testing only. */
  allowInsecureHttp: boolean;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    port: intFromEnv(env, "PORT", 8484),
    bindHost: env.BIND_HOST ?? "127.0.0.1",
    maxFileBytes: intFromEnv(env, "MAX_FILE_MB", 50) * 1024 * 1024,
    readPageBytes: intFromEnv(env, "READ_PAGE_BYTES", 64 * 1024),
    readPageRows: intFromEnv(env, "READ_PAGE_ROWS", 200),
    allowedHosts: (env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    rateLimitPerMinute: intFromEnv(env, "RATE_LIMIT_PER_MINUTE", 120),
    allowInsecureHttp: env.ALLOW_INSECURE_HTTP === "1",
  };
}
