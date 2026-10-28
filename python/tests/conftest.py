import re
import socket
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import uvicorn
from starlette.applications import Starlette
from starlette.testclient import TestClient

from thumbdrive import auth, keys
from thumbdrive.app import create_app
from thumbdrive.config import Config

PASSWORD = "correct horse battery"


def make_config(tmp_path: Path, **overrides: object) -> Config:
    values: dict = {"data_dir": tmp_path / "data", "allowed_hosts": ["testserver"], "read_page_bytes": 64}
    values.update(overrides)
    return Config(**values)


def csrf_of(html: str) -> str:
    match = re.search(r'name="_csrf" value="([^"]+)"', html)
    assert match, "page has no CSRF field"
    return match.group(1)


@pytest.fixture
def app(tmp_path: Path) -> Starlette:
    return create_app(make_config(tmp_path))


@pytest.fixture
def client(app: Starlette) -> Iterator[TestClient]:
    with TestClient(app, follow_redirects=False) as c:
        yield c


@pytest.fixture
def admin(app: Starlette, client: TestClient) -> TestClient:
    """A client signed in as the admin."""
    auth.set_password(app.state.db, PASSWORD)
    token = csrf_of(client.get("/login").text)
    response = client.post("/login", data={"password": PASSWORD, "_csrf": token})
    assert response.status_code == 303 and response.headers["location"] == "/files"
    return client


class Server:
    """The real app on a free loopback port, so MCP tests use the SDK client over real HTTP."""

    def __init__(self, app: Starlette) -> None:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.app = app
        self.url = f"http://127.0.0.1:{self.port}/mcp"
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def key(self, *folders: str, name: str = "agent") -> str:
        return keys.create(self.app.state.db, name, list(folders))


@pytest.fixture
def server(app: Starlette) -> Iterator[Server]:
    srv = Server(app)
    srv.thread.start()
    deadline = time.monotonic() + 10
    while not srv.server.started:
        assert time.monotonic() < deadline, "server did not start"
        time.sleep(0.02)
    yield srv
    srv.server.should_exit = True
    srv.thread.join(5)
