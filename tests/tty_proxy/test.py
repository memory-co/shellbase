"""tty_proxy — `/tty/` 反向代理场景. See README.md."""
from __future__ import annotations

import asyncio

from tests.conftest import FakeUpstream

BIG = b"<html>" + b"x" * 200_000 + b"</html>"


async def test_get_carries_no_body_framing_upstream(client, upstream_at):
    """无体的请求转发过去也必须是无体的。

    给 GET 挂上流式 body，httpx 会补 Transfer-Encoding: chunked —— 这就是
    /tty/ 偶发白页的根因。
    """
    async with FakeUpstream(BIG) as up:
        upstream_at(up)
        resp = await client.get("/tty/")

    assert resp.status_code == 200
    (seen,) = up.requests
    assert seen["method"] == "GET"
    assert "transfer-encoding" not in seen["headers"]
    assert "content-length" not in seen["headers"]


async def test_response_arrives_whole_from_a_picky_upstream(client, upstream_at):
    """回归：上游按 libwebsockets 的脾气对待带体的 GET，响应仍须完整。"""
    async with FakeUpstream(BIG, picky=True) as up:
        upstream_at(up)
        resp = await client.get("/tty/")

    assert resp.status_code == 200
    assert resp.content == BIG          # 旧实现：响应头说 len(BIG)，实际 0 字节


async def test_concurrent_gets_all_arrive_whole(client, upstream_at):
    """并发才是这个 bug 的高发区（顺序约 5%，并发 10 路约 50%）。"""
    async with FakeUpstream(BIG, picky=True) as up:
        upstream_at(up)
        resps = await asyncio.gather(*(client.get("/tty/") for _ in range(20)))

    assert all(r.status_code == 200 for r in resps)
    assert {len(r.content) for r in resps} == {len(BIG)}


async def test_request_body_still_reaches_upstream(client, upstream_at):
    """别矫枉过正：真带体的请求，体要一字节不差地过去。"""
    payload = b"a" * 100_000
    async with FakeUpstream(picky=True) as up:
        upstream_at(up)
        resp = await client.post("/tty/upload", content=payload)

    assert resp.status_code == 200
    (seen,) = up.requests
    assert seen["method"] == "POST"
    assert seen["body"] == payload
    assert resp.content == payload      # 假上游把 POST 的体原样回吐


async def test_query_and_headers_pass_through(client, upstream_at):
    """ttyd 靠 ?arg=<session> 认会话，丢了 query 就 attach 到别的终端上去了。"""
    async with FakeUpstream() as up:
        upstream_at(up)
        await client.get("/tty/", params={"arg": "w1--bash-workspace-1"},
                         headers={"x-probe": "keep-me"})

    (seen,) = up.requests
    assert seen["target"] == "/?arg=w1--bash-workspace-1"
    assert seen["headers"]["x-probe"] == "keep-me"


async def test_upstream_headers_and_status_pass_through(client, upstream_at):
    async with FakeUpstream(b"hi") as up:
        upstream_at(up)
        resp = await client.get("/tty/")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "text/html"
    assert resp.headers["content-length"] == "2"


async def test_unreachable_upstream_is_502(client, upstream_at):
    """上游没起来是 502，不是 500，也不该挂住。"""
    async with FakeUpstream() as up:
        upstream_at(up)
        dead = up.address                      # 出了这个 with 端口就没人听了

    from shellbase import gateway
    gateway.TTYD_UPSTREAM = dead               # monkeypatch 已在 fixture 里登记回滚
    resp = await client.get("/tty/")

    assert resp.status_code == 502
    assert resp.json()["error"] == "bad_gateway"


async def test_tty_requires_a_token(anon, upstream_at):
    """门禁盖住反代通道；且给 401 而不是 302 —— iframe 里跳登录页只会套娃。"""
    async with FakeUpstream() as up:
        upstream_at(up)
        resp = await anon.get("/tty/")

    assert resp.status_code == 401
    assert resp.json()["error"] == "unauthorized"
    assert up.requests == []                   # 一个字节都没到上游
