"""Every MCP tool, called through the official SDK client over real HTTP."""

import json
import re

import anyio
import httpx
import httpx2
from conftest import Server
from mcp import Client
from mcp.client.streamable_http import streamable_http_client


def call(server: Server, key: str, tool: str, **arguments: object):
    async def run():
        async with (
            httpx2.AsyncClient(headers={"Authorization": f"Bearer {key}"}) as http,
            Client(streamable_http_client(server.url, http_client=http)) as client,
        ):
            return await client.call_tool(tool, arguments)

    return anyio.run(run)


def ok(result) -> dict:
    assert not result.is_error, result.content[0].text
    return json.loads(result.content[0].text)


def error(result) -> str:
    assert result.is_error
    return re.sub(r"^Error executing tool \w+: ", "", result.content[0].text)


def seed(server: Server) -> None:
    drive = server.app.state.drive
    drive.put("/team/plan.md", b"# Plan\nShip the Python edition.\n")
    drive.put("/team/logo.png", b"\x89PNG\r\n\x1a\n\x00\x00binary")
    drive.put("/private/salary.txt", b"Ship the secret numbers.\n")


def test_requires_a_valid_bearer_key(server: Server) -> None:
    response = httpx.post(server.url, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert response.status_code == 401 and "Bearer" in response.headers["www-authenticate"]
    bad = httpx.post(server.url, json={}, headers={"Authorization": "Bearer td_wrong"})
    assert bad.status_code == 401


def test_tools_are_read_only(server: Server) -> None:
    key = server.key("/")

    async def run():
        async with (
            httpx2.AsyncClient(headers={"Authorization": f"Bearer {key}"}) as http,
            Client(streamable_http_client(server.url, http_client=http)) as client,
        ):
            return await client.list_tools()

    tools = anyio.run(run).tools
    assert sorted(t.name for t in tools) == ["history", "list", "read", "search"]
    assert all(t.annotations and t.annotations.read_only_hint for t in tools)


def test_list_is_scoped(server: Server) -> None:
    seed(server)
    key = server.key("/team")
    assert [e["name"] for e in ok(call(server, key, "list", path="/"))["entries"]] == ["team"]
    names = [e["name"] for e in ok(call(server, key, "list", path="/team"))["entries"]]
    assert names == ["logo.png", "plan.md"]
    assert error(call(server, key, "list", path="/private")) == "Not found: /private"


def test_read_text_binary_pages_versions(server: Server) -> None:
    seed(server)
    key = server.key("/team")
    result = call(server, key, "read", path="/team/plan.md")
    meta = ok(result)
    assert meta["version"] == 1 and meta["pages"] == 1 and result.content[1].text.startswith("# Plan")
    assert "metadata" in ok(call(server, key, "read", path="/team/logo.png"))["note"]
    assert error(call(server, key, "read", path="/private/salary.txt")) == "Not found: /private/salary.txt"

    server.app.state.drive.put("/team/long.txt", ("é" * 100).encode())  # 200 bytes, page size 64
    first = call(server, key, "read", path="/team/long.txt")
    assert ok(first)["pages"] == 4 and ok(first)["has_more"]
    text = "".join(call(server, key, "read", path="/team/long.txt", page=p).content[1].text for p in range(1, 5))
    assert text == "é" * 100
    assert "past the end" in error(call(server, key, "read", path="/team/long.txt", page=5))

    server.app.state.drive.put("/team/plan.md", b"rewritten")
    old = call(server, key, "read", path="/team/plan.md", version=1)
    assert old.content[1].text.startswith("# Plan")


def test_search_is_scoped(server: Server) -> None:
    seed(server)
    key = server.key("/team")
    hits = ok(call(server, key, "search", query="ship"))["hits"]
    assert [h["path"] for h in hits] == ["/team/plan.md"]
    assert ok(call(server, key, "search", query="logo"))["hits"][0]["path"] == "/team/logo.png"
    assert error(call(server, key, "search", query="ship", path="/private")) == "Not found: /private"


def test_history_and_activity_log(server: Server) -> None:
    seed(server)
    key = server.key("/team", name="cursor")
    server.app.state.drive.put("/team/plan.md", b"v2")
    versions = ok(call(server, key, "history", path="/team/plan.md"))["versions"]
    assert [v["version"] for v in versions] == [2, 1]
    assert error(call(server, key, "history", path="/private/salary.txt")).startswith("Not found")
    log = server.app.state.drive.activity("cursor")
    assert [(r["action"], r["detail"]) for r in log][:2] == [("history", "not found"), ("history", None)]


def test_revoked_key_stops_working(server: Server) -> None:
    from thumbdrive import keys

    key = server.key("/")
    keys.revoke(server.app.state.db, keys.all_keys(server.app.state.db)[0].id)
    response = httpx.post(server.url, json={}, headers={"Authorization": f"Bearer {key}"})
    assert response.status_code == 401
