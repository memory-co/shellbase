# Env API

设计背景：[works/env.md](../works/env.md)——凭证等环境变量由用户在平台内自助配置，注入到之后新拉起的终端。

## GET /api/env

读取全局变量表。**value 永远脱敏**（凭证只进不出，避免在浏览器与日志中往返）：

```json
{
  "updated_at": "2026-07-29T09:00:00Z",
  "vars": {
    "ANTHROPIC_API_KEY": { "preview": "sk-a…Wg8A", "length": 108 },
    "HTTPS_PROXY":       { "preview": "http…7890", "length": 21 }
  }
}
```

`preview` 为前 4 后 4 位（长度 ≤ 8 时只给首字符）；要改值就整个重填。

## PUT /api/env

增量合并写入：

```json
{ "vars": { "ANTHROPIC_API_KEY": "sk-ant-…", "OLD_KEY": null } }
```

- 字符串为设值，`null` 为删除；未提及的变量保持不变；
- 变量名须匹配 `[A-Za-z_][A-Za-z0-9_]*`，否则 `400 {"error":"bad_key"}`；
- 成功 `204`。落盘 `state/env.json`（0600、原子写），并同步 `tmux set-environment -g`。

## 生效范围

**只影响新创建/重建的会话**——tmux 会话的环境在创建时固化：

- 新开的终端块立即带上；已开着的终端不变，关闭重开即可（关闭即销毁 → 重开即重建）；
- 注入有两条通道（env.md §2）：tmux 全局环境（新会话继承）+ 创建时 `new-session -e KEY=VALUE`（兜底 tmux server 未启动的窗口期）；
- 容器进程环境是底座，平台配置叠加其上、同名覆盖。
