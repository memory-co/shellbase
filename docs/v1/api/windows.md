# Windows API

设计背景：[works/backend.md](../works/backend.md) §4（服务端 window 状态持久化）、[works/collab.md](../works/collab.md) §3（多客户端实时同步）。

**window 是可数的资源**：每张"页面"就是一个 window，后端存着它的完整状态（布局树 + 每块的 URI），id 即身份（默认 window `main`）。前端 URL `/#w/<id>` 决定打开哪个 window，缺省 `main`。id 语义与终端 URI 一致——无中生有：访问未知 id 即得到一个空 window。

window 对象：**24×16 网格上的矩形剖分**，每个面板一条扁平记录，只带坐标和块的 URI（uri.md §5）：

```json
{
  "id": "main",
  "name": "主工作台",
  "version": 3,
  "updated_at": "2026-07-28T09:00:00Z",
  "root": {
    "cols": 24,
    "rows": 16,
    "panels": [
      { "id": "p1", "uri": "file:///workspace",           "x": 0,  "y": 0, "w": 5,  "h": 16 },
      { "id": "p2", "uri": "bash://",                     "x": 5,  "y": 0, "w": 19, "h": 8  },
      { "id": "p3", "uri": "claude:///workspace/myproj",  "x": 5,  "y": 8, "w": 19, "h": 8  }
    ]
  }
}
```

- `cols`/`rows` 固定 24×16（网格是逻辑单位，实际像素由容器宽高等分）；
- `x`/`y` 是左上角格坐标（0 基），`w`/`h` 是跨格数；
- `uri: null` 表示空白面板（渲染启动页）；
- `id` 是面板的稳定标识，仅前端用于 diff（uri 未变则 iframe 原地保留，不闪断）；
- `name` 是 window 展示名，可改，不参与身份；window id 走 slug 校验（`[a-z0-9-]{1,64}`）。

**布局不变量**（服务端校验，见 PUT）：所有面板在界内、两两不重叠、面积之和恰好铺满
`cols × rows`。由于面板只能由"分割已有面板"产生、关闭时空间被邻居确定性吸收，
任何合法操作都保持这个不变量。

## GET /api/windows

列出全部 window——"当前存在多少个 window"的答案：

```json
{
  "windows": [
    { "id": "main",   "name": "主工作台", "updated_at": "2026-07-28T09:00:00Z", "blocks": 4 },
    { "id": "review", "name": "review",  "updated_at": "2026-07-27T18:00:00Z", "blocks": 2 }
  ]
}
```

首次使用时至少含自动创建的 `main`。

## GET /api/windows/{id}

- 已存在：`200` 返回布局对象；
- 未知 id：**无中生有**——落盘一个空 window（单个 `uri: null` 启动页块，`version: 1`，`name` = id）并返回之。进入 `/#w/xxx` 即创建 window，与终端 URI 的 attach 语义对称；
- id 不合法（slug 校验不过）：`400 {"error":"bad_window_id"}`。

## PUT /api/windows/{id}

全量覆盖写。请求体即布局对象，`version` 必须为**当前版本 + 1**：

- 成功：`204`，落盘（原子写）并向该页面的 `watch` 广播；
- `version` 不匹配（别的客户端先写了）：`409 {"error":"version_conflict", "current_version": 5}`——调用方应 `GET` 最新树、在其上重放本地改动后重试；
- 布局不合法：`400 {"error":"bad_layout"}`——三条纯几何规则，`message` 指明违反了哪条：
  1. **界内**：每个面板满足 `0 ≤ x`、`0 ≤ y`、`x+w ≤ cols`、`y+h ≤ rows`，且 `w ≥ 1`、`h ≥ 1`；
  2. **不重叠**：任意两个面板的矩形无交集；
  3. **铺满**：`Σ(w×h) = cols × rows`（配合前两条即等价于恰好铺满）。
- 面板数上限 64，超出 `400 {"error":"too_many_panels"}`。

前端节流：布局变更（分割/关闭/换应用/拖比例结束）后防抖 ~500ms 再 PUT，拖动过程中不写。

## DELETE /api/windows/{id}

删除 window。执行顺序：

1. 对该 window 的全部终端会话按"关闭即销毁"处理（`kill-session` + 删 state）——会话身份含 window，同一 URI 在别的 window 是独立现场，**无跨 window 引用问题**，删就是删；
2. 删除 window 文件，向该 window 的 `watch` 广播 `{"type":"window_deleted"}`（正在此 window 的客户端跳回 `main`）。

`main` 不可删除（`400 {"error":"cannot_delete_main"}`）；不存在 → `404`。

## WS /api/windows/{id}/watch

单个 window 的变更广播通道，协作的实时性来源。连接后：

```json
// 服务端 → 客户端，每次该 window PUT 成功后推送
{ "type": "window_updated", "version": 6 }
// window 被删除时
{ "type": "window_deleted" }
```

- 客户端收到版本号大于本地的通知即 `GET /api/windows/{id}` 拉新树、diff 重渲染（uri 未变的块 iframe 原地保留，不闪断）；
- 不在 WS 里传树本体——只传版本号，拉取仍走 GET，保证单一数据通道；
- 心跳：服务端每 30s 发 `{"type":"ping"}`，客户端应答 `{"type":"pong"}`；连接断开由客户端指数退避重连，重连成功后先 GET 一次全量。
