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

标准 URI 形态：`scheme://authority/path?query`。前端 Shell 的解析器**只做四类分流**：

```
                       ┌── https(localhost) ─▶ /apps/browser?url=…（本地服务，内层经 /proxy/<port>/ 代理）
                       ├── https(其余 host) ─▶ /apps/browser?url=…（外部站点，内层 iframe 直连）
块的 URI ──▶ 前端四分流 ┼── file://          ─▶ /apps/files?path=…（文件浏览器）
                       └── 其余一切（未知）  ─▶ /api/windows/{wid}/terminals/attach?uri=…（盲转发，302 → ttyd）
```

关键设计：**前端不维护任何终端 scheme 名单**。`bash://`、`claude://`、`vim://`、注册表别名……在前端眼里都是"未知"，一律原样转发给 terminals API，由后端完成 scheme → 命令的适配与合法性裁决（§3.1，错误码见 api/terminals.md）。好处是新增 CLI、加别名、改注册表都不需要前端发版。

https 类装载的是浏览器应用页（design.md §3.4：地址栏 + 内层 iframe），内层目标由 host 决定：外链直连、localhost 走 nginx 通配代理。

## 3. Scheme 一览

| URI 示例 | 含义 | 解析结果 |
|----------|------|----------|
| `https://www.example.com/docs` | 外部网页 | 浏览器应用打开，内层 iframe 直连该地址（受目标站 `X-Frame-Options` 限制，被拒时提示新窗口打开） |
| `https://localhost:5173/` | 容器/本机上的 web 服务 | 浏览器应用打开，内层经 nginx 通配代理 `/proxy/5173/` 访问——外部无需映射该端口，且同源、无嵌入限制 |
| `file:///workspace/src` | 本地目录 | 文件浏览器应用定位到该目录（文件树） |
| `file:///workspace/src/main.py` | 本地文件 | 文件浏览器应用直接打开该文件（编辑器） |
| `bash:///workspace/proj` | 在该目录启动 bash 终端 | 终端会话，state id 派生自 URI → `302 /tty/?arg=<id>` |
| `claude:///workspace/myproj` | 在该目录启动 Claude Code | Agent 终端：tmux 会话 cwd 为该目录、启动命令 `claude` |
| `codex:///workspace/myproj` | 在该目录启动 Codex | 同上，命令 `codex` |

约定：

- 终端/Agent 类 scheme 的 **path 表示工作目录**（省略则默认 `/workspace`），`bash://` 也不例外——同目录开多个互不相干的终端用 `?tab`（§4.1）；
- `https://localhost` 与 `https://127.0.0.1` 等价，其余 host 一律按外链处理；
- `query` 携带 scheme 相关参数：`?tab=<n>` 区分同路径的多个并行实例（身份参数，仅终端/Agent 类 scheme 有意义，见 §4.1）；`?mode=ro` 只读 attach（非身份参数，见 collab.md）。

### 3.1 scheme 名即命令名：CLI 无需注册

终端类 scheme 的解析是**约定优于注册**：`<scheme>:///<path>` 直接解释为"`cd <path>` 后启动命令 `<scheme>`"。`claude://`、`codex://` 并没有任何特殊登记——它们只是恰好叫这个名字的 CLI；PATH 里有的命令都开箱即用，`vim`、`htop`、`lazygit` 同理：

```
codex:///workspace/myproj      →  cd /workspace/myproj && codex
claude:///workspace/myproj     →  cd /workspace/myproj && claude
vim:///workspace/notes.md      →  cd /workspace && vim notes.md    # path 是文件：cwd 取父目录，文件名作参数
htop://                        →  cd /workspace && htop
```

- **path 是目录**：cwd = 该目录，命令无参启动；**path 是文件**：cwd = 父目录，文件名作为第一个参数——编辑器类（vim、nano）因此自然可用；
- **合法性校验**：attach 时后端 `shutil.which(<scheme>)` 确认命令存在于 PATH，不存在 → `400 {"error":"cmd_not_found"}`；
- **这不是新增权限**：能开 `bash://` 的人本来就能运行任意命令，scheme 只是把"到哪个目录、跑哪个命令"编码进了定位符，能力边界与 design.md §5"能力自觉"一致；
- `bash://` 与其他命令**完全同构**：`bash:///workspace/proj` = `cd /workspace/proj && bash`，没有任何特例。

## 4. 重入：会话身份 = (window, URI)

终端类 URI 的唯一性作用域是它**所属的 window**：同一 window 内，同一规范化 URI 就是同一现场（重开即重入）；同一 URI 出现在不同 window 里，是互不相干的两个现场。query 参数分两类：

- **身份参数**（参与身份，不同值 = 不同现场）：目前只有 `tab`；
- **非身份参数**（判定身份前剔除，只影响本次打开方式）：如 `mode=ro`。

规范化规则：scheme 小写、路径去尾斜杠、剔除非身份参数、`tab=1` 视为缺省并省略。后端由 `(window, 规范化 URI)` 确定性派生**内部会话名**（tmux 会话名，纯实现细节，前端不感知）：

```
(main,   bash://)                          →  main--bash-workspace（path 缺省 = /workspace）
(main,   claude:///workspace/myproj)       →  main--claude-workspace-myproj（超长/特殊字符取 slug + 短哈希）
(main,   codex:///workspace/myproj?tab=2)  →  main--codex-workspace-myproj-2
(review, codex:///workspace/myproj)        →  review--codex-workspace-myproj（与 main 中的互不相干）
```

- 后端 `GET /api/windows/{wid}/terminals/attach?uri=<encoded>`：规范化 → 查 `(wid, uri)` 的 state，**无则登记**（state 记录 window、原始 URI、cwd、启动命令）→ `302 /tty/?arg=<内部会话名>`；
- 于是"重入"就是在同一 window 里把同一个 URI 再解析一遍：现场还在则原样接上；容器重启后现场消亡，也能凭 state 重建出同目录、同命令的会话；
- 同一 window 的同一 URI 被多个客户端同时打开 = 共享同一现场（collab.md）。

### 4.1 同路径多实例：`tab` 参数

确定性映射带来一个必须回答的问题：**同一个目录要起两个 Codex 怎么办？**——`codex:///workspace/myproj` 打开第二次只会 attach 回第一个 tmux 会话（这正是重入语义，默认行为是对的：复用而不是起重）。

要真正并行第二个实例，用 `tab` 显式区分身份：

- 第一个：`codex:///workspace/myproj`（即 `tab=1`，缺省不写）；
- 第二个：`codex:///workspace/myproj?tab=2` → 独立的 state、独立的 tmux 会话，与第一个互不相干；
- 前端应用选择器负责体验：构造 URI 时发现同路径已有存活实例，提示"接入现有会话 / 新开一个"，选后者则自动取最小空闲 `tab` 值；
- `tab` 是身份的一部分，会随 URI 存进布局、参与分享与重入——`?tab=2` 的块刷新后回到的还是 2 号现场。

复用问题**只存在于终端类 scheme**（`bash://`、`claude://`、`codex://` 及扩展的 `terminal` 型）——因为它们背后是 tmux 会话这份持久现场。`file://`、`https://` 类是无状态引用：不产生终端 state，同一 URI 开多个块就是各自独立加载，重入即重新加载，天然不冲突，也就没有 `tab` 的概念。

## 5. 与布局、分享的关系

- 布局树（`windows/<id>.json`）的叶子只存 `{"type": "leaf", "uri": "..."}`——URI 是块的全部持久化内容（backend.md §4）；
- Shell 支持 deep link：`/#w/<wid>?open=<encoded-uri>` 进入指定 window 并在新块打开该 URI；块上提供"复制定位符"（window + URI），发给协作者即可让对方进入同一 window、打开同一现场——身份含 window，只分享 URI 而进了别的 window，得到的是独立现场；
- 应用选择器本质是 URI 构造器：选"Codex" + 选目录 = 生成 `codex:///workspace/myproj`。

## 6. 注册表的角色（可选增强，不是准入门槛）

由 §3.1，CLI 类应用**不需要注册**——任意 `<cmd>://` 即用。`SHELLBASE_APPS_EXTRA` 注册表只服务三件事：

```json
[
  { "scheme": "codex",   "type": "terminal", "title": "Codex", "icon": "..." },
  { "scheme": "lg",      "type": "terminal", "cmd": "lazygit", "title": "LazyGit" },
  { "scheme": "grafana", "type": "url", "template": "https://localhost:3000/{path}", "title": "Grafana" }
]
```

1. **启动页展示**：注册的 `terminal` 型条目出现在启动页宫格（标题/图标/常用位）；未注册的 CLI 不上宫格，但 URI 直达栏随时可用；
2. **别名与固定参数**：`cmd` 字段允许 scheme 名 ≠ 实际命令（如 `lg://` → `lazygit`），或携带固定参数；
3. **`url` 型应用**：改写为目标地址后按 §3 的 https 规则处理——这类没有约定可循，必须注册。
