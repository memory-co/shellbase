#!/bin/sh
set -e

# Cloud Run 等 PaaS 用 PORT 注入监听端口；显式设置的 SHELLBASE_PORT 优先
: "${SHELLBASE_PORT:=${PORT:-8080}}"
: "${SHELLBASE_WORKSPACE:=/workspace}"
: "${SHELLBASE_STATE_DIR:=$SHELLBASE_WORKSPACE/.shellbase/state}"

if [ -z "$SHELLBASE_TOKEN" ]; then
    SHELLBASE_TOKEN=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "==============================================================="
    echo " SHELLBASE_TOKEN not set. Generated login token:"
    echo "   $SHELLBASE_TOKEN"
    echo "==============================================================="
fi
export SHELLBASE_TOKEN SHELLBASE_PORT SHELLBASE_WORKSPACE SHELLBASE_STATE_DIR

mkdir -p "$SHELLBASE_STATE_DIR/terminals" "$SHELLBASE_STATE_DIR/windows"
mkdir -p /opt/shellbase/run

envsubst '${SHELLBASE_PORT}' \
    < /opt/shellbase/deploy/nginx.conf.tmpl \
    > /opt/shellbase/run/nginx.conf

exec supervisord -c /opt/shellbase/deploy/supervisord.conf
