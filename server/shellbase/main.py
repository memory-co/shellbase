"""shellbase FastAPI 入口。

只监听 127.0.0.1，鉴权由 nginx auth_request 在网关层强制（docs/v1/api/README.md）。
"""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import auth, env, files, system, terminals, windows
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


app.include_router(auth.router)
app.include_router(windows.router)
app.include_router(terminals.router)
app.include_router(files.router)
app.include_router(env.router)
app.include_router(system.router)
