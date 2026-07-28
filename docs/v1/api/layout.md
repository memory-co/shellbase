# Layouts API

设计背景：[works/backend.md](../works/backend.md) §4（服务端布局持久化）、[works/collab.md](../works/collab.md) §3（多客户端实时同步）。

**layout 是可数的资源**：每张"页面"一个 layout，id 即身份（默认页面 `main`）。前端 URL `/#l/<id>` 决定打开哪张页面，缺省 `main`。id 语义与终端 URI 一致——无中生有：访问未知 id 即得到一张空页面。

布局对象：递归二叉分割树，叶子只存块的 URI（uri.md §5）：

```json
{
  "id": "main",
  "name": "主工作台",
  "version": 3,
  "updated_at": "2026-07-28T09:00:00Z",
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

- `dir`: `row`（左右）| `col`（上下）；`ratio`: 第一个孩子的占比 (0,1)；
- 空白块（启动页）叶子记为 `{ "type": "leaf", "uri": null }`；
- `name` 是展示名，可改，不参与身份；id 建 slug 校验（`[a-z0-9-]{1,64}`）。

## GET /api/layouts

列出全部页面——"当前存在多少张 layout"的答案：

```json
{
  "layouts": [
    { "id": "main",   "name": "主工作台", "updated_at": "2026-07-28T09:00:00Z", "blocks": 4 },
    { "id": "review", "name": "review",  "updated_at": "2026-07-27T18:00:00Z", "blocks": 2 }
  ]
}
```

首次使用时至少含自动创建的 `main`。

## GET /api/layouts/{id}

- 已存在：`200` 返回布局对象；
- 未知 id：**无中生有**——落盘一张空页面（单个 `uri: null` 启动页块，`version: 1`，`name` = id）并返回之。进入 `/#l/xxx` 即创建页面，与终端 URI 的 attach 语义对称；
- id 不合法（slug 校验不过）：`400 {"error":"bad_layout_id"}`。

## PUT /api/layouts/{id}

全量覆盖写。请求体即布局对象，`version` 必须为**当前版本 + 1**：

- 成功：`204`，落盘（原子写）并向该页面的 `watch` 广播；
- `version` 不匹配（别的客户端先写了）：`409 {"error":"version_conflict", "current_version": 5}`——调用方应 `GET` 最新树、在其上重放本地改动后重试；
- 树结构不合法（未知 type、ratio 越界、嵌套超 32 层）：`400 {"error":"bad_tree"}`。

前端节流：布局变更（分割/关闭/换应用/拖比例结束）后防抖 ~500ms 再 PUT，拖动过程中不写。

## DELETE /api/layouts/{id}

删除页面。执行顺序：

1. 对树中每个终端类叶子按"关闭即销毁"处理——但**仅当该会话不被其他 layout 的叶子引用**时才 `kill-session` + 删 state（同一 URI 可能出现在多张页面上）；
2. 删除布局文件，向该页面的 `watch` 广播 `{"type":"layout_deleted"}`（正在此页面的客户端跳回 `main`）。

`main` 不可删除（`400 {"error":"cannot_delete_main"}`）；不存在 → `404`。

## WS /api/layouts/{id}/watch

单张页面的变更广播通道，协作的实时性来源。连接后：

```json
// 服务端 → 客户端，每次该页面 PUT 成功后推送
{ "type": "layout_updated", "version": 6 }
// 页面被删除时
{ "type": "layout_deleted" }
```

- 客户端收到版本号大于本地的通知即 `GET /api/layouts/{id}` 拉新树、diff 重渲染（uri 未变的块 iframe 原地保留，不闪断）；
- 不在 WS 里传树本体——只传版本号，拉取仍走 GET，保证单一数据通道；
- 心跳：服务端每 30s 发 `{"type":"ping"}`，客户端应答 `{"type":"pong"}`；连接断开由客户端指数退避重连，重连成功后先 GET 一次全量。
