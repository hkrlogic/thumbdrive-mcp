/** Small SQLite database for versions, keys and the activity log (node:sqlite). */
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('put', 'delete')),
  sha256 TEXT,
  size INTEGER,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (path, version)
);
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS key_folders (
  key_id INTEGER NOT NULL REFERENCES keys (id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  PRIMARY KEY (key_id, folder)
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  path TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS activity_at ON activity (at);
`;

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside a transaction. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
