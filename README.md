# shellbase

一个可以用单个 Dockerfile 拉起的「融合终端」平台：CLI Agent + 浏览器 + 文件管理，
部署在任意虚拟机上，通过浏览器访问。页面是一块可自由分割的画布，每个块由一个虚拟 URI
定位（`bash://`、`codex:///workspace/proj`、`file:///workspace`、`https://…`），
后端持久化每个 window 的完整状态，断线/换设备重入现场无损，多客户端实时协作。

设计文档见 [docs/v1/works/](docs/v1/works/design.md)，接口定义见 [docs/v1/api/](docs/v1/api/README.md)。

## 安装

两种方式跑的是同一套东西：单端口的 FastAPI 网关（静态托管 + 鉴权 + 反代）加一个 ttyd/tmux
终端子进程。区别只在环境谁来配。

| | Docker | pip |
| --- | --- | --- |
| 系统依赖 | 镜像自带 | 自己装 tmux + ttyd |
| Agent CLI（claude、codex） | 镜像预装 | 自己 `npm i -g` |
| 隔离 | 容器 | 无，直接跑在宿主机上 |
| 启动 | `docker run` | `shellbase start` |

两条路径都不需要 nginx，也没有任何配置文件要写。

### 方式一：Docker（不用配环境）

```bash
docker build -t shellbase .
docker run -d --name shellbase \
  -p 8080:8080 \
  -v $PWD/workspace:/workspace \
  -e SHELLBASE_TOKEN=your-secret \
  shellbase
```

浏览器打开 `http://<host>:8080`，输入令牌进入。未设置 `SHELLBASE_TOKEN` 时启动日志会打印随机生成的令牌（`docker logs shellbase`）。

### 方式二：pip（自备 tmux 与 ttyd）

```bash
# 1) 系统依赖：ttyd 在 ubuntu 24.04+ 的 universe 仓库里；
#    更老的发行版从 https://github.com/tsl0922/ttyd/releases 下静态二进制
sudo apt install -y tmux ttyd
npm install -g @anthropic-ai/claude-code @openai/codex   # 可选：claude:// 与 codex://

# 2) 装并启动
pip install shellbase
shellbase start --workspace ~/workspace
```

`start` 会在后台拉起服务并等它就绪，然后把地址、令牌、日志路径打出来：

```
shellbase 已启动（pid 12345）
  地址   http://127.0.0.1:8080
  令牌   3f2a…
  日志   ~/.shellbase/shellbase.log
  停止   shellbase stop
```

令牌不设 `SHELLBASE_TOKEN` 时随机生成并存在 `~/.shellbase/token`（0600）复用——
否则 stop/start 一次，浏览器里存的地址就全废了。想轮换删掉这个文件即可。

忘了地址或令牌就 `shellbase status`：

```
shellbase 运行中（pid 19763）
  地址     http://127.0.0.1:8080
  令牌     3d9e8dab2a1c0b9b76d5dd8f8d7eacb6
  工作区   /root/workspace
  终端     ttyd 127.0.0.1:41234
  已运行   1小时2分
  健康     ok
  日志     /root/.shellbase/shellbase.log
  停止     shellbase stop
```

没在跑时退出码非 0，方便脚本判断；`shellbase status --json` 给机器读
（`token` 字段验不出实例认哪份令牌时是 `null`）。

命令一览：

```bash
shellbase start     # 后台启动并等待就绪（关掉 ssh 也不会被带走）
shellbase status    # 看当前实例：地址、令牌、工作区、终端端口、运行时长、健康
shellbase stop      # 停止后台实例（先 SIGTERM，超时才 SIGKILL）
shellbase daemon    # 前台阻塞运行，日志走 stdout —— 容器与 systemd 用这个
shellbase serve     # 只起 HTTP 服务，不拉 ttyd（自己编排进程时用）
shellbase paths     # 打印随包分发的前端产物 / tmux.conf / attach.sh 路径
```

交给 systemd 托管就用前台那个：`ExecStart=shellbase daemon --workspace /srv/work`。

`daemon` 会拉起 ttyd 子进程并把它的存活与自身绑定：ttyd 挂了整体退出，不留半死实例；
反过来主进程无论怎么死（含 SIGKILL），内核都会顺手带走 ttyd。ttyd 只监听回环，
端口默认自动挑一个空闲的（`--ttyd-port` 可固定），不会跟你自己跑的 ttyd 打架。

pip 路径下 tmux 走独立 socket（`-L shellbase`）与随包配置，不与你自己的 tmux server 混在一起。

常用环境变量：`SHELLBASE_TOKEN`、`SHELLBASE_PORT`、`SHELLBASE_WORKSPACE`、`SHELLBASE_STATE_DIR`，
完整一览见 [design.md §4.3](docs/v1/works/design.md)。

> 安全提醒：默认监听 `0.0.0.0`，拿到令牌等于拿到这台机器上跑 shell 的能力。
> 公网部署请在外层套 TLS，或用 `--host 127.0.0.1` 配合 SSH 隧道。

## 本地开发

```bash
# 后端（含网关与 ttyd，127.0.0.1:8000）
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
PYTHONPATH=$PWD/server SHELLBASE_TOKEN=dev SHELLBASE_ATTACH_SH=$PWD/bin/attach.sh \
SHELLBASE_WEB_ROOT=$PWD/web/dist \
  .venv/bin/python -m shellbase.cli daemon --host 127.0.0.1 --port 8000 --workspace $PWD/workspace

# 前端（Vite dev server，把 /api、/tty、/proxy 都代理给后端）
cd web && npm install && npm run dev
```

dev server 上先访问 `/login.html` 用令牌换 Cookie，再回 `/`——鉴权对 dev 同样生效。

## 测试

按场景组织，每个目录一个场景、自带 README 说清边界（见 [tests/](tests/README.md)）：

```bash
pip install -e ".[dev]"
pytest                      # 全部
pytest tests/tty_proxy -v   # 单个场景
```

不起端口：client 走 `httpx.ASGITransport` 直连 ASGI 应用，反代的上游用假上游顶上。

发布 pip 包前要先构建前端（`cd web && npm run build`），`web/dist` 会被打进 wheel：

```bash
python -m build && twine upload dist/*
```

## 布局

```
├── Dockerfile          # 单镜像：ttyd(tmux) + FastAPI（网关同进程）+ 前端静态产物
├── pyproject.toml      # pip 包：后端 + 前端产物 + tmux.conf / attach.sh
├── deploy/tmux.conf    # tmux 配置（Docker 落到 /etc，pip 随包分发）
├── bin/attach.sh       # ttyd → tmux（校验 state，终端层禁止无中生有）
├── server/shellbase/   # FastAPI：gateway / auth / windows / terminals / files / system + cli
├── web/                # 前端：Shell 分割画布 + rich URL bar + files / browser 应用
├── tests/              # 按场景组织的测试，每个目录一个场景
└── docs/v1/            # works/ 设计文档 + api/ 接口定义
```
