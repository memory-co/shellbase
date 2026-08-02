"""shellbase FastAPI 入口：API + 网关（静态托管、鉴权门禁、反向代理）同进程。

对外只有一个监听端口。鉴权由 gateway.AuthGate 在整个应用最外层强制，
HTTP 与 WebSocket 一视同仁（docs/v1/api/README.md）。
"""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import auth, env, files, gateway, system, terminals, windows
from .state import ApiError, ensure_dirs

app = FastAPI(title="shellbase", docs_url=None, redoc_url=None)


@app.exception_handler(ApiError)
async def api_error_handler(_request: Request, exc: ApiError):
    return JSONResponse(
        {"error": exc.error, "message": exc.message}, status_code=exc.status
    )


@app.on_event("startup")
async def startup():
    ensure_dirs()
    env.sync_on_startup()


@app.on_event("shutdown")
async def shutdown():
    await gateway.aclose_client()


app.include_router(auth.router)
app.include_router(windows.router)
app.include_router(terminals.router)
app.include_router(files.router)
app.include_router(env.router)
app.include_router(system.router)

# 网关路由必须最后挂：它带一条 /{path:path} 兜底，会吃掉后面注册的一切
app.include_router(gateway.router)

app.add_middleware(gateway.BodyLimit)

# 门禁包在最外层：放行名单之外的一切（含静态页与反代）都要令牌。
# 后 add 的在外层，因此 AuthGate 必须最后加。
app.add_middleware(gateway.AuthGate)
