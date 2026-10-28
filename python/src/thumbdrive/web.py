"""The admin web UI: server-rendered pages, plain HTML forms, no JS required.

Every POST passes the same-origin and CSRF checks in `_check_post`.
Every page except /setup, /login and /healthz needs a signed-in admin.
"""

import secrets
import sqlite3
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import quote

from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from starlette.templating import Jinja2Templates

from . import auth, keys, paths
from .config import Config
from .drive import Drive, DriveError, NotFound, all_folders, sha256_hex
from .snippets import snippets

HERE = Path(__file__).parent
SESSION, PRE = "td_session", "td_pre"
Handler = Callable[[Request], Awaitable[Response]]


class Web:
    def __init__(self, drive: Drive, db: sqlite3.Connection, config: Config) -> None:
        self.drive, self.db, self.config = drive, db, config
        self.templates = Jinja2Templates(directory=HERE / "templates")
        self.limiter = auth.LoginLimiter()

    def routes(self) -> list[Route | Mount]:
        admin, post = self._admin, self._post
        return [
            Route("/healthz", self.healthz),
            Route("/setup", self.setup, methods=["GET", "POST"]),
            Route("/login", self.login, methods=["GET", "POST"]),
            Route("/logout", post(self.logout), methods=["POST"]),
            Route("/", admin(self.home)),
            Route("/files", admin(self.files)),
            Route("/files/download", admin(self.download)),
            Route("/files/history", admin(self.history)),
            Route("/files/mkdir", admin(post(self.mkdir)), methods=["POST"]),
            Route("/files/upload", admin(post(self.upload)), methods=["POST"]),
            Route("/files/rename", admin(post(self.rename)), methods=["POST"]),
            Route("/files/delete", admin(post(self.delete)), methods=["POST"]),
            Route("/files/restore", admin(post(self.restore)), methods=["POST"]),
            Route("/keys", admin(self.keys_page)),
            Route("/keys/create", admin(post(self.create_key)), methods=["POST"]),
            Route("/keys/revoke", admin(post(self.revoke_key)), methods=["POST"]),
            Route("/activity", admin(self.activity)),
            Mount("/static", StaticFiles(directory=HERE / "static"), name="static"),
        ]

    # --- plumbing --------------------------------------------------------

    def _signed_in(self, request: Request) -> bool:
        return auth.session_valid(self.db, request.cookies.get(SESSION))

    def _admin(self, handler: Handler) -> Handler:
        async def guarded(request: Request) -> Response:
            if not auth.has_password(self.db):
                return RedirectResponse("/setup", 303)
            if not self._signed_in(request):
                return RedirectResponse("/login", 303)
            return await handler(request)

        return guarded

    def _post(self, handler: Handler) -> Handler:
        async def checked(request: Request) -> Response:
            return await self._check_post(request) or await handler(request)

        return checked

    async def _check_post(self, request: Request) -> Response | None:
        """The refusal for a POST that fails the checks, or None when it may proceed."""
        site = request.headers.get("sec-fetch-site")
        if site and site not in ("same-origin", "none"):
            return PlainTextResponse("Cross-site request refused", 403)
        origin = request.headers.get("origin")
        if origin is not None and origin.split("://", 1)[-1] != request.headers.get("host"):
            return PlainTextResponse("Cross-origin request refused", 403)
        max_bytes = (self.config.max_file_mb + 1) * 1024 * 1024
        if int(request.headers.get("content-length") or 0) > max_bytes:
            limit = f"{self.config.max_file_mb} MB limit (MAX_FILE_MB)"
            return PlainTextResponse(f"Upload refused: larger than the {limit}. Go back and pick a smaller file.", 413)
        form = await request.form(max_files=200, max_fields=100)
        sent = request.headers.get("x-csrf-token") or str(form.get("_csrf", ""))
        browser = request.cookies.get(SESSION) or request.cookies.get(PRE)
        if not browser or sent != auth.csrf_token(self.db, browser):
            return PlainTextResponse("Invalid or missing CSRF token. Reload the page and try again.", 403)
        return None

    def _render(self, request: Request, template: str, status: int = 200, **context: object) -> Response:
        browser = request.cookies.get(SESSION) if self._signed_in(request) else None
        new_pre = None
        if browser is None:
            browser = request.cookies.get(PRE)
            if not browser:
                browser = new_pre = secrets.token_urlsafe(32)
        context |= {
            "csrf": auth.csrf_token(self.db, browser),
            "signed_in": self._signed_in(request),
            "error": context.get("error") or request.query_params.get("error"),
            "notice": request.query_params.get("notice"),
        }
        response = self.templates.TemplateResponse(request, template, context, status_code=status)
        if new_pre:
            self._cookie(response, PRE, new_pre, max_age=None)
        return response

    def _cookie(self, response: Response, name: str, value: str, max_age: int | None) -> None:
        response.set_cookie(
            name, value, max_age=max_age, httponly=True, samesite="strict", secure=self.config.secure_cookies, path="/"
        )

    @staticmethod
    def _back(folder: str, error: str | None = None, notice: str | None = None) -> Response:
        url = f"/files?path={quote(folder)}"
        if error:
            url += f"&error={quote(error)}"
        if notice:
            url += f"&notice={quote(notice)}"
        return RedirectResponse(url, 303)

    @staticmethod
    async def _field(request: Request, name: str) -> str:
        return str((await request.form()).get(name, "")).strip()

    def _client(self, request: Request) -> str:
        return request.client.host if request.client else "unknown"

    # --- sign-in ---------------------------------------------------------

    async def healthz(self, request: Request) -> Response:
        return JSONResponse({"ok": True, "name": "thumbdrive", "edition": "python"})

    async def setup(self, request: Request) -> Response:
        if auth.has_password(self.db):
            return RedirectResponse("/login", 303)
        if request.method == "GET":
            return self._render(request, "login.html", setup=True)
        if refused := await self._check_post(request):
            return refused
        password, again = await self._field(request, "password"), await self._field(request, "confirm")
        if password != again:
            return self._render(request, "login.html", 400, setup=True, error="The passwords do not match")
        try:
            auth.set_password(self.db, password)
        except ValueError as e:
            return self._render(request, "login.html", 400, setup=True, error=str(e))
        return self._start_session()

    async def login(self, request: Request) -> Response:
        if not auth.has_password(self.db):
            return RedirectResponse("/setup", 303)
        if request.method == "GET":
            return self._render(request, "login.html", setup=False)
        if refused := await self._check_post(request):
            return refused
        client = self._client(request)
        if self.limiter.blocked(client):
            return self._render(request, "login.html", 429, error="Too many attempts. Wait 15 minutes.")
        if not auth.verify_password(self.db, await self._field(request, "password")):
            self.limiter.failed(client)
            return self._render(request, "login.html", 401, error="Wrong password")
        return self._start_session()

    def _start_session(self) -> Response:
        response = RedirectResponse("/files", 303)
        self._cookie(response, SESSION, auth.new_session(self.db), max_age=auth.SESSION_DAYS * 86400)
        return response

    async def logout(self, request: Request) -> Response:
        auth.end_session(self.db, request.cookies.get(SESSION))
        response = RedirectResponse("/login", 303)
        response.delete_cookie(SESSION, path="/")
        return response

    # --- files -----------------------------------------------------------

    async def home(self, request: Request) -> Response:
        return RedirectResponse("/files", 303)

    def _path(self, value: str) -> str | None:
        try:
            return paths.normalize(value or "/")
        except paths.InvalidPath:
            return None

    async def files(self, request: Request) -> Response:
        folder = self._path(request.query_params.get("path", "/"))
        if folder is None or self.drive.kind(folder) != "folder":
            return self._render(request, "message.html", 404, message="Folder not found")
        crumbs, acc = [("Drive", "/")], ""
        for part in folder.strip("/").split("/") if folder != "/" else []:
            acc += "/" + part
            crumbs.append((part, acc))
        return self._render(
            request,
            "files.html",
            folder=folder,
            crumbs=crumbs,
            entries=self.drive.list(folder),
            deleted=self.drive.deleted_in(folder),
            parent=paths.parent(folder),
        )

    async def download(self, request: Request) -> Response:
        p = self._path(request.query_params.get("path", ""))
        version = request.query_params.get("version")
        try:
            if p is None:
                raise NotFound("")
            data, _ = self.drive.read(p, int(version) if version and version.isdigit() else None)
        except NotFound:
            return PlainTextResponse("Not found", 404)
        return Response(
            data,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(paths.name_of(p))}",
                "Content-Security-Policy": "sandbox; default-src 'none'",
                "X-Thumbdrive-SHA256": sha256_hex(data),
            },
        )

    async def history(self, request: Request) -> Response:
        p = self._path(request.query_params.get("path", ""))
        versions = self.drive.history(p) if p else []
        if not versions:
            return self._render(request, "message.html", 404, message="No history for that path")
        return self._render(request, "history.html", path=p, versions=versions, parent=paths.parent(p))

    async def mkdir(self, request: Request) -> Response:
        folder = self._path(await self._field(request, "path")) or "/"
        name = await self._field(request, "name")
        try:
            if not name or "/" in name:
                raise DriveError("Folder names cannot be empty or contain '/'")
            self.drive.mkdir(paths.join(folder, name))
        except (DriveError, paths.InvalidPath) as e:
            return self._back(folder, error=str(e))
        return self._back(folder, notice=f"Created {name}")

    async def upload(self, request: Request) -> Response:
        form = await request.form()
        folder = self._path(str(form.get("path", "/"))) or "/"
        limit = self.config.max_file_mb * 1024 * 1024
        stored = 0
        for item in form.getlist("files"):
            if not isinstance(item, UploadFile) or not item.filename:
                continue
            data = await item.read(limit + 1)
            if len(data) > limit:
                return self._back(folder, error=f"{item.filename} is larger than {self.config.max_file_mb} MB")
            try:
                name = Path(item.filename.replace("\\", "/")).name
                self.drive.put(paths.join(folder, name), data)
            except (DriveError, paths.InvalidPath) as e:
                return self._back(folder, error=str(e))
            stored += 1
        if not stored:
            return self._back(folder, error="Choose at least one file")
        return self._back(folder, notice=f"Uploaded {stored} file(s)")

    async def rename(self, request: Request) -> Response:
        p = self._path(await self._field(request, "path"))
        new = self._path(await self._field(request, "new_path"))
        if p is None or new is None:
            return self._back("/", error="Invalid path")
        try:
            self.drive.rename(p, new)
        except (DriveError, NotFound) as e:
            return self._back(paths.parent(p), error=str(e))
        return self._back(paths.parent(new), notice=f"Renamed to {new}")

    async def delete(self, request: Request) -> Response:
        p = self._path(await self._field(request, "path"))
        if p is None:
            return self._back("/", error="Invalid path")
        try:
            self.drive.delete(p)
        except (DriveError, NotFound) as e:
            return self._back(paths.parent(p), error=str(e))
        return self._back(paths.parent(p), notice=f"Deleted {paths.name_of(p)}")

    async def restore(self, request: Request) -> Response:
        p = self._path(await self._field(request, "path"))
        version = await self._field(request, "version")
        if p is None or not version.isdigit():
            return self._back("/", error="Invalid request")
        try:
            self.drive.restore(p, int(version))
        except (DriveError, NotFound) as e:
            return self._back(paths.parent(p), error=str(e))
        return self._back(paths.parent(p), notice=f"Restored {paths.name_of(p)} from version {version}")

    # --- keys and activity -----------------------------------------------

    def _mcp_url(self, request: Request) -> str:
        base = self.config.public_url or f"{request.url.scheme}://{request.headers.get('host', 'localhost')}"
        return base + "/mcp"

    async def keys_page(self, request: Request, **extra: object) -> Response:
        return self._render(
            request,
            "keys.html",
            keys=keys.all_keys(self.db),
            folders=all_folders(self.drive),
            mcp_url=self._mcp_url(request),
            **extra,
        )

    async def create_key(self, request: Request) -> Response:
        form = await request.form()
        name = str(form.get("name", ""))
        folders = [str(f) for f in form.getlist("folders")]
        try:
            new_key = keys.create(self.db, name, folders)
        except (ValueError, sqlite3.IntegrityError) as e:
            return await self.keys_page(request, error=str(e))
        self.drive.log("admin", "key-create", None, f"{name.strip()}: {', '.join(sorted(folders))}")
        page = await self.keys_page(
            request, new_key=new_key, new_name=name.strip(), snippets=snippets(self._mcp_url(request), new_key)
        )
        page.headers["Cache-Control"] = "no-store"
        return page

    async def revoke_key(self, request: Request) -> Response:
        key_id = await self._field(request, "id")
        if key_id.isdigit():
            keys.revoke(self.db, int(key_id))
            self.drive.log("admin", "key-revoke", None, f"key #{key_id}")
        return RedirectResponse("/keys", 303)

    async def activity(self, request: Request) -> Response:
        who = request.query_params.get("who") or "agents"
        actors = [r["actor"] for r in self.db.execute("SELECT DISTINCT actor FROM activity ORDER BY actor")]
        return self._render(request, "activity.html", rows=self.drive.activity(who), actors=actors, who=who)
