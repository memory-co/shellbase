# tty_proxy — `/tty/` 反向代理：把请求原样带过去，把响应完整带回来

## 这个场景在测什么

终端块是 iframe 装载 ttyd 自带的 web 客户端（`/api/terminals/attach` → 302
`/tty/?arg=<session>`），所以 `/tty/` 这条反代链路一旦失真，用户看到的就是**白页**。
网关下沉进 FastAPI 后（works/design.md §3.1），这层由 `gateway.proxy_http` 承担：

1. **GET 不许被塞进一个体** —— 转发时若给无体请求挂上流式 body，httpx 会补一个
   `Transfer-Encoding: chunked`；ttyd 用的 libwebsockets 收到「带 chunked 体的 GET」
   会在发完响应头后直接断开，表现为响应头说有 191KB、实际 0 字节。
   这条是**回归用例**：假上游按同样的脾气行事，请求带体就只发头不发体。
2. **并发下同样成立** —— 该 bug 顺序请求约 5% 触发、并发 10 路约 50%，
   所以断言必须压在并发上，单发跑绿说明不了问题。
3. **有体的请求照常带体** —— 修法不能矫枉过正：POST 的体要一字节不差地到上游。
4. **透传保真** —— query string、请求头、上游的响应头与状态码原样过线。
5. **上游不可达 → 502**，而不是 500 或挂住。
6. **门禁盖住 `/tty/`** —— 未登录拿不到反代通道，且返回 401 而不是跳登录页
   （iframe 里跳登录页只会套娃）。

## 不在这测什么

- **WebSocket 那半条链路**（`/tty/ws` 的子协议协商与双向转发）—— in-process
  ASGI transport 不支持 ws，要测得真起端口 + 真 ws 客户端，属于另一个形态的场景。
- **ttyd / tmux 本身**：会话怎么建、attach 怎么裁决，在 terminals 侧的场景里锁，
  这里只关心「网关有没有把字节原样搬运」，假上游连 ttyd 都不是。
- 静态托管、限流、上传上限等网关的其他职责 —— 各自场景。

## fixture 来源

- `client` / `anon`（`tests/conftest.py`）—— in-process ASGI client，带/不带令牌
- `FakeUpstream`（`tests/conftest.py`）—— 最小 HTTP/1.1 假上游，记录收到的请求；
  `picky=True` 模仿 libwebsockets 对「带体的 GET」的反应
- `upstream_at`（`tests/conftest.py`）—— 把 `gateway.TTYD_UPSTREAM` 指到假上游
