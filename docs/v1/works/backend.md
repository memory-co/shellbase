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

state 的设计**借鉴 ttyd `arg` 的无中生有语义**：attach 入口收到一个没见过的 URI，就规范化派生 id（[uri.md](uri.md) §4）并**当场登记一条 state**（等价于 `tmux new-session -A` 的"有则 attach、无则创建"），然后 302 到 ttyd。**每个面板就是一条 state**——面板打开的动作本身完成登记，前端无需先走一次显式创建。

```
前端 Shell                       FastAPI                            ttyd
   │ iframe.src =                   │                                 │
   │  /api/terminals/attach?uri=bash://                               │
   │───────────────────────────────▶│ 派生 id=bash-workspace，state 有？│
   │                                │  ├─ 无 → 写 terminals/bash-workspace.json（无中生有）
   │                                │  └─ 有 → 更新 last_attached      │
   │◀─302 /tty/?arg=bash-workspace──│                                 │
   │                                │                                 │
   │──(iframe 跟随 302)──────────────────────────────────────────────▶│ attach.sh → tmux
```

- iframe 的 `src` 永远指向 attach 入口（`/api/terminals/attach?uri=…`），而不是 `/tty/` 本身；浏览器对 iframe 内的 302 会自动跟随，对前端完全透明；
- 无中生有发生在 Python 这一层，因此后端能看到**开了多少个面板、每个面板何时创建、最近一次被打开是什么时候**。

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
| `GET  /api/terminals/attach?uri=` | 主入口：URI 规范化 → 确定性派生 id（见 [uri.md](uri.md)）→ 有则更新 `last_attached`、无则登记（无中生有，state 记录原始 URI/cwd/命令）→ `302 /tty/?arg=<id>` |
| `GET  /api/terminals/{id}/attach` | 按已知 id attach（等价于用 state 中记录的 URI 走上一行） |
| `POST /api/terminals` | 显式创建（可选路径）：分配匿名会话（等价 `bash://?tab=<最小空闲>`），返回 `{id, uri, attach_url}` |
| `GET  /api/terminals` | 列表：state ∪ `tmux ls` 的合并视图，含状态（alive / exited） |
| `DELETE /api/terminals/{id}` | `tmux kill-session` + 移除 state |

## 3. 存储：文件系统，不引数据库

### 3.1 目录结构

状态根目录 `SHELLBASE_STATE_DIR`，默认 `/workspace/.shellbase/state`——放在挂载卷上，**容器销毁重建后状态仍在**：

```
/workspace/.shellbase/state/
├── layout.json                 # 整个页面的分割布局（§4）
├── terminals/
│   ├── bash-workspace.json     # {id, uri:"bash://", kind:"plain", created_at, last_attached}
│   ├── bash-workspace-myproj.json
│   └── claude-workspace-myproj.json
│                               # {id, uri:"claude:///workspace/myproj", kind:"agent",
│                               #  cwd:"/workspace/myproj", cmd:"claude", ...}
└── counters.json               # 匿名会话的自增计数
```

### 3.2 读写纪律

- **原子写**：一律写临时文件后 `os.replace()`，任何时刻磁盘上都是完整 JSON，容器被 kill 也不会留半个文件；
- **单写者**：uvicorn 单进程是唯一写者（`attach.sh` 只读），进程内用 asyncio 锁串行化同一文件的写入，无跨进程并发问题；
- **无缓存直读**：状态量级是个位数到几十个小 JSON，每次请求直接读盘，不做内存缓存——省去一致性问题，文件系统页缓存足够快。

为什么不用 SQLite：状态就是"几十个小对象 + 一棵布局树"，文件系统天然提供了按 id 寻址、原子替换和人肉可调试性（`cat` 即可查看），引数据库只增加镜像与心智负担。

## 4. 布局持久化：恢复一模一样的页面

### 4.1 数据模型

`layout.json` 保存 Shell 的整棵分割树（与 design.md §3.6 的递归二叉分割模型一一对应）：

```json
{
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

- **写**：前端 Shell 在每次布局变更（分割/关闭/换应用/拖比例结束）后，**防抖 ~500ms** 调 `PUT /api/layout` 全量覆盖；`version` 单调递增，后端拒绝旧版本覆盖新版本（last-write-wins，防两个标签页互相打架时旧页面回写）；
- **读**：Shell 启动时 `GET /api/layout` 还原整棵树；
- **恢复零特判**：还原时每个终端类叶子照常把 iframe 指向 `/api/terminals/attach?uri=<叶子的 uri>` 即可——tmux 现场还在则原样接上；会话已消亡（如容器重启）则由无中生有语义自动重建同名会话，块的位置与用途不变，只是 shell 现场从头开始；
- localStorage 不再承担布局存储，仅可留作断网时的临时兜底。

| 端点 | 功能 |
|------|------|
| `GET /api/layout` | 读取布局树（404 = 首次使用，前端给默认单块布局） |
| `PUT /api/layout` | 全量写入，`version` 旧于当前则 409 |

## 5. Agent 会话

Agent 会话**就是**一条 `kind: "agent"` 的终端注册项，复用同一套注册/attach/回收机制：

- Agent 块的 URI（`claude:///workspace/proj`、`codex:///…`，见 uri.md）走统一 attach 入口：派生 id、登记 state（记录 cwd 与命令模板）、以该 cwd 创建 tmux 会话并启动应用注册表中该 Agent 的命令；
- design.md §3.5 的观测与交互接口（`input` / `output` / 状态）挂在同一 id 上：
  `POST /api/terminals/{id}/input`（`tmux send-keys`）、`GET /api/terminals/{id}/output`（`tmux capture-pane`）；
- 前端 Agent 块的 iframe 同样指向统一 attach 入口——观察与接管是同一个块。

## 6. 多人协作

state 是共享单元，"打开"只是 attach、不是独占——多个客户端可同时打开同一个终端、同一个页面。专项设计见 [collab.md](collab.md)。

## 7. 对账与回收（reconciliation）

注册表说的（应然）和 tmux 里实际存在的（实然）可能漂移，后端负责对齐：

- **触发时机**：FastAPI 启动时一次 + 每 60s 一次 + `GET /api/terminals` 时顺带；
- **注册表有、tmux 无**（容器重启、进程被杀）：标记 `status: exited`，**保留注册项**——布局里还引用它，恢复时据此重建；
- **tmux 有、注册表无**（用户在终端里手工 `tmux new`）：不杀、不收编，列表中标记为 `external`，不参与布局恢复；
- **垃圾回收**：`exited` 且不再被 `layout.json` 任何叶子引用的注册项，超过保留期（默认 7 天）后清除。

## 8. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SHELLBASE_STATE_DIR` | `/workspace/.shellbase/state` | 状态存储根目录（置于挂载卷以跨容器存活） |

## 9. 对 design.md 的影响清单

- §3.2 / §3.6：终端与 Agent 块的 iframe 不再直拼 `/tty/?arg=…`，改为 `/api/terminals/attach?uri=…`（302）；`attach.sh` 增加注册表校验；
- §3.6：布局持久化从 localStorage 改为后端 `/api/layout`；
- §3.5：Agent 会话 API 合并进终端 API（同一注册表，`kind: agent`）。
