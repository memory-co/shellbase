# cli_status — `shellbase status`：运行信息从哪来、什么时候不可信

## 这个场景在测什么

`status` 要回答的是「现在到底有没有在跑、跑在哪、拿什么令牌进」。信息来自
`daemon` 自报的 `~/.shellbase/instance.json`，而**文件会说谎**——进程可能已经
没了、令牌可能被 `SHELLBASE_TOKEN` 盖过。这个场景锁的就是这些拐点：

1. **没在跑就是没在跑**：没有运行信息文件时 `status` 退出码非 0，`--json` 给
   `{"running": false}`，不能假装有实例。
2. **陈旧文件不算数**：进程已经死了但文件还在（`kill -9` 之后就是这样），
   `status` 要认出来并顺手把 pid / instance 文件清掉，否则下次 `start` 会被
   一个幽灵实例拦住。
3. **落盘的令牌不一定是实例认的那份**：`SHELLBASE_TOKEN` 会盖过它，且环境变量
   给的令牌不落盘。所以要先拿去 `/api/auth/verify` 验一下，验过才显示；验不过
   要说清是环境变量在生效，而不是把旧令牌当真答案端出去。
4. **`--json` 是给脚本的**：`token` 字段验不出就是 `null`，不能塞中文句子。
5. 运行时长的人话格式（秒 / 分 / 小时 / 天）。

## 不在这测什么

- **真的把进程拉起来**（`start` → `status` → `stop` 全链路）：那要 spawn 子进程、
  等端口就绪，是另一种形态；这里用当前进程的 pid 假装「活着」，只测判定逻辑。
- ttyd 端口怎么挑、守护进程怎么脱离终端 —— 属于启动形态，不在这。
- 令牌本身的鉴权语义（谁能进）在网关那边锁。

## fixture 来源

- `run_dir`（本场景内）—— 把 `cli` 模块的 `RUN_DIR` / `PID_FILE` / `STATE_FILE` /
  `TOKEN_FILE` / `LOG_FILE` 一起指到临时目录，避免碰到跑测试的人自己的 `~/.shellbase`
- `capsys`（pytest 内置）—— 抓 `status` 的输出
