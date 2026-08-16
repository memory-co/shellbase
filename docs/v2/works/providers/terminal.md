# 终端 provider

```python
TerminalSpec(id, cwd, cmd, env)  →  Instance(window_url=<ttyd URL>, handle=<send/capture>)
```

## 一个实例 = 一个 tmux session

边界划在 session 而不是 pane：**pane 是 tmux 内部的事**，用户在终端里自己分屏、
自己切窗口，与画布怎么摆块无关。画布的块对应 session，正好也是「活得比连接久」
这件事的粒度——tmux 保住的就是 session。

实例便宜是这条边界能成立的前提：一个 tmux session 的成本是一个进程，所以
「同一个目录再开一个 shell」随手就来，不需要为省资源做任何共享
（[网页浏览器](browser.md)就没有这个待遇）。

## 窗与把手

| | 是什么 | 谁给的 |
| --- | --- | --- |
| 窗 | ttyd 的 URL | tmuxd 报出；**它是实现面，不是契约面**（[muxd-spec §5](../muxd-spec.md)） |
| 把手 | `send(text, enter=)` / `capture()` / `resize(cols, rows)` | tmuxd 的 `Session` |

逃生舱：`tmux -L tmuxd ls`——你的 tmux 和它的 tmux 是同一个。**任何时候都能绕开
shellbase 去看同一份现场**，这是选 tmux 而不是自研 pty 的根本理由。

## 生命周期

- **起**：`get()` 时向 tmuxd 要（id 幂等，已存在就是取回来）；
- **命令退出即结束**：`cmd` 跑完，session 就没了。**不自动重启**——自动重启会把
  「它崩了」变成「它一直在重启」，掩盖真正的问题。块里显示「已结束」和一个重开入口，
  由人决定；
- **收**：`reap(keep)` 里没被引用且闲置超过保留期的收掉。**保留期天级**（v1 是 7 天）——
  成本低，而「昨天那个跑到一半的东西还在不在」是真实需求。

## 多个块看同一个 session

允许，且是同一份现场（tmux 多客户端）。代价照实说：**尺寸会互相牵制**——
tmux 的 `window-size latest` 让窗口跟随最后操作的客户端（[v1 collab](../../../v1/works/collab.md)），
所以两个块尺寸不同时，小的那个会出现空白或截断。

这不是 bug，是共享一份现场的固有代价。想各看各的，开两个 session。

## 失败长什么样

| 情况 | 怎么说 |
| --- | --- |
| tmuxd 不可用 | `available()` 返回 `Unavailable`，带上装 tmuxd 的那条命令 |
| `cmd` 不在 PATH | 这是 plugin 该先拦的（它知道自己要跑什么），provider 拿到就是启动失败 |
| session 探不到 | `alive()` 返回 false。**不因为记录里写着就当它活着**（M13） |

## 做不到的

- **不做终端录制与回放**。历史就是 tmux 的 scrollback，有上限、能回看
  （[M10](../muxd-spec.md)）；要更长的历史，调 tmux 的 `history-limit`，不在这层加一套；
- **不做一个 session 跑多个命令**。一个实例一个 `cmd`，要并排跑两个东西就是两个实例——
  这样「它退出了没有」才有明确答案；
- **不做输入回放/宏**。那是终端里的程序自己的事。
