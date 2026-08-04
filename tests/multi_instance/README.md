# multi_instance — 一台机器上多份实例互不串

## 这个场景在测什么

同一台机器上不同用户各起一份 shellbase（各自的端口、各自的 workspace），
彼此必须完全独立。两层各有各的串法：

### 一、浏览器侧：cookie 的作用域不认端口

这是最容易被忽略的一条。**cookie 只按域名划分作用域，端口不参与**——
`1.2.3.4:8080` 和 `1.2.3.4:8081` 共用同一个 cookie 罐。两个实例若都写
`shellbase_token`，谁后登录谁把对方顶掉：A 登录 → 开 B → B 拒了 A 的令牌 →
在 B 登录 → cookie 被覆盖 → A 那个标签页下次请求带着 B 的令牌，被踢回登录页。
两边永远互相踢。

所以 cookie 名带上端口（`shellbase_token_8080`），浏览器就能同时持有多份登录态。
这里锁的是：名字确实按端口分、别人端口的 cookie 不被接受、登出只清自己那一份。

localStorage（recents）**不需要处理**：它按 origin 隔离，端口算在 origin 里；
前端也没有一行读写 cookie（HttpOnly，JS 读不到）。这条在测试里一并钉住，
免得以后有人"顺手"把令牌塞进 localStorage。

### 二、进程侧：文件、端口、会话

真起两份实例（不同 HOME、不同端口、不同 workspace），断言：

- 各自的 run 目录独立：pid / 日志 / 令牌 / instance.json 各一份，`status` 只看见自己；
- 令牌不通用：A 的令牌打 B 的端口一律 401；
- 终端会话不串：在 A 里开的会话，不出现在 B 的 `/api/terminals`；
- ttyd 端口不撞：两份实例各自拿到不同的回环端口（端口是自动挑的）；
- 停掉 A 不影响 B：B 依然健康，B 的 ttyd 依然在。

## 不在这测什么

- **真的用两个操作系统用户跑**：那要 root 建账号，测试不该在别人机器上干这个。
  这里用不同的 `HOME` 模拟按用户派生的 run 目录（`cli.RUN_DIR` 就是从
  `Path.home()` 来的），用不同的 `SHELLBASE_TMUX_SOCKET` 模拟 tmux 的按 UID 隔离
  （tmux socket 落在 `/tmp/tmux-<uid>/<name>`，真实双用户天然分开）。

  **因此有一条本场景证明不了、且现状确实不成立**：同一个 UID 下起两份实例，
  若不显式区分 socket 名，两者共用一个 tmux server，会互相看见对方的会话。
  跨用户没有这个问题；同用户多实例请自行设 `SHELLBASE_TMUX_SOCKET`。

- 反代、静态托管、限流等网关职责 —— 各自场景。

## fixture 来源

- `two_instances`（本场景内）—— 真起两份实例（`python -m shellbase.cli start`，
  各自 HOME/端口/workspace/tmux socket），产出 `(a, b)`，收尾自动 stop；
  缺 `ttyd` 或 `tmux` 时整组 skip
- `client_for`（`tests/conftest.py`）—— 浏览器侧那几条用 in-process ASGI client
