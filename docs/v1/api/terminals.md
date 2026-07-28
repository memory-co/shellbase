# Terminals API

设计背景：[works/backend.md](../works/backend.md) §2（无中生有 + 302 attach）、[works/uri.md](../works/uri.md)（URI → state id 派生）、[works/collab.md](../works/collab.md)（共享/只读）。

会话对象（响应中的 `terminal` 结构）：

```json
{
  "id": "codex-workspace-myproj-2",
  "uri": "codex:///workspace/myproj?tab=2",
  "kind": "agent",                  // plain | agent | external
  "cwd": "/workspace/myproj",
  "cmd": "codex",                   // plain 会话为 null
  "status": "alive",                // alive | exited
  "created_at": "2026-07-28T09:00:00Z",
  "last_attached": "2026-07-28T10:30:00Z",
  "clients": 2                      // 当前 attach 的客户端数（tmux list-clients）
}
```

## GET /api/terminals/attach?uri=&mode=

**主入口**。iframe 的 src 指向这里，不直接指向 `/tty/`。

**适配层在本端点**：前端只做四类分流（本地服务 / 外部站点 / `file://` / 其余未知），凡未知 scheme 一律盲转发到这里——scheme 是否合法、映射到什么命令（scheme 名即命令名 / 注册表别名）、命令是否存在，全部由本端点裁决（uri.md §2、§3.1）。前端不维护终端 scheme 名单。

| 参数 | 说明 |
|------|------|
| `uri` | URL-encoded 的虚拟 URI，仅接受终端类 scheme——任意"scheme 名即命令名"的 CLI（`bash://`、`claude://`、`codex://`、`vim://`…，见 uri.md §3.1，注册表可提供别名）。`file://`/`https://`/`url` 型 → `400 {"error":"not_terminal_scheme"}`；scheme 对应命令不在 PATH → `400 {"error":"cmd_not_found"}` |
| `mode` | 可选，`ro` = 只读 attach（`tmux attach -r`），非身份参数 |

行为：

1. 规范化 URI → 确定性派生 state id（uri.md §4）；
2. state 不存在：**无中生有**——写入 state 文件（记录原始 URI/cwd/cmd）；Agent 类同时预创建 tmux 会话并拉起命令。例外：`mode=ro` 时不创建，返回 `404 {"error":"no_such_session"}`；
3. state 已存在：更新 `last_attached`；若 tmux 会话已消亡（status=exited），按 state 记录的 cwd/cmd 重建；
4. `302 Location: /tty/?arg=<id>`（`mode=ro` 时附加只读参数）。

attach 是**唯一入口**，且只按 URI：前端不感知"URI → id"的派生与重入，这些完全由后端控制。id 只是后端的内部产物，仅出现在列表对象和管理端点（DELETE / input / output）的路径里。

## GET /api/terminals

列表：state ∪ `tmux ls` 的合并视图（顺带触发一次对账，backend.md §7）。

```json
{ "terminals": [ { ...terminal }, ... ] }
```

- 用户在终端里手工 `tmux new` 的会话以 `kind: "external"` 出现，仅展示，不参与布局恢复；
- 启动页用本端点为 recents 条目标注存活圆点（launcher.md §3.2）。

## POST /api/terminals

显式创建匿名会话（不常用，URI 入口是主路径）：

```json
// 请求（body 可为空）
{}
// 201 响应：等价于 bash://?tab=<最小空闲值>
{ "id": "bash-workspace-4", "uri": "bash://?tab=4", "attach_url": "/api/terminals/attach?uri=bash%3A%2F%2F%3Ftab%3D4" }
```

## DELETE /api/terminals/{id}

`tmux kill-session` + 删除 state 文件 → `204`。会话不存在 → `404`。正被其他客户端 attach 时同样执行（tmux 会把所有客户端踢出），前端在 `clients > 1` 时应二次确认。

这是**用户在网页上关闭终端块的标准动作**：Shell 关闭块时先调本端点销毁会话，再 `PUT /api/windows/{id}` 移除叶子——"关闭即销毁"，与 attach 的"打开即登记"对称（backend.md §4.2）。注意：若该会话的 URI 同时出现在其他 window 中，Shell 应跳过 DELETE 只改布局（判断依据：`GET /api/terminals` 返回的会话对照各 window，或简化为删除前确认）。

## POST /api/terminals/{id}/input

向会话注入输入（程序化给 Agent 下发任务）：

```json
{ "text": "帮我修复 tests/ 下的失败用例", "enter": true }
```

- `tmux send-keys` 实现；`enter: true`（默认）时末尾追加回车；
- `204`；会话不存在或已 exited → `404` / `409 {"error":"session_exited"}`。

## GET /api/terminals/{id}/output?lines=200

抓取会话最近输出（`tmux capture-pane -p`）：

```json
{ "id": "claude-workspace-myproj", "lines": 200, "output": "...终端文本..." }
```

`lines` 默认 200，上限 5000。用于程序化观测 Agent 进展；人看直接 attach 块即可。
