"""window：每张页面的状态都存在后端；多 window、无中生有、版本乐观锁、watch 广播。

设计依据 docs/v1/works/backend.md §4、docs/v1/api/windows.md。
"""

import asyncio
import contextlib
import json
import re
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .state import (
    WINDOWS_DIR,
    ApiError,
    lock,
    now_iso,
    read_json,
    write_json_atomic,
)

router = APIRouter()

WID_RE = re.compile(r"^[a-z0-9-]{1,64}$")
MAX_DEPTH = 32

# wid -> set[WebSocket]
_watchers: dict[str, set[WebSocket]] = {}


def validate_wid(wid: str) -> None:
    if not WID_RE.fullmatch(wid):
        raise ApiError(400, "bad_window_id", "window id must match [a-z0-9-]{1,64}")


def window_path(wid: str) -> Path:
    return WINDOWS_DIR / f"{wid}.json"


def window_files() -> list[Path]:
    return sorted(WINDOWS_DIR.glob("*.json"))


GRID_COLS = 24
GRID_ROWS = 16
MAX_PANELS = 64


def _empty_window(wid: str) -> dict:
    """空 window：一个铺满网格的启动页面板。"""
    return {
        "id": wid,
        "name": wid,
        "version": 1,
        "updated_at": now_iso(),
        "root": {
            "cols": GRID_COLS,
            "rows": GRID_ROWS,
            "panels": [
                {"id": "p0", "uri": None, "x": 0, "y": 0,
                 "w": GRID_COLS, "h": GRID_ROWS}
            ],
        },
    }


async def ensure_window_locked(wid: str) -> dict:
    """读取或无中生有一个 window（调用方须已持锁）。"""
    w = read_json(window_path(wid))
    if w is None:
        w = _empty_window(wid)
        write_json_atomic(window_path(wid), w)
    return w


def _panels_of(root) -> list[dict]:
    """window.root 中的全部面板记录。"""
    if not isinstance(root, dict):
        return []
    panels = root.get("panels")
    return panels if isinstance(panels, list) else []


def _count_blocks(root) -> int:
    return len(_panels_of(root))


def _validate_tree(root) -> None:
    """校验网格布局的三条几何不变量（windows.md：界内 / 不重叠 / 铺满）。"""
    if not isinstance(root, dict):
        raise ApiError(400, "bad_layout", "root must be an object")
    cols = root.get("cols")
    rows = root.get("rows")
    if cols != GRID_COLS or rows != GRID_ROWS:
        raise ApiError(400, "bad_layout", f"grid must be {GRID_COLS}x{GRID_ROWS}")
    panels = root.get("panels")
    if not isinstance(panels, list) or not panels:
        raise ApiError(400, "bad_layout", "panels must be a non-empty array")
    if len(panels) > MAX_PANELS:
        raise ApiError(400, "too_many_panels", f"at most {MAX_PANELS} panels")

    area = 0
    rects: list[tuple[int, int, int, int]] = []
    seen_ids: set[str] = set()
    for p in panels:
        if not isinstance(p, dict):
            raise ApiError(400, "bad_layout", "panel must be an object")
        pid = p.get("id")
        if not isinstance(pid, str) or not pid:
            raise ApiError(400, "bad_layout", "panel id must be a non-empty string")
        if pid in seen_ids:
            raise ApiError(400, "bad_layout", f"duplicate panel id: {pid}")
        seen_ids.add(pid)
        uri = p.get("uri")
        if uri is not None and not isinstance(uri, str):
            raise ApiError(400, "bad_layout", "panel uri must be string or null")
        x, y, w, h = p.get("x"), p.get("y"), p.get("w"), p.get("h")
        if not all(isinstance(v, int) for v in (x, y, w, h)):
            raise ApiError(400, "bad_layout", "panel x/y/w/h must be integers")
        # 界内
        if w < 1 or h < 1 or x < 0 or y < 0 or x + w > cols or y + h > rows:
            raise ApiError(400, "bad_layout", f"panel {pid} out of bounds")
        rects.append((x, y, w, h))
        area += w * h

    # 不重叠：两两 AABB 相交检测（面板数 ≤ 64，O(n²) 足够）
    for i in range(len(rects)):
        ax, ay, aw, ah = rects[i]
        for j in range(i + 1, len(rects)):
            bx, by, bw, bh = rects[j]
            if ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah:
                raise ApiError(400, "bad_layout", "panels overlap")

    # 铺满
    if area != cols * rows:
        raise ApiError(400, "bad_layout", "panels do not tile the grid")


async def _broadcast(wid: str, message: dict) -> None:
    dead = []
    for ws in list(_watchers.get(wid, ())):
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
            dead.append(ws)
    for ws in dead:
        _watchers.get(wid, set()).discard(ws)


@router.get("/api/windows")
async def list_windows():
    async with lock:
        out = []
        for wf in window_files():
            w = read_json(wf)
            if not w:
                continue
            out.append({
                "id": w.get("id", wf.stem),
                "name": w.get("name", wf.stem),
                "updated_at": w.get("updated_at"),
                "blocks": _count_blocks(w.get("root")),
            })
        if not out:
            w = await ensure_window_locked("main")
            out.append({
                "id": "main", "name": w["name"],
                "updated_at": w["updated_at"], "blocks": 1,
            })
    return {"windows": out}


@router.get("/api/windows/{wid}")
async def get_window(wid: str):
    validate_wid(wid)
    async with lock:
        return await ensure_window_locked(wid)


@router.put("/api/windows/{wid}", status_code=204)
async def put_window(wid: str, body: dict):
    validate_wid(wid)
    version = body.get("version")
    if not isinstance(version, int):
        raise ApiError(400, "bad_tree", "version must be an integer")
    _validate_tree(body.get("root"))
    async with lock:
        cur = await ensure_window_locked(wid)
        if version != cur["version"] + 1:
            raise ApiError(
                409, "version_conflict",
                f"expected version {cur['version'] + 1}",
            )
        new = {
            "id": wid,
            "name": str(body.get("name") or cur.get("name") or wid),
            "version": version,
            "updated_at": now_iso(),
            "root": body["root"],
        }
        write_json_atomic(window_path(wid), new)
    await _broadcast(wid, {"type": "window_updated", "version": version})


@router.delete("/api/windows/{wid}", status_code=204)
async def delete_window(wid: str):
    validate_wid(wid)
    if wid == "main":
        raise ApiError(400, "cannot_delete_main", "the main window cannot be deleted")
    from . import terminals  # 延迟导入避免环

    async with lock:
        if read_json(window_path(wid)) is None:
            raise ApiError(404, "no_such_window", f"window not found: {wid}")
        # 会话身份含 window：删就是删，无跨 window 引用问题
        terminals.destroy_window_terminals(wid)
        window_path(wid).unlink(missing_ok=True)
    await _broadcast(wid, {"type": "window_deleted"})
    _watchers.pop(wid, None)


@router.websocket("/api/windows/{wid}/watch")
async def watch(ws: WebSocket, wid: str):
    if not WID_RE.fullmatch(wid):
        await ws.close(code=4400)
        return
    await ws.accept()
    _watchers.setdefault(wid, set()).add(ws)
    try:
        while True:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(ws.receive_text(), timeout=30)
                continue
            await ws.send_text(json.dumps({"type": "ping"}))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        _watchers.get(wid, set()).discard(ws)
