#!/bin/sh
# ttyd -W 调用：$1 = 内部会话名，$2 = "ro"（可选，只读观看）。
# 终端层不允许无中生有：state 文件不存在即拒绝（backend.md §2.3）。
STATE="${SHELLBASE_STATE_DIR:-${SHELLBASE_WORKSPACE:-/workspace}/.shellbase/state}"
S="$1"
MODE="$2"

# tmux socket / 配置必须与后端（state.tmux_argv）一致，否则连的是另一个 tmux server。
# 位置参数已取完，这里安全复用 $@ 装 tmux 前缀参数。
set --
[ -n "$SHELLBASE_TMUX_SOCKET" ] && set -- "$@" -L "$SHELLBASE_TMUX_SOCKET"
[ -n "$SHELLBASE_TMUX_CONF" ] && set -- "$@" -f "$SHELLBASE_TMUX_CONF"

if [ -z "$S" ] || [ ! -f "$STATE/terminals/$S.json" ]; then
    echo "unknown session: ${S:-<empty>} (open it via the shellbase UI)"
    exit 1
fi

if [ "$MODE" = "ro" ]; then
    exec tmux "$@" attach-session -r -t "=$S"
fi

# 带自定义 cwd/命令的会话由 FastAPI 预创建，这里的 -A 只会命中已存在会话；
# -c 仅兜底最朴素的 bash://。
exec tmux "$@" new-session -A -s "$S" -c "${SHELLBASE_WORKSPACE:-/workspace}"
