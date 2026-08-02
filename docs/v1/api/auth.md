# Auth API

设计背景：[works/design.md](../works/design.md) §3.1——应用层网关方案，`AuthGate` 中间件是校验的真身。

Cookie：`shellbase_token`，`HttpOnly; SameSite=Strict; Path=/`（HTTPS 部署时加 `Secure`），值即访问令牌本身，有效期为会话级（不设 Max-Age，关浏览器即失）。

## POST /api/auth/login

登录。网关对此端点放行（无需令牌），并做限速（同 IP 60s 内最多 10 次，超限 `429`）。

请求：

```json
{ "token": "your-secret" }
```

- 与 `SHELLBASE_TOKEN` **常量时间比较**（`secrets.compare_digest`）；
- 成功：`204`，`Set-Cookie: shellbase_token=...`；
- 失败：`401 {"error": "bad_token", "message": "invalid token"}`。

## GET /api/auth/verify

**探测端点**：网关自身在中间件里校验令牌，不再发子请求；此端点保留给前端/外部探测，读取请求的 Cookie 或 `Authorization` 头：

- 校验顺序：Cookie `shellbase_token` → `Authorization: Bearer <token>`（供脚本/程序化调用 API）；
- 通过：`204`；不通过：`401`。网关对 `/api/`、`/tty/`、`/proxy/` 下的未认证请求返回 401，页面路由则 302 跳转 `/login`。

## POST /api/auth/logout

`204`，`Set-Cookie` 置空 + `Max-Age=0`。令牌本身不失效（它是根凭据），只是浏览器不再持有。

## GET /api/auth/me

登录态探测，前端 Shell 启动时调用（能到达这里即已通过门禁）：

```json
{ "authenticated": true }
```
