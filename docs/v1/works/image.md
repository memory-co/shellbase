# shellbase v1 基础镜像设计

> 单 Dockerfile、两阶段构建：前端在 node 阶段编译，运行时镜像基于 **ubuntu 24.04**。
> 本文档说明运行时镜像里装什么、为什么装、以及刻意不装什么——它就是仓库根目录
> `Dockerfile` 的设计依据。

## 1. 定位：镜像就是用户的 shell 环境

shellbase 的镜像有双重身份：既是**平台的运行时**（FastAPI 网关 / ttyd / tmux），也是**用户直接面对的终端环境**——用户 attach 进来跑的每一条命令、Agent 干活用到的每一个工具，都来自这个镜像。因此选型原则不是"越小越好"，而是：

- **平台层**求稳求薄：只装支撑四大子系统（终端/文件/浏览器/Agent）的最小集合；
- **终端层**求开箱即用：`scheme 名即命令名`（uri.md §3.1）的前提是 PATH 里真的有命令——文档里举例的 `vim://`、`htop://` 不该是空头支票；
- 镜像不追求 alpine 级体积——它是工作台，不是 sidecar。

## 2. 基底选型：ubuntu 24.04

- **ttyd 直接 apt 可得**：noble 的 universe 仓库收录了 ttyd，免去从 GitHub 下载二进制、自己跟安全更新（这是从 debian bookworm 迁移过来的直接原因）；
- LTS 到 2029，Agent CLI（Node 生态）与常见开发工具的官方支持度最好；
- 用户熟悉度：终端里 `apt list`、`man`、bash 补全等行为符合大多数人的肌肉记忆。

## 3. 两阶段构建

```
阶段 1  node:22-slim AS web     npm install && npm run build     （构建器，不进运行时）
阶段 2  ubuntu:24.04            apt/npm/pip 装运行时 + COPY 产物
```

前端只以静态产物（`/opt/shellbase/web`）进入运行时镜像；node_modules、npm 缓存都留在构建阶段。注意运行时镜像**也装 nodejs**，但那是给 Agent CLI 用的运行时（§4.2），与前端构建无关。

## 4. 运行时软件清单

### 4.1 平台服务层（支撑四大子系统）

| 软件 | 来源 | 用途 |
|------|------|------|
| `ttyd` | apt（noble universe） | 终端 WebSocket 服务，`-W attach.sh` 收口（design.md §3.2） |
| `tmux` | apt | 会话持久化与多客户端镜像（collab.md）；配置进 `/etc/tmux.conf` |
| `tini` | apt | PID 1 的本分：转发信号、回收孤儿进程（网关下沉后不再有 supervisord 干这活，design.md §4.1） |
| `python3` + `python3-venv` | apt | FastAPI 后端（同时是唯一对外入口：静态资源、鉴权、`/tty/` 与 `/proxy/<port>/` 反代，design.md §3.1），依赖装进 `/opt/shellbase/venv`（不污染系统 Python） |
| `curl` | apt | Docker `HEALTHCHECK` 探活 + 构建期安装脚本 |
| `ca-certificates` | apt | 出网 HTTPS（Agent 调 API、git clone、pip/npm 下载的根证书） |

Python 依赖（`server/requirements.txt`，pip 装进 venv）：`fastapi`、`uvicorn[standard]`、`watchfiles`（inotify 文件监听）、`python-multipart`（上传）、`httpx` 与 `websockets`（网关反代 `/tty/`、`/proxy/<port>/`，同时也是 windows/files watch 通道所需）。

### 4.2 Agent 层（`claude://`、`codex://` 开箱即用）

| 软件 | 来源 | 用途 |
|------|------|------|
| `nodejs` 22 | nodesource | Agent CLI 的运行时；顺带覆盖前端类项目的终端需求 |
| `@anthropic-ai/claude-code` | npm -g | `claude://` 的命令 |
| `@openai/codex` | npm -g | `codex://` 的命令 |
| `git` | apt | Agent 工作流的基础依赖（diff/commit），也是终端基本件 |

**凭证不进镜像**：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等一律运行时注入——经容器环境变量或平台的 env 设置页（env.md），新终端自动生效。构建日志与镜像层里不得出现任何密钥。

### 4.3 终端工具箱（保障 scheme 示例与日常可用）

| 软件 | 理由 |
|------|------|
| `vim`（或 `nano`） | 文档承诺的 `vim:///workspace/notes.md` 要能跑（uri.md §3.1） |
| `htop` | 同上，`htop://` 是资源观察的推荐姿势 |
| `less`、`unzip`、`jq`、`ripgrep` | 终端与 Agent 的高频小工具：分页、解包、JSON、代码搜索 |
| `openssh-client` | git over ssh 与偶发的跳板需求（只装 client，**不装 sshd**，§6） |

> 现状注记：这一层在当前 `Dockerfile` 中尚未补齐，落地时随下一次镜像变更加入。原则：**单文件、无守护进程、Agent 或文档引用过的**才进清单，避免镜像滑向"什么都装"。

## 5. 用户、目录与运行约定

- **非 root 运行**：删除 ubuntu 24.04 自带的 `ubuntu` 用户，建同 UID 的 `shellbase`；全部进程（对外端口是非特权端口）以它运行，无 sudo。为什么删：
  - ubuntu 23.04 起官方 OCI 镜像预置 `ubuntu` 用户占用 **UID 1000**，而 `useradd -u 1000` 遇占用会直接报错——要拿到这个 UID 必须先移走占位者（`userdel -r ubuntu || true`，`|| true` 兜底无此用户的基底）；
  - 坚持 UID 1000 是为了 **bind mount 属主对齐**：Linux 宿主机第一个普通用户几乎总是 1000，`-v $PWD/workspace:/workspace` 双向读写无 chown 麻烦（Docker Desktop 有映射层不受影响，Linux 服务器是主场景）；
  - 不复用/不改名 `ubuntu`：终端就是产品界面，提示符与 `$HOME` 该叫 shellbase；docker 版 `ubuntu` 是裸账号，改名保留不了任何东西，删除重建更直白；也不给 shellbase 换 UID 共存——1000 被休眠账号占着，挂载对齐就没了。删后镜像只有一个交互账号，"进程谁在跑、文件归谁"没有第二种答案；
- 目录布局：`/opt/shellbase/{server,web,bin,venv}` 平台自用（属主 shellbase）；`/workspace` 为挂载卷（`VOLUME`），终端/文件/Agent 共享，state 也在其上（backend.md §3）；
- `EXPOSE 8080`（`SHELLBASE_PORT` 可改）；`HEALTHCHECK` 打 `/api/system/health`。

## 6. 刻意不装的

| 不装 | 理由 |
|------|------|
| headless 浏览器（Chromium/CDP） | v1 浏览器面板是纯前端 iframe（design.md §1.3），留给 v2 |
| 数据库（SQLite/…） | 状态就是文件系统（backend.md §3），不引入 |
| `sshd` | 唯一入口是网关的 :8080；再开 ssh 就是第二个鉴权面 |
| TLS 终结（certbot 等） | 公网 TLS 由外层反代/LB 解决（design.md §5） |
| `build-essential` 等编译链 | 体积大、场景少；需要时走 §7 的加层路径 |

## 7. 能力边界与扩展路径

运行用户无 root、无 sudo，`apt` 在容器内**不可用**——镜像内容即能力上限。需要更多软件时按序选择：

1. **用户级安装**：`pip install --user`、`npx`、`uv`、下载单文件二进制到 `~/bin`——不动镜像，进挂载卷可跨重启存活；
2. **加层扩展**：`FROM shellbase:latest` + root 段 `apt-get install …` 再切回 `USER shellbase`——团队自定义工具链的正路，平台文档提供此模板；
3. **提议进基线**：满足 §4.3 的准入原则（单文件、无守护进程、被 Agent/文档实际引用）就提 PR 进本清单。

`SHELLBASE_APPS_EXTRA`（uri.md §6）只解决"叫什么、怎么展示"，不解决"有没有"——注册别名之前，命令本体必须先经上述路径进入 PATH。
