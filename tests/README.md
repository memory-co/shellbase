# shellbase 测试 — 按场景组织

每个子目录是**一个场景**，有自己的 `README.md`（在测什么 / 不在这测什么 /
fixture 来源）和 `test.py`。相关的用例合并在一个场景下，跟「按代码模块切文件」解耦。

## 场景一览

| 目录 | 测什么 |
|---|---|
| [`tty_proxy/`](tty_proxy/) | `/tty/` 反向代理这条链路：无体的请求不许被塞进体（否则 httpx 补 `Transfer-Encoding: chunked`，ttyd 发完响应头就断，终端块白页）、并发下同样成立、有体的请求照常带体、query 与头透传、上游不可达 502、门禁盖住反代通道 |

## 共享 fixture / helper（`conftest.py`）

- `client` —— 带令牌的 in-process HTTP client（`httpx.ASGITransport`，不开端口）
- `anon` —— 同上但不带令牌，用来验门禁
- `client_for(token=)` —— 自定义令牌的 client 工厂
- `FakeUpstream(body, picky=)` —— 只说最小 HTTP/1.1 的假上游，记录收到的请求原样；
  `picky=True` 模仿 libwebsockets（ttyd）对「带体的 GET」的反应：只发响应头就断开
- `upstream_at(up)` —— 把 `gateway.TTYD_UPSTREAM` 指到假上游
- 一个 autouse fixture 会在每个用例前后复位网关的 httpx 单例 —— 它绑在创建它的
  事件循环上，而 pytest-asyncio 每个用例换一个循环

环境变量（workspace / state / web root）在 `conftest` import 应用**之前**就设成
临时目录：`state.py` 在 import 期就把路径算出来了，默认值是 `/workspace`。

## 跑

```bash
pip install -e ".[dev]"
pytest                      # 全部
pytest tests/tty_proxy -v   # 单个场景
```

## 加新场景

1. 新目录 `tests/场景名/`，放 `__init__.py`
2. 写 `README.md`：**测什么 / 不测什么 / fixture 来源**
3. 写 `test.py`：测试本体
4. 不需要在任何地方登记 —— pytest 自动收集
