# shellbase

一个可以用单个 Dockerfile 拉起的「融合终端」平台：CLI Agent + 浏览器 + 文件管理，
部署在任意虚拟机上，通过浏览器访问。页面是一块可自由分割的画布，每个块由一个虚拟 URI
定位（`bash://`、`codex:///workspace/proj`、`file:///workspace`、`https://…`），
后端持久化每个 window 的完整状态，断线/换设备重入现场无损，多客户端实时协作。

设计文档见 [docs/v1/works/](docs/v1/works/design.md)，接口定义见 [docs/v1/api/](docs/v1/api/README.md)。

## 快速开始

```bash
docker build -t shellbase .
docker run -d --name shellbase \
  -p 8080:8080 \
  -v $PWD/workspace:/workspace \
  -e SHELLBASE_TOKEN=your-secret \
  shellbase
```

浏览器打开 `http://<host>:8080`，输入令牌进入。未设置 `SHELLBASE_TOKEN` 时启动日志会打印随机生成的令牌（`docker logs shellbase`）。

## 本地开发

```bash
# 后端（127.0.0.1:8000）
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
SHELLBASE_WORKSPACE=$PWD/workspace SHELLBASE_TOKEN=dev \
  .venv/bin/uvicorn app.main:app --app-dir server --port 8000

# 前端（Vite dev server，代理 /api 与 /tty）
cd web && npm install && npm run dev
```

## 布局

```
├── Dockerfile          # 单镜像：nginx + ttyd(tmux) + FastAPI + 前端静态产物
├── deploy/             # nginx 模板 / supervisord / entrypoint / tmux.conf
├── bin/attach.sh       # ttyd → tmux（校验 state，终端层禁止无中生有）
├── server/app/         # FastAPI：auth / windows / terminals / files / system
├── web/                # 前端：Shell 分割画布 + rich URL bar + files / browser 应用
└── docs/v1/            # works/ 设计文档 + api/ 接口定义
```
