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
| 启动 | `docker run` | `shellbase up` |

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
SHELLBASE_TOKEN=your-secret shellbase up --workspace ~/workspace
```

同样浏览器开 `http://<host>:8080` 输入令牌。不设 `SHELLBASE_TOKEN` 就会在终端打印随机令牌，
`--workspace` 不给则用当前目录。

`shellbase up` 会拉起 ttyd 子进程并把它的存活与自身绑定（ttyd 挂了就整体退出，不留半死实例），
退出时回收子进程。要交给 systemd 托管的话，一条 `ExecStart=shellbase up` 就够。

pip 路径下 tmux 走独立 socket（`-L shellbase`）与随包配置，不与你自己的 tmux server 混在一起。

命令：

```bash
shellbase up        # 完整服务（ttyd + HTTP 网关），默认 0.0.0.0:8080
shellbase serve     # 只起 HTTP 服务，不拉 ttyd（自己编排进程时用）
shellbase paths     # 打印随包分发的前端产物 / tmux.conf / attach.sh 路径
```

常用环境变量：`SHELLBASE_TOKEN`、`SHELLBASE_PORT`、`SHELLBASE_WORKSPACE`、`SHELLBASE_STATE_DIR`，
完整一览见 [design.md §4.3](docs/v1/works/design.md)。

> 安全提醒：`up` 默认监听 `0.0.0.0`，拿到令牌等于拿到这台机器上跑 shell 的能力。
> 公网部署请在外层套 TLS，或用 `--host 127.0.0.1` 配合 SSH 隧道。

## 本地开发

```bash
# 后端（含网关与 ttyd，127.0.0.1:8000）
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
PYTHONPATH=$PWD/server SHELLBASE_TOKEN=dev SHELLBASE_ATTACH_SH=$PWD/bin/attach.sh \
SHELLBASE_WEB_ROOT=$PWD/web/dist \
  .venv/bin/python -m shellbase.cli up --host 127.0.0.1 --port 8000 --workspace $PWD/workspace

# 前端（Vite dev server，把 /api、/tty、/proxy 都代理给后端）
cd web && npm install && npm run dev
```

dev server 上先访问 `/login.html` 用令牌换 Cookie，再回 `/`——鉴权对 dev 同样生效。

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
└── docs/v1/            # works/ 设计文档 + api/ 接口定义
```
