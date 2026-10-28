"""Wire everything into one ASGI app: the web UI on /, MCP on /mcp.

Guard (host allow-list, security headers)
  ├── /mcp       Bearer key -> MCP streamable HTTP (tools.py)
  └── everything else -> web UI (web.py)
"""

import ipaddress
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import auth, db, keys, tools
from .config import Config
from .drive import Drive
from .tables import Tables
from .tables_web import TablesWeb
from .web import Web

CSP = (
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
    "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)
SECURITY_HEADERS = [
    (b"x-frame-options", b"DENY"),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"same-origin"),
]
SHARED_ADDRESS_SPACE = ipaddress.ip_network("100.64.0.0/10")  # CGNAT / Tailscale


def hostname_of(authority: str) -> str:
    """'[fd00::1]:8484' -> 'fd00::1', 'nas.local:8484' -> 'nas.local'."""
    a = authority.strip().lower()
    if a.startswith("["):
        return a[1 : a.find("]")]
    return a.rsplit(":", 1)[0] if a.count(":") == 1 else a


def host_allowed(hostname: str, config: Config) -> bool:
    """DNS-rebinding guard: localhost, private/loopback IPs, ALLOWED_HOSTS, the public URL's host."""
    if hostname in ("localhost", config.public_host, *config.allowed_hosts) and hostname:
        return True
    try:
        ip = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local or ip in SHARED_ADDRESS_SPACE


Header = tuple[bytes, bytes]


async def _send_json(send: Send, status: int, body: dict[str, Any], extra: tuple[Header, ...] = ()) -> None:
    data = json.dumps(body).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(data)).encode()), *extra]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": data})


class Guard:
    """Checks Host and Origin on every request but /healthz, and adds security headers."""

    def __init__(self, app: ASGIApp, config: Config) -> None:
        self.app, self.config = app, config

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
        if scope["path"] != "/healthz":
            if not host_allowed(hostname_of(headers.get("host", "")), self.config):
                return await _send_json(send, 403, {"error": "Host not allowed. Add it to ALLOWED_HOSTS."})
            origin = headers.get("origin")
            if origin is not None and not host_allowed(hostname_of(origin.split("://", 1)[-1]), self.config):
                return await _send_json(send, 403, {"error": "Origin not allowed"})

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                names = {k.lower() for k, _ in message.get("headers", [])}
                extra = [h for h in SECURITY_HEADERS if h[0] not in names]
                if b"content-security-policy" not in names:
                    extra.append((b"content-security-policy", CSP.encode()))
                if b"cache-control" not in names and not scope["path"].startswith("/static/"):
                    extra.append((b"cache-control", b"no-store"))
                message["headers"] = [*message.get("headers", []), *extra]
            await send(message)

        await self.app(scope, receive, send_with_headers)


class McpEndpoint:
    """/mcp: check the Bearer key, put it in the scope for tools.py, hand over to the MCP SDK."""

    def __init__(self, database: Any, handle: ASGIApp) -> None:
        self.db, self.handle = database, handle

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        headers = dict(scope["headers"])
        bearer = headers.get(b"authorization", b"").decode("latin-1")
        token = bearer[7:].strip() if bearer[:7].lower() == "bearer " else ""
        key = keys.verify(self.db, token) if token else None
        if key is None:
            challenge = ((b"www-authenticate", b'Bearer realm="thumbdrive"'),)
            return await _send_json(send, 401, {"error": "A valid Thumbdrive key is required"}, challenge)
        scope[tools.SCOPE_KEY] = key
        await self.handle(scope, receive, send)


def create_app(config: Config) -> Starlette:
    config.data_dir.mkdir(parents=True, exist_ok=True)
    database = db.connect(config.data_dir / "thumbdrive.db")
    drive = Drive(config.data_dir, database)
    drive.sync()
    auth.apply_env_password(database, config.admin_password)

    tables = Tables(database)
    mcp_server = tools.build(drive, tables, config.read_page_bytes)
    mcp_server.streamable_http_app(
        stateless_http=True,
        json_response=True,
        max_request_body_size=1024 * 1024,
        # Guard does the host check for the whole app, with the same rules as the UI.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    sessions = mcp_server.session_manager

    @asynccontextmanager
    async def lifespan(_: Starlette) -> AsyncIterator[None]:
        async with sessions.run():
            yield

    web = Web(drive, database, config)
    tables_web = TablesWeb(web, tables)
    routes = [Route("/mcp", McpEndpoint(database, sessions.handle_request)), *web.routes(), *tables_web.routes()]
    app = Starlette(routes=routes, lifespan=lifespan, middleware=[Middleware(Guard, config=config)])
    app.state.drive, app.state.db, app.state.tables = drive, database, tables
    return app
