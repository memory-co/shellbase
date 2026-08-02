# shellbase v1 API 设计

FastAPI 提供的全部 HTTP/WS 接口。设计依据见 [works/design.md](../works/design.md) 及各专项文档，本目录是接口层面的权威定义。

## 通用约定

- **前缀**：全部挂在 `/api/` 下，与网关同进程（works/design.md §3.1）；`/tty/` 是网关反代到 ttyd 的通道，不属于本 API，但其入口由 [terminals](terminals.md) 的 attach 端点 302 引导；
- **鉴权**：除 `POST /api/auth/login` 与 `GET /api/system/health` 外，所有端点（含 WS）由网关最外层的 `AuthGate` 强制鉴权（见 [auth.md](auth.md)）；API 层代码不再做鉴权判断；
- **格式**：请求/响应体一律 JSON（上传/下载除外）；时间戳一律 ISO 8601 UTC（`2026-07-28T09:00:00Z`）；
- **错误体**：统一 `{"error": "<机器码>", "message": "<人读信息>"}`，如 `{"error": "path_escape", "message": "path outside workspace"}`；
- **常用状态码**：`400` 参数错误 / `401` 未认证（由网关返回）/ `403` 越权路径 / `404` 不存在 / `409` 版本或并发冲突 / `413` 过大 / `429` 限速；
- **无分页**：v1 所有列表（终端、文件目录、tmux 会话）量级都很小，不设计分页。

## 端点总览

| 模块 | 端点 | 说明 |
|------|------|------|
| [auth](auth.md) | `POST /api/auth/login` | 登录换 Cookie |
| | `GET  /api/auth/verify` | 令牌校验（前端探测用；网关自身在中间件里校验，不走此端点） |
| | `POST /api/auth/logout` | 登出清 Cookie |
| | `GET  /api/auth/me` | 登录态探测 |
| [terminals](terminals.md) | `GET /api/terminals/attach?uri=` | 唯一 attach 入口：会话身份 = 完整 URI（含 `window`/`block`），无中生有 + 302 |
| | `GET  /api/terminals?window=` | 全局会话观测（state ∪ tmux，可按 URI 的 `window` 参数过滤） |
| | `DELETE /api/terminals?uri=` | 销毁会话（关闭块的标准动作）。终端 I/O 不设端点，由用户自行掌控 |
| [windows](windows.md) | `GET /api/windows` | window 列表（每张页面一个 window，状态存后端） |
| | `GET  /api/windows/{id}` | 读布局树（未知 id 无中生有） |
| | `PUT  /api/windows/{id}` | 写布局树（version 乐观锁） |
| | `DELETE /api/windows/{id}` | 删除页面（连带销毁独占的终端会话） |
| | `WS   /api/windows/{id}/watch` | 单页面版本广播（协作） |
| [files](files.md) | `GET /api/files/tree` | 目录列表 |
| | `GET/PUT /api/files/content` | 读/写文件 |
| | `POST /api/files/upload` | 上传 |
| | `GET  /api/files/download` | 下载（目录打 zip） |
| | `POST /api/files/mkdir` / `move` / `delete` | 目录/移动/删除 |
| | `WS   /api/files/watch` | 文件变更推送 |
| [env](env.md) | `GET /api/env` | 全局环境变量（脱敏读） |
| | `PUT /api/env` | 增量写入，同步 tmux 全局环境 |
| [system](system.md) | `GET /api/system/info` | 资源与版本信息 |
| | `GET  /api/system/health` | 健康检查（Docker HEALTHCHECK） |
| | `GET  /api/apps` | 应用注册表（URL bar 宫格的冷启动兜底与元数据） |
