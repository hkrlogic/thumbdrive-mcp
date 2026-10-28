from conftest import PASSWORD, csrf_of, make_config
from starlette.testclient import TestClient

from thumbdrive import auth
from thumbdrive.app import create_app


def test_first_run_setup_then_login(client: TestClient) -> None:
    assert client.get("/files").headers["location"] == "/setup"
    token = csrf_of(client.get("/setup").text)
    bad = client.post("/setup", data={"password": "short", "confirm": "short", "_csrf": token})
    assert bad.status_code == 400
    ok = client.post("/setup", data={"password": PASSWORD, "confirm": PASSWORD, "_csrf": token})
    assert ok.status_code == 303
    assert client.get("/files").status_code == 200
    assert client.get("/setup").headers["location"] == "/login"  # setup only works once


def test_wrong_password_and_rate_limit(app, client: TestClient) -> None:
    from thumbdrive import auth

    auth.set_password(app.state.db, PASSWORD)
    token = csrf_of(client.get("/login").text)
    codes = [client.post("/login", data={"password": "nope", "_csrf": token}).status_code for _ in range(11)]
    assert codes[:10] == [401] * 10 and codes[10] == 429
    assert client.post("/login", data={"password": PASSWORD, "_csrf": token}).status_code == 429


def test_post_without_csrf_is_rejected(admin: TestClient) -> None:
    assert admin.post("/files/mkdir", data={"path": "/", "name": "x"}).status_code == 403
    assert admin.post("/files/mkdir", data={"path": "/", "name": "x", "_csrf": "forged"}).status_code == 403


def test_cross_site_post_is_rejected(admin: TestClient) -> None:
    token = csrf_of(admin.get("/files").text)
    data = {"path": "/", "name": "x", "_csrf": token}
    assert admin.post("/files/mkdir", data=data, headers={"sec-fetch-site": "cross-site"}).status_code == 403
    assert admin.post("/files/mkdir", data=data, headers={"origin": "http://evil.example"}).status_code == 403


def test_unknown_host_is_rejected(client: TestClient) -> None:
    assert client.get("/setup", headers={"host": "evil.example"}).status_code == 403
    assert client.get("/setup", headers={"host": "localhost:8484"}).status_code == 200


def test_security_headers_and_cookie_flags(client: TestClient) -> None:
    response = client.get("/setup")
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["x-content-type-options"] == "nosniff"
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie


def test_upload_browse_download_versions_restore(admin: TestClient) -> None:
    token = csrf_of(admin.get("/files").text)
    assert admin.post("/files/mkdir", data={"path": "/", "name": "docs", "_csrf": token}).status_code == 303
    for body in (b"first", b"second"):
        response = admin.post(
            "/files/upload", data={"path": "/docs", "_csrf": token}, files=[("files", ("a.txt", body, "text/plain"))]
        )
        assert "notice=Uploaded" in response.headers["location"]
    assert "a.txt" in admin.get("/files", params={"path": "/docs"}).text
    download = admin.get("/files/download", params={"path": "/docs/a.txt"})
    assert download.content == b"second" and "attachment" in download.headers["content-disposition"]
    assert admin.get("/files/download", params={"path": "/docs/a.txt", "version": 1}).content == b"first"
    assert "Restore" in admin.get("/files/history", params={"path": "/docs/a.txt"}).text
    admin.post("/files/restore", data={"path": "/docs/a.txt", "version": "1", "_csrf": token})
    assert admin.get("/files/download", params={"path": "/docs/a.txt"}).content == b"first"


def test_oversized_upload_is_refused_with_the_limit(tmp_path) -> None:
    app = create_app(make_config(tmp_path, max_file_mb=1))
    with TestClient(app, follow_redirects=False) as client:
        auth.set_password(app.state.db, PASSWORD)
        client.post("/login", data={"password": PASSWORD, "_csrf": csrf_of(client.get("/login").text)})
        token = csrf_of(client.get("/files").text)

        def upload(size: int):
            files = [("files", ("big.bin", b"x" * size, "application/octet-stream"))]
            return client.post("/files/upload", data={"path": "/", "_csrf": token}, files=files)

        over_file_limit = upload(1024 * 1024 + 10)
        assert "larger%20than%201%20MB" in over_file_limit.headers["location"]
        over_request_limit = upload(3 * 1024 * 1024)
        assert over_request_limit.status_code == 413 and "1 MB limit" in over_request_limit.text
        assert "big.bin" not in client.get("/files").text


def test_rename_and_delete(admin: TestClient) -> None:
    token = csrf_of(admin.get("/files").text)
    admin.post("/files/upload", data={"path": "/", "_csrf": token}, files=[("files", ("a.txt", b"x", "text/plain"))])
    admin.post("/files/rename", data={"path": "/a.txt", "new_path": "/b.txt", "_csrf": token})
    assert admin.get("/files/download", params={"path": "/b.txt"}).content == b"x"
    assert admin.get("/files/download", params={"path": "/a.txt"}).status_code == 404
    admin.post("/files/delete", data={"path": "/b.txt", "_csrf": token})
    assert admin.get("/files/download", params={"path": "/b.txt"}).status_code == 404
    assert "/b.txt" in admin.get("/files").text  # listed under "Deleted here"


def test_keys_are_shown_once_and_revocable(app, admin: TestClient) -> None:
    from thumbdrive import keys

    token = csrf_of(admin.get("/keys").text)
    created = admin.post("/keys/create", data={"name": "laptop", "folders": ["/"], "_csrf": token})
    assert created.status_code == 200 and "td_" in created.text and "mcp-remote" in created.text
    assert "td_" not in admin.get("/keys").text.replace(keys.all_keys(app.state.db)[0].prefix, "")
    key_id = keys.all_keys(app.state.db)[0].id
    admin.post("/keys/revoke", data={"id": str(key_id), "_csrf": token})
    assert keys.all_keys(app.state.db)[0].revoked_at


def test_logout(admin: TestClient) -> None:
    token = csrf_of(admin.get("/files").text)
    assert admin.post("/logout", data={"_csrf": token}).status_code == 303
    assert admin.get("/files").headers["location"] == "/login"


def test_admin_password_from_environment(tmp_path) -> None:
    from conftest import make_config

    from thumbdrive.app import create_app

    with TestClient(create_app(make_config(tmp_path, admin_password=PASSWORD)), follow_redirects=False) as c:
        assert c.get("/setup").headers["location"] == "/login"
        token = csrf_of(c.get("/login").text)
        assert c.post("/login", data={"password": PASSWORD, "_csrf": token}).status_code == 303


def test_startup_banner_reaches_piped_logs(tmp_path) -> None:
    """`docker logs` and nohup pipe stdout; the setup hint must not sit in a buffer."""
    import os
    import socket
    import subprocess
    import sys
    import threading

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = str(s.getsockname()[1])
    env = os.environ | {"DATA_DIR": str(tmp_path / "data"), "THUMBDRIVE_PORT": port}
    env.pop("PYTHONUNBUFFERED", None)
    proc = subprocess.Popen([sys.executable, "-m", "thumbdrive"], env=env, stdout=subprocess.PIPE, text=True)
    lines: list[str] = []
    reader = threading.Thread(target=lambda: lines.append(proc.stdout.readline() if proc.stdout else ""), daemon=True)
    try:
        reader.start()
        reader.join(15)
        assert lines and f"{port}/setup" in lines[0], "no setup hint on piped stdout"
    finally:
        proc.kill()
        proc.wait(5)
