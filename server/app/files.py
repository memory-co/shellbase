"""文件管理：根锚定 workspace，路径穿越一律 403。

设计依据 docs/v1/api/files.md。
"""

import asyncio
import contextlib
import json
import os
import shutil
import stat as stat_mod
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, UploadFile, WebSocket, WebSocketDisconnect, Form
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from starlette.background import BackgroundTask

from .state import WORKSPACE, ApiError, write_json_atomic  # noqa: F401

router = APIRouter(prefix="/api/files")

TEXT_LIMIT = 2 * 1024 * 1024


def safe(path: str | None) -> Path:
    raw = (path or "").strip()
    p = Path(raw)
    full = p if p.is_absolute() else WORKSPACE / p
    resolved = full.resolve()
    root = WORKSPACE.resolve()
    if resolved != root and root not in resolved.parents:
        raise ApiError(403, "path_escape", "path outside workspace")
    return resolved


def _mtime_iso(st: os.stat_result) -> str:
    return datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat()


def _entry(p: Path, depth: int) -> dict:
    st = p.lstat()
    is_dir = p.is_dir()
    e = {
        "name": p.name,
        "type": "dir" if is_dir else "file",
        "size": None if is_dir else st.st_size,
        "mtime": _mtime_iso(st),
        "mode": stat_mod.filemode(st.st_mode)[1:],
    }
    if is_dir:
        e["children"] = _list_dir(p, depth - 1) if depth > 1 else None
    return e


def _list_dir(d: Path, depth: int) -> list[dict]:
    try:
        entries = sorted(
            d.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())
        )
    except PermissionError:
        raise ApiError(403, "permission_denied", str(d))
    return [_entry(p, depth) for p in entries]


@router.get("/tree")
async def tree(path: str | None = None, depth: int = 1):
    d = safe(path)
    if not d.exists():
        raise ApiError(404, "not_found", str(d))
    if not d.is_dir():
        raise ApiError(400, "not_a_directory", str(d))
    rel = os.path.relpath(d, WORKSPACE.resolve())
    return {"path": "" if rel == "." else rel, "entries": _list_dir(d, max(depth, 1))}


@router.get("/content")
async def content(path: str):
    f = safe(path)
    if not f.exists():
        raise ApiError(404, "not_found", str(f))
    if not f.is_file():
        raise ApiError(400, "not_a_file", str(f))
    st = f.stat()
    data = None
    if st.st_size <= TEXT_LIMIT:
        raw = f.read_bytes()
        try:
            data = raw.decode("utf-8")
        except UnicodeDecodeError:
            data = None
    if data is None:
        return JSONResponse(
            {"binary": True, "size": st.st_size, "mtime": _mtime_iso(st)}
        )
    return PlainTextResponse(data, headers={"X-File-Mtime": _mtime_iso(st)})


@router.put("/content")
async def put_content(body: dict):
    f = safe(str(body.get("path", "")))
    base = body.get("base_mtime")
    text = body.get("content")
    if not isinstance(text, str):
        raise ApiError(400, "bad_request", "content must be a string")

    exists = f.exists()
    if base is None:
        if exists:
            raise ApiError(
                409, "mtime_conflict", "file exists",
            )
    else:
        if not exists:
            raise ApiError(404, "not_found", str(f))
        cur = _mtime_iso(f.stat())
        if cur != base:
            return JSONResponse(
                {"error": "mtime_conflict", "message": "file changed on disk",
                 "current_mtime": cur},
                status_code=409,
            )

    f.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(f.parent), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, f)
    return {"mtime": _mtime_iso(f.stat())}


@router.post("/upload", status_code=201)
async def upload(path: str = Form(""), files: list[UploadFile] = None):
    d = safe(path)
    d.mkdir(parents=True, exist_ok=True)
    uploaded = []
    for uf in files or []:
        name = os.path.basename(uf.filename or "unnamed")
        target = d / name
        with open(target, "wb") as out:
            shutil.copyfileobj(uf.file, out)
        uploaded.append(name)
    return {"uploaded": uploaded}


@router.get("/download")
async def download(path: str):
    p = safe(path)
    if not p.exists():
        raise ApiError(404, "not_found", str(p))
    if p.is_file():
        return FileResponse(p, filename=p.name,
                            content_disposition_type="attachment")
    # 目录：打 zip 后返回，临时文件响应后清理
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
        for sub in p.rglob("*"):
            if sub.is_file():
                zf.write(sub, sub.relative_to(p.parent))
    return FileResponse(
        tmp.name, filename=f"{p.name}.zip",
        content_disposition_type="attachment",
        background=BackgroundTask(os.unlink, tmp.name),
    )


@router.post("/mkdir", status_code=201)
async def mkdir(body: dict):
    d = safe(str(body.get("path", "")))
    d.mkdir(parents=True, exist_ok=True)


@router.post("/move", status_code=204)
async def move(body: dict):
    src = safe(str(body.get("from", "")))
    dst = safe(str(body.get("to", "")))
    if not src.exists():
        raise ApiError(404, "not_found", str(src))
    if dst.exists():
        raise ApiError(409, "exists", str(dst))
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))


@router.post("/delete", status_code=204)
async def delete(body: dict):
    p = safe(str(body.get("path", "")))
    if not p.exists():
        raise ApiError(404, "not_found", str(p))
    if p.is_dir():
        if not body.get("recursive"):
            raise ApiError(409, "not_recursive", "directory requires recursive: true")
        shutil.rmtree(p)
    else:
        p.unlink()


@router.websocket("/watch")
async def watch(ws: WebSocket, path: str | None = None):
    try:
        d = safe(path)
    except ApiError:
        await ws.close(code=4403)
        return
    await ws.accept()

    from watchfiles import Change, awatch

    stop = asyncio.Event()

    async def pinger():
        while not stop.is_set():
            await asyncio.sleep(30)
            with contextlib.suppress(Exception):
                await ws.send_text(json.dumps({"type": "ping"}))

    ping_task = asyncio.create_task(pinger())
    root = WORKSPACE.resolve()
    try:
        async for changes in awatch(d, stop_event=stop, step=200):
            for change, cpath in changes:
                event = {
                    Change.added: "created",
                    Change.modified: "modified",
                    Change.deleted: "deleted",
                }.get(change, "modified")
                rel = os.path.relpath(cpath, root)
                await ws.send_text(json.dumps({
                    "type": "fs", "event": event, "path": rel,
                    "is_dir": os.path.isdir(cpath),
                }))
    except (WebSocketDisconnect, RuntimeError, ConnectionError):
        pass
    finally:
        stop.set()
        ping_task.cancel()
