# `bash://` · 一个 shell，以及所有没人认领的 scheme

```
bash:///workspace            在这个目录开一个 shell
htop://                      没有 plugin 认领 → 落到这里，命令名就是 htop
```

## path

工作目录。不存在就退到 workspace 根，**不报错**——开一个 shell 是最低成本的动作，
为一个不存在的 cwd 拦住它不划算。（对照 [`vim://`](vim.md) 的相反判断：
编辑器打开不存在的路径八成是打错字，那里就该拦。）

## 形态

**只有终端。** 向 tmuxd 要 session：`cwd=path`、`cmd=bash`。

## 会话

沿用默认，每块一个——同一个目录开多个 shell 是最常见的用法。

## 兼任兜底：scheme 名即命令名

**没有 plugin 认领的 scheme，落到这里**，scheme 名被当作要跑的命令
（沿用 [v1 uri §3.1](../../../v1/works/uri.md)）：

```
htop://            → tmuxd session，cmd=htop
lazygit:///proj    → tmuxd session，cmd=lazygit，cwd=/proj
```

**为什么保留这个兜底**：它让「机器上装了什么 CLI，就能用什么 scheme」零配置成立。
不保留的话，每加一个命令行工具都要写一个 plugin，而绝大多数工具需要的不过是
「在某个目录把它跑起来」——那正是这个 plugin 已经做的事。

**代价要说清楚**：拼错的 scheme 不会被立刻识破，而是变成一次「命令未找到」。
所以命令不在 PATH 时，报错必须带这台机器上装它的那条命令（[M12](../muxd-spec.md)），
而不是干巴巴一句 `cmd_not_found`。

**兜底不猜形态**：落到这里的 scheme 一律是终端。想要别的形态，就得有人为它写一个 plugin——
这是有意的门槛，避免画布层去揣测某个陌生命令「大概适合对话形态」。

## 做不到的

- **不知道那个命令是不是真的适合跑在终端里**。它只负责起，起完什么样是命令自己的事；
- **不管命令退出之后**。进程结束后块里是一个退出后的 shell，与 [`vim://`](vim.md) 同理。
