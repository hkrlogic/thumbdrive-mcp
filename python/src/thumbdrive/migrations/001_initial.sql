-- Thumbdrive schema, version 1.
-- The files themselves live on disk (DATA_DIR/files and DATA_DIR/versions);
-- this database only describes them. See DESIGN.md for the full layout.

-- Every admin change to a file: one row per stored version.
-- action 'put' points at DATA_DIR/versions/<sha256>; 'delete' marks a deletion.
CREATE TABLE versions (
  id         INTEGER PRIMARY KEY,
  path       TEXT    NOT NULL,              -- drive path, e.g. /team/handbook.md
  version    INTEGER NOT NULL,              -- 1, 2, 3 ... per path
  action     TEXT    NOT NULL CHECK (action IN ('put', 'delete')),
  sha256     TEXT,                          -- NULL for 'delete'
  size       INTEGER,                       -- bytes; NULL for 'delete'
  actor      TEXT    NOT NULL,              -- 'admin', 'disk' (found on disk) ...
  created_at TEXT    NOT NULL,              -- ISO 8601 UTC
  UNIQUE (path, version)
);

-- Agent keys. Only the SHA-256 of the key is stored; prefix tells keys apart.
CREATE TABLE keys (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,       -- hex SHA-256 of the full key
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_used_at TEXT
);

-- The folders each key may read (the folder and everything under it).
CREATE TABLE key_folders (
  key_id INTEGER NOT NULL REFERENCES keys (id) ON DELETE CASCADE,
  folder TEXT    NOT NULL,
  PRIMARY KEY (key_id, folder)
);

-- Every agent call and every admin change.
CREATE TABLE activity (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL,                     -- ISO 8601 UTC
  actor  TEXT NOT NULL,                     -- key name, or 'admin'
  action TEXT NOT NULL,                     -- list, read, search, history, upload ...
  path   TEXT,
  detail TEXT
);
CREATE INDEX activity_actor ON activity (actor);

-- Small named values: admin_password (scrypt hash), csrf_secret.
CREATE TABLE settings (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Web sessions. Only the SHA-256 of the cookie value is stored.
CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Search index over the current text files. Derived data: it is rebuilt from
-- DATA_DIR/files on every start, so it never needs a backup.
CREATE VIRTUAL TABLE file_text USING fts5(path UNINDEXED, body, tokenize = 'trigram');
