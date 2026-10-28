"""Admin sign-in: one scrypt-hashed password, server-side sessions, CSRF tokens."""

import hashlib
import hmac
import secrets
import sqlite3
import time
from datetime import UTC, datetime, timedelta

from .db import now

SESSION_DAYS = 7
SCRYPT = {"n": 2**15, "r": 8, "p": 1}  # recorded in every hash, so it can change later
LOGIN_LIMIT, LOGIN_WINDOW = 10, 15 * 60  # failed sign-ins per client address per window


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, maxmem=2**26, dklen=32, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        actual = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), maxmem=2**26, dklen=32
        )
    except ValueError:
        return False
    return hmac.compare_digest(actual.hex(), digest)


def get_setting(db: sqlite3.Connection, name: str) -> str | None:
    row = db.execute("SELECT value FROM settings WHERE name = ?", (name,)).fetchone()
    return row["value"] if row else None


def set_setting(db: sqlite3.Connection, name: str, value: str) -> None:
    db.execute(
        "INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
        (name, value),
    )


def has_password(db: sqlite3.Connection) -> bool:
    return get_setting(db, "admin_password") is not None


def set_password(db: sqlite3.Connection, password: str) -> None:
    """Set the admin password and sign out every session."""
    if len(password) < 8:
        raise ValueError("The password must be at least 8 characters")
    set_setting(db, "admin_password", hash_password(password))
    db.execute("DELETE FROM sessions")


def apply_env_password(db: sqlite3.Connection, password: str) -> None:
    """THUMBDRIVE_ADMIN_PASSWORD wins at every start; only re-hash when it changed."""
    stored = get_setting(db, "admin_password")
    if password and not (stored and check_password(password, stored)):
        set_password(db, password)


def verify_password(db: sqlite3.Connection, password: str) -> bool:
    stored = get_setting(db, "admin_password")
    return stored is not None and check_password(password, stored)


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def new_session(db: sqlite3.Connection) -> str:
    token = secrets.token_urlsafe(32)
    expires = (datetime.now(UTC) + timedelta(days=SESSION_DAYS)).isoformat(timespec="seconds")
    db.execute("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)", (_sha(token), now(), expires))
    return token


def session_valid(db: sqlite3.Connection, token: str | None) -> bool:
    if not token:
        return False
    row = db.execute("SELECT expires_at FROM sessions WHERE id_hash = ?", (_sha(token),)).fetchone()
    return row is not None and row["expires_at"] > now()


def end_session(db: sqlite3.Connection, token: str | None) -> None:
    if token:
        db.execute("DELETE FROM sessions WHERE id_hash = ?", (_sha(token),))


def csrf_token(db: sqlite3.Connection, browser_id: str) -> str:
    """An HMAC of the browser's cookie (session, or pre-sign-in) with a server secret."""
    secret = get_setting(db, "csrf_secret")
    if secret is None:
        secret = secrets.token_hex(32)
        set_setting(db, "csrf_secret", secret)
    return hmac.new(secret.encode(), browser_id.encode(), "sha256").hexdigest()


class LoginLimiter:
    """At most LOGIN_LIMIT failed sign-ins per client address per LOGIN_WINDOW seconds."""

    def __init__(self) -> None:
        self.failures: dict[str, list[float]] = {}

    def blocked(self, client: str) -> bool:
        cutoff = time.monotonic() - LOGIN_WINDOW
        recent = [t for t in self.failures.get(client, []) if t > cutoff]
        self.failures[client] = recent
        return len(recent) >= LOGIN_LIMIT

    def failed(self, client: str) -> None:
        self.failures.setdefault(client, []).append(time.monotonic())
