"""Admin pages for tables: JSON edits need the CSRF header, templates, CSV import, review/publish/rollback."""

import re

from conftest import csrf_of
from starlette.applications import Starlette
from starlette.testclient import TestClient


def meta_csrf(html: str) -> str:
    match = re.search(r'<meta name="csrf" content="([^"]+)"', html)
    assert match
    return match.group(1)


def create_servers(admin: TestClient) -> str:
    token = csrf_of(admin.get("/tables").text)
    form = {"_csrf": token, "template": "servers", "folder": "/infra", "name": "servers"}
    response = admin.post("/tables/create", data=form)
    assert response.status_code == 303 and response.headers["location"].startswith("/tables/1?notice=")
    return token


def test_tables_need_sign_in(client: TestClient) -> None:
    assert client.get("/tables").status_code in (302, 303)
    assert client.post("/tables/1/edits", json={}).status_code in (302, 303, 403)


def test_grid_json_edits_and_csrf_header(app: Starlette, admin: TestClient) -> None:
    create_servers(admin)
    page = admin.get("/tables/1")
    assert page.status_code == 200 and 'id="grid"' in page.text and "tabulator-6.7.1.min.js" in page.text
    assert "<script>" not in page.text  # strict CSP: no inline scripts
    token = meta_csrf(page.text)
    draft = admin.get("/tables/1/draft.json").json()
    host = draft["table"]["keyColumn"]
    ip = next(c["id"] for c in draft["table"]["columns"] if c["name"] == "IP address")

    body = {"adds": [{"values": {host: "web-01", ip: "10.0.0.300"}}]}
    assert admin.post("/tables/1/edits", json=body).status_code == 403
    assert admin.post("/tables/1/edits", json=body, headers={"X-CSRF-Token": "nope"}).status_code == 403
    out = admin.post("/tables/1/edits", json=body, headers={"X-CSRF-Token": token}).json()
    assert out["added"] == [{"id": 1}]
    assert "not a valid" in out["rows"][0]["errors"][ip]

    out = admin.post("/tables/1/paste", json={"text": "db-01\t10.0.0.2"}, headers={"X-CSRF-Token": token}).json()
    assert (out["added"], out["updated"], out["invalid"]) == (1, 0, 0)
    bad = admin.post("/tables/1/edits", json={"deletes": ["x"]}, headers={"X-CSRF-Token": token})
    assert bad.status_code == 400 and "error" in bad.json()

    review = admin.get("/tables/1/review").text
    assert "10.0.0.300" in review and "r1 web-01" in review
    assert (
        admin.post("/tables/1/publish", data={"_csrf": token, "note": "first"})
        .headers["location"]
        .startswith("/tables/1/review?error=")
    )
    admin.post(
        "/tables/1/edits", json={"updates": [{"row": 1, "values": {ip: "10.0.0.1"}}]}, headers={"X-CSRF-Token": token}
    )
    response = admin.post("/tables/1/publish", data={"_csrf": token, "note": "first"})
    assert response.headers["location"] == "/tables/1/versions?notice=Published%20version%201"
    admin.post("/tables/1/edits", json={"deletes": [2]}, headers={"X-CSRF-Token": token})
    admin.post("/tables/1/publish", data={"_csrf": token, "note": "drop db-01"})
    versions = admin.get("/tables/1/versions").text
    assert "drop db-01" in versions and "first" in versions
    admin.post("/tables/1/rollback", data={"_csrf": token, "version": "1"})
    assert app.state.tables.latest(app.state.tables.get(1)).note == "Rollback to v1"
    assert "db-01" in admin.get("/tables/1/versions/3").text
    assert any(r["action"] == "table rollback" for r in app.state.drive.activity("all"))


def test_columns_are_managed_with_forms(app: Starlette, admin: TestClient) -> None:
    token = create_servers(admin)
    admin.post("/tables/1/columns/add", data={"_csrf": token, "name": "Rack", "type": "select", "options": "R1, R2"})
    table = app.state.tables.get(1)
    rack = table.column_named("Rack")
    assert rack and rack["options"] == ["R1", "R2"]
    admin.post("/tables/1/columns/rename", data={"_csrf": token, "column": rack["id"], "name": "Rack slot"})
    admin.post("/tables/1/columns/delete", data={"_csrf": token, "column": rack["id"]})
    assert app.state.tables.get(1).column_named("Rack slot") is None


def test_csv_import_preview_then_confirm(app: Starlette, admin: TestClient) -> None:
    token = csrf_of(admin.get("/tables").text)
    csv = (
        "\ufeffHostname;IP address;Description\nweb-01;10.0.0.1;front\ndb-01;10.0.0.999;data\n"
        + "".join(f"app-0{i};10.0.1.{i};x\n" for i in range(3))
    ).encode()
    preview = admin.post(
        "/tables/import",
        data={"_csrf": token, "folder": "/infra", "name": "imported"},
        files={"file": ("servers.csv", csv, "text/csv")},
    )
    assert preview.status_code == 200 and "5 rows found" in preview.text
    assert re.search(r'name="type_1"[^>]*>.*?<option value="ip" selected', preview.text, re.S)
    assert re.search(r'name="type_2"[^>]*>.*?<option value="text" selected', preview.text, re.S)
    import_token = re.search(r'name="token" value="([^"]+)"', preview.text).group(1)
    form = {"_csrf": token, "token": import_token, "key": "0", "type_0": "hostname", "type_1": "ip", "type_2": "skip"}
    response = admin.post("/tables/import/confirm", data=form)
    assert response.status_code == 303 and "1%20problem" in response.headers["location"]
    tables = app.state.tables
    table = tables.by_path("/infra/imported")
    assert [c["name"] for c in table.columns] == ["Hostname", "IP address"] and table.key_column == "c1"
    assert len(tables.draft(table)) == 5 and app.state.drive.kind("/infra") == "folder"
    again = admin.post("/tables/import/confirm", data=form)
    assert "expired" in again.headers["location"]


def test_import_rejects_non_csv_and_path_collisions(app: Starlette, admin: TestClient) -> None:
    token = csrf_of(admin.get("/tables").text)
    app.state.drive.put("/infra/servers", b"a file")
    response = admin.post(
        "/tables/create", data={"_csrf": token, "template": "servers", "folder": "/infra", "name": "servers"}
    )
    assert "error=" in response.headers["location"]
    response = admin.post(
        "/tables/import",
        data={"_csrf": token, "folder": "/", "name": "x"},
        files={"file": ("book.xlsx", b"PK", "application/octet-stream")},
    )
    assert "Only%20CSV" in response.headers["location"]
