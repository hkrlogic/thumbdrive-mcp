/**
 * Read-only agent keys. A key is "td_" + 43 base64url characters (32 random
 * bytes). Only its SHA-256 is stored; the plain key is shown once at creation.
 * Each key is limited to one or more folders, and may also be granted
 * CyberDrive datasets (e.g. "oui"), which unlock the matching lookup tools.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDatasetName } from "../cyberdrive/datasets.ts";
import { nowIso, transaction } from "../storage/db.ts";
import { normalizeDrivePath } from "../storage/paths.ts";

export const KEY_PREFIX = "td_";

export interface KeyRecord {
  id: number;
  name: string;
  prefix: string;
  folders: string[];
  /** CyberDrive datasets this key may query (see src/cyberdrive). */
  datasets: string[];
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const NEEDS_ACCESS = "A key needs at least one folder (use / for the whole drive) or dataset";

function normalizeDatasets(datasets: string[]): string[] {
  const out = [...new Set(datasets.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  for (const d of out) if (!isDatasetName(d)) throw new Error(`Unknown dataset "${d}"`);
  return out.sort();
}

export class KeyStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Create a key for the given folders (and datasets). Returns the plain key once; it cannot be recovered later. */
  create(name: string, folders: string[], datasets: string[] = []): { key: string; record: KeyRecord } {
    if (!KEY_NAME.test(name)) {
      throw new Error("Key name must be 1-64 letters, digits, spaces, dots, dashes or underscores");
    }
    const grants = normalizeDatasets(datasets);
    if (folders.length === 0 && grants.length === 0) throw new Error(NEEDS_ACCESS);
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
      const grant = this.db.prepare("INSERT INTO key_datasets (key_id, dataset) VALUES (?, ?)");
      for (const d of grants) grant.run(keyId, d);
      return keyId;
    });
    return { key, record: this.get(id) as KeyRecord };
  }

  get(id: number): KeyRecord | undefined {
    const row = this.db
      .prepare("SELECT id, name, prefix, created_at, revoked_at, last_used_at FROM keys WHERE id = ?")
      .get(id) as Omit<KeyRecord, "folders" | "datasets"> | undefined;
    if (!row) return undefined;
    return { ...row, folders: this.foldersOf(row.id), datasets: this.datasetsOf(row.id) };
  }

  list(): KeyRecord[] {
    const rows = this.db
      .prepare("SELECT id, name, prefix, created_at, revoked_at, last_used_at FROM keys ORDER BY id")
      .all() as unknown as Array<Omit<KeyRecord, "folders" | "datasets">>;
    return rows.map((row) => ({ ...row, folders: this.foldersOf(row.id), datasets: this.datasetsOf(row.id) }));
  }

  private foldersOf(id: number): string[] {
    const rows = this.db
      .prepare("SELECT folder FROM key_folders WHERE key_id = ? ORDER BY folder")
      .all(id) as unknown as Array<{ folder: string }>;
    return rows.map((r) => r.folder);
  }

  private datasetsOf(id: number): string[] {
    const rows = this.db
      .prepare("SELECT dataset FROM key_datasets WHERE key_id = ? ORDER BY dataset")
      .all(id) as unknown as Array<{ dataset: string }>;
    return rows.map((r) => r.dataset);
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

  /**
   * Replace a key's folders, and its datasets when given (undefined keeps
   * them). Takes effect on the agent's next request.
   */
  setFolders(id: number, folders: string[], datasets?: string[]): KeyRecord {
    const record = this.get(id);
    if (!record) throw new Error("No such key");
    const grants = datasets === undefined ? record.datasets : normalizeDatasets(datasets);
    if (folders.length === 0 && grants.length === 0) throw new Error(NEEDS_ACCESS);
    const normalized = [...new Set(folders.map(normalizeDrivePath))];
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM key_folders WHERE key_id = ?").run(id);
      const insert = this.db.prepare("INSERT INTO key_folders (key_id, folder) VALUES (?, ?)");
      for (const folder of normalized) insert.run(id, folder);
      this.db.prepare("DELETE FROM key_datasets WHERE key_id = ?").run(id);
      const grant = this.db.prepare("INSERT INTO key_datasets (key_id, dataset) VALUES (?, ?)");
      for (const d of grants) grant.run(id, d);
    });
    return this.get(id) as KeyRecord;
  }

  /** Replace only a key's datasets. */
  setDatasets(id: number, datasets: string[]): KeyRecord {
    const record = this.get(id);
    if (!record) throw new Error("No such key");
    return this.setFolders(id, record.folders, datasets);
  }

  /**
   * A folder was renamed: point every key folder at or under `from` to the
   * same place under `to`, so agents keep their access.
   */
  retargetFolder(from: string, to: string): void {
    const src = normalizeDrivePath(from);
    const dest = normalizeDrivePath(to);
    const rows = this.db.prepare("SELECT key_id, folder FROM key_folders").all() as unknown as Array<{
      key_id: number;
      folder: string;
    }>;
    transaction(this.db, () => {
      for (const row of rows) {
        if (row.folder !== src && !row.folder.startsWith(src + "/")) continue;
        const next = dest + row.folder.slice(src.length);
        this.db.prepare("DELETE FROM key_folders WHERE key_id = ? AND folder = ?").run(row.key_id, row.folder);
        this.db.prepare("INSERT OR IGNORE INTO key_folders (key_id, folder) VALUES (?, ?)").run(row.key_id, next);
      }
    });
  }

  /** Revoke by id. Returns false if the key does not exist or is already revoked. */
  revokeById(id: number): boolean {
    const result = this.db
      .prepare("UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(nowIso(), id);
    return Number(result.changes) > 0;
  }

  /** Revoke by name. Returns false if no active key has that name. */
  revoke(name: string): boolean {
    const result = this.db
      .prepare("UPDATE keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL")
      .run(nowIso(), name);
    return Number(result.changes) > 0;
  }
}
