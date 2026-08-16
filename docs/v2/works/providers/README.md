# providers · 一种形态一篇

层的契约（接口、装配、回收策略）在 [../provider.md](../provider.md)，这里是每种形态
各自的设计与判断。

| provider | 一个实例是什么 | 背后调谁 | 窗 | 把手 | 保留期 |
| --- | --- | --- | --- | --- | --- |
| [终端](terminal.md) | 一个 tmux session | tmuxd | ttyd URL | send / capture | 天级 |
| [网页浏览器](browser.md) | 一个 webmuxd session | webmuxd | VNC URL | CDP | 分钟级 |
| [对话](chat.md) | source 上的轮次视图 | 不调 | 无 | 即 source 的把手 | 跟随 source |
| [文件浏览器](files.md) | 一次浏览现场 | 平台文件 API | 无 | 无 | 即用即弃 |
| [自定义](custom.md) | plugin 自己起的窗 | 不调 | plugin 报的 URL | plugin 说了算 | 不回收 |

## 三条贯穿全部的规则

来自 [muxd-spec](../muxd-spec.md)，每篇都要落到实处：

- **id 幂等**——`get()` 同 id 就是同一个实例（M4）；
- **活得比连接久**——关块不等于关实例（M6）；
- **不许撒谎**——`alive()` 真去探，`available()` 不可用时带上装它的那条命令（M12/M13）。

## 一篇要回答什么

1. **一个实例到底是什么**——边界划在哪，为什么划在这里；
2. **窗和把手分别是什么**，没有的那个为什么没有；
3. **生命周期**——什么时候起、什么时候收、保留期为什么是这个量级；
4. **失败长什么样**——组件没了、实例死了、探测超时，各自怎么说；
5. **做不到的**——写在前面，别等人撞上。
