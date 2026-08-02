# shellbase v1 虚拟 URI 定位符设计

> 每个布局块由一个**虚拟 URI** 唯一定位。URI 既是块的身份，也是打开它的全部信息——
> 存进 [backend.md](backend.md) 的布局树即可持久化，再次解析即可**重入**同一现场；
> 分享以 window 为单位，同伴进入同一 window 即共享其全部现场（[collab.md](collab.md)）。

## 1. 动机

没有统一定位符时，"块里装的是什么"要靠 app 类型 + 一堆散装参数描述，持久化、恢复、分享各写一套逻辑。引入 URI 后：

- **一个字符串说清一个块**：`codex:///workspace/myproj` = "在这个目录跑 Codex 的终端"；
- **重入天然成立**：完整 URI（含 `window`/`block` 身份参数，§4）规范化后派生 state id，同一 URI 无论谁、何时、第几次打开，都 attach 到同一份现场（配合 backend.md 的无中生有与 collab.md 的共享语义）；
- **扩展只是加 scheme**：新应用 = 应用注册表里的一条 scheme 定义，布局、恢复、分享逻辑零改动。

## 2. 语法与解析

标准 URI 形态：`scheme://authority/path?query`。前端 Shell 的解析器**只做四类分流**：

```
                       ┌── https(localhost) ─▶ /apps/browser?url=…（本地服务，内层经 /proxy/<port>/ 代理）
                       ├── https(其余 host) ─▶ /apps/browser?url=…（外部站点，内层 iframe 直连）
块的 URI ──▶ 前端四分流 ┼── file://          ─▶ /apps/files?path=…（文件浏览器）
                       └── 其余一切（未知）  ─▶ /api/terminals/attach?uri=…（盲转发，302 → ttyd）
```

关键设计：**前端不维护任何终端 scheme 名单**。`bash://`、`claude://`、`vim://`、注册表别名……在前端眼里都是"未知"，一律原样转发给 terminals API，由后端完成 scheme → 命令的适配与合法性裁决（§3.1，错误码见 api/terminals.md）。好处是新增 CLI、加别名、改注册表都不需要前端发版。

https 类装载的是浏览器应用页（design.md §3.4：内层 iframe，地址栏统一在面板控制条的 URL bar），内层目标由 host 决定：外链直连、localhost 走网关通配代理。

## 3. Scheme 一览

| URI 示例 | 含义 | 解析结果 |
|----------|------|----------|
| `https://www.example.com/docs` | 外部网页 | 浏览器应用打开，内层 iframe 直连该地址（受目标站 `X-Frame-Options` 限制，被拒时提示新窗口打开） |
| `https://localhost:5173/` | 容器/本机上的 web 服务 | 浏览器应用打开，内层经网关通配代理 `/proxy/5173/` 访问——外部无需映射该端口，且同源、无嵌入限制 |
| `file:///workspace/src` | 本地目录 | 文件浏览器应用定位到该目录（文件树） |
| `file:///workspace/src/main.py` | 本地文件 | 文件浏览器应用直接打开该文件（编辑器） |
| `bash:///workspace/proj` | 在该目录启动 bash 终端 | 终端会话，state id 派生自 URI → `302 /tty/?arg=<id>` |
| `claude:///workspace/myproj` | 在该目录启动 Claude Code | Agent 终端：tmux 会话 cwd 为该目录、启动命令 `claude` |
| `codex:///workspace/myproj` | 在该目录启动 Codex | 同上，命令 `codex` |

约定：

- 终端/Agent 类 scheme 的 **path 表示工作目录**（省略则默认 `/workspace`），`bash://` 也不例外——同目录的多个块天然互不相干，落位时各分得一个 `block` 号（§4）；
- `https://localhost` 与 `https://127.0.0.1` 等价，其余 host 一律按外链处理；
- `query` 携带 scheme 相关参数：`?window=<id>&block=<n>` 是终端/Agent 类 scheme 的**身份参数**，唯一指认一个现场（§4）；`?mode=ro` 只读 attach（非身份参数，见 collab.md）。表中终端类示例均为省略身份参数的**构造形态**，落位时由 Shell 补全（§4）。

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

## 4. 重入：URI 自包含会话身份

终端类 URI 有两种形态：

- **构造形态**：`codex:///workspace/myproj`——用户输入、URL bar 产出的样子，只说"哪个命令、哪个目录"，不指认具体现场；
- **完整形态**：`codex:///workspace/myproj?window=main&block=1`——带上两个**身份参数**后唯一指认一个现场。布局持久化与 attach 用的都是完整形态，它只在布局 state 内部流转（分享是 window 级别的，§5）。

| 身份参数 | 含义 |
|----------|------|
| `window` | 会话归属的 window id——同 scheme+path 在不同 window 里是互不相干的现场 |
| `block` | 同一 window 内、同一 scheme+path 的实例序号（从 1 起）——同 window 里并行的多个实例靠它区分 |

Shell 在块**落位**时把构造形态补全为完整形态：`window` = 当前 window，`block` = 同 window 同 scheme+path 的最小空闲序号。这正是把身份编码进 query 的动机：**路径相同的两个块会分得不同的 `block` 号，各自独立现场**——不会出现两个块意外镜像同一个终端内容的情况；反过来，共享/重入一个现场必须使用它的完整 URI（相同 `window`+`block` = 同一现场），是显式动作而非默认巧合。

query 参数因此分两类：

- **身份参数**（参与身份，不同值 = 不同现场）：`window`、`block`；
- **非身份参数**（判定身份前剔除，只影响本次打开方式）：如 `mode=ro`。

规范化规则：scheme 小写、路径去尾斜杠、剔除非身份参数、身份参数按 `window`、`block` 定序。完整形态中身份参数**始终显式**（没有"缺省 = 1"的隐规则）；后端只认完整形态，终端 URI 缺身份参数 → `400 {"error":"incomplete_uri"}`——补全是 Shell 落位的职责。规范化 URI 确定性派生**内部会话名**（tmux 会话名，纯实现细节，前端不感知）：

```
bash://?window=main&block=1                      →  main--bash-workspace-1（path 缺省 = /workspace）
claude:///workspace/myproj?window=main&block=1   →  main--claude-workspace-myproj-1（超长/特殊字符取 slug + 短哈希）
codex:///workspace/myproj?window=main&block=2    →  main--codex-workspace-myproj-2
codex:///workspace/myproj?window=review&block=1  →  review--codex-workspace-myproj-1（与 main 中的互不相干）
```

- 后端 `GET /api/terminals/attach?uri=<encoded>`：规范化 → 查该 URI 的 state，**无则登记**（state 记录原始 URI、window、cwd、启动命令）→ `302 /tty/?arg=<内部会话名>`；
- 于是"重入"就是把同一条完整 URI 再解析一遍：现场还在则原样接上；容器重启后现场消亡，也能凭 state 重建出同目录、同命令的会话；
- 同一条完整 URI 被多个客户端同时打开 = 共享同一现场（collab.md）；
- **归属不变量**：块所在的 window 必须等于其 URI 的 `window` 参数（Shell 落位保证、服务端布局校验兜底，见 api/windows.md）——因此关闭/删除只涉及本 window 的会话，不存在跨 window 引用。

### 4.1 同路径多实例：`block` 默认隔离

确定性映射的经典问题是"**同一个目录要起两个 Codex 怎么办**"。身份进入 query 后，这个问题被反转了——**并行是默认，复用才需要显式**：

- **新开（默认）**：每个新块落位时自动分得最小空闲 `block` 号——同目录的第二个 Codex 块就是 `codex:///workspace/myproj?window=main&block=2`，独立 state、独立 tmux 会话，与 1 号互不相干。URL bar 的一切产出（宫格、recents、直接敲 URI）都走这条路（urlbar.md §2）；
- **重入（显式，只有一条路径）**：**布局恢复**——进入 window（`/#w/<id>`），布局里的终端叶子凭存着的完整 URI attach 回各自现场。分享同样以 window 为单位（§5）：同伴进的是同一 window、恢复的是同一份布局，自然 attach 同样的现场。不存在其他路径：归属不变量 + 关闭即销毁保证存活现场必然正被本 window 的某个块展示，在同 window 再装载同一条完整 URI 只会得到两个镜像块——正是本设计要规避的；块内 URL bar 手填的身份参数也一律被剥离重写（urlbar.md §2.2），没有接受外来完整 URI 的入口；
- `window`/`block` 随 URI 存进布局——`?window=main&block=2` 的块刷新后回到的还是这个现场。

身份参数**只存在于终端类 scheme**（`bash://`、`claude://`、`codex://` 及扩展的 `terminal` 型）——因为它们背后是 tmux 会话这份持久现场。`file://`、`https://` 类是无状态引用：不产生终端 state，同一 URI 开多个块就是各自独立加载，重入即重新加载，天然不冲突，也就没有 `window`/`block` 的概念。

## 5. 与布局、分享的关系

- 布局（`windows/<id>.json`）的每个面板记录只带坐标和 `uri`——终端类面板存**完整形态** URI，它是块的全部持久化内容（backend.md §4）；
- **分享是 window 级别的，不支持分享单个块**：可分享的 URL 只有 window 链接 `/#w/<id>`——发给同伴，对方进入同一 window，布局同步让双方看到同样的块、attach 同样的现场（collab.md）。完整 URI 只在布局 state 内部流转，**没有任何入口接受外部传入的完整 URI**：块内 URL bar 对手填/粘贴的身份参数一律剥离重写（urlbar.md §2.2）；
- URL bar（urlbar.md）本质是 URI 构造器：选"Codex" + 选目录 = 产出构造形态 `codex:///workspace/myproj`，落位时补全为完整形态。

## 6. 注册表的角色（可选增强，不是准入门槛）

由 §3.1，CLI 类应用**不需要注册**——任意 `<cmd>://` 即用。`SHELLBASE_APPS_EXTRA` 注册表只服务三件事：

```json
[
  { "scheme": "codex",   "type": "terminal", "title": "Codex", "icon": "..." },
  { "scheme": "lg",      "type": "terminal", "cmd": "lazygit", "title": "LazyGit" },
  { "scheme": "grafana", "type": "url", "template": "https://localhost:3000/{path}", "title": "Grafana" }
]
```

1. **冷启动兜底与元数据**：应用宫格由最近使用的 scheme 驱动（urlbar.md §2），注册与否不影响上宫格——用过 `vim://` 它就会出现；注册条目只在毫无使用记录时充当宫格的初始内容，平时提供标题/图标等展示元数据；
2. **别名与固定参数**：`cmd` 字段允许 scheme 名 ≠ 实际命令（如 `lg://` → `lazygit`），或携带固定参数；
3. **`url` 型应用**：改写为目标地址后按 §3 的 https 规则处理——这类没有约定可循，必须注册。
