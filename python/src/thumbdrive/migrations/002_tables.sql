-- Tables: small typed datasets edited in a grid and published as numbered versions.
-- A table lives at a drive path such as /inventory/servers (folder /inventory).
-- Row data is JSON keyed by column id ("c1", "c2", ...); ids never change or get reused.

CREATE TABLE tables (
    id             INTEGER PRIMARY KEY,
    path           TEXT NOT NULL UNIQUE,
    description    TEXT NOT NULL DEFAULT '',
    columns        TEXT NOT NULL DEFAULT '[]',  -- draft columns: [{"id", "name", "type", "options"}]
    key_column     TEXT,                        -- draft key column id, or NULL
    next_row_id    INTEGER NOT NULL DEFAULT 1,  -- only goes up, so row ids are never reused
    next_column_id INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

-- The draft: what the admin is editing. Invalid cells are stored as typed.
CREATE TABLE table_draft_rows (
    table_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    row_id   INTEGER NOT NULL,
    data     TEXT NOT NULL,                     -- {"c1": value, ...}
    PRIMARY KEY (table_id, row_id)
);

-- Published versions. Each is a full snapshot (columns + every row); agents read the newest.
CREATE TABLE table_versions (
    table_id     INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    columns      TEXT NOT NULL,
    key_column   TEXT,
    note         TEXT NOT NULL,
    published_at TEXT NOT NULL,
    row_count    INTEGER NOT NULL,
    added        INTEGER NOT NULL,
    changed      INTEGER NOT NULL,
    removed      INTEGER NOT NULL,
    PRIMARY KEY (table_id, version)
);

CREATE TABLE table_version_rows (
    table_id INTEGER NOT NULL,
    version  INTEGER NOT NULL,
    row_id   INTEGER NOT NULL,
    data     TEXT NOT NULL,                     -- canonical values only
    PRIMARY KEY (table_id, version, row_id),
    FOREIGN KEY (table_id, version) REFERENCES table_versions(table_id, version) ON DELETE CASCADE
);
