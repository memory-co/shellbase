"""shellbase 各场景共用的 fixture 与 helper。

- ``client`` (fixture) —— 带令牌的 in-process HTTP client，直连 ASGI 应用，不开端口
- ``anon`` (fixture) —— 同上但不带令牌，用来验门禁
- ``FakeUpstream`` —— 只说最小 HTTP/1.1 的假上游，记录收到的请求原样，供反代场景用
- ``TOKEN`` —— 测试用令牌

环境变量必须在 import 应用之前定好：``state.py`` 在 import 期就把 workspace /
state 目录算出来了，默认值是 ``/workspace``，跑测试的机器上不该去碰它。
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

TOKEN = "test-token"

_TMP = Path(tempfile.mkdtemp(prefix="shellbase-tests-"))
os.environ["SHELLBASE_TOKEN"] = TOKEN
os.environ["SHELLBASE_WORKSPACE"] = str(_TMP / "workspace")
os.environ["SHELLBASE_STATE_DIR"] = str(_TMP / "state")
os.environ["SHELLBASE_WEB_ROOT"] = str(_TMP / "web")
for _d in ("workspace", "state/terminals", "state/windows", "web"):
    (_TMP / _d).mkdir(parents=True, exist_ok=True)

from shellbase.main import app  # noqa: E402


def client_for(*, token: str | None = TOKEN) -> httpx.AsyncClient:
    """绑到 ASGI 应用的 client。``token=None`` 即未登录。"""
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://gateway",
        cookies={"shellbase_token": token} if token else None,
        follow_redirects=False,
        timeout=30,
    )


@pytest_asyncio.fixture
async def client():
    async with client_for() as c:
        yield c


@pytest_asyncio.fixture
async def anon():
    async with client_for(token=None) as c:
        yield c


@pytest_asyncio.fixture(autouse=True)
async def _fresh_proxy_client():
    """每个用例给网关一个干净的 httpx client。

    它在 gateway 里是模块级单例（生产上一个进程一个事件循环，正好），
    而 pytest-asyncio 每个用例起一个新循环 —— 不复位就会撞上
    ``RuntimeError: Event loop is closed``。收尾走的是生产同一条
    ``aclose_client``。
    """
    from shellbase import gateway

    gateway._client = None
    yield
    await gateway.aclose_client()


class FakeUpstream:
    """假上游：记录收到的请求，按需回一段大响应。

    ``picky=True`` 时模仿 libwebsockets（ttyd 用的那套）的脾气 —— 请求一旦带了
    体的框架头（``Transfer-Encoding`` / ``Content-Length``），就只把响应头发出去
    然后立刻断开。真实 ttyd 就是这么把「带 chunked 体的 GET」搞成半截响应的。

    用法::

        async with FakeUpstream(body=b"x" * 1000) as up:
            monkeypatch.setattr(gateway, "TTYD_UPSTREAM", up.address)
    """

    def __init__(self, body: bytes = b"<html>ttyd</html>", *, picky: bool = True) -> None:
        self.body = body
        self.picky = picky
        self.requests: list[dict] = []
        self._server: asyncio.AbstractServer | None = None

    @property
    def port(self) -> int:
        assert self._server is not None, "upstream not started"
        return self._server.sockets[0].getsockname()[1]

    @property
    def address(self) -> str:
        return f"127.0.0.1:{self.port}"

    async def __aenter__(self) -> FakeUpstream:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        return self

    async def __aexit__(self, *exc) -> None:
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:                                  # keep-alive：连接复用也要照常
                head = await reader.readuntil(b"\r\n\r\n")
                lines = head.decode("latin-1").split("\r\n")
                method, target, _ = lines[0].split(" ", 2)
                headers = {}
                for line in lines[1:]:
                    if ":" in line:
                        k, v = line.split(":", 1)
                        headers[k.strip().lower()] = v.strip()

                framed = "content-length" in headers or "transfer-encoding" in headers
                body = await self._read_body(reader, headers) if framed else b""
                self.requests.append(
                    {"method": method, "target": target, "headers": headers, "body": body}
                )

                if self.picky and framed and method in ("GET", "HEAD"):
                    # ttyd 的失败形态：头发完就断，体一个字节不给
                    writer.write(
                        b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n"
                        b"content-length: %d\r\n\r\n" % len(self.body)
                    )
                    await writer.drain()
                    break

                payload = body if method == "POST" else self.body
                writer.write(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n"
                    b"content-length: %d\r\n\r\n" % len(payload) + payload
                )
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()

    @staticmethod
    async def _read_body(reader: asyncio.StreamReader, headers: dict) -> bytes:
        if headers.get("transfer-encoding", "").lower() == "chunked":
            out = bytearray()
            while True:
                size = int((await reader.readuntil(b"\r\n")).strip() or b"0", 16)
                chunk = await reader.readexactly(size + 2) if size else await reader.readexactly(2)
                if not size:
                    return bytes(out)
                out += chunk[:-2]
        n = int(headers.get("content-length", 0))
        return await reader.readexactly(n) if n else b""


@pytest.fixture
def upstream_at(monkeypatch):
    """把 /tty/ 的上游指到假上游（网关每次调用现读这个模块变量）。"""
    from shellbase import gateway

    def point_to(up: FakeUpstream) -> None:
        monkeypatch.setattr(gateway, "TTYD_UPSTREAM", up.address)

    return point_to
