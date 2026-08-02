# shellbase：单 Dockerfile 拉起的融合终端平台（docs/v1/works/design.md §4）

# ---- 阶段 1：前端构建 ----
FROM node:22-slim AS web
WORKDIR /src
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ .
RUN npm run build

# ---- 阶段 2：运行时 ----
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# ttyd 在 ubuntu 24.04 (noble) universe 仓库里，直接装；其余基础组件同装。
# 网关（静态托管 / 鉴权 / 反代）在 FastAPI 里，因此不需要 nginx，
# 进程只有 uvicorn + ttyd 两个，也就不需要 supervisor；
# tini 只做 PID 1 的本分：转发信号、回收孤儿进程（原本是 supervisord 的活）。
RUN apt-get update && apt-get install -y --no-install-recommends \
        tmux ttyd tini \
        python3 python3-venv \
        curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && ttyd --version

# 预装 Agent CLI（claude:// 与 codex:// 开箱即用；运行时凭证经 env 注入，
# 如 ANTHROPIC_API_KEY / OPENAI_API_KEY）
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code @openai/codex \
    && npm cache clean --force \
    && claude --version && codex --version

# ubuntu 24.04 自带 UID 1000 的 ubuntu 用户，先移除再建 shellbase
RUN userdel -r ubuntu 2>/dev/null || true; useradd -m -u 1000 shellbase

COPY server/requirements.txt /opt/shellbase/server/requirements.txt
RUN python3 -m venv /opt/shellbase/venv \
    && /opt/shellbase/venv/bin/pip install --no-cache-dir \
        -r /opt/shellbase/server/requirements.txt

COPY server/ /opt/shellbase/server/
COPY bin/ /opt/shellbase/bin/
COPY --from=web /src/dist /opt/shellbase/web
COPY deploy/tmux.conf /etc/tmux.conf

RUN mkdir -p /workspace \
    && chmod +x /opt/shellbase/bin/attach.sh \
    && chown -R shellbase:shellbase /opt/shellbase /workspace

USER shellbase
# 刻意不写死 SHELLBASE_PORT：Cloud Run 等 PaaS 用 PORT 注入端口，
# 镜像里预置 SHELLBASE_PORT 会让它永远盖过 PORT。默认值 8080 在 cli.py 里。
ENV SHELLBASE_WORKSPACE=/workspace \
    SHELLBASE_WEB_ROOT=/opt/shellbase/web \
    SHELLBASE_ATTACH_SH=/opt/shellbase/bin/attach.sh \
    PYTHONPATH=/opt/shellbase/server \
    PYTHONUNBUFFERED=1

VOLUME /workspace
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -sf "http://127.0.0.1:${SHELLBASE_PORT:-${PORT:-8080}}/api/system/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/shellbase/venv/bin/python", "-m", "shellbase.cli", "up"]
