"""鉴权：FastAPI 是校验真身，nginx auth_request 每请求回调 verify。

设计依据 docs/v1/api/auth.md。
"""

import os
import secrets

from fastapi import APIRouter, Request, Response

from .state import ApiError

router = APIRouter(prefix="/api/auth")

COOKIE_PREFIX = "shellbase_token"


def cookie_name(host_header: str, scheme: str = "http") -> str:
    """按端口给 cookie 分名。

    cookie 的作用域只认域名、**不认端口**：同一台机器上两个实例若都写
    `shellbase_token`，谁后登录谁把对方顶掉，两边互相踢来踢去。名字带上端口，
    浏览器就能同时持有多份登录态（multi_instance 场景锁的就是这条）。

    端口取自浏览器发来的 Host 头——它才是 cookie 罐里区分不开的那一维。
    取不到就按 scheme 兜个默认值：这个值是否"正确"不重要，写入与读取
    走同一个函数、拿到同样的输入，就一定一致。
    """
    host = (host_header or "").rsplit("@", 1)[-1]
    port = ""
    if host.startswith("["):                       # IPv6 字面量：[::1]:8080
        _, _, rest = host.partition("]")
        port = rest[1:] if rest.startswith(":") else ""
    elif ":" in host:
        port = host.rsplit(":", 1)[1]
    if not port.isdigit():
        port = "443" if scheme == "https" else "80"
    return f"{COOKIE_PREFIX}_{port}"


def cookie_name_for(request: Request) -> str:
    return cookie_name(request.headers.get("host", ""), request.url.scheme)


def _token() -> str:
    return os.environ.get("SHELLBASE_TOKEN", "")


def _extract(request: Request) -> str:
    tok = request.cookies.get(cookie_name_for(request))
    if tok:
        return tok
    authz = request.headers.get("authorization", "")
    if authz.lower().startswith("bearer "):
        return authz[7:].strip()
    return ""


@router.post("/login", status_code=204)
async def login(body: dict, request: Request, response: Response):
    supplied = str(body.get("token", ""))
    if not _token() or not secrets.compare_digest(supplied, _token()):
        raise ApiError(401, "bad_token", "invalid token")
    response.set_cookie(
        cookie_name_for(request), supplied, httponly=True, samesite="strict", path="/"
    )


@router.get("/verify", status_code=204)
async def verify(request: Request):
    supplied = _extract(request)
    if not _token() or not supplied or not secrets.compare_digest(supplied, _token()):
        raise ApiError(401, "unauthorized", "missing or invalid token")


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response):
    response.delete_cookie(cookie_name_for(request), path="/")


@router.get("/me")
async def me():
    return {"authenticated": True}
