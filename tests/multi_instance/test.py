"""multi_instance — 一台机器上多份实例互不串. See README.md."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest

from shellbase import cli
from shellbase.auth import cookie_name
from tests.conftest import TOKEN, client_for

REPO = Path(__file__).resolve().parents[2]

# ---- 一、浏览器侧：cookie 不能互相覆盖 ----


def test_cookie_name_carries_the_port():
    """cookie 罐不认端口，名字必须自己认。"""
    assert cookie_name("1.2.3.4:8080") == "shellbase_token_8080"
    assert cookie_name("1.2.3.4:8081") == "shellbase_token_8081"
    assert cookie_name("[::1]:8080") == "shellbase_token_8080"
    # 没写端口就按 scheme 兜底；重要的不是"对"，而是写入与读取拿到同一个名字
    assert cookie_name("example.com", "https") == "shellbase_token_443"
    assert cookie_name("example.com", "http") == "shellbase_token_80"


async def test_login_sets_a_port_scoped_cookie():
    async with client_for(token=None) as c:
        resp = await c.post(
            "/api/auth/login", json={"token": TOKEN}, headers={"host": "box:8080"}
        )
    assert resp.status_code == 204
    assert "shellbase_token_8080=" in resp.headers["set-cookie"]


async def test_another_instances_cookie_is_not_accepted():
    """8081 那份实例的 cookie 递给 8080，不该被认。"""
    async with client_for(token=None) as c:
        c.cookies.set("shellbase_token_8081", TOKEN)
        resp = await c.get("/api/system/info", headers={"host": "box:8080"})
    assert resp.status_code == 401


async def test_own_cookie_works_with_the_others_in_the_jar():
    """两份 cookie 同时躺在罐里（真实浏览器就是这样），各认各的。"""
    async with client_for(token=None) as c:
        c.cookies.set("shellbase_token_8080", TOKEN)
        c.cookies.set("shellbase_token_8081", "another-instances-token")
        resp = await c.get("/api/system/info", headers={"host": "box:8080"})
    assert resp.status_code == 200


async def test_logout_only_clears_its_own_cookie():
    async with client_for(token=None) as c:
        c.cookies.set("shellbase_token_8080", TOKEN)
        resp = await c.post("/api/auth/logout", headers={"host": "box:8080"})
    assert resp.status_code == 204
    assert "shellbase_token_8080=" in resp.headers["set-cookie"]
    assert "shellbase_token_8081" not in resp.headers["set-cookie"]


def test_frontend_keeps_the_token_out_of_browser_storage():
    """令牌只许待在 HttpOnly cookie 里。

    一旦有人"顺手"把它塞进 localStorage，同源的任意脚本就能读到，
    而且会变成第二个登录态来源——按 origin 隔离的存储反而给了它落脚点。
    """
    web = REPO / "web" / "src"
    hits = [
        f"{p.relative_to(web)}:{i}"
        for p in web.rglob("*.ts*")
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
        if ("localStorage" in line or "sessionStorage" in line or "document.cookie" in line)
        and "token" in line.lower()
    ]
    assert hits == [], f"令牌不该进浏览器存储：{hits}"


# ---- 二、进程侧：真起两份实例 ----

# 从源码树跑（而不是装好的 wheel）：包路径、attach 脚本、前端产物都得显式指出来，
# 跟 Dockerfile 里那套环境变量是同一回事。
needs_terminal = pytest.mark.skipif(
    shutil.which("ttyd") is None or shutil.which("tmux") is None,
    reason="需要 ttyd + tmux 才能起完整实例",
)


@dataclass
class Instance:
    home: Path
    port: int
    workspace: Path
    token: str

    @property
    def env(self) -> dict:
        return {
            **os.environ,
            "HOME": str(self.home),                  # → cli.RUN_DIR = HOME/.shellbase
            "SHELLBASE_TOKEN": self.token,
            "SHELLBASE_STATE_DIR": str(self.workspace / ".shellbase" / "state"),
            # 真实双用户下 tmux socket 落在 /tmp/tmux-<uid>/ 天然分开；
            # 同 UID 跑两份得自己区分，见 README
            "SHELLBASE_TMUX_SOCKET": f"sb-test-{self.port}",
            "PYTHONPATH": str(REPO / "server"),
            "SHELLBASE_ATTACH_SH": str(REPO / "bin" / "attach.sh"),
            "SHELLBASE_WEB_ROOT": str(REPO / "web" / "dist"),
        }

    def doc(self) -> dict:
        return json.loads((self.home / ".shellbase" / "instance.json").read_text())

    def get(self, path: str, token: str | None = None) -> httpx.Response | None:
        """None 表示连不上（实例已经下线）。"""
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            return httpx.get(
                f"http://127.0.0.1:{self.port}{path}",
                headers=headers, timeout=5, follow_redirects=False,
            )
        except httpx.HTTPError:
            return None


def _run(inst: Instance, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "shellbase.cli", *args],
        env=inst.env, capture_output=True, text=True, timeout=90,
    )


@pytest.fixture
def two_instances(tmp_path):
    made = []
    for name in ("alice", "bob"):
        home = tmp_path / name
        (home / ".shellbase").mkdir(parents=True)
        ws = tmp_path / f"{name}-ws"
        ws.mkdir()
        made.append(Instance(home, cli._free_port(), ws, f"token-of-{name}"))

    for inst in made:
        r = _run(inst, "start", "--host", "127.0.0.1",
                 "--port", str(inst.port), "--workspace", str(inst.workspace))
        assert r.returncode == 0, f"start 失败：{r.stdout}\n{r.stderr}"
    try:
        yield made[0], made[1]
    finally:
        for inst in made:
            _run(inst, "stop")


@needs_terminal
def test_each_instance_keeps_its_own_run_dir(two_instances):
    a, b = two_instances
    for inst in (a, b):
        assert (inst.home / ".shellbase" / "instance.json").exists()
        assert (inst.home / ".shellbase" / "shellbase.pid").exists()
    assert a.doc()["pid"] != b.doc()["pid"]
    assert (a.doc()["port"], b.doc()["port"]) == (a.port, b.port)


@needs_terminal
def test_status_only_sees_its_own_instance(two_instances):
    a, b = two_instances
    doc_a = json.loads(_run(a, "status", "--json").stdout)
    doc_b = json.loads(_run(b, "status", "--json").stdout)
    assert (doc_a["port"], doc_b["port"]) == (a.port, b.port)
    assert doc_a["pid"] != doc_b["pid"]


@needs_terminal
def test_tokens_are_not_interchangeable(two_instances):
    a, b = two_instances
    assert a.get("/api/system/info", a.token).status_code == 200
    assert b.get("/api/system/info", b.token).status_code == 200
    assert a.get("/api/system/info", b.token).status_code == 401
    assert b.get("/api/system/info", a.token).status_code == 401


@needs_terminal
def test_ttyd_ports_do_not_collide(two_instances):
    a, b = two_instances
    pa, pb = a.doc()["ttyd_port"], b.doc()["ttyd_port"]
    assert pa and pb and pa != pb


@needs_terminal
def test_terminal_sessions_do_not_leak(two_instances):
    a, b = two_instances
    uri = f"bash://{a.workspace}?window=w-iso&block=1"
    attach = a.get(
        "/api/terminals/attach?uri=" + urllib.parse.quote(uri, safe=""), a.token
    )
    assert attach.status_code == 302, attach.text     # 302 → /tty/?arg=<会话名>

    assert "w-iso" in a.get("/api/terminals", a.token).text
    # 必须是"一个都看不到"：只查会话名会漏掉——共用 tmux socket 时，别人的会话
    # 会以 kind=external（window/uri 皆为 null）的形态出现在列表里，
    # 那同样是串数据
    assert b.get("/api/terminals", b.token).json()["terminals"] == []


@needs_terminal
def test_stopping_one_leaves_the_other_alone(two_instances):
    a, b = two_instances
    assert _run(a, "stop").returncode == 0
    time.sleep(1)
    assert a.get("/api/system/health") is None          # a 真的下线了
    assert b.get("/api/system/health").status_code == 200
    assert json.loads(_run(b, "status", "--json").stdout)["running"] is True
