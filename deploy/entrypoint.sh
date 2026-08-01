#!/bin/sh
set -e

# Cloud Run 等 PaaS 用 PORT 注入监听端口；显式设置的 SHELLBASE_PORT 优先
: "${SHELLBASE_PORT:=${PORT:-8080}}"
: "${SHELLBASE_WORKSPACE:=/workspace}"
: "${SHELLBASE_STATE_DIR:=$SHELLBASE_WORKSPACE/.shellbase/state}"
: "${SHELLBASE_RUN_DIR:=/opt/shellbase/run}"
: "${SHELLBASE_WEB_ROOT:=/opt/shellbase/web}"

if [ -z "$SHELLBASE_TOKEN" ]; then
    SHELLBASE_TOKEN=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "==============================================================="
    echo " SHELLBASE_TOKEN not set. Generated login token:"
    echo "   $SHELLBASE_TOKEN"
    echo "==============================================================="
fi
export SHELLBASE_TOKEN SHELLBASE_PORT SHELLBASE_WORKSPACE SHELLBASE_STATE_DIR
export SHELLBASE_RUN_DIR SHELLBASE_WEB_ROOT

mkdir -p "$SHELLBASE_STATE_DIR/terminals" "$SHELLBASE_STATE_DIR/windows"
mkdir -p "$SHELLBASE_RUN_DIR"

envsubst '${SHELLBASE_PORT} ${SHELLBASE_RUN_DIR} ${SHELLBASE_WEB_ROOT}' \
    < /opt/shellbase/deploy/nginx.conf.tmpl \
    > "$SHELLBASE_RUN_DIR/nginx.conf"

exec supervisord -c /opt/shellbase/deploy/supervisord.conf
