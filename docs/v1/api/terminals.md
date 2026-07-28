# Terminals API

设计背景：[works/backend.md](../works/backend.md) §2（无中生有 + 302 attach）、[works/uri.md](../works/uri.md)（URI 语义）、[works/collab.md](../works/collab.md)（共享/只读）。

**标识模型**：终端是 window 的子资源，**会话身份 = (window, URI)**——URI 在其所属 window 内唯一（同 window 重开同一 URI 是重入，`?tab` 区分并行实例）；同一 URI 出现在不同 window 里是**互不相干的两个现场**。API 面上没有派生 id：管理端点一律用 `window` + `uri` 定位，后端内部的 tmux 会话名（302 目标 `/tty/?arg=<内部名>` 中可见）只是实现细节。

会话对象（响应中的 `terminal` 结构）：

```json
{
  "window": "main",
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

## GET /api/windows/{wid}/terminals/attach?uri=&mode=

**唯一 attach 入口**。iframe 的 src 指向这里，不直接指向 `/tty/`。

**适配层在本端点**：前端只做四类分流（本地服务 / 外部站点 / `file://` / 其余未知），凡未知 scheme 一律盲转发到这里——scheme 是否合法、映射到什么命令（scheme 名即命令名 / 注册表别名）、命令是否存在，全部由本端点裁决（uri.md §2、§3.1）。前端不维护终端 scheme 名单，也不感知重入与内部会话名。

| 参数 | 说明 |
|------|------|
| `uri` | URL-encoded 的虚拟 URI，仅接受终端类 scheme——任意"scheme 名即命令名"的 CLI（`bash://`、`claude://`、`codex://`、`vim://`…，见 uri.md §3.1，注册表可提供别名）。`file://`/`https://`/`url` 型 → `400 {"error":"not_terminal_scheme"}`；scheme 对应命令不在 PATH → `400 {"error":"cmd_not_found"}` |
| `mode` | 可选，`ro` = 只读 attach（`tmux attach -r`），非身份参数 |

行为：

1. 规范化 URI（uri.md §4），以 `(wid, uri)` 查 state；
2. 不存在：**无中生有**——写入 state 文件（记录 window、原始 URI、cwd、cmd）；带 cwd/命令的会话同时预创建 tmux 会话并拉起命令。例外：`mode=ro` 时不创建，返回 `404 {"error":"no_such_session"}`；
3. 已存在：更新 `last_attached`；若 tmux 会话已消亡（status=exited），按 state 记录的 cwd/cmd 重建；
4. `302 Location: /tty/?arg=<内部会话名>`（`mode=ro` 时附加只读参数）。

`wid` 未知时先无中生有该 window（windows.md），再执行上述流程。

## GET /api/terminals?window=

全局观测视图：state ∪ `tmux ls` 的合并（顺带触发一次对账，backend.md §7）；`window` 参数可选，过滤单个 window。

```json
{ "terminals": [ { ...terminal }, ... ] }
```

- 用户在终端里手工 `tmux new` 的会话以 `kind: "external"` 出现（无 window/uri），仅展示，不参与恢复；
- 启动页用 `?window=<当前>` 为 recents 条目标注存活圆点（launcher.md §3.2）。

## DELETE /api/windows/{wid}/terminals?uri=

销毁会话：`tmux kill-session` + 删除 state 文件 → `204`。不存在 → `404`。正被其他客户端 attach 时同样执行（tmux 会把所有客户端踢出），前端在 `clients > 1` 时应二次确认。

这是**用户在网页上关闭终端块的标准动作**：Shell 关闭块时先调本端点销毁会话，再 `PUT /api/windows/{wid}` 移除叶子——"关闭即销毁"，与 attach 的"打开即登记"对称。会话身份含 window，因此**不存在跨 window 引用问题**：删就是删，无需检查别的 window。

## 不做的事：终端输入/输出

API **不提供**向会话注入输入或抓取输出的端点。终端的 I/O 完全属于用户：交互走 ttyd 的 WS 通道（attach 进块里直接敲），程序化需求在终端里用 tmux 自身解决（`send-keys` / `capture-pane` 本来就是 shell 命令）。平台的职责止步于会话的生命周期（attach / list / delete），不碰会话里的内容。
