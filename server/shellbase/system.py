"""平台元信息：system info / health / 应用注册表。

设计依据 docs/v1/api/system.md。
"""

import asyncio
import os
import socket
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .state import STATE_DIR, WORKSPACE, load_registry

router = APIRouter()

VERSION = "1.0.0"
_started = time.time()


def _meminfo() -> dict:
    total = used = 0
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.strip().split()[0]) * 1024
        total = info.get("MemTotal", 0)
        used = total - info.get("MemAvailable", 0)
    except (OSError, ValueError):
        pass
    return {"total": total, "used": used}


def _cpu_sample() -> tuple[int, int]:
    with open("/proc/stat") as f:
        parts = f.readline().split()[1:]
    nums = [int(x) for x in parts]
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
    return sum(nums), idle


async def _cpu_percent() -> float:
    try:
        t1, i1 = _cpu_sample()
        await asyncio.sleep(0.1)
        t2, i2 = _cpu_sample()
        dt = t2 - t1
        if dt <= 0:
            return 0.0
        return round(100.0 * (1 - (i2 - i1) / dt), 1)
    except (OSError, ValueError, IndexError):
        return 0.0


@router.get("/api/system/info")
async def info():
    st = os.statvfs(WORKSPACE)
    from .terminals import tmux_sessions

    try:
        with open("/proc/uptime") as f:
            uptime = int(float(f.read().split()[0]))
    except (OSError, ValueError):
        uptime = int(time.time() - _started)
    return {
        "version": VERSION,
        "hostname": socket.gethostname(),
        "uptime_seconds": uptime,
        "cpu_percent": await _cpu_percent(),
        "memory": _meminfo(),
        "disk": {
            "total": st.f_blocks * st.f_frsize,
            "used": (st.f_blocks - st.f_bavail) * st.f_frsize,
        },
        "terminals_alive": len(tmux_sessions()),
    }


@router.get("/api/system/health")
async def health():
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        probe = STATE_DIR / ".health"
        probe.write_text("ok")
        probe.unlink()
    except OSError:
        return JSONResponse({"status": "unhealthy"}, status_code=503)
    return {"status": "ok"}


@router.get("/api/apps")
async def apps():
    return {"apps": load_registry()}
