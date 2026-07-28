# Auth API

设计背景：[works/design.md](../works/design.md) §3.1——nginx `auth_request` 方案，FastAPI 是校验的真身。

Cookie：`shellbase_token`，`HttpOnly; SameSite=Strict; Path=/`（HTTPS 部署时加 `Secure`），值即访问令牌本身，有效期为会话级（不设 Max-Age，关浏览器即失）。

## POST /api/auth/login

登录。nginx 对此端点放行（不经 auth_request），并做限速（同 IP 60s 内最多 10 次，超限 `429`）。

请求：

```json
{ "token": "your-secret" }
```

- 与 `SHELLBASE_TOKEN` **常量时间比较**（`secrets.compare_digest`）；
- 成功：`204`，`Set-Cookie: shellbase_token=...`；
- 失败：`401 {"error": "bad_token", "message": "invalid token"}`。

## GET /api/auth/verify

**内部端点**：仅供 nginx `auth_request` 子请求调用，前端不应直接使用。nginx 把原请求的 Cookie / `Authorization` 头透传过来：

- 校验顺序：Cookie `shellbase_token` → `Authorization: Bearer <token>`（供脚本/程序化调用 API）；
- 通过：`204`；不通过：`401`（nginx 据此对原请求返回 401，页面路由则跳转 `/login`）。

## POST /api/auth/logout

`204`，`Set-Cookie` 置空 + `Max-Age=0`。令牌本身不失效（它是根凭据），只是浏览器不再持有。

## GET /api/auth/me

登录态探测，前端 Shell 启动时调用（能到达这里即已通过 auth_request）：

```json
{ "authenticated": true }
```
