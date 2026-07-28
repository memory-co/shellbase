# shellbase：单 Dockerfile 拉起的融合终端平台（docs/v1/works/design.md §4）

# ---- 阶段 1：前端构建 ----
FROM node:22-slim AS web
WORKDIR /src
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ .
RUN npm run build

# ---- 阶段 2：运行时 ----
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx tmux supervisor \
        python3 python3-venv \
        gettext-base curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# ttyd 不在 bookworm 仓库，从 GitHub releases 取静态二进制（x86_64 / aarch64 同名规则）
ARG TTYD_VERSION=1.7.7
RUN curl -fsSL -o /usr/local/bin/ttyd \
        "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.$(uname -m)" \
    && chmod +x /usr/local/bin/ttyd \
    && /usr/local/bin/ttyd --version

RUN useradd -m -u 1000 shellbase

COPY server/requirements.txt /opt/shellbase/server/requirements.txt
RUN python3 -m venv /opt/shellbase/venv \
    && /opt/shellbase/venv/bin/pip install --no-cache-dir \
        -r /opt/shellbase/server/requirements.txt

COPY server/ /opt/shellbase/server/
COPY deploy/ /opt/shellbase/deploy/
COPY bin/ /opt/shellbase/bin/
COPY --from=web /src/dist /opt/shellbase/web
COPY deploy/tmux.conf /etc/tmux.conf

RUN mkdir -p /opt/shellbase/run /workspace \
    && chmod +x /opt/shellbase/bin/attach.sh /opt/shellbase/deploy/entrypoint.sh \
    && chown -R shellbase:shellbase /opt/shellbase /workspace

USER shellbase
ENV SHELLBASE_WORKSPACE=/workspace \
    SHELLBASE_PORT=8080

VOLUME /workspace
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -sf "http://127.0.0.1:${SHELLBASE_PORT}/api/system/health" || exit 1

ENTRYPOINT ["/opt/shellbase/deploy/entrypoint.sh"]
