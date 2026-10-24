/**
 * The single admin: a scrypt password hash, server-side sessions and CSRF
 * tokens. Everything lives in the settings and sessions tables, so sessions
 * survive restarts and a password change signs every browser out.
 */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../storage/db.ts";

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** "scrypt$N$r$p$salt$hash" with base64url salt and hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password needs at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error("The password is too long");
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export class AdminAuth {
  private readonly secret: Buffer;

  constructor(private readonly db: DatabaseSync) {
    let secret = this.setting("csrf_secret");
    if (!secret) {
      secret = randomBytes(32).toString("base64url");
      this.db.prepare("INSERT OR IGNORE INTO settings (name, value) VALUES ('csrf_secret', ?)").run(secret);
      secret = this.setting("csrf_secret") as string;
    }
    this.secret = Buffer.from(secret, "base64url");
  }

  private setting(name: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE name = ?").get(name) as { value: string } | undefined;
    return row?.value;
  }

  hasPassword(): boolean {
    return this.setting("admin_password") !== undefined;
  }

  /** Set or replace the admin password. Signs out every session. */
  async setPassword(password: string): Promise<void> {
    validatePassword(password);
    const hash = await hashPassword(password);
    this.db
      .prepare("INSERT INTO settings (name, value) VALUES ('admin_password', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value")
      .run(hash);
    this.db.prepare("DELETE FROM sessions").run();
  }

  async verifyPassword(password: string): Promise<boolean> {
    const stored = this.setting("admin_password");
    if (!stored || password.length > MAX_PASSWORD_LENGTH) return false;
    return verifyPasswordHash(password, stored);
  }

  /** THUMBDRIVE_ADMIN_PASSWORD: the environment is the source of truth when set. */
  async applyEnvPassword(password: string | undefined): Promise<boolean> {
    if (!password) return false;
    if (await this.verifyPassword(password)) return false;
    await this.setPassword(password);
    return true;
  }

  /** Start a session. Returns the cookie value; only its hash is stored. */
  createSession(now = Date.now()): string {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date(now).toISOString());
    this.db
      .prepare("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(sha256(token), nowIso(), new Date(now + SESSION_TTL_MS).toISOString());
    return token;
  }

  sessionValid(token: string | undefined, now = Date.now()): boolean {
    if (!token || token.length > 100) return false;
    const row = this.db.prepare("SELECT expires_at FROM sessions WHERE id_hash = ?").get(sha256(token)) as
      | { expires_at: string }
      | undefined;
    return row !== undefined && row.expires_at > new Date(now).toISOString();
  }

  destroySession(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(token));
  }

  /** CSRF token bound to a cookie value (the session, or a pre-login cookie). */
  csrfToken(binding: string): string {
    return createHmac("sha256", this.secret).update(binding).digest("base64url");
  }

  checkCsrf(binding: string | undefined, token: string | undefined): boolean {
    if (!binding || !token) return false;
    const expected = Buffer.from(this.csrfToken(binding));
    const actual = Buffer.from(token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

/** Failed logins per client address: 10 per 15 minutes, then wait. */
export class LoginLimiter {
  private failures = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  blocked(client: string, now = Date.now()): boolean {
    const f = this.failures.get(client);
    if (!f) return false;
    if (now - f.start >= this.windowMs) {
      this.failures.delete(client);
      return false;
    }
    return f.count >= this.max;
  }

  fail(client: string, now = Date.now()): void {
    const f = this.failures.get(client);
    if (!f || now - f.start >= this.windowMs) this.failures.set(client, { start: now, count: 1 });
    else f.count++;
  }

  reset(client: string): void {
    this.failures.delete(client);
  }
}
