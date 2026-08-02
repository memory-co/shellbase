# Files API

设计背景：[works/design.md](../works/design.md) §3.3。所有路径参数均为**相对 workspace 根**（`SHELLBASE_WORKSPACE`，默认 `/workspace`）的路径或以其为前缀的绝对路径；服务端 `resolve()`（含符号链接）后必须仍在 workspace 根内，否则一律 `403 {"error":"path_escape"}`。

## GET /api/files/tree?path=&depth=1

目录列表。`path` 缺省为根；`depth` 默认 1（前端文件树按需展开逐层拉取）。

```json
{
  "path": "src",
  "entries": [
    { "name": "main.py", "type": "file", "size": 2048,
      "mtime": "2026-07-28T09:00:00Z", "mode": "rw-r--r--" },
    { "name": "utils",   "type": "dir",  "children": null }   // depth 用尽时为 null
  ]
}
```

`path` 不是目录 → `400`；不存在 → `404`。

## GET /api/files/content?path=

读文件：

- 文本（UTF-8 可解码且 ≤ 2MB）：`200`，`Content-Type: text/plain`，响应头 `X-File-Mtime` 带 mtime（供写回时做乐观锁）；
- 二进制或超限：`200` 返回元信息 JSON `{"binary": true, "size": ..., "mtime": ...}`，前端引导走 download。

## PUT /api/files/content

写文件（编辑器保存）：

```json
{ "path": "src/main.py", "content": "...", "base_mtime": "2026-07-28T09:00:00Z" }
```

- `base_mtime` 乐观锁：与磁盘当前 mtime 不符（终端里被并发改过）→ `409 {"error":"mtime_conflict", "current_mtime": "..."}`，前端提示 diff/覆盖/放弃；传 `null` 表示新建（已存在则 409）；
- 成功：`200 {"mtime": "<新值>"}`；原子写（临时文件 + rename）。

## POST /api/files/upload

`multipart/form-data`：`path`（目标目录）+ `files[]`。单请求上限 1GB（网关按 `Content-Length` 卡，超限 `413`）。同名文件直接覆盖。成功 `201 {"uploaded": ["a.txt", ...]}`。

## GET /api/files/download?path=

- 文件：流式下载，`Content-Disposition: attachment`；
- 目录：即时打 zip 流式返回（不落盘）。

## POST /api/files/mkdir | /api/files/move | /api/files/delete

```json
{ "path": "src/newdir" }                          // mkdir，递归创建，成功 201
{ "from": "src/a.py", "to": "src/b.py" }          // move/重命名，目标已存在 → 409
{ "path": "src/old", "recursive": true }          // delete；目录且未传 recursive → 409
```

均成功 `204`（mkdir 为 `201`）。删除不进回收站——终端里 `rm` 同样不进，能力对齐（design.md §5"能力自觉"）。

## WS /api/files/watch?path=

订阅目录（递归）变更，基于 watchfiles/inotify，前端文件树实时刷新：

```json
// 服务端 → 客户端
{ "type": "fs", "event": "created",  "path": "src/new.py", "is_dir": false }
{ "type": "fs", "event": "modified", "path": "src/main.py", "is_dir": false }
{ "type": "fs", "event": "deleted",  "path": "src/old",    "is_dir": true }
```

- 事件在服务端做 200ms 合并去抖（编译类工具的风暴写入合并为少量事件）；
- 心跳与重连约定同 [windows.md](windows.md) 的 watch。
