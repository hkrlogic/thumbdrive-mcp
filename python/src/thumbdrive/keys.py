"""Agent keys: td_ + 43 random characters, stored only as a SHA-256 hash."""

import hashlib
import secrets
import sqlite3
from dataclasses import dataclass

from . import paths
from .db import now


@dataclass(frozen=True)
class Key:
    id: int
    name: str
    prefix: str
    folders: list[str]
    created_at: str
    revoked_at: str | None
    last_used_at: str | None


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def create(db: sqlite3.Connection, name: str, folders: list[str]) -> str:
    """Create a key for the given folders and return it. This is the only time it is visible."""
    name = name.strip()
    if not name or len(name) > 100:
        raise ValueError("Give the key a name (up to 100 characters)")
    if not folders:
        raise ValueError("Pick at least one folder")
    if db.execute("SELECT 1 FROM keys WHERE name = ?", (name,)).fetchone():
        raise ValueError(f"A key named {name!r} already exists")
    key = "td_" + secrets.token_urlsafe(32)
    db.execute("BEGIN")
    cur = db.execute(
        "INSERT INTO keys (name, prefix, hash, created_at) VALUES (?, ?, ?, ?)", (name, key[:9], _hash(key), now())
    )
    for folder in sorted({paths.normalize(f) for f in folders}):
        db.execute("INSERT INTO key_folders (key_id, folder) VALUES (?, ?)", (cur.lastrowid, folder))
    db.execute("COMMIT")
    return key


def verify(db: sqlite3.Connection, key: str) -> Key | None:
    """The active key matching `key`, or None."""
    if not key.startswith("td_"):
        return None
    row = db.execute("SELECT id FROM keys WHERE hash = ? AND revoked_at IS NULL", (_hash(key),)).fetchone()
    if row is None:
        return None
    db.execute("UPDATE keys SET last_used_at = ? WHERE id = ?", (now(), row["id"]))
    return get(db, row["id"])


def get(db: sqlite3.Connection, key_id: int) -> Key | None:
    row = db.execute("SELECT * FROM keys WHERE id = ?", (key_id,)).fetchone()
    if row is None:
        return None
    folders = [
        r["folder"] for r in db.execute("SELECT folder FROM key_folders WHERE key_id = ? ORDER BY folder", (key_id,))
    ]
    return Key(
        row["id"], row["name"], row["prefix"], folders, row["created_at"], row["revoked_at"], row["last_used_at"]
    )


def all_keys(db: sqlite3.Connection) -> list[Key]:
    ids = [r["id"] for r in db.execute("SELECT id FROM keys ORDER BY revoked_at IS NOT NULL, name")]
    return [k for k in (get(db, i) for i in ids) if k]


def revoke(db: sqlite3.Connection, key_id: int) -> None:
    db.execute("UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", (now(), key_id))
