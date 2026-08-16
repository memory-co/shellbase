# 自定义 provider

```python
CustomSpec(id, url, close=None)  →  Instance(window_url=url, handle=None)
```

## 一个实例 = plugin 自己起的一扇窗

这是**逃生舱**：前四种形态装不下的东西，plugin 自己起一个 HTTP 服务，
把 URL 交上来，画布照着摆。

它的存在理由和 [muxd-spec](../muxd-spec.md) 里「下一个成员」是同一个——
**规范要留一个不需要改规范的入口**。没有它，每来一种新形态都得改画布。

## provider 在这里做的事非常少

只有三件：**登记 URL、探活、按需回收**。

它**不起、不管、不解析**那扇窗——里面是 Jupyter、是 Grafana、还是 plugin 自研的
一个页面，provider 一概不知道，也不该知道。这跟 [M11](../muxd-spec.md)「不代理那扇窗」
是同一条线：**摆的人不解释内容**。

## 谁负责关掉它

**起它的人。** `CustomSpec.close` 是一个可选回调：

- **给了**：`reap()` 判定该收时调用它，由 plugin 自己去停；
- **没给**：provider **只登记不回收**——它不会去杀一个不是自己起的进程。
  这种实例会一直留在 `list()` 里，直到 plugin 自己清掉。

这条是有意的保守：**猜着去 kill 别人的进程，比留一个孤儿更糟。**

## 探活

对 `url` 做 HTTP 探测。探不到就是 `alive() == false`，**不区分「还没起来」和「已经死了」**——
provider 没有依据分辨这两者，装作能分辨就是撒谎（[M13](../muxd-spec.md)）。

plugin 若知道更准的判据（比如它自己的健康端点），应当在 `url` 上给出那个端点，
而不是指望 provider 猜。

## 没有把手

`handle` 恒为 `None`。因此：

- **接不上[对话](chat.md) provider**——对话要求 source 能发能读，`get()` 会直接拒绝；
- 要程序驱动，plugin 自己在别处提供，不经这一层。

## 做不到的

- **不做鉴权穿透**。那扇窗自己负责认人。画布会把它摆进块里，但**不会替它注入
  shellbase 的令牌**——一扇不设防的窗被摆进来，风险由起它的 plugin 承担；
- **不做端口管理**。plugin 自己挑端口、自己负责不撞车。provider 拿到的只是一个 URL；
- **不保证「活得比连接久」**。那取决于 plugin 怎么起的——起在前台进程里就活不过重启。
  provider 不为它兜底，也不假装它会活着。
