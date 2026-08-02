# shellbase v1 全局环境变量设计

> Agent CLI 的凭证（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`…）以及任何用户想让终端携带的
> 环境变量，不应在部署时注入（换个 key 要重新部署，还把配置绑死在平台外）。
> 它是平台内的**全局配置**：Python 后端维护一张环境变量表，用户在界面上自己填；
> 此后**新拉起的终端会话**全部自动生效这些变量。

## 1. 模型

- 后端维护一张**全局 env 表**（key → value），是 [backend.md](backend.md) state 体系的一等成员，
  存于 `state/env.json`（0600 权限，原子写，单写者纪律照旧）：

```json
{
  "updated_at": "2026-07-29T09:00:00Z",
  "vars": {
    "ANTHROPIC_API_KEY": "sk-ant-…",
    "OPENAI_API_KEY": "sk-…",
    "HTTPS_PROXY": "http://127.0.0.1:7890"
  }
}
```

- **分层**：容器启动时的进程环境（`docker run -e`）是底座；全局 env 表叠加在其上，
  同名时**平台配置覆盖容器环境**。于是部署注入仍然可用（作为默认值），但不再是必须。

## 2. 生效机制

注入点在 tmux，两条通道叠加保证覆盖所有创建路径：

1. **tmux 全局环境**：FastAPI 在启动时与每次配置变更时执行
   `tmux set-environment -g KEY VALUE`（删除则 `-r`）——tmux 新建会话的
   session environment 从 global environment 初始化，因此**任何**新会话
   （含 `attach.sh` 兜底创建的）都会带上；
2. **创建时显式注入**：FastAPI 预创建会话（backend.md §2.3）时以
   `tmux new-session -e KEY=VALUE …` 再注入一遍，兜底 tmux server 尚未启动、
   全局环境还没来得及设置的窗口期。

### 生效语义（必须向用户讲清楚）

- **只影响新创建/重建的会话**：tmux 会话的环境在创建时固化，已开着的终端不变；
- 改完配置后，新开的块立即生效；旧块要生效需关闭重开（关闭即销毁 → 重开即重建，语义现成）；
- `exited` 会话被 attach 自动重建时（backend.md §2.4），走的是重建时点的最新配置——符合直觉；
- 前端在保存配置时提示："已保存，对新打开的终端生效"。

## 3. API

| 端点 | 功能 |
|------|------|
| `GET /api/env` | 返回变量列表，value **脱敏**（只给前 4 后 4 位 + 长度），前端据此展示"已配置" |
| `PUT /api/env` | 增量合并：`{"vars": {"KEY": "value", "OLD_KEY": null}}`——字符串为设值，`null` 为删除；成功后同步 `tmux set-environment -g` |

- 读接口不回传明文：value 一旦写入就只出不进（要改就整个重填），避免凭证在浏览器与日志中往返；
- 鉴权与其他 API 一致（网关 AuthGate），无额外权限层——单用户模型下"拿到 token 即拥有容器"（design.md §5"能力自觉"）；终端里本来就能 `env` 看到这些变量，此设计不引入新的暴露面。

`GET /api/env` 响应示例：

```json
{
  "updated_at": "2026-07-29T09:00:00Z",
  "vars": {
    "ANTHROPIC_API_KEY": { "preview": "sk-a…Wg8A", "length": 108 },
    "HTTPS_PROXY":       { "preview": "http…7890", "length": 21 }
  }
}
```

## 4. 前端：设置应用

配置界面是一个 builtin 应用 `settings://`（与"块即 URI"模型一致，可装进任意块，
也从 Shell 顶栏和 URL bar 宫格进入），解析为 `/apps/settings`：

- 变量列表：KEY + 掩码后的 value 预览 + 删除按钮；
- 新增/修改：KEY 输入框 + value 输入框（`type=password`），保存即 `PUT /api/env`；
- 保存成功提示"对新打开的终端生效"；
- 常用凭证（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`）给预设的空条目做引导。

## 5. 安全边界

- `env.json` 属主 0600；它在 state 目录（workspace 卷）上，文件面板/终端可读——
  与"终端里 `env` 即可见"是同一暴露面，不是新增风险；
- 明文只存在于：state 文件、tmux 进程环境、终端会话内。API 读路径永远脱敏；
- 公网部署的前提不变：必须有 TLS（design.md §5），否则 PUT 时凭证裸奔的是传输层，不是本设计能救的；
- 与 Secret Manager 类外部方案的关系：容器环境底座仍可由其注入，本设计只是把
  "用户可自助改"的那层放进平台。

## 6. 对其他文档的影响清单

- backend.md §3.1：存储树增加 `env.json`；
- api/：待方案确认后补 `env.md`（端点定义即 §3）；
- urlbar.md / design.md §3.6：应用注册表增加 builtin 的 `settings://`。
