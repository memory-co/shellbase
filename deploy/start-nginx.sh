#!/bin/sh
# 冷启动门闩：Cloud Run 等 PaaS 以 "8080 可连接" 作为放量信号，
# 因此 nginx 必须等到上游 FastAPI 就绪后再开始监听，否则首个请求 502。
until curl -sf http://127.0.0.1:8000/api/system/health >/dev/null 2>&1; do
    sleep 0.2
done
exec nginx -c /opt/shellbase/run/nginx.conf -g "daemon off;"
