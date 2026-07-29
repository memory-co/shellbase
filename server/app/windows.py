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


def _empty_window(wid: str) -> dict:
    """空 window：单个启动页块（FlexLayout IJsonModel）。"""
    return {
        "id": wid,
        "name": wid,
        "version": 1,
        "updated_at": now_iso(),
        "root": {
            "global": {"tabEnableRename": False, "splitterSize": 4},
            "borders": [],
            "layout": {
                "type": "row",
                "weight": 100,
                "children": [
                    {
                        "type": "tabset",
                        "weight": 100,
                        "children": [
                            {
                                "type": "tab",
                                "id": "t0",
                                "name": "启动页",
                                "component": "block",
                                "config": {"uri": None},
                            }
                        ],
                    }
                ],
            },
        },
    }


async def ensure_window_locked(wid: str) -> dict:
    """读取或无中生有一个 window（调用方须已持锁）。"""
    w = read_json(window_path(wid))
    if w is None:
        w = _empty_window(wid)
        write_json_atomic(window_path(wid), w)
    return w


def _walk_tabs(node, out: list[dict]) -> None:
    """收集布局树中的全部 tab 节点（FlexLayout IJsonModel 的叶子）。"""
    if not isinstance(node, dict):
        return
    if node.get("type") == "tab":
        out.append(node)
        return
    for child in node.get("children") or []:
        _walk_tabs(child, out)


def _tabs_of(root) -> list[dict]:
    if not isinstance(root, dict):
        return []
    tabs: list[dict] = []
    _walk_tabs(root.get("layout"), tabs)
    for border in root.get("borders") or []:
        _walk_tabs(border, tabs)
    return tabs


def _count_blocks(root) -> int:
    return len(_tabs_of(root))


def _depth(node, depth: int = 0) -> int:
    if not isinstance(node, dict) or depth > MAX_DEPTH:
        return depth
    children = node.get("children") or []
    return max((_depth(c, depth + 1) for c in children), default=depth)


def _validate_tree(root) -> None:
    """校验 FlexLayout IJsonModel 的骨架：layout 根 + tab 的 config.uri。"""
    if not isinstance(root, dict):
        raise ApiError(400, "bad_tree", "root must be an object")
    layout = root.get("layout")
    if not isinstance(layout, dict) or layout.get("type") not in ("row", "col"):
        raise ApiError(400, "bad_tree", "layout root must be a row/col node")
    if _depth(layout) > MAX_DEPTH:
        raise ApiError(400, "bad_tree", "tree too deep")
    for tab in _tabs_of(root):
        uri = (tab.get("config") or {}).get("uri")
        if uri is not None and not isinstance(uri, str):
            raise ApiError(400, "bad_tree", "tab config.uri must be string or null")


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
