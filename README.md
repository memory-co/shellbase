# shellbase

一个可以用单个 Dockerfile 拉起的「融合终端」平台：CLI Agent + 浏览器 + 文件管理，
部署在任意虚拟机上，通过浏览器访问。页面是一块可自由分割的画布，每个块由一个虚拟 URI
定位（`bash://`、`codex:///workspace/proj`、`file:///workspace`、`https://…`），
后端持久化每个 window 的完整状态，断线/换设备重入现场无损，多客户端实时协作。

设计文档见 [docs/v1/works/](docs/v1/works/design.md)，接口定义见 [docs/v1/api/](docs/v1/api/README.md)。

## 安装

两种方式，跑起来的是同一套东西（nginx 网关 + ttyd/tmux 终端 + FastAPI 后端 + 前端静态产物），
区别只在环境谁来配：

| | Docker | pip |
| --- | --- | --- |
| 系统依赖 | 镜像自带 | 自己装 nginx / tmux / ttyd |
| Agent CLI（claude、codex） | 镜像预装 | 自己 `npm i -g` |
| 进程编排 | supervisord 全包 | 自己拉起三个进程 |
| 适合 | 直接部署 | 已有机器、想复用本机环境与已装好的 CLI |

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

### 方式二：pip（自备环境）

pip 包里带了后端、前端静态产物、nginx 配置模板与 `attach.sh`；nginx / tmux / ttyd 这些系统组件需要自己装。

```bash
# 1) 系统依赖（Debian/Ubuntu；ttyd 在 ubuntu 24.04+ 的 universe 仓库里）
sudo apt install -y nginx tmux ttyd
npm install -g @anthropic-ai/claude-code @openai/codex   # 可选：claude:// 与 codex://

# 2) 装 shellbase
pip install shellbase
cp "$(shellbase paths | awk -F'\t' '$1=="tmux-conf"{print $2}')" ~/.tmux.conf

# 3) 环境
export SHELLBASE_TOKEN=your-secret
export SHELLBASE_WORKSPACE=$HOME/workspace
export SHELLBASE_STATE_DIR=$SHELLBASE_WORKSPACE/.shellbase/state
mkdir -p "$SHELLBASE_STATE_DIR"/terminals "$SHELLBASE_STATE_DIR"/windows ~/.shellbase/run

# 4) 三个进程（后端只监听回环，对外一律走 nginx，鉴权在网关层）
shellbase serve &                                                  # FastAPI → 127.0.0.1:8000
ttyd -i 127.0.0.1 -p 7681 -W \
  -a "$(shellbase paths | awk -F'\t' '$1=="attach-sh"{print $2}')" &
shellbase nginx-conf --port 8080 -o ~/.shellbase/run/nginx.conf    # 渲染出指向本机路径的配置
nginx -c ~/.shellbase/run/nginx.conf
```

同样浏览器开 `http://<host>:8080` 输入令牌。三个进程建议交给 systemd/supervisor 托管，
可参照仓库里的 [deploy/supervisord.conf](deploy/supervisord.conf)。

命令行只做这三件事：

```bash
shellbase serve         # 起 FastAPI 后端（--host/--port）
shellbase paths         # 打印随包分发的前端产物 / nginx 模板 / tmux.conf / attach.sh 路径
shellbase nginx-conf    # 按本机路径渲染 nginx 配置（--port/--run-dir/--web-root/-o）
```

## 本地开发

```bash
# 后端（127.0.0.1:8000）
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
SHELLBASE_WORKSPACE=$PWD/workspace SHELLBASE_TOKEN=dev \
  .venv/bin/uvicorn shellbase.main:app --app-dir server --port 8000

# 前端（Vite dev server，代理 /api 与 /tty）
cd web && npm install && npm run dev
```

发布 pip 包前要先构建前端（`cd web && npm run build`），`web/dist` 会被打进 wheel：

```bash
python -m build && twine upload dist/*
```

## 布局

```
├── Dockerfile          # 单镜像：nginx + ttyd(tmux) + FastAPI + 前端静态产物
├── pyproject.toml      # pip 包：后端 + 前端产物 + deploy 资源
├── deploy/             # nginx 模板 / supervisord / entrypoint / tmux.conf
├── bin/attach.sh       # ttyd → tmux（校验 state，终端层禁止无中生有）
├── server/shellbase/   # FastAPI：auth / windows / terminals / files / system + cli
├── web/                # 前端：Shell 分割画布 + rich URL bar + files / browser 应用
└── docs/v1/            # works/ 设计文档 + api/ 接口定义
```
