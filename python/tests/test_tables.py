"""The tables store: draft edits, review diff, publish, rollback, discard, paste, folder moves."""

import pytest
from starlette.applications import Starlette

from thumbdrive.drive import DriveError
from thumbdrive.table_templates import TEMPLATES
from thumbdrive.tables import Table, TableError, Tables


@pytest.fixture
def tables(app: Starlette) -> Tables:
    return app.state.tables


def servers(tables: Tables) -> Table:
    return tables.create("/infra/servers", TEMPLATES["servers"]["columns"])


def col(table: Table, name: str) -> str:
    column = table.column_named(name)
    assert column
    return column["id"]


def test_invalid_cells_are_kept_and_block_publishing(tables: Tables) -> None:
    t = servers(tables)
    host, ip = col(t, "Hostname"), col(t, "IP address")
    tables.edit(t, adds=[{"values": {host: "WEB-01", ip: "10.0.0.300"}}])
    assert tables.draft(t) == {1: {host: "web-01", ip: "10.0.0.300"}}
    problems = tables.problems(t)
    assert problems == ["Row 1, IP address: '10.0.0.300' is not a valid IPv4 or IPv6 address"]
    with pytest.raises(TableError, match="Fix 1 problem"):
        tables.publish(t, "first")
    tables.edit(t, updates=[{"row": 1, "values": {ip: "10.0.0.30"}}])
    assert tables.publish(t, "first") == 1


def test_key_must_be_unique_and_present(tables: Tables) -> None:
    t = servers(tables)
    host = col(t, "Hostname")
    tables.edit(t, adds=[{"values": {host: "a"}}, {"values": {host: "A."}}, {"values": {}}])
    problems = tables.problems(t)
    assert "Rows 1 and 2 have the same Hostname: a" in problems
    assert "Row 3: the key column Hostname is empty" in problems


def test_diff_publish_rollback_and_ids_are_never_reused(tables: Tables) -> None:
    t = servers(tables)
    host, os_ = col(t, "Hostname"), col(t, "OS")
    tables.edit(t, adds=[{"values": {host: "a"}}, {"values": {host: "b"}}])
    assert tables.publish(t, "v1") == 1
    tables.edit(t, updates=[{"row": 1, "values": {os_: "Debian"}}], adds=[{"values": {host: "c"}}], deletes=[2])
    diff = tables.diff(t)
    assert (diff.added, diff.changed, diff.removed) == ([3], [(1, ["OS"])], [2])
    assert tables.publish(t, "v2") == 2
    assert tables.version(t, 2).note == "v2" and tables.version(t, 2).row_count == 2
    tables.edit(t, adds=[{"values": {host: "d"}}])
    assert list(tables.draft(t)) == [1, 3, 4]  # row 2 is gone for good; ids keep climbing

    assert tables.rollback(t, 1) == 3
    v3 = tables.latest(t)
    assert (v3.note, v3.added, v3.changed, v3.removed) == ("Rollback to v1", 1, 1, 1)
    assert tables.rows(t, 3) == tables.rows(t, 1)
    assert tables.draft(t) == tables.rows(t, 1)
    assert tables.rows(t, 2)[3] == {host: "c"}  # old versions are untouched


def test_discard_resets_draft_to_latest(tables: Tables) -> None:
    t = servers(tables)
    host = col(t, "Hostname")
    tables.edit(t, adds=[{"values": {host: "a"}}])
    tables.publish(t, "v1")
    tables.edit(t, adds=[{"values": {host: "b"}}])
    tables.delete_column(t, col(t, "Notes"))
    tables.discard(t)
    t = tables.get(t.id)
    assert tables.draft(t) == {1: {host: "a"}}
    assert t.column_named("Notes")
    assert tables.diff(t).columns == []


def test_columns_add_rename_delete(tables: Tables) -> None:
    t = tables.create("/x/t", [{"name": "Name", "type": "text", "key": True}])
    tables.edit(t, adds=[{"values": {"c1": "a"}}])
    rack = tables.add_column(t, "Rack", "select", ["R1", "R2", "R1"])
    assert rack == {"id": "c2", "name": "Rack", "type": "select", "options": ["R1", "R2"]}
    with pytest.raises(TableError, match="already a column"):
        tables.add_column(t, "rack", "text")
    tables.rename_column(t, "c2", "Rack position")
    tables.delete_column(t, "c1")
    assert t.key_column is None and [c["id"] for c in t.columns] == ["c2"]
    assert tables.add_column(t, "Name", "text")["id"] == "c3"  # column ids are not reused either
    tables.publish(t, "v1")
    tables.delete_column(t, "c3")
    assert tables.diff(t).columns == ["Removed column Name"]


def test_paste_with_header_updates_by_key_and_appends(tables: Tables) -> None:
    t = servers(tables)
    host, ip = col(t, "Hostname"), col(t, "IP address")
    tables.edit(t, adds=[{"values": {host: "web-01"}}])
    added, updated = tables.paste(t, "IP address\tHostname\n10.0.0.1\tWEB-01\n10.0.0.2\tdb-01\n")
    assert (added, updated) == ([2], [1])
    assert tables.draft(t) == {1: {host: "web-01", ip: "10.0.0.1"}, 2: {host: "db-01", ip: "10.0.0.2"}}
    added, _ = tables.paste(t, "app-01,10.0.0.3")  # no header: columns in order
    assert tables.draft(t)[added[0]] == {host: "app-01", ip: "10.0.0.3"}


def test_folder_rename_moves_tables_and_delete_refuses(app: Starlette, tables: Tables) -> None:
    drive = app.state.drive
    drive.mkdir("/infra")
    t = servers(tables)
    with pytest.raises(DriveError, match="holds tables"):
        drive.delete("/infra")
    drive.rename("/infra", "/ops")
    assert tables.get(t.id).path == "/ops/servers"


def test_dev_seed_is_idempotent(tables: Tables) -> None:
    from thumbdrive.__main__ import seed_tables

    seed_tables(tables)
    seed_tables(tables)
    servers, plan = tables.by_path("/team/servers"), tables.by_path("/team/ip-plan")
    assert len(tables.problems(servers)) == 1 and len(tables.versions(servers)) == 1
    assert len(tables.versions(plan)) == 2 and tables.diff(plan).added == []
