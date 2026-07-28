# shellbase v1 API 设计

FastAPI 提供的全部 HTTP/WS 接口。设计依据见 [works/design.md](../works/design.md) 及各专项文档，本目录是接口层面的权威定义。

## 通用约定

- **前缀**：全部挂在 `/api/` 下，由 nginx 反代到 `127.0.0.1:8000`；`/tty/` 是 ttyd 的 WS，不属于本 API，但其入口由 [terminals](terminals.md) 的 attach 端点 302 引导；
- **鉴权**：除 `POST /api/auth/login` 外，所有端点（含 WS）经 nginx `auth_request` 强制鉴权（见 [auth.md](auth.md)）；API 层代码不再做鉴权判断；
- **格式**：请求/响应体一律 JSON（上传/下载除外）；时间戳一律 ISO 8601 UTC（`2026-07-28T09:00:00Z`）；
- **错误体**：统一 `{"error": "<机器码>", "message": "<人读信息>"}`，如 `{"error": "path_escape", "message": "path outside workspace"}`；
- **常用状态码**：`400` 参数错误 / `401` 未认证（由 nginx 返回）/ `403` 越权路径 / `404` 不存在 / `409` 版本或并发冲突 / `413` 过大 / `429` 限速；
- **无分页**：v1 所有列表（终端、文件目录、tmux 会话）量级都很小，不设计分页。

## 端点总览

| 模块 | 端点 | 说明 |
|------|------|------|
| [auth](auth.md) | `POST /api/auth/login` | 登录换 Cookie |
| | `GET  /api/auth/verify` | nginx auth_request 内部校验 |
| | `POST /api/auth/logout` | 登出清 Cookie |
| | `GET  /api/auth/me` | 登录态探测 |
| [terminals](terminals.md) | `GET /api/terminals/attach?uri=` | 主入口：URI attach（无中生有 + 302） |
| | `GET  /api/terminals/{id}/attach` | 按 id attach |
| | `GET  /api/terminals` | 会话列表（state ∪ tmux） |
| | `POST /api/terminals` | 匿名会话显式创建 |
| | `DELETE /api/terminals/{id}` | 销毁会话 |
| | `POST /api/terminals/{id}/input` | 注入输入（Agent 下发任务） |
| | `GET  /api/terminals/{id}/output` | 抓取输出 |
| [layout](layout.md) | `GET /api/layout` | 读布局树 |
| | `PUT  /api/layout` | 写布局树（version 乐观锁） |
| | `WS   /api/layout/watch` | 布局版本广播（协作） |
| [files](files.md) | `GET /api/files/tree` | 目录列表 |
| | `GET/PUT /api/files/content` | 读/写文件 |
| | `POST /api/files/upload` | 上传 |
| | `GET  /api/files/download` | 下载（目录打 zip） |
| | `POST /api/files/mkdir` / `move` / `delete` | 目录/移动/删除 |
| | `WS   /api/files/watch` | 文件变更推送 |
| [system](system.md) | `GET /api/system/info` | 资源与版本信息 |
| | `GET  /api/system/health` | 健康检查（Docker HEALTHCHECK） |
| | `GET  /api/apps` | 应用注册表（启动页宫格数据源） |
