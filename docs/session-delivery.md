# 将消息投递到原 Codex / DSH 会话

这是可选的宿主会话投递能力。2026-10-20 已部署到本机 A2A 网关；首次验收见 [部署验收记录](session-delivery-deployment-20261020.md)，正文与产物链接升级见 [最新验收记录](notice-body-deployment-20261020.md)。以下示例仅说明配置和调用方法。已有安装需要先更新并检查 gateway 工具契约；旧的 A2A 任务、收件箱和 webhook 路径保持兼容。

gateway 负责持久化投递记录、绑定原会话、核对受理结果及恢复；Codex 和 DSH 负责各自的宿主队列与模型执行。`accepted` 表示宿主接受排队，不表示模型已经执行，更不表示业务已经完成。

## 配置宿主

在现有 gateway 配置中添加命名的 `sessionHosts`。名称用于 `session_bind`，凭据只由配置和宿主环境提供。以下值均为占位值：

```json
{
  "stateDirectory": "/absolute/private/a2a-gateway-state",
  "remotes": {},
  "sessionHosts": {
    "codex-local": {
      "kind": "codex",
      "executable": "codex",
      "cwd": "/absolute/existing/workspace",
      "timeoutMs": 30000
    },
    "dsh-main": {
      "kind": "dsh",
      "url": "http://dsh-host:3080",
      "headers": {
        "Cookie": "replace-with-protected-DSH-host-session-cookie"
      },
      "timeoutMs": 30000
    }
  }
}
```

保留已有 `remotes`、`callback`、`notificationTargets` 等配置，不要用示例空映射覆盖正常部署。配置文件应受保护，Unix 上使用 `chmod 600`。配置完成后复用现有启动方式：

```sh
acp-service a2a gateway --config /absolute/private/gateway.json
```

Codex 的 `executable` 是运行宿主队列命令的程序；可选 `remote`、`remoteAuthTokenEnv` 指定受支持的远程连接及认证环境变量名称。实际调用原生 `codex queue --thread=<UUID> --message=<原文>`，参数不经 shell。`sessionId` 必须是真实 Codex thread UUID；不能用 A2A task/context ID 或原生 Agent 的其他 ID 代替。

DSH 的 `url` 是宿主 HTTP(S) origin。适配器按 DSH Web Remote envelope 调用 `/api/session/prompt`，使用 `mode: "queue"` 和稳定 requestId；`sessionId` 是已有 DSH 会话的 ID，可指向 UI 创建的会话。该路径使用宿主队列，无需新增 HTTP receiver。

宿主传输 ID 稳定派生自 `sha256([originSessionId, messageId])`，DSH requestId/rpcId 使用该派生值，避免多个 origin 使用相同 messageId 时发生宿主去重冲突。对外绑定、查询和恢复仍使用原 messageId；`hostReceiptId` 由宿主实际回执决定，不要假定它等于原 messageId。

DSH `headers` 应按实际部署提供所需的 Cookie 或 Authorization。示例不意味着所有 DSH 部署都使用 Bearer；宿主登录凭据与 A2A `/a2a` 的 bearer token 不是同一用途。不要读取或展示真实 header 值来排查普通调用问题，也不要将它们放入工具参数、消息正文、receipt 或日志。Codex 远程认证值同样不能进入这些位置。

本次安装的 DSH Web 使用进程启动时生成的登录令牌，配置中的固定 `launchToken` 不生效。部署时通过真实启动入口登录，由宿主签发 Cookie，并仅写入受保护配置；不能从持久签名密钥自行伪造凭据。Cookie 有有效期，到期需重新通过宿主登录流程签发。API operator Cookie 另有生命周期，不应假定其跨进程有效。

网关配置的 remote origin 必须与 Agent Card 公布的接口 origin 一致。端口转发入口能读取 Agent Card，也可能因 Card 指向另一个 origin 而无法派单；应核对实际节点与接口后修正部署地址，不应关闭 origin 校验来绕过问题。

## 绑定与发送

所有工具均由本机 `a2a-gateway` 提供，可通过 DreamMate 调用，也可使用已有 `acp-service a2a invoke <method>`，参数 JSON 从 stdin 读取。无需新 CLI 子命令。

先取得主会话的稳定归属 ID，再绑定真实目标。`originSessionId` 是本地关联 ID，绑定的 `sessionId` 是宿主真实会话 ID，两者可以不同。重复相同绑定安全；改变已绑定目标会被拒绝，不能借重试把结果发到另一个会话。

```sh
acp-service a2a invoke session_bind <<'JSON'
{
  "originSessionId": "actual-parent-session-id",
  "host": "codex-local",
  "sessionId": "actual-codex-thread-uuid"
}
JSON
```

发送必须已有用户授权，使用稳定 messageId。公开 `session_send` 禁止使用 `a2a-notice:` 前缀，该命名空间保留给自动任务通知。调用先落盘并立即返回 receipt；宿主调用由后台处理，不保证返回时已入队。相同 origin/messageId 与相同正文会复用原记录；相同 ID 改正文是冲突，需要更正的消息应使用新 ID。

```sh
acp-service a2a invoke session_send <<'JSON'
{
  "originSessionId": "actual-parent-session-id",
  "messageId": "handoff-result-001",
  "text": "PPT 任务结果已就绪，请核对报告和产物后继续原任务。"
}
JSON
acp-service a2a invoke session_delivery_get <<'JSON'
{"originSessionId":"actual-parent-session-id","messageId":"handoff-result-001"}
JSON
```

绑定与发送到已有会话不会创建一个新的远端 A2A 工作会话。需要派发新工作时继续使用 `remote_agent_spawn`；需要继续该远端工作会话时使用 `remote_agent_message`。

## 投递 receipt 与恢复

receipt 字段包括 `originSessionId`、`messageId`、`host`、`sessionId`、`status`、`attempts`、`createdAt`、`updatedAt`，并可包含 `nextAttemptAt`、`hostReceiptId`、`error`、`processedAt`、`resolutionNote`。不要把 receipt 当作模型回答。

| 状态 | 含义与处理 |
| --- | --- |
| `pending` | 已持久化，等待投递 |
| `dispatching` | 已记录正在尝试宿主调用；尚无明确受理结果 |
| `retrying` | 确认未受理且可恢复的失败，等待下次尝试 |
| `accepted` | 宿主接受排队；不证明模型运行或业务处理 |
| `unknown` | 可能已受理但无法确认；禁止自动重发，先核对宿主 |
| `rejected` | 已明确拒绝且不能自动恢复；先修复阻碍，再明确决定是否重试 |

每个 origin 按 FIFO 投递；unknown 和 rejected 都会阻塞该 origin 的后续自动投递，其他 origin 可继续。超时、断线或进程中断后无法证明未受理时，Codex 和 DSH 都进入 unknown。宿主可能已经入队，即使命令或 HTTP 响应没有到达 gateway。DSH 的稳定 requestId 有助于幂等，不构成 exactly-once 或跨重启无重复保证。

裸 HTTP 429/503 不足以证明 DSH 未入队，仍按 unknown 处理。只有匹配本次 rpcId、`result.ok: false` 的明确 RPC 拒绝，结合可恢复的响应状态，才允许自动重试。明确拒绝但不可自动恢复时记录 rejected，不把它误当成受理不明。

只有取得宿主入队记录等明确证据，或完成明确拒绝原因的修复后，才能解决 unknown/rejected：

```sh
acp-service a2a invoke session_delivery_resolve <<'JSON'
{
  "originSessionId": "actual-parent-session-id",
  "messageId": "handoff-result-001",
  "accepted": true,
  "note": "已核对宿主入队记录，确认该消息被接受。",
  "hostReceiptId": "verified-host-receipt-id"
}
JSON
```

确认已受理用 `accepted: true`，可补 `hostReceiptId`；**确认未受理且已排除重试阻碍**才用 `accepted: false`，使消息回到 pending 以便重新投递。false 不表示模型尚未运行、结果不满意或用户没有看见通知。不能用猜测解除 unknown；note 应说明核对与修复依据。该工具只适用于 unknown/rejected，不能据此改写其他状态。

投递记录写盘失败时，投递层停止继续发送，健康检查返回 HTTP 503。先修复磁盘空间、目录权限或其他存储故障，再重启 gateway。恢复以磁盘中已持久化记录为准，不在失败后的内存状态上盲目续投。若最后保存的状态为 dispatching，重启后按 unknown 核对宿主是否已受理；健康恢复也不表示该条消息已被模型处理。

## A2A 结果自动回投

在派单前绑定 origin。A2A 任务进入完成、失败、取消、拒绝或需要输入状态后，gateway 仍先生成稳定 notice 并放入持久收件箱；新建 notice 时确定路由：

- origin 已绑定：使用 session 投递，messageId 为 `a2a-notice:<noticeId>`，优先于该任务的旧 `notificationTarget`。
- origin 未绑定：继续使用现有 notificationTarget webhook（若有）和持久 inbox。之后增加绑定不会自动迁移已有 notice。

一个 notice 的路由在创建时固定，避免同一结果经两条路径重复唤醒。自动消息先展示远端最终答复正文（保留其中的 Markdown 产物链接），随后列出 A2A artifact 中明确提供的 HTTP(S) URL，最后附上可解析的任务定位 JSON（taskId、noticeId、originSessionId 等）。`remote_agent_get` 和 inbox 通知新增可选的 `artifactLinks` 信息，原有 result 与查询/ack 机制保持兼容。未提供答复时会明确提示查询，不虚构产物或下载地址。

正常长度的正文完整投递；正文超过 48 KiB（UTF-8）时显示节选并注明完整结果查询入口，独立产物链接列表最多 8 KiB，避免超出宿主队列命令限制。正文和链接是远端任务结果，主 Agent 仍按原授权处理并保存结论后 ack。可用 `session_delivery_get` 查询通知的受理状态；`accepted` 后 notice 仍在 inbox，不自动确认业务完成。升级时保留已持久化投递的原正文和幂等 ID，不因格式升级重发旧通知。

主 Agent 核对结果并完成本轮业务处理后，才调用：

```sh
acp-service a2a invoke remote_agent_ack <<'JSON'
{"originSessionId":"actual-parent-session-id","noticeId":"actual-notice-id"}
JSON
```

ack 会标记通知已处理、记录对应 delivery 的 `processedAt`，并阻止尚未发出的该通知再次触发。它不能撤回宿主已接受的消息。`processedAt` 记录调用者的处理确认，不是独立的模型运行证据。手工 `session_send` 没有 A2A 业务 ack。

未绑定时的旧 webhook 行为不变：非 2xx/超时会重试，HTTP 2xx 后停止 webhook 重投，但 notice 继续留在 inbox。自建 receiver 必须先持久化再回 2xx，并自行负责后续注入与恢复。

## 过程审批请求实时提醒（DSH `steer`）

子任务在执行期间提交工具权限（`permission`）、计划审批（`plan`）或提问（`question`）等过程请求时，若发起方 `originSessionId` 已通过 `session_bind` 绑定，且网关未关闭 `workbench.notifyOriginOnProcessRequest`（默认 `true`），网关在持久化 `ProcessRequest` 后立即写入一条幂等投递并触发即时派发：

- 幂等键使用保留命名空间 `process-request:<requestId>`（`session_send` 拒绝手动使用该前缀）。
- 投递模式为 `mode: "steer"`，并携带 `notice: { form: "notice", summary }`：
  - 对安装了新版 `@1agents/acp-service` 插件的 DSH 宿主，优先调用 `POST /api/1agents-acp/session/deliver`，以原生 `ContextFormed`（`source: { kind: "1agents-acp", form: "notice", summary }`）写入 `agent.steer()`，在 DSH 对话流中渲染为可展开的单行系统通知条（不冒充人类聊天气泡），同时在 ACP 适配器中放行 `1agents-acp` 来源以兼容外部 ACP 主会话；
  - 若旧版 DSH 宿主尚未暴露该路由（返回非 RPC 的 HTTP 404），自动降级到 `/api/session/prompt`（`mode: "steer"`）；对 Codex 宿主仍走 `codex queue`。
- 正文采用 `<system-reminder>` 结构，包含工具名/参数节选、截止时间、授权边界提示、`mcp-a2a-approval.a2a_process_answer` 直调模板（已知精确契约，可跳过 `search → inspect` 直接 `dreammate_invoke`）及定位 JSON；发起方可通过 `mcp-a2a-approval.a2a_process_answer` 或 `a2a-gateway` 的 `execution_process_answer`（`decidedBy: { kind: "coach", ... }`）审批或答复，与任务工作台人工操作先到先得。
- 请求一旦被回答、取消或到期，网关自动标记对应 `process-request:<requestId>` 为已确认，避免尚未发出的过期提醒继续投递。

## 验证边界

先检查实际版本、方法契约、受保护配置和真实会话 ID，再由用户授权的测试消息验证宿主排队。测试应分别确认：receipt 接受、宿主入队、原模型执行、业务处理和最终 ack。不要只凭 accepted 宣称闭环完成。

当前 A2A 工作状态仍是 submitted/working/终态等粗状态；这个投递层没有新增 PPT 页级进度。它也没有接管 Codex 原生子智能体工具，或把标准 ACP 的所有实现改造成支持队列。受理不明时保留证据和 unknown，不能用重新发送来替代核对。
