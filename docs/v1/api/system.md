# System API

平台元信息与健康检查。

## GET /api/system/info

前端状态栏数据源（轮询 5s）：

```json
{
  "version": "1.0.0",
  "hostname": "my-vm",
  "uptime_seconds": 86400,
  "cpu_percent": 12.5,
  "memory": { "total": 8589934592, "used": 3221225472 },
  "disk":   { "total": 107374182400, "used": 32212254720 },   // workspace 所在卷
  "terminals_alive": 3
}
```

## GET /api/system/health

Docker `HEALTHCHECK` 与外部探活用。**nginx 对此端点放行**（不经 auth_request），不泄露任何信息：

- `200 {"status":"ok"}`：FastAPI 存活且 state 目录可写；
- 其余情况非 200。

## GET /api/apps

应用注册表——启动页宫格与 URI 解析器的数据源（内置应用 + `SHELLBASE_APPS_EXTRA` 合并）：

```json
{
  "apps": [
    { "scheme": "bash",   "type": "terminal", "title": "终端",       "cmd": null },
    { "scheme": "file",   "type": "builtin",  "title": "文件浏览器" },
    { "scheme": "https",  "type": "builtin",  "title": "浏览器" },
    { "scheme": "claude", "type": "terminal", "title": "Claude Code", "cmd": "claude" },
    { "scheme": "codex",  "type": "terminal", "title": "Codex",       "cmd": "codex" },
    { "scheme": "aider",  "type": "terminal", "title": "Aider",       "cmd": "aider", "extra": true }
  ]
}
```

- `type: builtin` 的 scheme 由前端固定实现（文件浏览器、浏览器应用）；`terminal` 型统一走 attach 入口；
- `extra: true` 标记来自 `SHELLBASE_APPS_EXTRA` 的自定义项；
- 本列表只是**启动页宫格的展示项**，不是终端类 scheme 的白名单——未注册的 CLI（`vim://`、`htop://`…）不在列表中但同样可经 URI 直达（scheme 名即命令名，uri.md §3.1）；
- 注册表在进程启动时装载，修改环境变量需重启容器生效（v1 不做热更新）。
