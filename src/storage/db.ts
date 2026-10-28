/** Small SQLite database for versions, keys, share links, admin settings and the activity log (node:sqlite). */
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
CREATE INDEX IF NOT EXISTS activity_actor ON activity (actor);
CREATE TABLE IF NOT EXISTS settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY,
  folder TEXT NOT NULL,
  label TEXT,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  downloads INTEGER NOT NULL DEFAULT 0
);
-- CyberDrive datasets (src/cyberdrive): one row per import; the highest version is current.
CREATE TABLE IF NOT EXISTS dataset_imports (
  id INTEGER PRIMARY KEY,
  dataset TEXT NOT NULL,
  version INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  actor TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (dataset, version)
);
CREATE TABLE IF NOT EXISTS key_datasets (
  key_id INTEGER NOT NULL REFERENCES keys (id) ON DELETE CASCADE,
  dataset TEXT NOT NULL,
  PRIMARY KEY (key_id, dataset)
);
CREATE TABLE IF NOT EXISTS oui_entries (
  prefix TEXT PRIMARY KEY,
  nibbles INTEGER NOT NULL,
  oui TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  registry TEXT,
  short_name TEXT,
  device_type TEXT,
  registered_date TEXT,
  address TEXT,
  sources TEXT,
  status TEXT,
  deregistered_date TEXT
);
CREATE TABLE IF NOT EXISTS winevent_events (
  event_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT NOT NULL,
  summary TEXT NOT NULL,
  min_os TEXT,
  position INTEGER NOT NULL,
  PRIMARY KEY (event_id, category, subcategory)
);
CREATE TABLE IF NOT EXISTS winevent_messages (
  event_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  message TEXT NOT NULL,
  min_os TEXT,
  PRIMARY KEY (event_id, version)
);
CREATE TABLE IF NOT EXISTS controls (
  framework TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent TEXT,
  family TEXT,
  family_title TEXT,
  title TEXT NOT NULL,
  statement TEXT,
  guidance TEXT,
  examples TEXT NOT NULL DEFAULT '[]',
  related TEXT NOT NULL DEFAULT '[]',
  withdrawn INTEGER NOT NULL DEFAULT 0,
  withdrawn_to TEXT NOT NULL DEFAULT '[]',
  extra TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL,
  PRIMARY KEY (framework, id)
);
CREATE INDEX IF NOT EXISTS controls_parent ON controls (framework, parent);
CREATE TABLE IF NOT EXISTS control_catalogs (
  framework TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  version TEXT,
  oscal_version TEXT,
  last_modified TEXT
);
CREATE TABLE IF NOT EXISTS control_mappings (
  source_framework TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_framework TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  PRIMARY KEY (source_framework, source_id, target_framework, target_id)
);
CREATE INDEX IF NOT EXISTS control_mappings_target ON control_mappings (target_framework, target_id);
CREATE TABLE IF NOT EXISTS user_tables (
  id INTEGER PRIMARY KEY,
  folder TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  columns TEXT NOT NULL DEFAULT '[]',
  key_column TEXT,
  next_row_id INTEGER NOT NULL DEFAULT 1,
  next_col_id INTEGER NOT NULL DEFAULT 1,
  published_version INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (folder, name)
);
CREATE TABLE IF NOT EXISTS user_table_draft (
  table_id INTEGER NOT NULL REFERENCES user_tables (id) ON DELETE CASCADE,
  row_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (table_id, row_id)
);
CREATE TABLE IF NOT EXISTS user_table_versions (
  table_id INTEGER NOT NULL REFERENCES user_tables (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  columns TEXT NOT NULL,
  key_column TEXT,
  note TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  added INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  column_changes TEXT NOT NULL DEFAULT '[]',
  rollback_of INTEGER,
  PRIMARY KEY (table_id, version)
);
-- Published row contents, valid from version v_from up to (not including) v_to; v_to NULL = current.
CREATE TABLE IF NOT EXISTS user_table_rows (
  table_id INTEGER NOT NULL REFERENCES user_tables (id) ON DELETE CASCADE,
  row_id INTEGER NOT NULL,
  v_from INTEGER NOT NULL,
  v_to INTEGER,
  data TEXT NOT NULL,
  PRIMARY KEY (table_id, row_id, v_from)
);
CREATE INDEX IF NOT EXISTS user_table_rows_current ON user_table_rows (table_id, v_to);
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
