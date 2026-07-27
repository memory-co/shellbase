# shellbase v1 设计文档

> 一个可以用单个 Dockerfile 拉起的「融合终端」平台：CLI Agent + 浏览器 + 文件管理，
> 部署在任意虚拟机上，通过浏览器访问，形态类似 webshell，但能力远超传统 webshell。

## 1. 定位与目标

### 1.1 一句话定位

shellbase = **在任意 VM 上一条 `docker run` 拉起的 Web 工作台**，把三类能力融合进同一个页面：

1. **终端（Terminal）**：真实的 shell / tmux 会话，可以直接跑 CLI Agent（如 Claude Code）；
2. **浏览器（Browser）**：前端内嵌的浏览器面板（iframe），与终端、文件并排使用；
3. **文件（Files)**：对容器/挂载卷内文件的树形浏览、编辑、上传下载。

### 1.2 与传统 webshell 的区别

| 维度 | 传统 webshell | shellbase |
|------|--------------|-----------|
| 终端 | 单个 pty，断线即丢 | tmux 持久会话，多窗口，断线重连恢复 |
| 文件 | 无或只有简陋上传 | 完整文件管理器 + 在线编辑器 |
| 浏览器 | 无 | 内嵌浏览器面板（iframe），与终端/文件同屏 |
| Agent | 无 | 一等公民：会话管理、任务下发、状态观测 |
| 部署 | 依赖宿主 web 服务 | 单容器自包含，nginx 统一入口 |
| 认证 | 通常裸奔 | token 认证，nginx 层统一鉴权 |

### 1.3 v1 范围（明确不做的事）

**做**：单用户、单容器、token 认证、终端/文件/浏览器/Agent 会话四大模块。

**不做**（留给后续版本）：
- 多租户 / 用户体系 / RBAC；
- 集群编排、多节点管理；
- HTTPS 证书自动化（v1 假设由外层反代或用户自签解决，容器内只出 HTTP）；
- 容器内 headless 浏览器（CDP screencast / noVNC）——v1 浏览器面板为纯前端 iframe，真实浏览器实例留给 v2。

## 2. 总体架构

```
                        ┌─────────────────────────── Docker 容器 ───────────────────────────┐
                        │                                                                    │
  浏览器(用户)           │   ┌─────────┐                                                      │
 ───────────────────────┼──▶│  nginx  │  :8080  统一入口 / 静态资源 / 反代 / 鉴权             │
   HTTP + WebSocket     │   └────┬────┘                                                      │
                        │        │                                                           │
                        │        ├── /            → 前端 SPA 静态文件（xterm.js + 文件树 + 浏览器画布）
                        │        │                                                           │
                        │        ├── /api/…       → FastAPI   127.0.0.1:8000                 │
                        │        │                  ├─ 文件管理 API                           │
                        │        │                  ├─ Agent 会话管理                         │
                        │        │                  └─ auth_request 鉴权端点                  │
                        │        │                                                           │
                        │        └── /tty/…       → ttyd      127.0.0.1:7681  (WebSocket)   │
                        │                            └─ 挂到 tmux 会话上，提供持久终端        │
                        │                                                                    │
                        │   浏览器面板：前端 iframe 直接加载目标 URL，不经容器内进程            │
                        │   supervisord 负责拉起并守护：nginx / ttyd / fastapi                │
                        │   /workspace  ← 挂载卷，终端、文件、Agent 共享同一工作目录           │
                        └────────────────────────────────────────────────────────────────────┘
```

核心原则：

1. **nginx 是唯一对外端口**（默认 `:8080`），其余进程全部只监听 `127.0.0.1`；
2. **所有子系统共享 `/workspace`**：终端里 Agent 改的文件，文件面板立刻能看到；文件面板上传的资料，终端里立刻能用；
3. **ttyd 不直接暴露 shell，而是挂到 tmux**：会话持久化、断线重连、多标签都由 tmux 承担；
4. **浏览器面板是纯前端能力**：iframe 直接加载目标页面，容器内不跑任何浏览器进程，镜像保持精简；典型用途是查看容器内启动的 web 服务（dev server、文档站等）和允许被嵌入的外部页面。

## 3. 组件设计

### 3.1 nginx（顶层 HTTP 负载）

职责：静态资源、路由、WebSocket 升级、统一鉴权、限流。

路由表：

| 路径 | 目标 | 说明 |
|------|------|------|
| `/` | `/opt/shellbase/web`（静态） | 前端 SPA |
| `/api/` | `http://127.0.0.1:8000` | FastAPI |
| `/tty/` | `http://127.0.0.1:7681` | ttyd，需 WS 升级 |

鉴权方案（v1）：

- 启动时通过环境变量 `SHELLBASE_TOKEN` 注入访问令牌（不设置则启动时随机生成并打印到容器日志）；
- 前端登录页把 token 写入 Cookie（`HttpOnly` 由 FastAPI 下发）；
- nginx 对 `/tty/`、`/api/` 一律走 `auth_request /api/auth/verify`，由 FastAPI 校验 Cookie/Header 中的 token；
- 静态资源放行，`/api/auth/login` 放行。

这样 ttyd 自身不需要感知认证，鉴权收敛在一处。

关键配置点：

- `proxy_read_timeout` 对 WS 路由调大（如 24h），避免终端空闲被掐断；
- `client_max_body_size` 调大（如 1G）以支持文件上传；
- 对 `/tty/` 设置 `proxy_http_version 1.1` + `Upgrade/Connection` 头。

### 3.2 ttyd + tmux（终端子系统）

- ttyd 以 `ttyd -i 127.0.0.1 -p 7681 -W /opt/shellbase/bin/attach.sh` 启动；
- `attach.sh` 逻辑：`tmux new-session -A -s main -c /workspace`——存在则 attach，不存在则创建；
- 前端不用 ttyd 自带页面，而是用 **xterm.js 直连 `/tty/` 的 WebSocket**（ttyd 的 ws 协议是公开的），这样终端才能作为一个组件嵌入融合界面，而不是一个独立 iframe；
- 多终端标签：URL query 传 `?arg=<session>`，`attach.sh` 据此 attach 不同 tmux 会话；FastAPI 提供 `GET /api/terminals` 列出 tmux 会话供前端渲染标签页。

选 tmux 而不是裸 pty 的理由：断线重连不丢现场、Agent 长任务不因刷新页面而中断、天然支持多会话，并且 Agent 的输出历史可以通过 `tmux capture-pane` 被 API 读取。

### 3.3 FastAPI（接口服务）

单进程 uvicorn，监听 `127.0.0.1:8000`。模块划分：

```
app/
├── main.py              # FastAPI 实例、路由挂载、启动钩子
├── auth.py              # /api/auth/login, /api/auth/verify (供 nginx auth_request)
├── files.py             # 文件管理
├── terminals.py         # tmux 会话枚举/创建/关闭
├── agent.py             # Agent 会话管理
└── system.py            # /api/system/info: CPU/内存/磁盘/版本
```

**文件 API**（根锚定在 `/workspace`，路径穿越一律 403）：

| 端点 | 功能 |
|------|------|
| `GET  /api/files/tree?path=` | 目录列表（名称、类型、大小、mtime、权限） |
| `GET  /api/files/content?path=` | 读文件（文本直出；二进制/超限返回元信息） |
| `PUT  /api/files/content` | 写文件（带 mtime 乐观锁，防覆盖终端里的并发修改） |
| `POST /api/files/upload` | 分片/流式上传 |
| `GET  /api/files/download?path=` | 下载（目录自动打 zip） |
| `POST /api/files/mkdir` / `move` / `delete` | 常规操作 |
| `WS   /api/files/watch` | inotify（watchfiles 库）推送变更，前端文件树实时刷新 |

**Agent API** 详见 3.5。

### 3.4 浏览器子系统

技术选型：**纯前端 iframe**，容器内不引入任何浏览器进程。

浏览器面板就是主区的一种标签页：地址栏 + `<iframe>`，输入 URL 直接加载。实现上只有前端工作：

- 地址栏、前进/后退（维护面板自身的历史栈，`iframe.src` 切换）、刷新、新标签；
- iframe 加 `sandbox` 属性按需放权，避免嵌入页影响宿主页面；
- 前端记住最近打开的 URL 列表（localStorage），刷新后恢复。

主要用途与已知限制：

- **主用途是查看容器内起的 web 服务**：Agent 在终端里 `npm run dev` 起了 dev server，用户在浏览器面板输入 `http://<host>:<port>` 直接预览。若目标端口未对外映射，可在 nginx 加一条通配代理路由（如 `/proxy/<port>/` → `127.0.0.1:<port>`），作为 v1.1 增强；
- **外部站点受同源策略约束**：设置了 `X-Frame-Options` / `frame-ancestors` 的站点（大多数登录类站点）无法被 iframe 嵌入，此为方案的已知取舍——遇到时前端提示"在新窗口打开"。

### 3.5 CLI Agent 子系统

v1 的 Agent 模型是「**运行在 tmux 会话里的 CLI Agent 进程**」，平台负责拉起、观测、交互，不重新发明 Agent 运行时：

- `POST /api/agent/sessions`：创建一个 tmux 会话并在其中启动配置好的 Agent 命令
  （镜像内预装可配置，如 `claude`；命令模板由 `SHELLBASE_AGENT_CMD` 环境变量定义）；
- `GET /api/agent/sessions`：列出 Agent 会话及状态（running / idle / exited，通过 tmux pane 的存活 + 前台进程判断）；
- `POST /api/agent/sessions/{id}/input`：向会话注入文本（`tmux send-keys`），用于程序化下发任务；
- `GET /api/agent/sessions/{id}/output`：`tmux capture-pane` 抓取最近输出；
- 前端可以随时把某个 Agent 会话「接管」为普通终端标签——因为它本来就是 tmux 会话。

Agent 与文件/浏览器的融合点：Agent 在终端里跑，工作目录就是 `/workspace`（与文件面板同源）；Agent 起的 web 服务（dev server 等），用户直接在浏览器面板（iframe）里输入地址预览，形成"Agent 改代码 → 面板看效果"的闭环。

### 3.6 前端

单页应用，nginx 直接托管静态产物。v1 保持轻量：Vite + React + TypeScript。

布局（IDE 式三区）：

```
┌────────────┬──────────────────────────────┐
│  文件树     │   主区：多标签               │
│  (可折叠)   │   [终端1] [终端2] [浏览器]    │
│            │   [编辑器: xxx.py] [Agent#1] │
│            │                              │
├────────────┴──────────────────────────────┤
│  状态栏：连接状态 / CPU / 内存 / 磁盘        │
└───────────────────────────────────────────┘
```

- 终端：xterm.js（+ fit / webgl addon）对接 ttyd WS 协议；
- 编辑器：CodeMirror 6（比 Monaco 轻，v1 够用），对接文件 API；
- 浏览器：iframe + 地址栏 + 历史栈（见 3.4）；
- 拖拽上传到文件树；文件树通过 `/api/files/watch` 实时刷新。

## 4. 进程模型与 Dockerfile

### 4.1 进程守护

容器内多进程，用 **supervisord** 守护（成熟、日志方便）：

```ini
[program:nginx]      command=nginx -g 'daemon off;'            priority=30
[program:fastapi]    command=uvicorn app.main:app --host 127.0.0.1 --port 8000   priority=20
[program:ttyd]       command=ttyd -i 127.0.0.1 -p 7681 -W /opt/shellbase/bin/attach.sh  priority=20
```

启动顺序：supervisord → fastapi/ttyd → nginx。entrypoint 脚本负责：生成/打印 token、初始化 `/workspace` 权限、渲染 nginx 配置模板（端口等来自环境变量）。

### 4.2 Dockerfile（多阶段）

```dockerfile
# 阶段1: 前端构建
FROM node:22-slim AS web
WORKDIR /src && COPY web/ . && RUN npm ci && npm run build

# 阶段2: 运行时
FROM debian:bookworm-slim
RUN apt-get install -y nginx tmux supervisor python3 ...  # + ttyd 二进制
RUN pip install fastapi uvicorn watchfiles websockets ...
COPY --from=web /src/dist /opt/shellbase/web
COPY server/ /opt/shellbase/app
COPY deploy/nginx.conf.tmpl deploy/supervisord.conf deploy/entrypoint.sh ...
VOLUME /workspace
EXPOSE 8080
ENTRYPOINT ["/opt/shellbase/bin/entrypoint.sh"]
```

镜像内以非 root 用户 `shellbase` 运行所有进程（nginx 用非特权端口，故无需 root）。

### 4.3 启动方式

```bash
docker run -d --name shellbase \
  -p 8080:8080 \
  -v $PWD/workspace:/workspace \
  -e SHELLBASE_TOKEN=your-secret \
  shellbase:latest
```

环境变量一览：

| 变量 | 默认 | 说明 |
|------|------|------|
| `SHELLBASE_TOKEN` | 随机生成 | 访问令牌 |
| `SHELLBASE_PORT` | `8080` | nginx 监听端口 |
| `SHELLBASE_WORKSPACE` | `/workspace` | 工作根目录 |
| `SHELLBASE_AGENT_CMD` | `claude` | Agent 启动命令模板 |

## 5. 安全设计

shellbase 本质上是"授权的远程 shell"，安全边界必须清晰：

1. **单一入口**：只有 nginx 端口对外；ttyd、FastAPI 全部绑定 loopback；
2. **强制 token**：nginx `auth_request` 覆盖所有动态路由，未认证只能看到登录页；token 比较用常量时间比较；连续失败限速（FastAPI 内存计数即可）；
3. **传输加密**：文档明确告知——公网部署必须在外层套 TLS（云 LB / caddy / 反代），或 `-v` 挂证书启用容器内 HTTPS（v1.1 再做）；
4. **文件 API 越权防护**：所有路径 `resolve()` 后必须以 workspace 根为前缀，否则 403；符号链接解析后同样受此约束；
5. **能力自觉**：终端本身就是全量 shell，因此文件 API 不需要也不假装做比 shell 更细的权限控制——安全模型是"拿到 token 即拥有容器"，边界靠容器隔离（建议部署时不加 `--privileged`，按需挂载目录）；
6. **Cookie**：`HttpOnly + SameSite=Strict`，避免 token 被页面脚本读取及跨站携带。

## 6. 仓库结构

```
shellbase/
├── Dockerfile
├── deploy/
│   ├── nginx.conf.tmpl
│   ├── supervisord.conf
│   └── entrypoint.sh
├── server/                 # FastAPI
│   └── app/…
├── web/                    # 前端 SPA
│   └── src/…
├── bin/
│   └── attach.sh           # ttyd → tmux
└── docs/
    └── v1/works/design.md  # 本文档
```

## 7. 里程碑

| 阶段 | 内容 | 验收标准 |
|------|------|----------|
| M1 骨架 | Dockerfile + supervisord + nginx + ttyd(tmux) + FastAPI 健康检查 + token 鉴权 | 一条 docker run 后，浏览器登录并使用持久终端 |
| M2 文件 | 文件 API 全套 + 前端文件树/编辑器/上传下载 | 终端改文件 ⇄ 面板实时可见、可编辑 |
| M3 浏览器 | iframe 浏览器面板（地址栏/历史/多标签/URL 恢复） | 在面板中预览容器内 dev server 页面 |
| M4 Agent | Agent 会话 API + 前端 Agent 面板 | 一键启动 Claude Code 会话，可下发任务、接管终端 |
| M5 打磨 | 断线重连、限流、日志、system info、文档 | 30 分钟断网重连后现场无损 |

## 8. 主要技术决策记录（ADR 摘要)

1. **ttyd + tmux 而非自研 pty 服务**：ttyd 成熟稳定、WS 协议简单；tmux 免费获得持久化与多会话。代价是多一层依赖，可接受。
2. **浏览器面板用纯前端 iframe，而非容器内 Chromium（CDP/noVNC）**：容器不跑浏览器进程，镜像小、实现简单、零额外资源开销。代价是设置了 `X-Frame-Options`/`frame-ancestors` 的外部站点无法嵌入——v1 的主场景是预览容器内 web 服务，可接受；若后续需要 Agent 驱动的真实浏览器，再引入 headless Chromium 作为 v2 能力。
3. **supervisord 而非 s6/多容器 compose**："单 Dockerfile 拉起"是硬需求，排除 compose；supervisord 配置直观、python 生态一致。
4. **鉴权收敛到 nginx auth_request**：ttyd/静态资源无需各自实现认证，未来换认证方式只改一处。
5. **前端自绘终端（xterm.js 直连 ttyd WS）而非 iframe 嵌 ttyd 页面**：融合终端要求终端是可组合的组件（分屏、标签、与文件/浏览器联动），iframe 做不到。
