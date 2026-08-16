# 协议 · provider · plugin

v1 里一个块是「一个虚拟 URI」，URI 后面直接就是实现（终端 attach、iframe、文件页）。
v2 把这条线拆成三层，让「做什么」和「怎么交互」彼此独立：

```
claude:///workspace/proj
└──┬──┘ └──────┬───────┘
 协议        路径
 做什么      在哪儿做

协议 ──by── plugin ──选用── provider ──背后是── *muxd 组件 / 内置能力
                      ↑
              形态由 plugin 定，不进 URI
```

三句话把它们的边界说清：

- **协议**回答「做什么」，**路径**回答「在哪儿做」——两者合起来是块的身份；
- **provider** 只回答「人怎么上手」，是**视图，不是身份**；
- **plugin** 是某个协议的实现，它的工作是把 URI 变成一个能被 provider 呈现的东西。

## 1. 协议：scheme 是动词，path 是它作用的对象

```
claude:///workspace/proj      在这个目录上跑 Claude
vim:///workspace/a.py         编辑这个文件
file:///workspace             浏览这个目录
https://example.com/x         打开这个页面
```

**path 不限于文件系统路径**，它是「这个协议作用的对象」，语义由协议自己解释：
`file://` / `vim://` 解释成本机路径，`https://` 解释成网址，将来某个 `pg://`
可以解释成一个连接串。画布层不解释 path，只负责原样交给 plugin——
**画布不该知道 `vim://` 后面是文件还是目录**。

path 的校验也归 plugin：`vim://` 可以要求它必须存在且是文件，`claude://` 可以接受
不存在的目录（它会自己建）。校验失败要报清楚是哪一条不满足，而不是笼统的「打不开」。

## 2. provider：五种交互形态

provider 的唯一职责是**提供一种让人 input 的形态**。只有五种，前四种内置，第五种是逃生舱：

| provider | 形态 | 人怎么 input | 背后通常是 |
| --- | --- | --- | --- |
| **终端** | 字符流 | 打字 | tmuxd（窗是 ttyd 端口） |
| **网页浏览器** | 一个页面 | 点、填、拖 | webmuxd（服务器侧的真浏览器） |
| **对话** | 轮次化的消息 | 发一段话 | 任意「能发能读」的把手 |
| **文件浏览器** | 树 + 内容 | 点选、编辑 | shellbase 自己的文件 API |
| **自定义** | plugin 自带的一扇窗 | 由它自己决定 | plugin 起的任意 HTTP 服务 |

**为什么是这五种**：前四种覆盖了「人能上手」的绝大多数方式，且各自有成熟的承载物；
第五种存在的意义是不把新东西挡在门外——同 [muxd-spec](muxd-spec.md) 的「下一个成员」
一样，规范要留一个不需要改规范的入口。

**provider 不改变协议的语义。** 换 provider 是换「怎么交互」，不是换「做什么」。
`file://` 若哪天支持终端形态，那也必须仍然是「浏览这个目录」（一个 TUI 文件管理器），
**不能变成「在这个目录开个 shell」**——那是 `bash://` 的事。这条是硬约束：一旦允许
provider 改语义，同一个 URI 在不同形态下就是两个东西，块的身份也就没有意义了。

## 3. plugin：一个协议的实现

plugin 要声明的东西不多，但每一条都必须显式：

| 声明 | 说明 |
| --- | --- |
| `schemes` | 认领哪些 scheme（可多个别名） |
| `parse(path)` | 怎么解释和校验 path，失败要说清哪一条不满足 |
| `providers` | 支持哪几种形态，以及每种怎么接（见下表） |
| `default_provider` | 起手用哪个形态；有多种形态时，切换入口也由 plugin 自己提供 |
| `session_id(uri)` | 同一个 URI 是不是同一个会话——对齐 [M4 id 幂等](muxd-spec.md)；返回 `None` 表示这个协议**没有活的会话**（如 `file://`） |

每种 provider 向 plugin 要的东西，就是它全部的接线面：

| provider | plugin 递一份 spec |
| --- | --- |
| 终端 | `TerminalSpec(id, cwd, cmd, env)` |
| 网页浏览器 | `BrowserSpec(id, url)` |
| 对话 | `ChatSpec(id, source, split)`——`source` 是另一个已存在的实例 |
| 文件浏览器 | `FilesSpec(id, root)` |
| 自定义 | `CustomSpec(id, url, close=None)`（plugin 自己起的窗，自己负责活着） |

**plugin 不碰 muxd**——递 spec，provider 去调。换掉 tmuxd 时 plugin 一行不改。
实例、粒度与回收见 [provider.md](provider.md)。

**provider 存在的全部意义就在这张表**：它把「怎么呈现、怎么收 input」这部分做成公共的，
plugin 只需交出那一两样东西。以 `claude://` 为例——它本来就是个终端程序，终端形态零成本；
要多一个对话形态，plugin 只需再交出「发一段 / 读一段」加一条切轮次的规则，
**而不是重写一个对话应用**。

一个 plugin 支持几种形态是它自己的事：`vim://` 只支持终端完全合法，`https://` 只支持
网页浏览器也完全合法。**没有「应该多支持几种」这回事**——只在这个形态确实成立时才声明它。

## 4. 形态由 plugin 定，不由 URI 指定

**形态不进 URI。** URI 是块的身份（协议 + 路径），而形态是视图——把视图写进身份，
等于说「换个看法就换了个块」，与 §2 那条硬约束自相矛盾。

所以：

- **plugin 说了算。** 只有它知道自己有几种形态、当下哪种成立（比如对话形态要求
  那条切轮次的规则能用）；
- **形态清单与默认值来自 plugin**（`forms` / `default_form`），切换控件由画布用统一
  样式渲染——plugin 是后端对象，没有前端，控件只能画布来摆。想完全自己控制界面的，
  用「自定义」那扇窗；
- 用户切过之后，**形态作为块的状态跟布局一起持久化**（v1 已有「块参数随布局存」
  的机制，见 [v1 design §3.4](../../v1/works/design.md)），下次原样传回给 plugin。
  **画布只负责存和取，不解释它。**

画布**认识那五种形态**（它得会画一扇窗、一棵树、一串消息），但**不参与选择**：
选哪一种、为什么是它，全在 plugin 里。代码形状见 [plugin-api.md](plugin-api.md)。

**切形态不换会话。** 同一个块从终端切到对话，底下还是同一个 session、同一份现场——
这正是 provider 是视图而非身份的直接后果。也因此，**两个块可以用两种形态看同一份现场**：
终端块里滚动的输出，和对话块里的最后一轮，是同一个东西的两种画法
（tmux 的多客户端镜像本来就成立，见 [v1 collab](../../v1/works/collab.md)）。

会话有三种形态：**每块一个**（默认，如 `bash://`）、**同 path 共享**（如 `vim://`——
两个 vim 编辑同一文件会打架）、**没有会话**（如 `file://`——背后没有长驻进程）。
各协议的选择与理由见 [plugins/](plugins/)。

**开新块默认是新会话。** v1 的会话身份含 window 与 block 号（[v1 uri](../../v1/works/uri.md)），
即同一个 `scheme://path` 在两个块里是两个独立终端——这个默认保留，因为「我想在同一个目录
再开一个 shell」是常见需求。plugin 若要让某个协议反过来（同 path 永远共享一份现场），
在 `session_id()` 里去掉 block 号即可。**这个决定归 plugin，画布层不猜。**

## 5. 与 *muxd 的关系：谁来代理那扇窗

[M11](muxd-spec.md) 规定组件**不代理自己的窗**，只把 URL 报出来。这跟 shellbase 的
网关要把 `/tty/`、`/proxy/<port>/` 反代出去，看起来是冲突的，其实不是：

> **组件不代理，不等于上层不能代理。shellbase 就是那个上层。**

组件报出一个 `http://127.0.0.1:<port>` 的 URL；画布决定要不要把它摆进 iframe、要不要
套一层鉴权、要不要经网关转发。**组件不替上层做展示决定**——这正是 M11 想保住的东西。
所以 v1 网关那套反代在 v2 里继续存在，只是它反代的对象从「我们自己拉起的 ttyd」
变成「组件报出来的窗」。

**provider 是唯一调用组件的那一层**：终端 provider 调 tmuxd、浏览器 provider 调 webmuxd、
文件浏览器 provider 背后干脆没有组件（就是平台自己的文件 API）、对话 provider 包在
另一个实例的把手上。plugin 与画布都不直接碰组件。

组件不可用时按 [M13](muxd-spec.md) 办：**说不可用，不静默换一个 provider**。
悄悄从对话降级成终端，用户会以为自己看到的是同一个东西。

## 6. 与 v1 的差异

| | v1 | v2 |
| --- | --- | --- |
| 块的身份 | 虚拟 URI | 不变（协议 + 路径） |
| 未知 scheme | 盲转发给终端 attach 端点 | 落到兜底 plugin（行为等价，但有名有姓） |
| 形态 | URI 隐含（终端 / iframe / 文件页三选一） | plugin 选用，块状态里持久化，可切换 |
| 实现在哪 | 后端按 scheme 分支 | 每个协议一个 plugin |
| 终端从哪来 | 网关自己拉起 ttyd | tmuxd 组件报出的窗 |
| 注册表 | `SHELLBASE_APPS_EXTRA`（环境变量里的 JSON） | plugin 自己声明 |

v1 的 `?window=&block=` 身份参数原样保留，**v2 不往 URI 上加新参数**。

## 7. 明确不做

- **不做 provider 之间的自动转译。** 把终端的字符流自动切成对话轮次是猜测，猜错了
  比不做更糟。要切轮次，由 plugin 给规则；
- **不做 plugin 沙箱。** plugin 是可信代码，与平台同权。拿到 token 即拥有容器，
  这条 [v1 §5](../../v1/works/design.md) 已经定了，v2 不改；
- **不做多用户与权限模型**，沿用 [muxd-spec §3](muxd-spec.md)；
- **不做 provider 的可视化编排。** 怎么摆、怎么分割是画布的事，不是协议层的事。

## 8. 各协议的实现

每个协议一个目录，声明与判断写在各自的 README 里：[plugins/](plugins/)。

## 9. 走一遍：`claude://` 的两种形态

```
claude:///workspace/proj      URI 只说"在这个目录上跑 Claude"，不说用哪种形态
```

plugin 侧发生的事：

1. `parse("/workspace/proj")` —— 是目录，不存在就建；
2. `session_id()` 派生出 `w1--claude-workspace-proj-1`，向 tmuxd 要这个 session
   （id 幂等，已存在就是取回来）；
3. 终端形态：把组件报出的窗 URL 交给画布，画布摆进块里；
4. 用户在块里切到对话：plugin 把同一个 session 的 `send()` / `capture()` 交给对话
   provider，外加一条「以 shell 提示符为界切轮次」的规则；切换记在块状态里，
   下次重入还是它。

**plugin 为第二种形态多写的只有第 4 步的那条规则**，其余全是公共的——
这就是 provider 分层要换来的东西。
