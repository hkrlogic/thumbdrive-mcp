/**
 * Read-only agent keys. A key is "td_" + 43 base64url characters (32 random
 * bytes). Only its SHA-256 is stored; the plain key is shown once at creation.
 * Each key is limited to one or more folders.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso, transaction } from "../storage/db.ts";
import { normalizeDrivePath } from "../storage/paths.ts";

export const KEY_PREFIX = "td_";

export interface KeyRecord {
  id: number;
  name: string;
  prefix: string;
  folders: string[];
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export class KeyStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Create a key for the given folders. Returns the plain key once; it cannot be recovered later. */
  create(name: string, folders: string[]): { key: string; record: KeyRecord } {
    if (!KEY_NAME.test(name)) {
      throw new Error("Key name must be 1-64 letters, digits, spaces, dots, dashes or underscores");
    }
    if (folders.length === 0) throw new Error("A key needs at least one folder (use / for the whole drive)");
    const normalized = [...new Set(folders.map(normalizeDrivePath))];
    const key = KEY_PREFIX + randomBytes(32).toString("base64url");
    const prefix = key.slice(0, KEY_PREFIX.length + 6);
    const id = transaction(this.db, () => {
      const result = this.db
        .prepare("INSERT INTO keys (name, prefix, hash, created_at) VALUES (?, ?, ?, ?)")
        .run(name, prefix, hashKey(key), nowIso());
      const keyId = Number(result.lastInsertRowid);
      const insert = this.db.prepare("INSERT INTO key_folders (key_id, folder) VALUES (?, ?)");
      for (const folder of normalized) insert.run(keyId, folder);
      return keyId;
    });
    return { key, record: this.get(id) as KeyRecord };
  }

  get(id: number): KeyRecord | undefined {
    const row = this.db
      .prepare("SELECT id, name, prefix, created_at, revoked_at, last_used_at FROM keys WHERE id = ?")
      .get(id) as Omit<KeyRecord, "folders"> | undefined;
    if (!row) return undefined;
    return { ...row, folders: this.foldersOf(row.id) };
  }

  list(): KeyRecord[] {
    const rows = this.db
      .prepare("SELECT id, name, prefix, created_at, revoked_at, last_used_at FROM keys ORDER BY id")
      .all() as unknown as Array<Omit<KeyRecord, "folders">>;
    return rows.map((row) => ({ ...row, folders: this.foldersOf(row.id) }));
  }

  private foldersOf(id: number): string[] {
    const rows = this.db
      .prepare("SELECT folder FROM key_folders WHERE key_id = ? ORDER BY folder")
      .all(id) as unknown as Array<{ folder: string }>;
    return rows.map((r) => r.folder);
  }

  /** Look up an active key by its plain value. Returns undefined for unknown or revoked keys. */
  verify(key: string | undefined | null): KeyRecord | undefined {
    if (!key?.startsWith(KEY_PREFIX) || key.length > 128) return undefined;
    const row = this.db
      .prepare("SELECT id FROM keys WHERE hash = ? AND revoked_at IS NULL")
      .get(hashKey(key)) as { id: number } | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE keys SET last_used_at = ? WHERE id = ?").run(nowIso(), row.id);
    return this.get(row.id);
  }

  /** Revoke by name. Returns false if no active key has that name. */
  revoke(name: string): boolean {
    const result = this.db
      .prepare("UPDATE keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL")
      .run(nowIso(), name);
    return Number(result.changes) > 0;
  }
}
