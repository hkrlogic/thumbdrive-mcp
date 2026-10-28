"""The SQLite database: open it and apply numbered migrations.

Migrations are plain SQL files in ``migrations/`` named ``NNN_description.sql``.
Each runs once, in order, inside a transaction; the applied number is kept in
SQLite's own ``PRAGMA user_version``. Never edit a released migration: add a new one.
"""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

MIGRATIONS = Path(__file__).parent / "migrations"


def now() -> str:
    """The current time as ISO 8601 UTC, the format every timestamp column uses."""
    return datetime.now(UTC).isoformat(timespec="seconds")


def connect(file: Path) -> sqlite3.Connection:
    """Open the database (creating it if needed) and bring its schema up to date."""
    db = sqlite3.connect(file, check_same_thread=False, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 5000")
    migrate(db)
    return db


def migrate(db: sqlite3.Connection) -> None:
    current = db.execute("PRAGMA user_version").fetchone()[0]
    for script in sorted(MIGRATIONS.glob("*.sql")):
        number = int(script.name.split("_", 1)[0])
        if number <= current:
            continue
        db.execute("BEGIN IMMEDIATE")
        try:
            for statement in _statements(script.read_text()):
                db.execute(statement)
            db.execute(f"PRAGMA user_version = {number}")
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise


def _statements(sql: str) -> list[str]:
    """Split a migration file into statements (our migrations have no ';' inside strings)."""
    lines = [line.split("--", 1)[0] for line in sql.splitlines()]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


@contextmanager
def transaction(db: sqlite3.Connection) -> Iterator[None]:
    """BEGIN IMMEDIATE ... COMMIT, or ROLLBACK on any error."""
    db.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        db.execute("ROLLBACK")
        raise
    db.execute("COMMIT")
