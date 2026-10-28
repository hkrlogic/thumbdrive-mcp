from pathlib import Path

import pytest

from thumbdrive import db, paths
from thumbdrive.drive import Drive, DriveError, NotFound


@pytest.fixture
def drive(tmp_path: Path) -> Drive:
    conn = db.connect(tmp_path / "thumbdrive.db")
    return Drive(tmp_path, conn)


def test_versions_are_kept_and_restorable(drive: Drive) -> None:
    drive.put("/a.txt", b"one")
    drive.put("/a.txt", b"two")
    assert drive.read("/a.txt") == (b"two", 2)
    assert drive.read("/a.txt", 1) == (b"one", 1)
    drive.restore("/a.txt", 1)
    assert drive.read("/a.txt") == (b"one", 3)
    drive.delete("/a.txt")
    with pytest.raises(NotFound):
        drive.read("/a.txt")
    assert [v["action"] for v in drive.history("/a.txt")] == ["delete", "put", "put", "put"]
    drive.restore("/a.txt", 2)
    assert drive.read("/a.txt")[0] == b"two"


def test_rename_moves_history_and_search(drive: Drive) -> None:
    drive.put("/old/a.txt", b"needle in a haystack")
    drive.rename("/old", "/new")
    assert drive.read("/new/a.txt")[0].startswith(b"needle")
    assert len(drive.history("/new/a.txt")) == 1
    assert [h["path"] for h in drive.search(["/"], "NEEDLE")] == ["/new/a.txt"]
    with pytest.raises(DriveError):
        drive.rename("/new", "/new/inside")


def test_search_escapes_like_wildcards(drive: Drive) -> None:
    drive.put("/a.txt", b"100% sure")
    drive.put("/b.txt", b"100 percent")
    assert [h["path"] for h in drive.search(["/"], "0%")] == ["/a.txt"]


def test_files_dropped_on_disk_are_adopted(drive: Drive) -> None:
    (drive.files / "dropped.txt").write_text("hello from disk")
    drive.sync()
    assert drive.read("/dropped.txt") == (b"hello from disk", 1)
    assert drive.history("/dropped.txt")[0]["actor"] == "disk"


def test_paths_reject_traversal() -> None:
    for bad in ["/../etc", "a\\b", "/x\x00y"]:
        with pytest.raises(paths.InvalidPath):
            paths.normalize(bad)
    assert paths.normalize("team//notes/") == "/team/notes"
    scope = paths.Scope(["/team"])
    assert scope.can_see("/team/x") and not scope.can_see("/teamwork") and not scope.can_see("/")
