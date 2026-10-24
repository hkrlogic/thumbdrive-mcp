/**
 * Share links: a browser link that lets anyone holding it download the files
 * in one folder until it expires or is revoked. The token is 32 random bytes;
 * only its SHA-256 is stored, so a link is shown once at creation.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../storage/db.ts";
import { normalizeDrivePath } from "../storage/paths.ts";

export const SHARE_PREFIX = "tds_";

/** Expiry choices offered in the UI, in hours. 24 hours is the default. */
export const SHARE_EXPIRY_HOURS = [1, 24, 24 * 7, 24 * 30] as const;
export const DEFAULT_SHARE_HOURS = 24;

export interface ShareRecord {
  id: number;
  folder: string;
  label: string | null;
  prefix: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  downloads: number;
}

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const COLUMNS = "id, folder, label, prefix, created_at, expires_at, revoked_at, last_used_at, downloads";

export class ShareStore {
  constructor(private readonly db: DatabaseSync) {}

  create(folder: string, hours: number, label = "", now = Date.now()): { token: string; record: ShareRecord } {
    if (!(SHARE_EXPIRY_HOURS as readonly number[]).includes(hours)) throw new Error("Pick one of the offered expiry times");
    const cleanLabel = label.trim().slice(0, 80) || null;
    const token = SHARE_PREFIX + randomBytes(32).toString("base64url");
    const result = this.db
      .prepare("INSERT INTO share_links (folder, label, prefix, hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        normalizeDrivePath(folder),
        cleanLabel,
        token.slice(0, SHARE_PREFIX.length + 6),
        hashToken(token),
        new Date(now).toISOString(),
        new Date(now + hours * 3600_000).toISOString(),
      );
    return { token, record: this.get(Number(result.lastInsertRowid)) as ShareRecord };
  }

  get(id: number): ShareRecord | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM share_links WHERE id = ?`).get(id) as ShareRecord | undefined;
  }

  /** Links that still work, newest first. */
  listActive(now = Date.now()): ShareRecord[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM share_links WHERE revoked_at IS NULL AND expires_at > ? ORDER BY id DESC`)
      .all(new Date(now).toISOString()) as unknown as ShareRecord[];
  }

  /** Expired or revoked links, newest first. */
  listInactive(now = Date.now(), limit = 20): ShareRecord[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM share_links WHERE revoked_at IS NOT NULL OR expires_at <= ? ORDER BY id DESC LIMIT ?`)
      .all(new Date(now).toISOString(), limit) as unknown as ShareRecord[];
  }

  /** The link for a token, if it is neither revoked nor expired. */
  verify(token: string | undefined, now = Date.now()): ShareRecord | undefined {
    if (!token?.startsWith(SHARE_PREFIX) || token.length > 128) return undefined;
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM share_links WHERE hash = ? AND revoked_at IS NULL AND expires_at > ?`)
      .get(hashToken(token), new Date(now).toISOString()) as ShareRecord | undefined;
    return row;
  }

  recordDownload(id: number): void {
    this.db.prepare("UPDATE share_links SET downloads = downloads + 1, last_used_at = ? WHERE id = ?").run(nowIso(), id);
  }

  revoke(id: number): boolean {
    const result = this.db.prepare("UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id);
    return Number(result.changes) > 0;
  }

  /** A folder was renamed: keep its links working. */
  retargetFolder(from: string, to: string): void {
    const src = normalizeDrivePath(from);
    const dest = normalizeDrivePath(to);
    this.db
      .prepare("UPDATE share_links SET folder = ? || substr(folder, ?) WHERE folder = ? OR substr(folder, 1, ?) = ?")
      .run(dest, src.length + 1, src, src.length + 1, src + "/");
  }
}
