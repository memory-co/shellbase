# provider · 交互形态与它的实例

一句话：**provider 是一类交互形态的实例工厂，也是唯一调用 muxd 的地方。**

```
plugin ──要一个实例──▶ provider ──调用──▶ muxd 组件 / 平台能力
（协议实现）           （交互形态）        （tmuxd / webmuxd / 文件 API）
```

**plugin 不碰 muxd。** 它只说「我要一个终端，跑这个命令、在这个目录」，
至于终端从哪来、tmuxd 怎么调、窗的 URL 怎么拿，全在 provider 里。
换掉 tmuxd 时，**所有 plugin 一行都不用改**——这才是这一层要换来的东西。

全部词汇就五个：**协议**（做什么）、**路径**（在哪儿做）、**plugin**（协议的实现）、
**provider**（交互形态）、**实例**（这个形态的一份具体现场）。没有第六个。

## 1. 实例

每个 provider 管着**一个或多个实例**。实例是有 id 的一份现场：

```python
class Instance:
    id: str
    window_url: str | None   # 人看的那扇窗；没有窗的形态（对话、文件）是 None
    handle: object | None    # 程序驱动它的把手；没有就是 None
    def alive(self) -> bool: ...
    def close(self) -> None: ...
```

三条硬规则：

- **id 幂等**——同一个 id 拿两次是同一个实例（[M4](muxd-spec.md)），不是两份等价的东西。
  这是「一个 provider 能有多个实例」的管理方式：靠 id 分，不靠调用次数分；
- **活得比连接久**——关掉网页、关掉块，实例照常在（[M6](muxd-spec.md)）。
  **关块不等于关实例**；
- **不许撒谎**——`alive()` 要真的探到底下那个东西还在，而不是「我记得我起过」
  （[M13](muxd-spec.md)）。

## 2. 五种 provider

| provider | 一个实例是什么 | 背后调谁 | 产出 |
| --- | --- | --- | --- |
| **终端** | 一个 tmux session | tmuxd | 窗（ttyd URL）+ 把手（send / capture） |
| **网页浏览器** | 一个 tab | webmuxd | 窗（VNC URL）+ 把手（CDP） |
| **对话** | 一个 source 实例上的轮次视图 | **不调 muxd**，见 §3 | 无窗，把手即 source 的把手 |
| **文件浏览器** | 一个根路径下的浏览现场 | 平台自己的文件 API | 无窗，画布直接渲染 |
| **自定义** | plugin 自己起的一扇窗 | **不调**，plugin 自己负责 | 窗（plugin 报的 URL） |

要一个实例，plugin 递一份 spec：

```python
TerminalSpec(id, cwd, cmd, env)      BrowserSpec(id, url)
ChatSpec(id, source, split)          FilesSpec(id, root)      CustomSpec(id, url)
```

### 实例粒度不是一刀切

**终端每块一个，浏览器不是。** 一个 tmux session 极便宜，所以「同一个目录再开一个
shell」随手就来；而 webmuxd 的一个 session 是一整个桌面镜像（4 GB 级），
每块起一个不可接受。

所以**浏览器 provider 内部分两级**：一个按需起的共享 webmuxd session，
每个块在里面占一个 tab。对 plugin 和画布来说，实例仍然只有一种粒度（一个 tab），
**共享那一级是 provider 的内务**。

这就是「一个 provider 能搞出一个或多个实例」的实际含义：实例数由使用决定，
而它们底下压着几个 muxd session，是 provider 自己的账。

## 3. 对话 provider 没有自己的 muxd

它包在**另一个实例的把手**上：

```python
term = providers.terminal.get(TerminalSpec(id=..., cwd=..., cmd="claude"))
chat = providers.chat.get(ChatSpec(id=..., source=term, split=split_on_prompt))
```

`ChatSpec.source` 就是一个已经存在的实例。对话 provider 拿它的 `send` / `capture`，
按 `split` 切成轮次——**所以对话与终端是同一份现场**，也因此对话形态不需要新起任何东西。

轮次历史来自 source 的 scrollback（[M10](muxd-spec.md)），对话 provider **不自己存一份**——
两份历史迟早对不上。切不出轮次时返回整屏文本并标注，不猜边界。

这条也划出了对话形态的适用边界：**source 必须能发能读**。给一个只有窗、没有把手的
实例（比如自定义 provider 报的那扇窗）套对话，是接不上的，声明时就该拒绝。

## 4. 谁回收实例

**块关掉不回收。** 关块只是不看了，实例照常活着（M6）——用户重开同一个 URI 就该
回到原来那份现场，这是 v1 就有的承诺。

真正的回收有两条：

- **显式关闭**：用户在块里选「关闭这个会话」，或调 `close()`；
- **无人引用且超过保留期**：provider 定期对账，没有任何块引用、且闲置超过保留期的
  实例回收掉。保留期按成本定——终端便宜，可以放到天级（v1 是 7 天）；
  浏览器一个 session 压着 4 GB，闲置几十分钟就该收。

对账要按 M13 办：**以实际探测为准**，tmux session 没了就是没了，不因为记录里还写着
就当它活着。

## 5. muxd 不可用时

按 [M13](muxd-spec.md)：**报不可用，不静默换一个 provider**。

provider 是最靠近 muxd 的一层，也是唯一知道「它到底起没起来」的一层，
所以这条判断只能在这里做，不能推给 plugin 或画布。报错要带这台机器上装它的那条命令
（[M12](muxd-spec.md)）。

**尤其不许做的**：对话不可用就悄悄给终端、浏览器不可用就悄悄给一个 iframe。
用户会以为自己看到的是同一个东西。

## 6. 不做什么

- **不做 provider 之间的自动转换**。终端流自动变对话轮次是猜测，规则由 plugin 给；
- **不做跨 provider 的实例共享**（对话包在 source 上是明确的接线，不是共享）；
- **不做实例的可视化管理界面**——那是画布的产品决定，provider 只提供 `list()`。
