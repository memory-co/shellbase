"""文件系统状态存储：原子写、路径约定、应用注册表。

设计依据 docs/v1/works/backend.md §3。
"""

import asyncio
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

WORKSPACE = Path(os.environ.get("SHELLBASE_WORKSPACE", "/workspace"))
STATE_DIR = Path(
    os.environ.get("SHELLBASE_STATE_DIR", str(WORKSPACE / ".shellbase" / "state"))
)
TERMINALS_DIR = STATE_DIR / "terminals"
WINDOWS_DIR = STATE_DIR / "windows"

# 单进程唯一写者，进程内一把锁串行化全部状态写入（量级极小，无需分文件锁）
lock = asyncio.Lock()


class ApiError(Exception):
    def __init__(self, status: int, error: str, message: str = ""):
        self.status = status
        self.error = error
        self.message = message or error


def ensure_dirs() -> None:
    TERMINALS_DIR.mkdir(parents=True, exist_ok=True)
    WINDOWS_DIR.mkdir(parents=True, exist_ok=True)


def now_iso() -> str:
    return (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def read_json(path: Path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def write_json_atomic(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---- 应用注册表（uri.md §6：可选增强，不是准入门槛） ----

BUILTIN_APPS = [
    {"scheme": "bash", "type": "terminal", "title": "终端", "cmd": None},
    {"scheme": "file", "type": "builtin", "title": "文件浏览器"},
    {"scheme": "https", "type": "builtin", "title": "浏览器"},
    {"scheme": "claude", "type": "terminal", "title": "Claude Code", "cmd": "claude"},
    {"scheme": "codex", "type": "terminal", "title": "Codex", "cmd": "codex"},
]


def load_registry() -> list[dict]:
    apps = [dict(a) for a in BUILTIN_APPS]
    extra = os.environ.get("SHELLBASE_APPS_EXTRA", "").strip()
    if extra:
        try:
            for item in json.loads(extra):
                if isinstance(item, dict) and item.get("scheme"):
                    item["extra"] = True
                    apps = [a for a in apps if a["scheme"] != item["scheme"]]
                    apps.append(item)
        except (ValueError, TypeError):
            pass  # 配置坏了不拦启动，注册表只是增强
    return apps


def registry_by_scheme() -> dict[str, dict]:
    return {a["scheme"]: a for a in load_registry()}
