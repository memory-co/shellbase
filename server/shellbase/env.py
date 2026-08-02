"""全局环境变量：用户自助配置，注入到新拉起的终端。

设计依据 docs/v1/works/env.md。读路径永远脱敏；写入后同步 tmux 全局环境。
"""

import os
import re
import subprocess

from fastapi import APIRouter

from .state import (
    STATE_DIR,
    ApiError,
    lock,
    now_iso,
    read_json,
    tmux_argv,
    write_json_atomic,
)

router = APIRouter(prefix="/api/env")

ENV_FILE = STATE_DIR / "env.json"
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def load_vars() -> dict[str, str]:
    doc = read_json(ENV_FILE) or {}
    return dict(doc.get("vars") or {})


def _mask(value: str) -> str:
    if len(value) <= 8:
        return value[:1] + "…" if value else ""
    return f"{value[:4]}…{value[-4:]}"


def _sync_tmux(vars_: dict[str, str], removed: list[str]) -> None:
    """tmux 全局环境：新会话从中继承（env.md §2）。tmux server 未起时忽略。"""
    for key, value in vars_.items():
        subprocess.run(
            tmux_argv("set-environment", "-g", key, value),
            capture_output=True, timeout=5,
        )
    for key in removed:
        subprocess.run(
            tmux_argv("set-environment", "-gr", key),
            capture_output=True, timeout=5,
        )


def apply_to_env() -> dict[str, str]:
    """容器进程环境为底座，平台配置叠加其上（同名覆盖）。"""
    return {**os.environ, **load_vars()}


def sync_on_startup() -> None:
    vars_ = load_vars()
    if vars_:
        _sync_tmux(vars_, [])


@router.get("")
async def get_env():
    doc = read_json(ENV_FILE) or {"updated_at": None, "vars": {}}
    return {
        "updated_at": doc.get("updated_at"),
        "vars": {
            k: {"preview": _mask(v), "length": len(v)}
            for k, v in (doc.get("vars") or {}).items()
        },
    }


@router.put("", status_code=204)
async def put_env(body: dict):
    incoming = body.get("vars")
    if not isinstance(incoming, dict):
        raise ApiError(400, "bad_request", "vars must be an object")

    async with lock:
        current = load_vars()
        removed: list[str] = []
        changed: dict[str, str] = {}
        for key, value in incoming.items():
            if not KEY_RE.fullmatch(key):
                raise ApiError(400, "bad_key", f"invalid variable name: {key}")
            if value is None:
                current.pop(key, None)
                removed.append(key)
            elif isinstance(value, str):
                current[key] = value
                changed[key] = value
            else:
                raise ApiError(400, "bad_request", f"{key}: value must be string or null")

        write_json_atomic(ENV_FILE, {"updated_at": now_iso(), "vars": current})
        try:
            os.chmod(ENV_FILE, 0o600)
        except OSError:
            pass
        _sync_tmux(changed, removed)
