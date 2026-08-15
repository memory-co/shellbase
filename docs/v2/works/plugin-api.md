# plugin 长什么样（代码）

[protocol.md](protocol.md) 讲三层怎么分，这篇用一段代码把 plugin 那层坐实。
拿 `claude://` 做例子，因为它有两种形态，最能说明问题。

```python
class Claude(Plugin):
    schemes = ("claude",)
    forms = ("terminal", "chat")          # 我有哪几种形态
    default_form = "terminal"

    def parse(self, path):
        p = Path(path or "/workspace")
        if not p.parent.is_dir():
            raise BadPath(f"父目录不存在：{p.parent}")   # 打错的路径不该造出一棵树
        p.mkdir(exist_ok=True)
        return p

    def session_id(self, uri):            # 返回 None = 这个协议没有活的会话（file://）
        return f"{uri.window}--claude-{slug(uri.path)}-{uri.block}"

    def mount(self, ctx):
        if not which("claude"):
            raise Missing("claude", install="npm i -g @anthropic-ai/claude-code")
        sid = self.session_id(ctx.uri)
        term = ctx.providers.terminal.get(     # 找 provider 要，不碰 tmuxd（M4 id 幂等）
            TerminalSpec(id=sid, cwd=str(ctx.path), cmd="claude", env=ctx.env),
        )
        if ctx.form == "chat":
            return ctx.providers.chat.get(
                ChatSpec(id=sid, source=term, split=split_on_prompt),
            )
        return term
```

**两种形态共用同一个 `term`**，所以它们是同一份现场；第二种形态多写的全部代码，
就是那个 `split_on_prompt`（切不出轮次就返回 `None`，画布降级为整屏文本，不猜边界）。

`mount()` 返回一个**实例**（[provider.md](provider.md)）。plugin 全程没有出现
`tmuxd` 这个词——换掉终端组件时，这段代码一行不动。

`ctx` 是画布递进来的只读上下文：`uri`、`path`（运行时已 `parse` 好）、
`form`（块状态里的当前形态）、`providers`（五个 provider）、`env`（平台注入的环境变量）。

外部 plugin 走 entry point 注册（`shellbase.plugins`）——**plugin 是代码，声明也在代码里**，
不像 v1 那样往环境变量里塞一段 JSON。

## 写这段代码逼出的四处修正

设计文档在这三处是自欺的，已回改 [protocol.md](protocol.md)：

1. **「画布层完全不需要认识 provider」是错的。** 画布得会画那五种东西，所以它认识
   形态；它不认识的是**选择逻辑**；
2. **「plugin 自己提供切换入口」做不到**——plugin 是后端对象，没有前端。切换控件只能
   由画布渲染，**但形态清单与默认值来自 plugin，用户选完存进块状态、下次原样传回
   `ctx.form`**。想完全自己控制界面的，用 `Custom` 那扇窗；
3. **`parse()` 原本会被调两次**（校验一次、`mount` 里一次）。改成运行时先 parse、
   结果放进 `ctx.path`；
4. **plugin 原本直接调 `ctx.tmuxd`**——那样 provider 就没省下任何开发量，换组件时
   每个 plugin 都得改。改成向 provider 要实例，**调 muxd 是 provider 的事**
   （[provider.md](provider.md)）。
