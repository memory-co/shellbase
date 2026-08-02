"""应用层网关：鉴权门禁 + 静态托管 + 反向代理。

原来这三件事由 nginx 干（design.md §3.1 旧版），网关下沉进 FastAPI 后，
Docker 与 pip 两条分发路径都只需要一个监听端口、一个进程树，无需任何配置文件。

安全前提随之改变：进程不再只监听回环，鉴权是本模块的 AuthGate 强制的，
它包在整个 ASGI 应用最外层，HTTP 与 WebSocket 一视同仁。放行名单只有登录必需的
三项，新增路由默认是被门禁保护的——这个默认方向是有意的。
"""

import asyncio
import contextlib
import os
import posixpath
import secrets
import time
from http.cookies import SimpleCookie
from pathlib import Path
import httpx
from fastapi import APIRouter, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from starlette.responses import StreamingResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import WebSocketException

from .auth import COOKIE

# 前端静态产物：Docker 用 COPY 落到镜像里，pip 用随 wheel 分发的 _assets/web
WEB_ROOT = Path(
    os.environ.get("SHELLBASE_WEB_ROOT", str(Path(__file__).parent / "_assets" / "web"))
).resolve()

TTYD_UPSTREAM = os.environ.get("SHELLBASE_TTYD_UPSTREAM", "127.0.0.1:7681")

# 未登录能拿到的只有这三项：登录页、登录接口、健康检查。
# 登录页是自包含的（内联 CSS/JS），所以静态资源目录不必像旧 nginx 那样放行。
PUBLIC_EXACT = {"/login", "/api/auth/login", "/api/system/health"}

# 这些前缀下鉴权失败返回 401；其余（页面导航）跳登录页
API_PREFIX = ("/api/", "/tty/", "/proxy/")

# 上传体积上限（api/files.md）。没有 nginx 兜底后由这里按 Content-Length 卡。
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

# 逐跳首部：转发时必须丢弃（RFC 9110 §7.6.1）
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
# websockets 客户端自己会写的首部，转发时一并丢弃
WS_OWN = {
    "host", "sec-websocket-key", "sec-websocket-version",
    "sec-websocket-extensions", "sec-websocket-protocol",
}


# ---- 鉴权门禁 ----

def _header(scope: Scope, name: bytes) -> str:
    for k, v in scope.get("headers", []):
        if k == name:
            return v.decode("latin-1")
    return ""


def _supplied_token(scope: Scope) -> str:
    raw = _header(scope, b"cookie")
    if raw:
        jar = SimpleCookie()
        try:
            jar.load(raw)
        except Exception:  # 坏 cookie 不该 500，按未携带处理
            jar = SimpleCookie()
        if COOKIE in jar:
            return jar[COOKIE].value
    authz = _header(scope, b"authorization")
    if authz.lower().startswith("bearer "):
        return authz[7:].strip()
    return ""


def _client_ip(scope: Scope) -> str:
    # Cloud Run 等 PaaS 在前面还有一层负载，取 XFF 首段；直连时用对端地址。
    # XFF 可伪造，因此它只用于限流分桶，不参与任何授权判定。
    xff = _header(scope, b"x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    client = scope.get("client")
    return client[0] if client else "-"


class _LoginLimiter:
    """登录限流：等价于旧 nginx 的 limit_req rate=10r/m burst=5 nodelay。

    令牌桶：容量 6（1 + burst），每 6 秒回补 1 个。
    """

    CAPACITY = 6.0
    REFILL_PER_SEC = 10 / 60
    MAX_BUCKETS = 4096

    def __init__(self) -> None:
        self._buckets: dict[str, tuple[float, float]] = {}

    def allow(self, ip: str) -> bool:
        now = time.monotonic()
        tokens, last = self._buckets.get(ip, (self.CAPACITY, now))
        tokens = min(self.CAPACITY, tokens + (now - last) * self.REFILL_PER_SEC)
        if tokens < 1:
            self._buckets[ip] = (tokens, now)
            return False
        if len(self._buckets) > self.MAX_BUCKETS:
            # 满桶的条目等价于不存在，直接丢掉，避免无界增长
            self._buckets = {
                k: v for k, v in self._buckets.items() if v[0] < self.CAPACITY
            }
        self._buckets[ip] = (tokens - 1, now)
        return True


class AuthGate:
    """包在最外层的 ASGI 中间件：没有有效令牌，什么都到不了下游。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.limiter = _LoginLimiter()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")

        if path in PUBLIC_EXACT:
            if path == "/api/auth/login" and not self.limiter.allow(_client_ip(scope)):
                await JSONResponse(
                    {"error": "rate_limited", "message": "too many login attempts"},
                    status_code=429,
                )(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return

        expected = os.environ.get("SHELLBASE_TOKEN", "")
        supplied = _supplied_token(scope)
        if expected and supplied and secrets.compare_digest(supplied, expected):
            await self.app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            # accept 之前 close：ASGI 服务器会翻译成 HTTP 403，握手不会建立
            await send({"type": "websocket.close", "code": 1008})
            return

        if path.startswith(API_PREFIX):
            resp: Response = JSONResponse(
                {"error": "unauthorized", "message": "missing or invalid token"},
                status_code=401,
            )
        else:
            resp = RedirectResponse("/login", status_code=302)
        await resp(scope, receive, send)


class BodyLimit:
    """按 Content-Length 卡上传体积：越界的请求在读体之前就回 413。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope.get("path") == "/api/files/upload":
            raw = _header(scope, b"content-length")
            if raw.isdigit() and int(raw) > MAX_UPLOAD_BYTES:
                await JSONResponse(
                    {"error": "too_large", "message": "upload exceeds 1GB"},
                    status_code=413,
                )(scope, receive, send)
                return
        await self.app(scope, receive, send)


# ---- 反向代理（HTTP + WebSocket）----

_client: httpx.AsyncClient | None = None


def _http_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # 终端与长轮询都可能挂很久，读超时放到 24h（对齐旧 nginx proxy_read_timeout）
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=86400.0, write=86400.0, pool=10.0),
            follow_redirects=False,
        )
    return _client


async def aclose_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def proxy_http(request: Request, upstream: str, path: str) -> Response:
    """把请求原样转给 http://<upstream>/<path>，响应流式回吐。"""
    url = httpx.URL(f"http://{upstream}/{path}", query=request.url.query.encode())
    headers = [
        (k, v) for k, v in request.headers.raw
        if k.decode("latin-1").lower() not in HOP_BY_HOP
    ]
    client = _http_client()
    req = client.build_request(
        request.method, url, headers=headers, content=request.stream()
    )
    try:
        upstream_resp = await client.send(req, stream=True)
    except httpx.HTTPError as exc:
        return JSONResponse(
            {"error": "bad_gateway", "message": f"upstream unreachable: {exc}"},
            status_code=502,
        )

    out = [
        (k, v) for k, v in upstream_resp.headers.raw
        if k.decode("latin-1").lower() not in HOP_BY_HOP
    ]
    return StreamingResponse(
        upstream_resp.aiter_raw(),
        status_code=upstream_resp.status_code,
        headers=dict((k.decode("latin-1"), v.decode("latin-1")) for k, v in out),
        background=_CloseUpstream(upstream_resp),
    )


class _CloseUpstream:
    """StreamingResponse 收尾时关掉上游响应（httpx 流式响应必须显式关闭）。"""

    def __init__(self, resp: httpx.Response) -> None:
        self.resp = resp

    async def __call__(self) -> None:
        await self.resp.aclose()


async def proxy_ws(ws: WebSocket, upstream: str, path: str) -> None:
    """WebSocket 反代：先连上游、拿到协商好的子协议，再 accept 客户端。

    ttyd 的 web 客户端要求子协议 "tty"，顺序反了握手就废了。
    """
    query = ws.url.query
    url = f"ws://{upstream}/{path}" + (f"?{query}" if query else "")
    subprotocols = list(ws.scope.get("subprotocols") or [])
    headers = [
        (k, v) for k, v in ws.headers.items()
        if k.lower() not in HOP_BY_HOP and k.lower() not in WS_OWN
    ]

    try:
        upstream_ws = await ws_connect(
            url,
            subprotocols=subprotocols or None,
            additional_headers=headers,
            open_timeout=10,
            max_size=None,
            ping_interval=None,
        )
    except (WebSocketException, OSError, TimeoutError):
        await ws.close(code=1011)
        return

    async with upstream_ws:
        await ws.accept(subprotocol=upstream_ws.subprotocol)

        async def to_upstream() -> None:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    return
                if msg.get("bytes") is not None:
                    await upstream_ws.send(msg["bytes"])
                elif msg.get("text") is not None:
                    await upstream_ws.send(msg["text"])

        async def to_client() -> None:
            async for msg in upstream_ws:
                if isinstance(msg, bytes):
                    await ws.send_bytes(msg)
                else:
                    await ws.send_text(msg)

        tasks = [asyncio.create_task(to_upstream()), asyncio.create_task(to_client())]
        try:
            done, pending = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_COMPLETED
            )
            for t in pending:
                t.cancel()
        finally:
            for t in tasks:
                t.cancel()
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await ws.close()  # 客户端可能已经走了


router = APIRouter()


@router.api_route(
    "/tty/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
)
async def tty_http(request: Request, path: str):
    return await proxy_http(request, TTYD_UPSTREAM, path)


@router.websocket("/tty/{path:path}")
async def tty_ws(ws: WebSocket, path: str):
    await proxy_ws(ws, TTYD_UPSTREAM, path)


def _local_upstream(port: int) -> str:
    if not 1 <= port <= 65535:
        raise ValueError("port out of range")
    return f"127.0.0.1:{port}"


@router.api_route(
    "/proxy/{port:int}/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
)
async def local_http(request: Request, port: int, path: str):
    """https://localhost:<port> 类 URI 的代理通道（uri.md §3）。"""
    try:
        upstream = _local_upstream(port)
    except ValueError:
        return JSONResponse(
            {"error": "bad_port", "message": "port out of range"}, status_code=400
        )
    return await proxy_http(request, upstream, path)


@router.websocket("/proxy/{port:int}/{path:path}")
async def local_ws(ws: WebSocket, port: int, path: str):
    try:
        upstream = _local_upstream(port)
    except ValueError:
        await ws.close(code=1008)
        return
    await proxy_ws(ws, upstream, path)


# ---- 静态托管 ----

def _safe_file(rel: str) -> Path | None:
    """把 URL 路径解析成 WEB_ROOT 内的文件；越界或不存在返回 None。"""
    clean = posixpath.normpath("/" + rel).lstrip("/")
    candidate = (WEB_ROOT / clean).resolve()
    if candidate != WEB_ROOT and WEB_ROOT not in candidate.parents:
        return None
    return candidate if candidate.is_file() else None


def _file_response(path: Path, cache: bool = False) -> FileResponse:
    headers = {"Cache-Control": "public, max-age=3600"} if cache else {}
    return FileResponse(path, headers=headers)


@router.get("/login")
async def login_page():
    page = _safe_file("login.html")
    if page is None:
        return JSONResponse(
            {"error": "no_web_assets", "message": f"login.html not found under {WEB_ROOT}"},
            status_code=404,
        )
    return _file_response(page)


@router.api_route("/{path:path}", methods=["GET", "HEAD"])
async def static_or_spa(path: str):
    """静态文件 → 同名 .html（/apps/files → apps/files.html）→ SPA 兜底 index.html。"""
    if path.startswith(("api/", "tty/", "proxy/")):
        return JSONResponse(
            {"error": "not_found", "message": f"no such route: /{path}"}, status_code=404
        )

    hit = _safe_file(path)
    if hit is not None:
        return _file_response(hit, cache=path.startswith("assets/"))

    if path and not path.endswith("/"):
        html = _safe_file(path + ".html")
        if html is not None:
            return _file_response(html)

    index = _safe_file("index.html")
    if index is None:
        return JSONResponse(
            {
                "error": "no_web_assets",
                "message": f"frontend assets not found under {WEB_ROOT}; "
                           "set SHELLBASE_WEB_ROOT or reinstall the package",
            },
            status_code=404,
        )
    return _file_response(index)


__all__ = ["AuthGate", "BodyLimit", "router", "WEB_ROOT", "aclose_client"]
