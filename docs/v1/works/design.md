# shellbase v1 设计文档

> 一个可以用单个 Dockerfile 拉起的「融合终端」平台：CLI Agent + 浏览器 + 文件管理，
> 部署在任意虚拟机上，通过浏览器访问，形态类似 webshell，但能力远超传统 webshell。

## 1. 定位与目标

### 1.1 一句话定位

shellbase = **在任意 VM 上一条 `docker run` 拉起的 Web 工作台**，页面是一块可自由分割的画布，每个分割块自选应用（终端 / Claude Code / Codex / 文件浏览器 / 浏览器……），把三类能力融合进同一屏：

1. **终端（Terminal）**：真实的 shell / tmux 会话，可以直接跑 CLI Agent（如 Claude Code）；
2. **浏览器（Browser）**：前端内嵌的浏览器面板（iframe），与终端、文件并排使用；
3. **文件（Files)**：对容器/挂载卷内文件的树形浏览、编辑、上传下载。

### 1.2 与传统 webshell 的区别

| 维度 | 传统 webshell | shellbase |
|------|--------------|-----------|
| 终端 | 单个 pty，断线即丢 | tmux 持久会话，多窗口，断线重连恢复 |
| 文件 | 无或只有简陋上传 | 完整文件管理器 + 在线编辑器 |
| 浏览器 | 无 | 内嵌浏览器面板（iframe），与终端/文件同屏 |
| Agent | 无 | 一等公民：会话管理、同屏观察、随时接管 |
| 部署 | 依赖宿主 web 服务 | 单容器自包含（或一条 pip 安装），单端口统一入口 |
| 认证 | 通常裸奔 | token 认证，网关层统一鉴权 |
| 协作 | 无 | 多客户端同开一个页面/终端，实时镜像（见 [collab.md](collab.md)） |

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
  浏览器(用户)           │   ┌──────────────────┐                                             │
 ───────────────────────┼──▶│ uvicorn(FastAPI) │ :8080  唯一对外端口                        │
   HTTP + WebSocket     │   └────────┬─────────┘                                             │
                        │            │  gateway.py：鉴权门禁 / 静态托管 / 反向代理            │
                        │            │                                                       │
                        │            ├── /            → 前端静态产物：Shell + 各应用页面      │
                        │            │                                                       │
                        │            ├── /api/…       → 同进程内的 API 路由                   │
                        │            │                  ├─ 文件管理 API                       │
                        │            │                  ├─ 终端/Agent 会话 + 布局状态          │
                        │            │                  └─ 登录/登出/探测端点                 │
                        │            │                                                       │
                        │            ├── /tty/…       → 反代 ttyd  127.0.0.1:7681 (HTTP+WS)  │
                        │            │                  └─ 挂到 tmux 会话上，提供持久终端      │
                        │            │                                                       │
                        │            └── /proxy/<port>/… → 反代 127.0.0.1:<port>（本机服务）  │
                        │                                                                    │
                        │   浏览器面板：前端 iframe 直接加载目标 URL，不经容器内进程            │
                        │   进程只有两个：uvicorn 与它拉起的 ttyd（`shellbase up`）            │
                        │   /workspace  ← 挂载卷，终端、文件、Agent 共享同一工作目录           │
                        └────────────────────────────────────────────────────────────────────┘
```

核心原则：

1. **网关进程是唯一对外端口**（默认 `:8080`），ttyd 与用户起的本机服务只监听 `127.0.0.1`，一律经网关反代；
2. **所有子系统共享 `/workspace`**：终端里 Agent 改的文件，文件面板立刻能看到；文件面板上传的资料，终端里立刻能用；
3. **ttyd 不直接暴露 shell，而是挂到 tmux**：会话持久化、断线重连、多标签都由 tmux 承担；
4. **浏览器面板是纯前端能力**：iframe 直接加载目标页面，容器内不跑任何浏览器进程，镜像保持精简；典型用途是查看容器内启动的 web 服务（dev server、文档站等）和允许被嵌入的外部页面。

## 3. 组件设计

### 3.1 应用层网关（`gateway.py`）

职责：鉴权门禁、静态托管、WebSocket 与 HTTP 反向代理、登录限流。它是 FastAPI 应用的一部分，
不是独立进程——因此 Docker 与 pip 两条分发路径都只需一个端口、一个进程树，且没有任何配置文件。

> v1 早期这一层是 nginx（`auth_request` + `proxy_pass`）。改为应用层网关的理由：pip 安装
> 场景下要求用户自行安装并配置 nginx，是这条路径上最大的一块摩擦；而 nginx 在这里承担的
> 全部职责都能在 ASGI 层等价实现。

路由表：

| 路径 | 目标 | 说明 |
|------|------|------|
| `/api/` | 同进程路由 | FastAPI 各模块 |
| `/tty/` | `http://127.0.0.1:7681` | ttyd，HTTP 与 WS 都经反代（子协议 `tty` 原样协商） |
| `/proxy/<port>/` | `http://127.0.0.1:<port>` | 本机服务通配代理（uri.md §3） |
| 其余 | 静态产物 | 命中文件 → 同名 `.html`（`/apps/files` → `apps/files.html`）→ SPA 兜底 `index.html` |

鉴权方案（v1）：

- 启动时通过环境变量 `SHELLBASE_TOKEN` 注入访问令牌（不设置则启动时随机生成并打印到日志）；
- 前端登录页把 token 交给 `/api/auth/login`，由 FastAPI 下发 `HttpOnly` Cookie；
- `AuthGate` 是包在整个 ASGI 应用**最外层**的中间件，HTTP 与 WebSocket 一视同仁：
  没有有效令牌，任何请求都到不了下游路由（WS 在 accept 之前就被关闭，握手不会建立）；
- 放行名单只有三项：`/login`、`POST /api/auth/login`、`GET /api/system/health`。
  新增路由默认受保护——这个默认方向是有意的。

ttyd 自身仍不感知认证，鉴权收敛在一处（端点与 Cookie 细节见 [api/auth.md](../api/auth.md)）。

关键实现点：

- 反代的读超时放到 24h，避免空闲终端被掐断；
- WebSocket 反代必须**先连上游、拿到协商结果，再 accept 客户端**，否则子协议对不上；
- 登录限流用令牌桶（容量 6、每 6 秒回补 1 个），等价于原先 nginx 的 `rate=10r/m burst=5 nodelay`，超限返回 `429`；
- 上传按 `Content-Length` 卡 1GB 上限，超限 `413`。

### 3.2 ttyd + tmux（终端子系统）

- ttyd 以 `ttyd -i 127.0.0.1 -p 7681 -W /opt/shellbase/bin/attach.sh` 启动；
- `attach.sh` 逻辑：先校验会话 state 已登记（backend.md §2.3），再 `tmux new-session -A`——存在则 attach，不存在则创建；
- 前端**直接以 iframe 装载 ttyd 自带页面**（配合 3.6 的分割布局，终端就是一种可放进块里的应用），不自研终端渲染层；
- 多终端：URL query 传 `?arg=<session>`，`attach.sh` 据此 attach 不同 tmux 会话——每个终端块一个会话；
- **会话经 Python 收口**：终端块的 iframe 不直接指向 `/tty/`，而是指向统一 attach 入口 `/api/terminals/attach?uri=<块的完整 URI>`（无中生有登记 state 后 302 到 ttyd；`attach.sh` 只对已有 state 的会话放行）。attach 机制与 state 存储见 [backend.md](backend.md) §2，会话身份（`window`/`block` 身份参数）与重入语义见 [uri.md](uri.md) §4。

选 tmux 而不是裸 pty 的理由：断线重连不丢现场、Agent 长任务不因刷新页面而中断、天然支持多会话；输出历史、注入输入这类程序化需求也由 tmux 自身（`capture-pane`/`send-keys`）在终端内解决，无需平台代劳。

### 3.3 FastAPI（接口服务）

单进程 uvicorn，直接监听对外端口（默认 `:8080`）。模块划分：

```
app/
├── main.py              # FastAPI 实例、路由挂载、启动钩子
├── auth.py              # /api/auth/{login,verify,logout,me}
├── gateway.py           # 鉴权门禁 + 静态托管 + 反向代理（§3.1）
├── cli.py               # shellbase up / serve / paths
├── files.py             # 文件管理
├── terminals.py         # 终端会话注册表 + 302 attach + Agent 会话（见 backend.md）
├── windows.py           # window（页面）状态的读写 + watch 广播（见 backend.md / collab.md）
├── state.py             # 文件系统状态存储（原子写、对账、回收）
└── system.py            # /api/system/{info,health} + /api/apps 应用注册表
```

完整的接口定义（请求/响应/错误码）见 [../api/](../api/README.md)。

后端是**全局状态的唯一权威**：终端注册表、页面布局、Agent 会话全部以文件系统持久化在
`SHELLBASE_STATE_DIR`（默认 `/workspace/.shellbase/state`），用户换设备或容器重启后仍能恢复
一模一样的页面。专项设计见 [backend.md](backend.md)。

**文件 API**：根锚定在 `/workspace`（路径穿越一律 403），提供树 / 读写（mtime 乐观锁）/ 上传下载 / 移动删除，外加 `WS /api/files/watch` 实时推送变更——端点定义见 [api/files.md](../api/files.md)。**Agent API** 详见 3.5。

### 3.4 浏览器子系统

技术选型：**纯前端 iframe**，容器内不引入任何浏览器进程。

浏览器是一个可装进布局块的应用页面（`/apps/browser`）：只有一个内层 `<iframe>`，**没有自己的地址栏**——
地址栏统一在 Shell 的面板控制条上（§3.6）。实现上只有前端工作：

- 接收 Shell 的 `go` / `reload` 指令跳转与重载；跳转后回发 `navigate` 让面板 URI 随之持久化；
- iframe 加 `sandbox` 属性按需放权，避免嵌入页影响宿主页面；
- 当前打开的 URL 作为块参数随布局存到后端（见 backend.md），重新进入后原样恢复；最近访问列表可留在 localStorage 作为便利功能。

主要用途与已知限制：

- **主用途是查看容器内起的 web 服务**：Agent 在终端里 `npm run dev` 起了 dev server，用户在浏览器面板输入 `http://<host>:<port>` 直接预览。目标端口无需对外映射——`https://localhost:<port>` 类 URI 经网关通配代理路由（`/proxy/<port>/` → `127.0.0.1:<port>`）访问，同源且无嵌入限制（见 [uri.md](uri.md)）；
- **外部站点受同源策略约束**：设置了 `X-Frame-Options` / `frame-ancestors` 的站点（大多数登录类站点）无法被 iframe 嵌入，此为方案的已知取舍——遇到时前端提示"在新窗口打开"。

### 3.5 CLI Agent 子系统

v1 的 Agent 模型是「**运行在 tmux 会话里的 CLI Agent 进程**」，平台负责拉起、观测、交互，不重新发明 Agent 运行时：

- Agent 会话就是一条 `kind: agent` 的终端注册项，与普通终端共用同一套 URI attach / 回收机制（`claude://`、`codex://` 走 scheme 名即命令名，无需注册）——机制见 [backend.md](backend.md) §5，URI 语义见 [uri.md](uri.md) §3.1，端点见 [api/terminals.md](../api/terminals.md)；
- 平台**不提供**终端输入/输出接口——与 Agent 的交互就是 attach 进块里直接看、直接敲；程序化需求用 tmux 自身的 `send-keys`/`capture-pane` 在终端里解决（见 api/terminals.md"不做的事"）；
- Agent 应用块（如 Claude Code、Codex）装载的就是该 tmux 会话的终端——因此"观察 Agent"和"接管操作"是同一个块，无需切换。

Agent 与文件/浏览器的融合点：Agent 在终端里跑，工作目录就是 `/workspace`（与文件浏览器应用同源）；Agent 起的 web 服务（dev server 等），用户在旁边的浏览器块里输入地址即可预览——同屏分割布局让"Agent 改代码 → 看效果"零切换。

### 3.6 前端：可自由分割的应用画布

前端不是 IDE 式固定布局，而是一个**可自由分割的画布（tiling shell）**：页面可以横向/纵向任意切分成块，每个块里是一个 iframe，用户在块内选择要装载的「应用」。

```
┌───────────────────────┬───────────────────┐
│                       │  [浏览器]          │
│   [终端: main]        │  http://:5173     │
│                       ├───────────────────┤
│                       │  [Claude Code]    │
├───────────────────────┤                   │
│   [文件浏览器]         │                   │
└───────────────────────┴───────────────────┘
  ── 每条分割线可拖拽；每个块可继续二分、关闭、更换应用 ──
```

**Shell 层**（顶层页面，Vite + React + TypeScript，保持很薄）：

- 布局模型是 **24×16 网格上的矩形剖分**：每个块是一条扁平记录 `{id, uri, x, y, w, h}`，渲染直接落到 CSS Grid（`gridColumn/gridRow`），拖拽把像素位移换算成整数格数并吸附；
  - **三种操作**：分割（把一个面板一分为二）、拖分割线（同时改变相邻面板坐标，钳制在最小尺寸 w≥3/h≥2）、关闭；
  - **关闭即回收**：被关面板的空间由邻居确定性吸收——优先选与之共享完整边的邻居直接延伸，否则由同侧多个邻居各自延伸。因为面板只能由分割产生，该规则总能收敛、不留空洞；
  - **关闭终端类块会真正销毁后端会话**（`DELETE`，kill tmux + 删 state，见 backend.md §4.2），不是仅从页面摘除；
  - 不做标签页、不做面板自由拖放——画布语义就是"分割 + 缩放 + 关闭"；
- **面板控制条按需浮现**：常态下面板没有标题栏，内容占满，只在右上角留一个小圆角方格；
  鼠标移上去后从顶部滑出一整行 bar（**覆盖**在 iframe 上，不挤压内容），离开 250ms 收起：
  `[✕ 关闭] [⟳ 刷新] [── 统一地址栏 ──] [⬓ 上下分割] [◫ 左右分割] [⏎]`——原方格位置在展开态变为回车提交；
  - **统一地址栏 = rich URL bar**：聚焦展开 recents + 应用宫格、输入即自动补全；浏览器面板经 postMessage 内页跳转（保住内部历史），终端面板改 URI = 销毁重建（提交前确认），手填的 `window`/`block` 一律被 Shell 重写——交互与规则的专项设计见 [urlbar.md](urlbar.md)。浏览器应用因此不再自带地址栏与前进后退；
  - **刷新分流**：浏览器面板让内页 reload；其余面板重挂 iframe（终端是重新 attach，tmux 现场还在）；
  - Shell → 应用的指令通道是 `go` / `reload` 两条 postMessage（见 uri.ts）；
- 没有独立启动页：空白块只渲染一条自动聚焦的 **rich URL bar**（与面板控制条的地址栏同一组件）——聚焦展示最近使用 + 应用宫格，输入即自动补全，本质是 URI 构造器（选应用/点记录 = 产出块的 URI，见 [uri.md](uri.md) 与 [urlbar.md](urlbar.md)）；
- 布局树 + 每块的应用与参数**持久化在后端**，且**页面可以有多张**：每张页面是一个有 id 的 **window**，后端存每个 window 的完整状态（`/#w/<id>`，缺省 `main`，未知 id 无中生有），`GET/PUT /api/windows/{id}` 防抖全量覆盖（见 [backend.md](backend.md)）——换浏览器、换设备、容器重启后进入，都恢复出一模一样的页面（终端块靠 tmux 恢复现场，天然无损）；
- 同源 iframe 自动携带认证 Cookie，各应用无需单独处理鉴权。

**块即 URI**：每个块由一个虚拟 URI 唯一定位——它是块的身份、持久化内容和重入凭证。Shell 的解析器只做**四类分流**：本地服务（https+localhost，经 `/proxy/<port>/` 代理）、外部站点（https+其余 host，iframe 直连）、文件（`file://` → `/apps/files`）、其余未知一律转发终端 attach 入口——终端 scheme 的适配与裁决全在后端（scheme 名即命令名，CLI 无需注册）。scheme 一览、身份参数与规范化、注册表的兜底角色，专项设计见 [uri.md](uri.md)；应用宫格与最近使用见 [urlbar.md](urlbar.md)。

## 4. 进程模型与 Dockerfile

### 4.1 进程模型

网关下沉进 FastAPI 后，容器里只剩两个进程，父子关系明确，不再需要 supervisord：

```
tini                    # 容器里的 PID 1：转发信号、回收孤儿进程
└── shellbase up        # cli.py：备好环境与状态目录、生成/打印 token
    │                   #   进程本身就是 uvicorn（API + 网关同进程，对外端口）
    └── ttyd            # 127.0.0.1:7681，-W -a bin/attach.sh
```

`up` 负责：生成/打印 token、创建状态目录、拉起 ttyd、把 ttyd 的存活与自身绑定
（ttyd 异常退出即整体收摊，避免留下"终端全挂但页面还在"的半死实例）。

反向的绑定用 `PR_SET_PDEATHSIG` 交给内核：父进程一消失，ttyd 立刻收到 SIGTERM。
不能只写在 `finally` 里——uvicorn 处理完 SIGTERM 会把信号重新抛给原处理器，
进程直接死于信号，`finally` 根本不执行（SIGKILL 更是如此）。
Docker 的 `ENTRYPOINT` 就是它，pip 安装后用户敲的也是它——两条路径同一份启动逻辑。

### 4.2 基础镜像（多阶段构建）

两阶段：node 阶段编译前端（只有静态产物进运行时），运行时基于 **ubuntu 24.04**（ttyd 可直接 apt）。镜像同时是平台运行时和用户的终端环境——装什么、为什么装、刻意不装什么、非 root 下的扩展路径，专项设计见 [image.md](image.md)。镜像内以非 root 用户 `shellbase`（UID 1000）运行所有进程（对外端口是非特权端口，故无需 root）。

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
| `SHELLBASE_PORT` | `8080` | 对外监听端口 |
| `SHELLBASE_WORKSPACE` | `/workspace` | 工作根目录 |
| `SHELLBASE_STATE_DIR` | `/workspace/.shellbase/state` | 后端状态存储目录（见 backend.md） |
| `SHELLBASE_TMUX_SOCKET` | 空（pip 路径为 `shellbase`） | tmux socket 名，与用户自己的 tmux server 隔离 |
| `SHELLBASE_TMUX_CONF` | 空（pip 路径为随包 tmux.conf） | tmux 配置文件 |
| `SHELLBASE_WEB_ROOT` | 随包静态产物 | 前端产物目录 |
| `SHELLBASE_APPS_EXTRA` | 空 | JSON，应用注册表扩展：命令别名/固定参数、宫格冷启动兜底与元数据、`url` 型应用（见 uri.md §6） |

## 5. 安全设计

shellbase 本质上是"授权的远程 shell"，安全边界必须清晰：

1. **单一入口**：只有网关端口对外；ttyd 及用户起的本机服务绑定 loopback，只能经网关反代抵达；
2. **强制 token**：`AuthGate` 包在 ASGI 应用最外层，覆盖所有路由（含静态页与 WebSocket），未认证只能看到登录页；token 比较用常量时间比较；登录接口限速（同 IP 60s 内 10 次，见 api/auth.md）；
3. **传输加密**：文档明确告知——公网部署必须在外层套 TLS（云 LB / caddy / 反代），或 `-v` 挂证书启用容器内 HTTPS（v1.1 再做）；
4. **文件 API 越权防护**：所有路径 `resolve()` 后必须以 workspace 根为前缀，否则 403；符号链接解析后同样受此约束；
5. **能力自觉**：终端本身就是全量 shell，因此文件 API 不需要也不假装做比 shell 更细的权限控制——安全模型是"拿到 token 即拥有容器"，边界靠容器隔离（建议部署时不加 `--privileged`，按需挂载目录）；
6. **Cookie**：`HttpOnly + SameSite=Strict`，避免 token 被页面脚本读取及跨站携带。

## 6. 仓库结构

```
shellbase/
├── Dockerfile
├── pyproject.toml          # pip 包：后端 + 前端产物 + deploy 资源
├── deploy/
│   └── tmux.conf
├── server/                 # FastAPI
│   └── shellbase/…
├── web/                    # 前端 SPA
│   └── src/…
├── bin/
│   └── attach.sh           # ttyd → tmux（含注册表校验，见 backend.md）
└── docs/
    └── v1/
        ├── works/
        │   ├── design.md   # 本文档
        │   ├── backend.md  # Python 后端专项设计（状态管理/存储/302 attach）
        │   ├── collab.md   # 多人协作专项设计（state 共享/布局广播）
        │   ├── uri.md      # 虚拟 URI 定位符设计（块的身份与重入）
        │   ├── urlbar.md   # rich URL bar 设计（应用入口/最近使用/自动补全）
        │   ├── env.md      # 全局环境变量设计（凭证自助配置，新终端生效）
        │   └── image.md    # 基础镜像设计（软件清单/能力边界/扩展路径）
        └── api/            # 接口设计（README 总览 + auth/terminals/windows/files/system）
```

## 7. 里程碑

| 阶段 | 内容 | 验收标准 |
|------|------|----------|
| M1 骨架 | Dockerfile + ttyd(tmux) + FastAPI（网关 + 健康检查 + token 鉴权）+ 分割布局 Shell（终端应用可装块） | 一条 docker run 后登录，任意分割布局并在多个块中使用持久终端 |
| M2 文件 | 文件 API 全套 + 文件浏览器应用（树/编辑器/上传下载） | 终端改文件 ⇄ 文件块实时可见、可编辑 |
| M3 浏览器 | 浏览器应用（地址栏/历史/URL 恢复）+ 布局持久化 | 终端块起 dev server，旁边浏览器块预览；刷新页面布局原样恢复 |
| M4 Agent | Agent 会话（URI attach）+ Claude Code / Codex 应用接入 URL bar | 空白块的 URL bar 选择 Claude Code 即启动会话，块内直接对话、随时接管 |
| M5 打磨 | 断线重连、限流、日志、system info、文档 | 30 分钟断网重连后现场无损 |

## 8. 主要技术决策记录（ADR 摘要)

1. **ttyd + tmux 而非自研 pty 服务**：ttyd 成熟稳定、WS 协议简单；tmux 免费获得持久化与多会话。代价是多一层依赖，可接受。
2. **浏览器面板用纯前端 iframe，而非容器内 Chromium（CDP/noVNC）**：容器不跑浏览器进程，镜像小、实现简单、零额外资源开销。代价是设置了 `X-Frame-Options`/`frame-ancestors` 的外部站点无法嵌入——v1 的主场景是预览容器内 web 服务，可接受；若后续需要 Agent 驱动的真实浏览器，再引入 headless Chromium 作为 v2 能力。
3. **进程编排放在 `shellbase up` 里，而非 supervisord/compose**："单 Dockerfile 拉起"是硬需求，排除 compose；网关下沉后只剩 uvicorn + ttyd 两个进程，一段 Python 足够，还顺带让 pip 路径与 Docker 路径共用同一份启动逻辑。
4. **鉴权收敛到 ASGI 最外层的 `AuthGate`，而非 nginx `auth_request`**：ttyd/静态资源无需各自实现认证，未来换认证方式只改一处；相比 nginx 方案还少了一整套需要用户安装与配置的外部依赖，代价是限流、静态托管、反代这些能力要自己实现（见 §3.1）。
5. **前端采用"分割布局 Shell + iframe 应用"而非单体 SPA**：组合能力放在布局层（任意分割、每块自选应用），应用本身只是 URI——终端直接复用 ttyd 自带页面，零终端渲染代码；应用彼此隔离、可独立开发、可通过配置扩展（新增一个 Agent 只是注册一条命令模板）。代价是跨块联动（如文件树点击在编辑器块打开）需要经 Shell 层 postMessage 中转，v1 仅实现最小联动。
