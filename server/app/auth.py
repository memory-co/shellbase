"""鉴权：FastAPI 是校验真身，nginx auth_request 每请求回调 verify。

设计依据 docs/v1/api/auth.md。
"""

import os
import secrets

from fastapi import APIRouter, Request, Response

from .state import ApiError

router = APIRouter(prefix="/api/auth")

COOKIE = "shellbase_token"


def _token() -> str:
    return os.environ.get("SHELLBASE_TOKEN", "")


def _extract(request: Request) -> str:
    tok = request.cookies.get(COOKIE)
    if tok:
        return tok
    authz = request.headers.get("authorization", "")
    if authz.lower().startswith("bearer "):
        return authz[7:].strip()
    return ""


@router.post("/login", status_code=204)
async def login(body: dict, response: Response):
    supplied = str(body.get("token", ""))
    if not _token() or not secrets.compare_digest(supplied, _token()):
        raise ApiError(401, "bad_token", "invalid token")
    response.set_cookie(
        COOKIE, supplied, httponly=True, samesite="strict", path="/"
    )


@router.get("/verify", status_code=204)
async def verify(request: Request):
    supplied = _extract(request)
    if not _token() or not supplied or not secrets.compare_digest(supplied, _token()):
        raise ApiError(401, "unauthorized", "missing or invalid token")


@router.post("/logout", status_code=204)
async def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")


@router.get("/me")
async def me():
    return {"authenticated": True}
