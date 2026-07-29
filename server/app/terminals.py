"""终端会话：会话身份 = (window, URI)，无中生有 + 302 attach。

设计依据 docs/v1/works/backend.md §2、docs/v1/works/uri.md、docs/v1/api/terminals.md。
"""

import hashlib
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter
from fastapi.responses import RedirectResponse

from . import windows
from .state import (
    TERMINALS_DIR,
    WORKSPACE,
    ApiError,
    lock,
    now_iso,
    read_json,
    registry_by_scheme,
    write_json_atomic,
)

router = APIRouter()

NON_TERMINAL_SCHEMES = {"http", "https", "file"}
GC_KEEP_SECONDS = 7 * 24 * 3600


# ---- URI 规范化与内部会话名派生（uri.md §4） ----

def parse_terminal_uri(uri: str) -> dict:
    parts = urlsplit(uri)
    scheme = parts.scheme.lower()
    if not scheme or not re.fullmatch(r"[a-z][a-z0-9+.-]*", scheme):
        raise ApiError(400, "bad_uri", f"cannot parse uri: {uri!r}")
    registry = registry_by_scheme()
    app = registry.get(scheme)
    if scheme in NON_TERMINAL_SCHEMES or (app and app.get("type") != "terminal"):
        raise ApiError(400, "not_terminal_scheme", f"{scheme}:// is not a terminal scheme")

    # path 表示工作目录；authority 位并入路径（bash://x 与 bash:///x 等价）
    path = parts.path or ""
    if parts.netloc:
        path = "/" + parts.netloc + path
    path = path.rstrip("/") or str(WORKSPACE)

    q = parse_qs(parts.query)
    try:
        tab = int(q.get("tab", ["1"])[0] or "1")
    except ValueError:
        raise ApiError(400, "bad_uri", "tab must be an integer")
    if tab < 1:
        raise ApiError(400, "bad_uri", "tab must be >= 1")

    # scheme 名即命令名；注册表可提供别名（uri.md §3.1 / §6）
    cmd = (app or {}).get("cmd") or scheme
    if shutil.which(cmd) is None:
        raise ApiError(400, "cmd_not_found", f"command not in PATH: {cmd}")

    # path 是文件：cwd 取父目录，文件名作第一个参数（编辑器类因此可用）
    p = Path(path)
    arg = None
    if p.is_file():
        cwd = str(p.parent)
        arg = p.name
    elif p.is_dir():
        cwd = str(p)
    else:
        cwd = str(WORKSPACE)

    normalized = f"{scheme}://{path}" + (f"?tab={tab}" if tab > 1 else "")
    return {
        "scheme": scheme,
        "path": path,
        "tab": tab,
        "cmd": cmd,
        "arg": arg,
        "cwd": cwd,
        "uri": normalized,
        "kind": "plain" if cmd == "bash" else "agent",
    }


def _slug(path: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", path).strip("-").lower() or "workspace"
    if len(s) > 40:
        s = s[:32] + "-" + hashlib.sha1(path.encode()).hexdigest()[:6]
    return s


def session_name(wid: str, t: dict) -> str:
    name = f"{wid}--{t['scheme']}-{_slug(t['path'])}"
    if t["tab"] > 1:
        name += f"-{t['tab']}"
    return name


def state_path(name: str) -> Path:
    return TERMINALS_DIR / f"{name}.json"


# ---- tmux ----

def _tmux(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["tmux", *args], capture_output=True, text=True, timeout=10
    )


def tmux_alive(name: str) -> bool:
    return _tmux("has-session", "-t", f"={name}").returncode == 0


def tmux_sessions() -> list[str]:
    r = _tmux("list-sessions", "-F", "#{session_name}")
    if r.returncode != 0:
        return []
    return [line for line in r.stdout.splitlines() if line]


def tmux_clients(name: str) -> int:
    r = _tmux("list-clients", "-t", f"={name}", "-F", "#{client_name}")
    if r.returncode != 0:
        return 0
    return len([line for line in r.stdout.splitlines() if line])


def tmux_create(name: str, cwd: str, cmd: str, arg: str | None) -> None:
    from . import env as env_mod

    args = ["new-session", "-d", "-s", name, "-c", cwd]
    # 全局环境变量注入（env.md §2 通道 2：兜底 tmux 全局环境未设置的窗口期）
    for key, value in env_mod.load_vars().items():
        args += ["-e", f"{key}={value}"]
    if cmd != "bash":
        args.append("--")
        args.append(cmd)
        if arg:
            args.append(arg)
    elif arg:
        args += ["--", "bash"]
    r = _tmux(*args)
    if r.returncode != 0 and not tmux_alive(name):
        raise ApiError(500, "tmux_error", r.stderr.strip() or "failed to create session")
    _tmux("set-option", "-g", "window-size", "latest")


# ---- 端点 ----

@router.get("/api/windows/{wid}/terminals/attach")
async def attach(wid: str, uri: str, mode: str | None = None):
    windows.validate_wid(wid)
    t = parse_terminal_uri(uri)
    name = session_name(wid, t)
    sf = state_path(name)
    ro = mode == "ro"

    async with lock:
        await windows.ensure_window_locked(wid)
        st = read_json(sf)
        if st is None:
            if ro:
                raise ApiError(404, "no_such_session", "cannot watch a session that does not exist")
            # 无中生有：登记 state + 预创建 tmux 会话
            st = {
                "window": wid,
                "uri": t["uri"],
                "kind": t["kind"],
                "cwd": t["cwd"],
                "cmd": None if t["kind"] == "plain" else t["cmd"],
                "arg": t["arg"],
                "created_at": now_iso(),
                "last_attached": now_iso(),
            }
            write_json_atomic(sf, st)
            if not tmux_alive(name):
                tmux_create(name, t["cwd"], t["cmd"], t["arg"])
        else:
            st["last_attached"] = now_iso()
            write_json_atomic(sf, st)
            if not tmux_alive(name):
                # 现场消亡（容器重启等）：凭 state 重建同目录、同命令的会话
                tmux_create(name, st.get("cwd") or str(WORKSPACE),
                            st.get("cmd") or "bash", st.get("arg"))

    target = f"/tty/?arg={name}" + ("&arg=ro" if ro else "")
    return RedirectResponse(target, status_code=302)


@router.get("/api/terminals")
async def list_terminals(window: str | None = None):
    async with lock:
        items = _reconcile_locked()
    if window is not None:
        items = [i for i in items if i.get("window") == window]
    return {"terminals": items}


@router.delete("/api/windows/{wid}/terminals", status_code=204)
async def delete_terminal(wid: str, uri: str):
    windows.validate_wid(wid)
    t = parse_terminal_uri(uri)
    name = session_name(wid, t)
    sf = state_path(name)
    async with lock:
        if read_json(sf) is None:
            raise ApiError(404, "no_such_session", f"no session for {t['uri']} in window {wid}")
        _tmux("kill-session", "-t", f"={name}")
        sf.unlink(missing_ok=True)


# ---- 对账与回收（backend.md §7） ----

def destroy_window_terminals(wid: str) -> None:
    """删除 window 时销毁其全部会话（须已持锁）。"""
    for sf in TERMINALS_DIR.glob("*.json"):
        st = read_json(sf)
        if st and st.get("window") == wid:
            _tmux("kill-session", "-t", f"={sf.stem}")
            sf.unlink(missing_ok=True)


def _referenced_uris() -> set[tuple[str, str]]:
    refs: set[tuple[str, str]] = set()
    for wf in windows.window_files():
        w = read_json(wf)
        if not w:
            continue
        for tab in windows._tabs_of(w.get("root")):
            uri = (tab.get("config") or {}).get("uri")
            if uri:
                refs.add((w["id"], uri))
    return refs


def _reconcile_locked() -> list[dict]:
    from datetime import datetime, timezone

    alive = set(tmux_sessions())
    refs = _referenced_uris()
    items: list[dict] = []
    seen: set[str] = set()

    for sf in sorted(TERMINALS_DIR.glob("*.json")):
        st = read_json(sf)
        if not st:
            continue
        name = sf.stem
        seen.add(name)
        status = "alive" if name in alive else "exited"

        # GC 兜底：exited 且不被任何 window 引用且超保留期
        if status == "exited":
            wid = st.get("window")
            norm = st.get("uri", "")
            referenced = any(
                w == wid and _same_identity(norm, u) for (w, u) in refs
            )
            try:
                last = datetime.fromisoformat(
                    st.get("last_attached", "").replace("Z", "+00:00")
                )
                age = (datetime.now(timezone.utc) - last).total_seconds()
            except ValueError:
                age = 0
            if not referenced and age > GC_KEEP_SECONDS:
                sf.unlink(missing_ok=True)
                continue

        items.append({
            "window": st.get("window"),
            "uri": st.get("uri"),
            "kind": st.get("kind"),
            "cwd": st.get("cwd"),
            "cmd": st.get("cmd"),
            "status": status,
            "created_at": st.get("created_at"),
            "last_attached": st.get("last_attached"),
            "clients": tmux_clients(name) if status == "alive" else 0,
        })

    # tmux 有、state 无：external，不杀、不收编
    for name in sorted(alive - seen):
        items.append({
            "window": None,
            "uri": None,
            "kind": "external",
            "cwd": None,
            "cmd": None,
            "status": "alive",
            "created_at": None,
            "last_attached": None,
            "clients": tmux_clients(name),
        })
    return items


def _same_identity(state_uri: str, leaf_uri: str) -> bool:
    if state_uri == leaf_uri:
        return True
    try:
        return parse_terminal_uri(leaf_uri)["uri"] == state_uri
    except ApiError:
        return False
