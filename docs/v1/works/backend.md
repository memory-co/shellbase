# shellbase v1 Python 后端服务设计

> 本文档是 [design.md](design.md) §3.3 的专项展开：FastAPI 后端如何管理平台的**全部运行时状态**——
> 终端会话、页面布局、Agent 会话——以及以文件系统为存储的持久化方案。

## 1. 职责定位：后端是全局状态的唯一权威

前端 Shell 是"薄"的：它不自己记状态，所有需要跨刷新、跨设备存活的东西都在后端。后端掌握三张账：

1. **终端账**：当前存在哪些终端会话、谁创建的、什么时候最后被打开、是否还活着；
2. **布局账**：用户把页面分割成了什么样、每个块里装的什么应用带什么参数；
3. **Agent 账**：哪些终端会话是 Agent 会话（claude / codex …）、运行状态如何。

由此得到核心承诺：**用户任何时候重新进入 shellbase（换浏览器、换设备、容器重启后），都能恢复出和离开时一模一样的页面**——布局从后端读，块里的终端靠 tmux 现场还在。

## 2. 终端会话：借鉴 ttyd arg 的无中生有 + 302 attach

### 2.1 问题

若前端直接拼 `/tty/?arg=<session>` 装进 iframe，session 会在 ttyd/tmux 层被凭空创建，后端对"当前开着哪些终端"一无所知，布局恢复、状态观测、回收都无从谈起。

### 2.2 方案：attach 入口收口到 Python，语义照搬 ttyd arg

state 的设计**借鉴 ttyd `arg` 的无中生有语义**：attach 入口收到一个没见过的 `(window, URI)` 组合，就**当场登记一条 state**（等价于 `tmux new-session -A` 的"有则 attach、无则创建"），然后 302 到 ttyd。**每个面板就是一条 state**——面板打开的动作本身完成登记，前端无需先走一次显式创建。

**会话身份 = (window, URI)**：URI 在其所属 window 内唯一（重开即重入，`?tab` 区分并行）；同一 URI 在不同 window 是互不相干的两个现场。API 面上没有派生 id——前端只带 URI，内部会话名（tmux 会话、302 目标里的 `arg`）由后端从 `(window, URI)` 确定性派生，纯实现细节。

```
前端 Shell                       FastAPI                              ttyd
   │ iframe.src =                   │                                   │
   │  /api/windows/main/terminals/attach?uri=bash://                    │
   │───────────────────────────────▶│ (main, bash://) 的 state 有？      │
   │                                │  ├─ 无 → 写 terminals/main--bash-workspace.json（无中生有）
   │                                │  └─ 有 → 更新 last_attached        │
   │◀─302 /tty/?arg=main--bash-workspace                                │
   │                                │                                   │
   │──(iframe 跟随 302)────────────────────────────────────────────────▶│ attach.sh → tmux
```

- iframe 的 `src` 永远指向 attach 入口，而不是 `/tty/` 本身；浏览器对 iframe 内的 302 会自动跟随，对前端完全透明；
- 无中生有发生在 Python 这一层，因此后端能看到**每个 window 开了哪些面板、每个面板何时创建、最近一次被打开是什么时候**。

### 2.3 创建收口在 Python

`attach.sh` 在 pty 创建点校验 state 文件，保证任何会话的诞生都必然经过了 Python：

```bash
# bin/attach.sh（ttyd -W 调用，$1 = session 名）
STATE=/workspace/.shellbase/state
if [ ! -f "$STATE/terminals/$1.json" ]; then
    echo "unknown session: $1 (open it via the shellbase UI)"; exit 1
fi
exec tmux new-session -A -s "$1" -c /workspace
```

绕过 attach 端点直接访问 `/tty/?arg=rogue` 不会产生 pty；经 attach 端点进来则先落 state 再放行——两条路都保证 state 与实际会话一一对应。state 文件由 FastAPI 独家写入，`attach.sh` 只读。

带自定义 cwd 或启动命令的会话（非默认目录的 `bash://`、以及 `claude://` 等各类 CLI scheme）由 FastAPI 在 302 之前**预创建** tmux 会话（`cd <path> && <cmd>`），`attach.sh` 的 `new-session -A` 对它们只会命中已存在的会话；上面片段中的默认 `-c /workspace` 仅兜底最朴素的 `bash://`。

### 2.4 终端 API

| 端点 | 功能 |
|------|------|
| `GET  /api/windows/{wid}/terminals/attach?uri=` | **唯一 attach 入口**：规范化 URI，以 `(wid, uri)` 查 state → 有则更新 `last_attached`、无则登记（无中生有，state 记录 window/原始 URI/cwd/命令）→ `302 /tty/?arg=<内部会话名>`。前端不感知重入与内部命名，全由后端控制 |
| `GET  /api/terminals?window=` | 全局观测：state ∪ `tmux ls` 的合并视图，含状态（alive / exited），可按 window 过滤 |
| `DELETE /api/windows/{wid}/terminals?uri=` | `tmux kill-session` + 移除 state（身份含 window，无跨 window 引用问题） |

## 3. 存储：文件系统，不引数据库

### 3.1 目录结构

状态根目录 `SHELLBASE_STATE_DIR`，默认 `/workspace/.shellbase/state`——放在挂载卷上，**容器销毁重建后状态仍在**：

```
/workspace/.shellbase/state/
├── env.json                    # 全局环境变量表（见 env.md，0600）
├── windows/                    # 每个 window（页面）一个状态文件（§4）
│   ├── main.json               # 默认 window
│   └── review.json
├── terminals/                  # 文件名 = 内部会话名（由 window + URI 确定性派生）
│   ├── main--bash-workspace.json
│   │                           # {window:"main", uri:"bash://", kind:"plain", created_at, last_attached}
│   ├── main--codex-workspace-myproj.json
│   └── review--claude-workspace-myproj.json
│                               # {window:"review", uri:"claude:///workspace/myproj", kind:"agent",
│                               #  cwd:"/workspace/myproj", cmd:"claude", ...}
```

### 3.2 读写纪律

- **原子写**：一律写临时文件后 `os.replace()`，任何时刻磁盘上都是完整 JSON，容器被 kill 也不会留半个文件；
- **单写者**：uvicorn 单进程是唯一写者（`attach.sh` 只读），进程内用 asyncio 锁串行化同一文件的写入，无跨进程并发问题；
- **无缓存直读**：状态量级是个位数到几十个小 JSON，每次请求直接读盘，不做内存缓存——省去一致性问题，文件系统页缓存足够快。

为什么不用 SQLite：状态就是"几十个小对象 + 一棵布局树"，文件系统天然提供了按 id 寻址、原子替换和人肉可调试性（`cat` 即可查看），引数据库只增加镜像与心智负担。

## 4. window：每张页面的状态都存在后端

### 4.1 数据模型：window 是可数的资源

window 不是单例——**每张"页面"就是一个 window**，后端存着它的完整状态（布局树 + 每块的 URI），有自己的 id（默认 window `main`；用户可另建 `review`、`ops` 等），存为 `windows/<id>.json`。进入 shellbase 时 URL 决定打开哪个 window（`/#w/<id>`，缺省 `main`）；window id 的语义与终端 URI 一致——**无中生有**：访问一个不存在的 id 即创建一个空 window（单个启动页块）。

每个 window 文件保存一棵分割树（与 design.md §3.6 的递归二叉分割模型一一对应）：

```json
{
  "id": "main",
  "name": "主工作台",
  "version": 3,
  "updated_at": "2026-07-27T12:00:00Z",
  "root": {
    "type": "split", "dir": "row", "ratio": 0.6,
    "children": [
      { "type": "leaf", "uri": "bash://" },
      { "type": "split", "dir": "col", "ratio": 0.5,
        "children": [
          { "type": "leaf", "uri": "https://localhost:5173/" },
          { "type": "leaf", "uri": "claude:///workspace/myproj" }
        ] }
    ]
  }
}
```

### 4.2 同步与恢复

- **写**：前端 Shell 在每次布局变更（分割/关闭/换应用/拖比例结束）后，**防抖 ~500ms** 调 `PUT /api/windows/{id}` 全量覆盖；`version` 单调递增，后端拒绝旧版本覆盖新版本（last-write-wins，防两个标签页互相打架时旧页面回写）；
- **读**：Shell 启动时按 URL 中的 window id `GET /api/windows/{id}` 还原整棵树；
- **恢复零特判**：还原时每个终端类叶子照常把 iframe 指向 `/api/windows/{wid}/terminals/attach?uri=<叶子的 uri>` 即可——tmux 现场还在则原样接上；会话已消亡（如容器重启）则由无中生有语义自动重建同名会话，块的位置与用途不变，只是 shell 现场从头开始；
- **关闭即销毁**：用户在网页上关闭一个块，不只是从布局树里摘掉——终端类叶子会同步 `DELETE /api/windows/{wid}/terminals?uri=`（kill tmux 会话 + 删 state 文件），后端资源真正释放；无状态叶子（file/https）只改布局。打开与关闭因此对称：打开 = 无中生有登记，关闭 = 彻底注销。会话身份含 window，删除无需顾虑其他 window；
- localStorage 不再承担布局存储，仅可留作断网时的临时兜底。

| 端点 | 功能 |
|------|------|
| `GET  /api/windows` | 列出全部 window（id、name、updated_at、块数）——回答"当前存在多少个 window" |
| `GET  /api/windows/{id}` | 读取 window；未知 id 无中生有一个空 window |
| `PUT  /api/windows/{id}` | 全量写入，`version` 旧于当前则 409 |
| `DELETE /api/windows/{id}` | 删除 window：先按"关闭即销毁"处理其全部终端块（不被其他 window 引用的会话才杀），再删 window 文件 |
| `WS   /api/windows/{id}/watch` | 该 window 的版本广播（协作，见 collab.md） |

## 5. Agent 会话

Agent 会话**就是**一条 `kind: "agent"` 的终端注册项，复用同一套注册/attach/回收机制：

- Agent 块的 URI（`claude:///workspace/proj`、`codex:///…`，见 uri.md）走统一 attach 入口：派生 id、登记 state（记录 cwd 与命令模板）、以该 cwd 创建 tmux 会话并启动应用注册表中该 Agent 的命令；
- 平台不提供 Agent 的输入/输出接口——观察与交互就是 attach 进块里直接看、直接敲（终端 I/O 由用户自行掌控，见 api/terminals.md）；程序化需求用 tmux 自身的 `send-keys`/`capture-pane` 在终端里解决；
- 前端 Agent 块的 iframe 同样指向统一 attach 入口——观察与接管是同一个块。

## 6. 多人协作

state 是共享单元，"打开"只是 attach、不是独占——多个客户端可同时打开同一个终端、同一个页面。专项设计见 [collab.md](collab.md)。

## 7. 对账与回收（reconciliation）

注册表说的（应然）和 tmux 里实际存在的（实然）可能漂移，后端负责对齐：

- **触发时机**：FastAPI 启动时一次 + 每 60s 一次 + `GET /api/terminals` 时顺带；
- **注册表有、tmux 无**（容器重启、进程被杀）：标记 `status: exited`，**保留注册项**——布局里还引用它，恢复时据此重建；
- **tmux 有、注册表无**（用户在终端里手工 `tmux new`）：不杀、不收编，列表中标记为 `external`，不参与布局恢复；
- **垃圾回收只是兜底**：正常路径下"关闭块"已同步 DELETE（§4.2 关闭即销毁），不会留孤儿；GC 处理的是异常漂移——客户端崩溃没来得及 DELETE、布局被手工改坏等导致的"`exited` 且不被**任何 window** 的叶子引用"的注册项，超过保留期（默认 7 天）后清除。

## 8. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SHELLBASE_STATE_DIR` | `/workspace/.shellbase/state` | 状态存储根目录（置于挂载卷以跨容器存活） |

## 9. 对 design.md 的影响清单

- §3.2 / §3.6：终端与 Agent 块的 iframe 不再直拼 `/tty/?arg=…`，改为 `/api/windows/{wid}/terminals/attach?uri=…`（302）；`attach.sh` 增加注册表校验；
- §3.6：布局持久化从 localStorage 改为后端 `/api/windows/{id}`（多页面）；
- §3.5：Agent 会话 API 合并进终端 API（同一注册表，`kind: agent`）。
