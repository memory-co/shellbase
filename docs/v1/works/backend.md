# shellbase v1 Python 后端服务设计

> 本文档是 [design.md](design.md) §3.3 的专项展开：FastAPI 后端如何管理平台的**全部运行时状态**——
> 终端会话、页面布局、Agent 会话——以及以文件系统为存储的持久化方案。

## 1. 职责定位：后端是全局状态的唯一权威

前端 Shell 是"薄"的：它不自己记状态，所有需要跨刷新、跨设备存活的东西都在后端。后端掌握三张账：

1. **终端账**：当前存在哪些终端会话、谁创建的、什么时候最后被打开、是否还活着；
2. **布局账**：用户把页面分割成了什么样、每个块里装的什么应用带什么参数；
3. **Agent 账**：哪些终端会话是 Agent 会话（claude / codex …）、运行状态如何。

由此得到核心承诺：**用户任何时候重新进入 shellbase（换浏览器、换设备、容器重启后），都能恢复出和离开时一模一样的页面**——布局从后端读，块里的终端靠 tmux 现场还在。

## 2. 终端会话：注册制 + 302 attach

### 2.1 问题

若前端直接拼 `/tty/?arg=<session>` 装进 iframe，用户（或任何拿到 URL 的请求）可以**无中生有**：随便编一个 session 名，`attach.sh` 的 `tmux new-session -A` 就会创建它。后端对"当前开着哪些终端"一无所知，布局恢复、状态观测、回收都无从谈起。

### 2.2 方案：先注册，再跳转

终端一律先向后端申请，后端登记后用 **302** 把 iframe 带到 ttyd：

```
前端 Shell                    FastAPI                        ttyd
   │ POST /api/terminals         │                             │
   │────────────────────────────▶│ 分配 id (term-3)             │
   │◀─{id, attach_url}───────────│ 写入 terminals/term-3.json   │
   │                             │                             │
   │ iframe.src =                │                             │
   │  /api/terminals/term-3/attach                             │
   │────────────────────────────▶│ 校验注册表存在                │
   │◀─302 /tty/?arg=term-3───────│ 更新 last_attached          │
   │                             │                             │
   │──(iframe 跟随 302)──────────────────────────────────────▶│ attach.sh → tmux
```

- iframe 的 `src` 永远指向 `/api/terminals/{id}/attach`，而不是 `/tty/` 本身；浏览器对 iframe 内的 302 会自动跟随，对前端完全透明；
- 每次 attach 都经过后端，因此后端天然知道**每个终端最近一次被打开的时间**，这是状态观测和回收的依据。

### 2.3 封死"无中生有"

302 只是引导，真正的强制在 pty 创建点：`attach.sh` 创建会话前校验注册表——

```bash
# bin/attach.sh（ttyd -W 调用，$1 = session 名）
STATE=/workspace/.shellbase/state
if [ ! -f "$STATE/terminals/$1.json" ]; then
    echo "unknown session: $1 (create it via the shellbase UI)"; exit 1
fi
exec tmux new-session -A -s "$1" -c /workspace
```

未注册的 session 名即使直接访问 `/tty/?arg=rogue`（已通过鉴权的用户手工构造）也只会得到一行错误、不会产生 pty。注册表文件由 FastAPI 独家写入，`attach.sh` 只读。

### 2.4 终端 API

| 端点 | 功能 |
|------|------|
| `POST /api/terminals` | 创建：分配 `term-<n>`，写注册表，返回 `{id, attach_url}`；body 可带 `{agent: "claude"}` 创建 Agent 终端（见 §5） |
| `GET  /api/terminals/{id}/attach` | 校验存在 → `302 /tty/?arg=<id>`；不存在 → 404 |
| `GET  /api/terminals` | 列表：注册表 ∪ `tmux ls` 的合并视图，含状态（alive / exited） |
| `DELETE /api/terminals/{id}` | `tmux kill-session` + 移除注册表项 |

## 3. 存储：文件系统，不引数据库

### 3.1 目录结构

状态根目录 `SHELLBASE_STATE_DIR`，默认 `/workspace/.shellbase/state`——放在挂载卷上，**容器销毁重建后状态仍在**：

```
/workspace/.shellbase/state/
├── layout.json                 # 整个页面的分割布局（§4）
├── terminals/
│   ├── term-1.json             # {id, kind:"plain", created_at, last_attached}
│   ├── term-2.json
│   └── agent-claude-1.json     # {id, kind:"agent", agent:"claude", created_at, ...}
└── counters.json               # id 自增计数
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
      { "type": "leaf", "app": "terminal", "params": { "id": "term-1" } },
      { "type": "split", "dir": "col", "ratio": 0.5,
        "children": [
          { "type": "leaf", "app": "browser",  "params": { "url": "http://host:5173" } },
          { "type": "leaf", "app": "terminal", "params": { "id": "agent-claude-1" } }
        ] }
    ]
  }
}
```

### 4.2 同步与恢复

- **写**：前端 Shell 在每次布局变更（分割/关闭/换应用/拖比例结束）后，**防抖 ~500ms** 调 `PUT /api/layout` 全量覆盖；`version` 单调递增，后端拒绝旧版本覆盖新版本（last-write-wins，防两个标签页互相打架时旧页面回写）；
- **读**：Shell 启动时 `GET /api/layout` 还原整棵树；
- **对账后恢复**：还原时对每个 `terminal` 叶子核对注册表——会话仍存在（tmux 现场还在）则直接 attach；已消亡（如容器重启且未持久化 tmux）则按原参数**自动重建**同名会话，块的位置与用途不变，只是 shell 现场从头开始；
- localStorage 不再承担布局存储，仅可留作断网时的临时兜底。

| 端点 | 功能 |
|------|------|
| `GET /api/layout` | 读取布局树（404 = 首次使用，前端给默认单块布局） |
| `PUT /api/layout` | 全量写入，`version` 旧于当前则 409 |

## 5. Agent 会话

Agent 会话**就是**一条 `kind: "agent"` 的终端注册项，复用同一套注册/attach/回收机制：

- `POST /api/terminals {agent: "claude"}` → 分配 `agent-claude-<n>`，注册后在该 tmux 会话内启动应用注册表中该 Agent 的命令模板；
- design.md §3.5 的观测与交互接口（`input` / `output` / 状态）挂在同一 id 上：
  `POST /api/terminals/{id}/input`（`tmux send-keys`）、`GET /api/terminals/{id}/output`（`tmux capture-pane`）；
- 前端 Agent 块的 iframe 同样指向 `/api/terminals/{id}/attach`——观察与接管是同一个块。

## 6. 对账与回收（reconciliation）

注册表说的（应然）和 tmux 里实际存在的（实然）可能漂移，后端负责对齐：

- **触发时机**：FastAPI 启动时一次 + 每 60s 一次 + `GET /api/terminals` 时顺带；
- **注册表有、tmux 无**（容器重启、进程被杀）：标记 `status: exited`，**保留注册项**——布局里还引用它，恢复时据此重建；
- **tmux 有、注册表无**（用户在终端里手工 `tmux new`）：不杀、不收编，列表中标记为 `external`，不参与布局恢复；
- **垃圾回收**：`exited` 且不再被 `layout.json` 任何叶子引用的注册项，超过保留期（默认 7 天）后清除。

## 7. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SHELLBASE_STATE_DIR` | `/workspace/.shellbase/state` | 状态存储根目录（置于挂载卷以跨容器存活） |

## 8. 对 design.md 的影响清单

- §3.2 / §3.6：终端与 Agent 块的 iframe 不再直拼 `/tty/?arg=…`，改为 `/api/terminals/{id}/attach`（302）；`attach.sh` 增加注册表校验；
- §3.6：布局持久化从 localStorage 改为后端 `/api/layout`；
- §3.5：Agent 会话 API 合并进终端 API（同一注册表，`kind: agent`）。
