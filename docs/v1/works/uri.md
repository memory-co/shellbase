# shellbase v1 虚拟 URI 定位符设计

> 每个布局块由一个**虚拟 URI** 唯一定位。URI 既是块的身份，也是打开它的全部信息——
> 存进 [backend.md](backend.md) 的布局树即可持久化，再次解析即可**重入**同一现场，
> 复制给协作者即可共享（[collab.md](collab.md)）。

## 1. 动机

没有统一定位符时，"块里装的是什么"要靠 app 类型 + 一堆散装参数描述，持久化、恢复、分享各写一套逻辑。引入 URI 后：

- **一个字符串说清一个块**：`codex:///workspace/myproj` = "在这个目录跑 Codex 的终端"；
- **重入天然成立**：URI 规范化后派生 state id，同一 URI 无论谁、何时、第几次打开，都 attach 到同一份现场（配合 backend.md 的无中生有与 collab.md 的共享语义）；
- **扩展只是加 scheme**：新应用 = 应用注册表里的一条 scheme 定义，布局、恢复、分享逻辑零改动。

## 2. 语法与解析

标准 URI 形态：`scheme://authority/path?query`。前端 Shell 持有解析器，把 URI 翻译成块内 iframe 的实际 `src`：

```
                     ┌── https(www)  ──▶ 直接作为 iframe src（外链嵌入）
                     ├── https(localhost) ─▶ /proxy/<port>/…（nginx 代理本地端口）
块的 URI ──▶ 解析器 ──┼── file://     ──▶ /apps/files?path=…（文件浏览器）
                     ├── bash://     ──▶ /api/terminals/attach?uri=…（302 → ttyd）
                     └── claude:// codex:// … ─▶ 同上，Agent 终端
```

## 3. Scheme 一览

| URI 示例 | 含义 | 解析结果 |
|----------|------|----------|
| `https://www.example.com/docs` | 外部网页 | 直接 iframe 嵌入该地址（受目标站 `X-Frame-Options` 限制，被拒时提示新窗口打开） |
| `https://localhost:5173/` | 容器/本机上的 web 服务 | 经 nginx 通配代理 `/proxy/5173/` 访问——外部无需映射该端口，且同源、无嵌入限制 |
| `file:///workspace/src` | 本地目录 | 文件浏览器应用定位到该目录（文件树） |
| `file:///workspace/src/main.py` | 本地文件 | 文件浏览器应用直接打开该文件（编辑器） |
| `bash://main` | 本地 bash 终端 | 终端会话，state id 派生自 URI → `302 /tty/?arg=<id>` |
| `claude:///workspace/myproj` | 在该目录启动 Claude Code | Agent 终端：tmux 会话 cwd 为该目录、启动命令 `claude` |
| `codex:///workspace/myproj` | 在该目录启动 Codex | 同上，命令 `codex` |

约定：

- 终端/Agent 类 scheme 的 **path 表示工作目录**（省略则默认 `/workspace`）；`bash://` 的 authority 位置是**会话名**（`bash://main`、`bash://build`），允许同目录开多个互不相干的终端；
- `https://localhost` 与 `https://127.0.0.1` 等价，其余 host 一律按外链处理；
- `query` 携带 scheme 相关参数，如 `?mode=ro`（只读 attach，见 collab.md）。

## 4. 重入：URI → state id 的确定性映射

终端类 URI 规范化（scheme 小写、路径去尾斜杠、query 剔除非身份参数如 `mode`）后，确定性地派生 state id：

```
bash://main                →  bash-main
claude:///workspace/myproj →  claude-workspace-myproj（超长或含特殊字符时取 slug + 短哈希）
```

- 后端 `GET /api/terminals/attach?uri=<encoded>`：规范化 → 派生 id → 查 state，**无则登记**（state 文件记录原始 URI、cwd、启动命令）→ `302 /tty/?arg=<id>`；
- 于是"重入"就是把同一个 URI 再解析一遍：现场还在则原样接上；容器重启后现场消亡，也能凭 state 里的 URI 重建出同目录、同命令的会话；
- 同一 URI 被多个客户端同时打开 = 共享同一现场（collab.md）。

`file://` 与 `https://` 类是无状态引用，不产生终端 state，重入即重新加载。

## 5. 与布局、分享的关系

- `layout.json` 的叶子只存 `{"type": "leaf", "uri": "..."}`——URI 是块的全部持久化内容（backend.md §4）；
- Shell 支持 deep link：`/#open=<encoded-uri>` 进入时自动在新块打开该 URI；块上提供"复制定位符"，把 URI 发给协作者即可让对方打开同一现场；
- 应用选择器本质是 URI 构造器：选"Codex" + 选目录 = 生成 `codex:///workspace/myproj`。

## 6. 扩展

`SHELLBASE_APPS_EXTRA` 注册新 scheme，两类模板：

```json
[
  { "scheme": "aider",   "type": "terminal", "cmd": "aider", "title": "Aider" },
  { "scheme": "grafana", "type": "url", "template": "https://localhost:3000/{path}", "title": "Grafana" }
]
```

- `terminal` 型：解析规则与 `claude://` 相同（path = cwd，派生 state id，无中生有）；
- `url` 型：纯改写为目标地址后按 §3 的 https 规则处理。
