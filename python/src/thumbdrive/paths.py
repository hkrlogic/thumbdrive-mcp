"""Drive paths and folder scopes.

A drive path is "/" or "/a/b/c": forward slashes, no empty, "." or ".."
segments, no control characters or backslashes.
"""

import re

FORBIDDEN = re.compile(r"[\x00-\x1f\x7f\\]")


class InvalidPath(ValueError):
    pass


def normalize(path: str) -> str:
    if len(path) > 1024:
        raise InvalidPath("Invalid path: too long")
    if FORBIDDEN.search(path):
        raise InvalidPath("Invalid path: control characters or backslashes are not allowed")
    parts = []
    for part in path.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise InvalidPath("Invalid path: '..' is not allowed")
        if len(part.encode()) > 255:
            raise InvalidPath("Invalid path: a name is too long")
        parts.append(part)
    return "/" + "/".join(parts)


def join(folder: str, name: str) -> str:
    return normalize(f"{folder}/{name}")


def parent(path: str) -> str:
    return path.rsplit("/", 1)[0] or "/"


def name_of(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def is_within(path: str, folder: str) -> bool:
    """True when path is folder itself or lies inside it."""
    return folder == "/" or path == folder or path.startswith(folder + "/")


class Scope:
    """What one key can see. Anything outside its folders does not exist for it."""

    def __init__(self, folders: list[str]) -> None:
        self.folders = [normalize(f) for f in folders]

    def can_see(self, path: str) -> bool:
        return any(is_within(path, f) for f in self.folders)

    def leads_to(self, path: str) -> set[str]:
        """For a parent of granted folders (e.g. "/" when only "/team" is granted):
        the names of its children that lead down to a granted folder."""
        depth = 0 if path == "/" else path.count("/")
        return {f.split("/")[depth + 1] for f in self.folders if f != path and is_within(f, path)}

    def search_roots(self, path: str) -> list[str]:
        if self.can_see(path):
            return [path]
        return [f for f in self.folders if is_within(f, path)]
