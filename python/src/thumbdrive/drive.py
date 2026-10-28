"""The drive: plain files on disk, every version kept, plus the activity log.

    DATA_DIR/files/<drive path>    the current files, as normal files and folders
    DATA_DIR/versions/<sha256>     every stored version, named by its SHA-256
    DATA_DIR/thumbdrive.db         SQLite: versions, keys, activity, search index

Only the admin (web UI) changes the drive. Agents read it through tools.py.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from . import paths
from .db import now

SEARCH_MAX_BYTES = 5 * 1024 * 1024  # larger files are found by name only


class NotFound(LookupError):
    def __init__(self, path: str) -> None:
        super().__init__(f"Not found: {path}")


class DriveError(ValueError):
    """A request the drive refuses, with a message safe to show."""


@dataclass(frozen=True)
class Entry:
    name: str
    path: str
    type: str  # "file" or "folder"
    size: int | None
    sha256: str | None
    modified: str


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def is_text(data: bytes) -> bool:
    """UTF-8 without NUL bytes counts as text; everything else is binary."""
    if b"\x00" in data[:8192]:
        return False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def _write_atomic(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".tmp-")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, target)


class Drive:
    def __init__(self, data_dir: Path, db: sqlite3.Connection) -> None:
        self.db = db
        self.files = data_dir / "files"
        self.blobs = data_dir / "versions"
        self.files.mkdir(parents=True, exist_ok=True)
        self.blobs.mkdir(parents=True, exist_ok=True)

    # --- locating things -------------------------------------------------

    def disk(self, path: str) -> Path | None:
        """The on-disk location of a drive path, or None if it passes through a symlink."""
        current = self.files
        for part in path.strip("/").split("/") if path != "/" else []:
            current = current / part
            if current.is_symlink():
                return None
        return current

    def kind(self, path: str) -> str | None:
        p = self.disk(path)
        if p is None:
            return None
        if p.is_file():
            return "file"
        if p.is_dir():
            return "folder"
        return None

    def latest(self, path: str) -> sqlite3.Row | None:
        return self.db.execute(
            "SELECT * FROM versions WHERE path = ? ORDER BY version DESC LIMIT 1", (path,)
        ).fetchone()

    # --- reading ---------------------------------------------------------

    def list(self, path: str) -> list[Entry]:
        folder = self.disk(path)
        if folder is None or not folder.is_dir():
            raise NotFound(path)
        entries = []
        for child in sorted(folder.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())):
            if child.is_symlink() or child.name.startswith(".tmp-"):
                continue
            child_path = paths.join(path, child.name)
            modified = _mtime(child)
            if child.is_dir():
                entries.append(Entry(child.name, child_path, "folder", None, None, modified))
            elif child.is_file():
                row = self.latest(child_path)
                sha = row["sha256"] if row and row["action"] == "put" else None
                entries.append(Entry(child.name, child_path, "file", child.stat().st_size, sha, modified))
        return entries

    def read(self, path: str, version: int | None = None) -> tuple[bytes, int | None]:
        """Current bytes (or one stored version) and the version number."""
        if version is None:
            if self.kind(path) != "file":
                raise NotFound(path)
            data = self.disk(path).read_bytes()  # type: ignore[union-attr]
            row = self.latest(path)
            same = row is not None and row["action"] == "put" and row["sha256"] == sha256_hex(data)
            return data, row["version"] if same else None
        row = self.db.execute(
            "SELECT * FROM versions WHERE path = ? AND version = ? AND action = 'put'", (path, version)
        ).fetchone()
        if row is None:
            raise NotFound(f"{path} (version {version})")
        return (self.blobs / row["sha256"]).read_bytes(), version

    def history(self, path: str) -> list[dict]:
        rows = self.db.execute(
            "SELECT version, action, sha256, size, actor, created_at FROM versions"
            " WHERE path = ? ORDER BY version DESC",
            (path,),
        ).fetchall()
        return [dict(r) for r in rows]

    def deleted_in(self, folder: str) -> list[str]:
        """Files directly in `folder` whose latest version is a deletion (restorable)."""
        prefix = folder.rstrip("/") + "/"
        rows = self.db.execute(
            "SELECT v.path FROM versions v WHERE v.action = 'delete' AND substr(v.path, 1, ?) = ?"
            " AND v.version = (SELECT max(version) FROM versions WHERE path = v.path) ORDER BY v.path",
            (len(prefix), prefix),
        ).fetchall()
        return [r["path"] for r in rows if "/" not in r["path"][len(prefix) :]]

    def search(self, roots: list[str], query: str, limit: int = 50) -> list[dict]:
        """Case-insensitive substring match on names (walking the folders) and on text
        content (FTS5 trigram index). One hit per file, at most `limit`."""
        needle = query.lower()
        hits: dict[str, dict] = {}
        for root in roots:
            if self.kind(root) == "file":
                names = [root]
            elif self.kind(root) == "folder":
                base = self.disk(root)
                names = [paths.join(root, str(p.relative_to(base))) for p in sorted(base.rglob("*"))]  # type: ignore[union-attr]
            else:
                continue
            for p in names:
                if needle in paths.name_of(p).lower() and len(hits) < limit:
                    hits.setdefault(p, {"path": p, "match": "name"})
        like = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        for row in self.db.execute(
            "SELECT path, body FROM file_text WHERE body LIKE ? ESCAPE '\\' ORDER BY path", (like,)
        ):
            if len(hits) >= limit:
                break
            if row["path"] in hits or not any(paths.is_within(row["path"], r) for r in roots):
                continue
            for number, line in enumerate(row["body"].splitlines(), 1):
                if needle in line.lower():
                    hits[row["path"]] = {"path": row["path"], "match": "content", "line": number, "snippet": line[:200]}
                    break
        return list(hits.values())

    # --- changing (admin only) -------------------------------------------

    def put(self, path: str, data: bytes, actor: str = "admin") -> int:
        """Store bytes as the new current version of a file. Returns the version number."""
        if path == "/":
            raise DriveError("Choose a file name")
        target = self.disk(path)
        if target is None or target.is_dir():
            raise DriveError(f"{path} is a folder")
        parent = self.disk(paths.parent(path))
        if parent is None or (parent.exists() and not parent.is_dir()):
            raise DriveError(f"{paths.parent(path)} is not a folder")
        digest = sha256_hex(data)
        blob = self.blobs / digest
        if not blob.exists():
            _write_atomic(blob, data)
        _write_atomic(target, data)
        version = self._record(path, "put", digest, len(data), actor)
        self._index(path, data)
        self.log(actor, "put", path, f"version {version}")
        return version

    def mkdir(self, path: str) -> None:
        target = self.disk(path)
        if target is None or target.exists():
            raise DriveError(f"{path} already exists")
        target.mkdir(parents=True)
        self.log("admin", "mkdir", path)

    def delete(self, path: str, actor: str = "admin") -> None:
        """Delete a file or a whole folder. History is kept, so files can be restored."""
        if path == "/":
            raise DriveError("The root folder cannot be deleted")
        target = self.disk(path)
        if target is None or not target.exists():
            raise NotFound(path)
        for file_path in self._files_under(path):
            row = self.latest(file_path)
            if row is None or row["action"] != "delete":
                self._record(file_path, "delete", None, None, actor)
            self.db.execute("DELETE FROM file_text WHERE path = ?", (file_path,))
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
        self.log(actor, "delete", path)

    def rename(self, path: str, new_path: str) -> None:
        """Rename or move a file or folder. Its history and key grants move with it."""
        source, target = self.disk(path), self.disk(new_path)
        if path == "/" or source is None or not source.exists():
            raise NotFound(path)
        if target is None or target.exists():
            raise DriveError(f"{new_path} already exists")
        if paths.is_within(new_path, path):
            raise DriveError("A folder cannot be moved into itself")
        target.parent.mkdir(parents=True, exist_ok=True)
        if self._versions_exist_under(new_path):
            raise DriveError(f"{new_path} has history from an earlier file; pick another name")
        source.rename(target)
        n = len(path)
        for table, column in (("versions", "path"), ("file_text", "path"), ("key_folders", "folder")):
            self.db.execute(
                f"UPDATE {table} SET {column} = ? || substr({column}, ?)"
                f" WHERE {column} = ? OR {column} LIKE ? ESCAPE '\\'",
                (new_path, n + 1, path, _like_prefix(path)),
            )
        self.log("admin", "rename", path, f"to {new_path}")

    def restore(self, path: str, version: int) -> int:
        data, _ = self.read(path, version)
        new_version = self.put(path, data)
        self.log("admin", "restore", path, f"version {version} as version {new_version}")
        return new_version

    def sync(self) -> None:
        """At start: give files copied in by hand a version, and rebuild the search index."""
        self.db.execute("DELETE FROM file_text")
        for file_path in self._files_under("/"):
            data = self.disk(file_path).read_bytes()  # type: ignore[union-attr]
            digest = sha256_hex(data)
            row = self.latest(file_path)
            if row is None or row["action"] != "put" or row["sha256"] != digest:
                if not (self.blobs / digest).exists():
                    _write_atomic(self.blobs / digest, data)
                self._record(file_path, "put", digest, len(data), "disk")
            self._index(file_path, data)

    # --- activity log ----------------------------------------------------

    def log(self, actor: str, action: str, path: str | None, detail: str | None = None) -> None:
        self.db.execute(
            "INSERT INTO activity (at, actor, action, path, detail) VALUES (?, ?, ?, ?, ?)",
            (now(), actor, action, path, detail),
        )

    def activity(self, who: str = "agents", limit: int = 200) -> list[sqlite3.Row]:
        """Newest first. who: "agents" (every key), "all", or one actor name."""
        if who == "all":
            where, args = "", ()
        elif who == "agents":
            where, args = "WHERE actor NOT IN ('admin', 'disk')", ()
        else:
            where, args = "WHERE actor = ?", (who,)
        return self.db.execute(f"SELECT * FROM activity {where} ORDER BY id DESC LIMIT ?", (*args, limit)).fetchall()

    # --- internals -------------------------------------------------------

    def _record(self, path: str, action: str, digest: str | None, size: int | None, actor: str) -> int:
        row = self.latest(path)
        version = (row["version"] if row else 0) + 1
        self.db.execute(
            "INSERT INTO versions (path, version, action, sha256, size, actor, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (path, version, action, digest, size, actor, now()),
        )
        return version

    def _index(self, path: str, data: bytes) -> None:
        self.db.execute("DELETE FROM file_text WHERE path = ?", (path,))
        if len(data) <= SEARCH_MAX_BYTES and is_text(data):
            self.db.execute("INSERT INTO file_text (path, body) VALUES (?, ?)", (path, data.decode("utf-8")))

    def _files_under(self, path: str) -> list[str]:
        base = self.disk(path)
        if base is None:
            return []
        if base.is_file():
            return [path]
        found = []
        for root, dirs, names in os.walk(base):
            dirs[:] = [d for d in dirs if not (Path(root) / d).is_symlink()]
            for name in names:
                full = Path(root) / name
                if full.is_file() and not full.is_symlink() and not name.startswith(".tmp-"):
                    found.append(paths.join(path, str(full.relative_to(base))))
        return sorted(found)

    def _versions_exist_under(self, path: str) -> bool:
        return (
            self.db.execute(
                "SELECT 1 FROM versions WHERE path = ? OR path LIKE ? ESCAPE '\\' LIMIT 1", (path, _like_prefix(path))
            ).fetchone()
            is not None
        )


def _like_prefix(folder: str) -> str:
    return folder.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%"


def _mtime(p: Path) -> str:
    return datetime.fromtimestamp(p.stat().st_mtime, UTC).isoformat(timespec="seconds")


def all_folders(drive: Drive) -> list[str]:
    """Every folder on the drive, "/" first, for the key form."""
    found = ["/"]
    for root, dirs, _ in os.walk(drive.files):
        dirs[:] = sorted(d for d in dirs if not (Path(root) / d).is_symlink())
        for d in dirs:
            found.append(paths.join("/", str((Path(root) / d).relative_to(drive.files))))
    return sorted(found)
