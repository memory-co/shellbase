# shellbase v1 鉴权设计（OpenResty + Lua + JWT）

> 本文档是 [design.md](design.md) 鉴权部分的专项设计，并替换其早期方案：
> 顶层 HTTP 负载由 nginx 换为 **OpenResty**，鉴权由 `auth_request` 回调 FastAPI
> 改为 **网关层 Lua 本地校验 JWT**。

## 1. 方案概述与选型理由

```
 浏览器 ──(1) POST /api/auth/login {token}──▶ FastAPI ── 校验 SHELLBASE_TOKEN
    │◀──(2) Set-Cookie: shellbase_jwt=<JWT> ──┘          签发 HS256 JWT
    │
    │──(3) 任意请求（Cookie 自动携带 JWT）──▶ OpenResty
    │                                          access_by_lua: 本地验签 + 过期检查
    │                                          ├─ 通过 → proxy_pass 到上游
    │◀──(4) 401 / 302 /login ──────────────────┴─ 失败
```

职责划分一句话：**FastAPI 只负责"发证"，OpenResty 负责"查证"**，两者共享同一个 HMAC 密钥。

为什么从 nginx + auth_request 换成 OpenResty + Lua + JWT：

1. **每请求零回调**：`auth_request` 对每个请求发起一次到 FastAPI 的子请求；Lua 方案在网关进程内本地验签（HMAC + LuaJIT，微秒级），高频的文件 API / 终端 WS 握手不再放大到 FastAPI；
2. **鉴权与业务彻底解耦**：FastAPI 挂了，已登录用户的静态资源和 ttyd 终端不受影响（它们不经过 FastAPI）；
3. **无状态**：JWT 自包含过期时间与签名，网关不需要会话存储，容器重启（密钥不变时）登录态不丢；
4. **完全兼容**：OpenResty 就是 nginx + LuaJIT，design.md 中所有 nginx 配置（路由、WS 升级、上传大小、超时）原样保留，只是二进制换成 openresty、多一个 `access_by_lua_block`。

依赖：`lua-resty-jwt`（含 `lua-resty-hmac`），随镜像用 `opm` 或直接 vendor 到 `deploy/openresty/lualib/`。

## 2. 令牌设计

### 2.1 登录凭据与 JWT 的关系

- **登录凭据**仍是 `SHELLBASE_TOKEN`（环境变量注入；未设置则启动时随机生成并打印到容器日志）——它只在 `/api/auth/login` 出现一次；
- 登录成功后 FastAPI 签发 **JWT**，此后所有请求只携带 JWT，`SHELLBASE_TOKEN` 不再上网络。

这样即使某个请求日志泄露，暴露的也只是有过期时间的 JWT，而不是长期有效的根凭据。

### 2.2 JWT 规格

- 算法：**HS256**（对称 HMAC；单容器内签发方和校验方是同一信任域，无需 RS256 的公私钥分发复杂度）；
- 密钥：`SHELLBASE_JWT_SECRET`，未设置则 entrypoint 启动时随机生成 32 字节，同时注入 FastAPI（env）和 OpenResty（渲染进 lua 配置）。**注意**：不设置固定密钥时容器重启会使所有已发 JWT 失效（需重新登录），这是可接受的默认行为；
- Claims：

| Claim | 值 | 说明 |
|-------|----|------|
| `sub` | `admin` | v1 单用户，固定值；为多用户预留 |
| `iat` | 签发时间 | |
| `exp` | `iat + SHELLBASE_JWT_TTL`（默认 86400s） | 过期时间 |
| `jti` | 随机 UUID | 为将来吊销黑名单预留，v1 不校验 |

### 2.3 令牌携带方式

校验时按以下顺序提取，取到即用：

1. **Cookie `shellbase_jwt`**（主通道）：`HttpOnly; SameSite=Strict; Path=/`，部署在 HTTPS 后加 `Secure`。同源 iframe（终端块、文件块等）自动携带，前端各应用零鉴权代码；
2. **`Authorization: Bearer <jwt>`**（程序化通道）：供脚本/CLI/Agent 调用 API 使用。

不支持 URL query 携带 JWT（会进访问日志与浏览器历史）。

## 3. OpenResty 侧：校验实现

### 3.1 配置结构

```
deploy/openresty/
├── nginx.conf.tmpl          # 主配置模板（entrypoint 渲染端口/密钥路径）
├── lualib/
│   └── shellbase/
│       └── auth.lua         # 鉴权模块（下述逻辑）
└── jwt_secret               # entrypoint 写入，仅容器内可读 (0600)
```

### 3.2 核心逻辑（`auth.lua`）

```lua
-- 伪代码级示意，实际实现见 deploy/openresty/lualib/shellbase/auth.lua
local jwt = require "resty.jwt"

local _M = {}

function _M.check()
    local token = extract()          -- Cookie shellbase_jwt → Authorization: Bearer
    if not token then return deny() end

    local obj = jwt:verify(SECRET, token)   -- 验签 + 结构校验
    if not obj.verified then return deny() end
    if obj.payload.exp < ngx.time() then return deny() end

    ngx.req.set_header("X-Shellbase-Sub", obj.payload.sub)  -- 传给上游备用
end

function deny()
    if is_api_or_ws() then          -- /api/、/tty/：返回 401 JSON
        ngx.status = 401
        ngx.say('{"error":"unauthorized"}')
        return ngx.exit(401)
    end
    return ngx.redirect("/login")   -- 页面请求：跳登录页
end

return _M
```

### 3.3 路由接入

```nginx
# http 块
lua_package_path "/opt/shellbase/openresty/lualib/?.lua;;";

# server 块内
location /login      { try_files /login.html =404; }          # 放行
location /assets/    { ... }                                   # 静态资源放行
location = /api/auth/login { proxy_pass http://127.0.0.1:8000; }  # 放行（含限速，见 §5）

location /api/ {
    access_by_lua_block { require("shellbase.auth").check() }
    proxy_pass http://127.0.0.1:8000;
}
location /tty/ {
    access_by_lua_block { require("shellbase.auth").check() }
    proxy_pass http://127.0.0.1:7681/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 24h;
}
location / {
    access_by_lua_block { require("shellbase.auth").check() }  # Shell 页面本身也要登录
    root /opt/shellbase/web;
}
```

放行名单只有三类：登录页、静态资源（js/css，不含业务数据）、`/api/auth/login`。其余一律过 `check()`。

### 3.4 WebSocket 的特殊性

- JWT 只在**握手（HTTP Upgrade）时校验一次**；连接建立后即使 JWT 过期，连接也不主动断开——终端长会话不应因令牌到期被掐断；
- 代价与边界：一条已建立的 WS 最长可存活到用户主动断开；新连接（含断线重连）必须重新持有效 JWT。结合 tmux 的现场保持，重连时若 JWT 过期，前端引导重新登录后 attach 回原会话，不丢任何工作。

## 4. FastAPI 侧：签发与生命周期

`auth.py` 端点：

| 端点 | 功能 |
|------|------|
| `POST /api/auth/login` | body `{token}` 与 `SHELLBASE_TOKEN` **常量时间比较**；通过则签发 JWT 并 `Set-Cookie` |
| `POST /api/auth/refresh` | 持有效 JWT 调用，签发新 JWT（滑动续期） |
| `POST /api/auth/logout` | 清 Cookie（`Max-Age=0`）；JWT 本身无状态，见 §6 吊销 |
| `GET  /api/auth/me` | 返回当前登录态（前端启动时探测用） |

续期策略：前端 Shell 定时（如每小时）调 `/api/auth/refresh`；只要页面开着，登录态就滑动延长；关闭页面超过 TTL 则需重新登录。

原方案中的 `/api/auth/verify`（供 `auth_request` 回调）**取消**——校验职责已整体移至 OpenResty。

## 5. 防护措施

1. **登录限速**：`/api/auth/login` 在 OpenResty 层用 `lua_shared_dict` 按来源 IP 计数（如 60s 内 10 次），超限直接 429，爆破流量根本不落到 FastAPI；
2. **常量时间比较**：`secrets.compare_digest`（FastAPI 比较 SHELLBASE_TOKEN）；
3. **密钥文件权限**：`jwt_secret` 0600，属主为运行用户 `shellbase`；
4. **Cookie 三件套**：`HttpOnly`（防 XSS 读取）+ `SameSite=Strict`（防 CSRF 携带）+ `Secure`（HTTPS 部署时）；
5. **算法固定**：校验端强制 `alg=HS256`，拒绝 token 头部声明的其他算法（防 `alg=none` 类攻击）；
6. **传输加密**：JWT 只是完整性保护不是机密性保护，公网部署必须有 TLS（外层反代或 v1.1 容器内 HTTPS），与 design.md §5 一致。

## 6. 吊销与登出的取舍

v1 采用纯无状态 JWT，明确接受的取舍：

- **登出**只是清浏览器 Cookie，已签发的 JWT 在 exp 前技术上仍有效；
- **全局吊销**手段是更换 `SHELLBASE_JWT_SECRET` 并重启（所有 JWT 立即失效）；
- 单用户自用场景下这足够；若未来需要即时吊销单个令牌，方案已预留 `jti`——在 OpenResty 用 `lua_shared_dict` 维护黑名单，`logout` 时把 `jti` 写入并保留至其 `exp`，属 v1.1+ 增强，不改变现有令牌格式。

## 7. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SHELLBASE_TOKEN` | 随机生成并打印日志 | 登录凭据（根凭据，仅登录时使用） |
| `SHELLBASE_JWT_SECRET` | 随机生成（重启失效） | HS256 签名密钥，FastAPI 与 OpenResty 共享 |
| `SHELLBASE_JWT_TTL` | `86400` | JWT 有效期（秒） |

## 8. 对 design.md 的影响清单

- 顶层负载 nginx → **OpenResty**（架构图、supervisord、Dockerfile 依赖同步更新）；
- 删除 `auth_request` 与 `/api/auth/verify`；
- `auth.py` 职责改为：login / refresh / logout / me；
- ADR 4 更新为本方案。
