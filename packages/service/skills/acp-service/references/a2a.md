# A2A 调度、查询与完成通知

## 默认调用边界

日常主会话按 [角色与任务路由](roles-and-tasks.md) 选择管理、固定角色或临时任务入口：开发部署先完成，派单保存回执后立即结束本轮；实际通知唤醒后只读一次回执/新报告、保存结论并按通知类型 ack。现稿 PPT 只验收计步才使用 [专用脚本](async-caller.md)。以下 get/list/inbox 示例是接口说明，只用于真实通知后的单次读取或用户明确要求的单次状态查询，不能组成主会话轮询。后台网关核对照常运行，主会话不读子日志、不等待、不重复产物验收。

## 链路与入口

```text
主 Agent / CLI → 本机 a2a-gateway → 远端 DSH /a2a SendMessage
→ 解析远端 cwd 与 preset → 创建或恢复 DSH 会话 → 返回 taskId
→ 独立执行 → GetTask / SSE / webhook → gateway 持久收件箱 → 主会话处理并 ack
```

当前为 **A2A 1.0 JSON-RPC**，SDK `@a2a-js/sdk@1.3.0`。执行端挂载于 DSH web server；`acp-service serve` 提供 ACP，不会自动开放 DSH A2A。`a2a gateway` 是调用端工具和收件箱，不是另一个 DSH 执行器。

## 远端 DSH 启用 A2A

在现有 `oneagents-acp` 配置行的 `config` 中添加：

```yaml
a2a:
  enabled: true
  tokenEnv: DSH_A2A_TOKEN
  publicUrl: http://dsh-host:3080
  defaultCwd: /home/scott
  defaultAgentPreset: standard
  workspaces:
    demo: /home/scott/projects/demo
  # 仅需要 webhook 时设置接收端实际 origin
  pushNotificationOrigins:
    - http://caller-host:36815
```

目录和主机为示例，应替换为实际部署值。通过 DSH 进程的受保护环境配置 `DSH_A2A_TOKEN`，然后重启 DSH。不要把真实 token 放在技能文档或对话中；DSH UI 登录凭据不是 A2A bearer token。未配置 A2A 时默认关闭，缺少 token 会拒绝激活。

- 公开发现：`GET /.well-known/agent-card.json`。
- 认证调用：`POST /a2a`，`Authorization: Bearer <A2A-token>`、`A2A-Version: 1.0`、`Content-Type: application/json`。
- `publicUrl` 必须是调用端能访问的 DSH origin；`path` 可自定义 RPC 路由。
- `a2a.stateDirectory` 可覆盖默认 `<DSH_HOME>/plugins/1agents-acp/a2a`。

## 调用端 gateway

先复用已有 gateway。新部署时创建受保护的 JSON 配置，例如：

```json
{
  "stateDirectory": "/absolute/private/a2a-gateway-state",
  "port": 36814,
  "remotes": {
    "wsl-dsh": { "url": "http://dsh-host:3080", "token": "replace-with-protected-A2A-token" }
  }
}
```

```sh
chmod 600 /absolute/private/gateway.json
acp-service a2a gateway --config /absolute/private/gateway.json
curl http://127.0.0.1:36814/health
```

CLI 启动时若配置没有 `capacityDirectory`，`/health` 读取本机 ACP 容量目录，并给出 `taskSlot` 与 `processSlot`。`processSlot.headWaitMs` 是进程名额 FIFO 队首已等的毫秒数。直接调用库且未传该目录时，健康检查不读取家目录里的容量账。

Unix 上 CLI 校验配置权限。gateway 工具端口固定监听 `127.0.0.1`，默认 `36814`；省略 `--no-report` 会向本机 DreamMate node 注册 `a2a-gateway`。不用 DreamMate 时加 `--no-report`，通过 CLI 使用。凭据仅保存在配置中，不传入任务参数。

callback 可选；不配置也会由后台 GetTask 查询补齐状态。需要 push 时增加：

```json
{
  "callback": {
    "host": "caller-bind-IP",
    "port": 36815,
    "url": "http://caller-host:36815/a2a-events",
    "token": "replace-with-separate-callback-token"
  }
}
```

替换可绑定的 IP 与 DSH 可达的 URL，并将 URL 的精确 origin 加入远端 `pushNotificationOrigins`。回调监听器只开放配置的事件路径，不开放工具 `/invoke`；本地工具端口拒绝浏览器 Origin 调用。`originSessionId` 是可信本地调用端使用的通知路由 ID，不是认证凭据。

## 远端任务工具

DreamMate 调用参数为 `service_id: "a2a-gateway"`、`method: 方法名`、`params: 参数对象`；先查询服务和方法契约。CLI 则从 stdin 读取同一参数 JSON：

| 方法 | 参数与用途 |
| --- | --- |
| `remote_agent_preflight` | `remote, originSessionId, cwd`；可选任务目录、必需输入和运行时依赖，仅检查、不创建会话 |
| `remote_agent_spawn` | 必填 `remote, originSessionId, cwd, prompt`；可选 `agentPreset, title, notificationTarget, preflight, resultContract, clientRequestId, roleId, roleLockPath, lifecycle, provider, model`；新建远端任务/上下文/DSH 会话。省略 `lifecycle` 保持 persistent。`provider`、`model` 见下文「standard 选模型」 |
| `remote_agent_get` | `remote, originSessionId, taskId`；当前状态、结果；离线返回缓存与 stale。进程名额排队时仍是 submitted，并带 `capacity`、`taskSlot` 和 `processSlot`。指定过模型的 `standard` 任务带实际使用的 `provider`、`model` |
| `remote_agent_message` | 上述任务定位字段加 `prompt`；可选 `clientRequestId, preflight, resultContract, roleId, roleLockPath, autoResume, lifecycle, provider, model`；复用远端会话，创建新 taskId；已有角色/锁不能更换。已关闭会话默认接回，get 返回 `resumed: true` 和实际 `restoreMethod`（`session/load` 或绑定里的 `session/resume`）。`autoResume: false` 不向远端发送，返回 `SESSION_CLOSED` |
| `remote_agent_cancel` | 任务定位字段；只取消这项任务自己的执行，不能释放已经完成的会话进程 |
| `remote_agent_close` | `remote, originSessionId`，以及 `taskId`、`contextId`、`sessionId` 三选一；可选 `force`。普通关闭 ACP 进程，保留会话记录和绑定，不删除。进行中返回 `SESSION_BUSY`；`force: true` 先取消再关闭。宿主没有关闭能力时返回 `UNSUPPORTED`，且不把任务记成已关闭。`standard` 不发送 `session/close`。可选 `mode: "delete"` 还删除 ACP 会话记录，之后 message 返回 `SESSION_DELETED`；仅在网关 `sessionLifecycle.allowDelete: true` 时接受，否则返回 `DELETE_DISABLED`。不删 DSH 会话历史 |
| `remote_agent_sessions` | 无业务参数。按 `prewarm`、`job`、`user-opened` 和未标注列进程租约，并给出两本账。只读，不关闭，也不给已经在跑且没有来源的进程补标签 |
| `remote_agent_list` | `originSessionId`；列出该主会话派发的任务 |
| `remote_agent_inbox` | `originSessionId`；读取未确认的完成/需要输入通知 |
| `remote_agent_ack` | `originSessionId, noticeId`；确认已处理，重复确认安全 |

```sh
acp-service a2a invoke remote_agent_spawn <<'JSON'
{
  "remote": "wsl-dsh",
  "originSessionId": "actual-parent-session-id",
  "cwd": "/home/scott",
  "agentPreset": "standard",
  "title": "只读系统健康巡检",
  "prompt": "实际采集 CPU、内存、磁盘、服务状态并总结。仅只读；不安装、不修改、不重启、不读取凭据。"
}
JSON
```

CLI 和 DreamMate 都返回业务结果对象；spawn 的 `taskId`、`contextId`、`sessionId`、实际 cwd/preset 位于该对象中，`result` 字段是任务报告文本。受理返回 `TASK_STATE_SUBMITTED` 不等于完成。

```sh
acp-service a2a invoke remote_agent_get <<'JSON'
{"remote":"wsl-dsh","originSessionId":"actual-parent-session-id","taskId":"returned-task-id"}
JSON
acp-service a2a invoke remote_agent_inbox <<'JSON'
{"originSessionId":"actual-parent-session-id"}
JSON
# 处理通知结果后：
acp-service a2a invoke remote_agent_ack <<'JSON'
{"originSessionId":"actual-parent-session-id","noticeId":"returned-notice-id"}
JSON
```

每次 spawn 都创建新会话，即使 cwd 相同。这次新会话会回放该工作区、该 Agent 在 ACP 设置里已经接受的模式和配置；Grok Build 与 Codex 的记录各自保存。message 复用原 context/cwd/preset 和原会话上的设置，创建新任务；可排队，但不是对当前轮的原生 interrupt/steer。未传 `lifecycle` 时 message 沿用原会话策略。`remote_agent_*` 没有 `modelId`、`modeId` 或显式恢复任意 DSH session ID 的参数。

**standard 选模型。** `provider` 和 `model` 只用于 `standard` 等 DSH 原生预设，必须一起传，例如 `"provider": "deepseek", "model": "<目录里的模型 id>"`。DSH 新建会话后、第一条 prompt 前，按 `modelCatalog()` 核对，再调用 `selectModel`。目录里没有时任务失败，`resultMetadata.validation.code` 为 `MODEL_UNAVAILABLE`，不退回默认模型，也不发 prompt。省略时用 DSH 当时的默认模型，get 不带这两个字段。message 不传时沿用该会话已选的模型，传了就在本轮前切换。`oneagents-acp-*` 预设传这两个字段会被拒绝（宿主侧为 `MODEL_SELECTION_UNSUPPORTED`），它们的模型由 Agent 自己公布，经 `session/set_config_option` 切换。get 与 `resultMetadata` 写出实际使用的 `provider`、`model`。不要把模型名写进 prompt，那不会改会话模型。注意：DSH 的 `selectModel` 同时把这次选择存成 DSH 的默认模型，之后不指定模型的新会话（包括 DSH 界面里新开的）会用它。投递到已存在的主会话使用下面新增的 `session_*` 工具，两类 API 的任务 ID 和会话 ID 不可混用。

`lifecycle.mode: "one-shot"` 在任务完成、失败或取消后由网关普通关闭进程。`closeAfter: "ack"` 要等这条通知被 ack。`INPUT_REQUIRED` 不关闭。one-shot 在 runtime 里仍调用 `ensureSession({ mode: "persistent" })`，关闭只 release，不 delete，也不改 runtime 模式。`remote_agent_get` 在进程名额排队时仍是 submitted，并带 `capacity.position` 与 `capacity.waitedMs`；60 秒握手时限从出队之后才开始计。本技能不保证模型在进程关闭后仍记得上文。

persistent 的 `oneagents-acp-*` 会话在最后一轮结束、远端 `status` 确认已附着且没有进行中的回合，并且空闲超过时限后，由网关普通关闭，原因 `idle-ttl`，之后 message 仍可接回。时限缺省取网关配置 `sessionLifecycle.persistentIdleTtlSeconds`（600 秒），`lifecycle.idleTtlSeconds` 覆盖它，`0` 不回收。进行中、`INPUT_REQUIRED`、状态查不到的不关。`INPUT_REQUIRED` 超过 `sessionLifecycle.inputRequiredAlertSeconds`（7200 秒）只告警，不关进程。`/health` 的 `sessions` 给出 busy、告警、按原因的关闭数、恢复方式、关闭失败数和 `processReleasePending`。

## 原会话排队投递（本次新增）

这是可选 gateway 能力。以当前安装的方法契约和真实绑定为准；没有 `sessionHosts` 和绑定时保留原收件箱/webhook 路径。普通 MCP 连接本身不证明可自动唤醒。

gateway 配置中的 `sessionHosts` 按名称定义宿主。`kind: "codex"` 使用原生 `codex queue --thread=<UUID> --message=<原文>`，可配置 `executable`、`remote`、`cwd`、`timeoutMs` 和 `remoteAuthTokenEnv`；进程参数不经 shell。`kind: "dsh"` 使用宿主 origin 的 `/api/session/prompt`，按其 Web Remote envelope 发送 `mode: "queue"` 和稳定 requestId，可配置 `url`、`headers`、`timeoutMs`。这条路径直接使用已有宿主队列，无需另设通知 receiver。

DSH `headers` 是部署所需的 Cookie/Authorization 等受保护配置，不是工具参数；不要把真实值放入 prompt、receipt、日志或文档。DSH UI/宿主凭据与远端 A2A bearer token 是不同用途，不能混用。Codex 的远端认证同样通过配置的环境变量提供。

宿主传输 ID 使用 `sha256([originSessionId, messageId])` 稳定派生，避免不同 origin 的同名消息在宿主发生冲突。DSH requestId/rpcId 使用该派生 ID；外部工具仍用原 messageId 查询和恢复，`hostReceiptId` 以宿主实际回执为准。

| 新增方法 | 参数与用途 |
| --- | --- |
| `session_bind` | `originSessionId, host, sessionId`；将 origin 绑定到命名宿主的已有会话。重复同一绑定安全，不能静默换成另一目标 |
| `session_send` | `originSessionId, messageId, text`；持久化后立即返回投递 receipt。同一 ID 重复正文安全，改正文冲突；禁止保留前缀 `a2a-notice:` |
| `session_delivery_get` | `originSessionId, messageId`；查询投递状态，不等同于模型执行状态 |
| `session_delivery_resolve` | `originSessionId, messageId, accepted, note`，可选 `hostReceiptId`；只解决 `unknown/rejected`。确认已受理填 true；有证据确认未入队且已处理阻碍才填 false，使其回到 pending |

CLI 复用现有 `a2a invoke`，DreamMate 使用同名 gateway 方法：

```sh
acp-service a2a invoke session_bind <<'JSON'
{"originSessionId":"actual-parent-session-id","host":"codex-local","sessionId":"actual-codex-thread-uuid"}
JSON
acp-service a2a invoke session_send <<'JSON'
{"originSessionId":"actual-parent-session-id","messageId":"handoff-result-001","text":"任务结果已就绪，请核对报告后继续原任务。"}
JSON
acp-service a2a invoke session_delivery_get <<'JSON'
{"originSessionId":"actual-parent-session-id","messageId":"handoff-result-001"}
JSON
```

示例需要真实配置和用户授权，文档中的命令未执行。receipt 含 `originSessionId/messageId/host/sessionId/status/attempts/createdAt/updatedAt`，可含 `nextAttemptAt/hostReceiptId/error/processedAt/resolutionNote`。状态为 `pending → dispatching → accepted`，确定未受理的可恢复失败进入 `retrying`；明确拒绝且不可自动恢复进入 `rejected`；超时、断线或崩溃后无法确认受理时进入 `unknown`。DSH 裸 HTTP 429/503 不能证明未受理；仅匹配 rpcId、`result.ok: false` 的明确 RPC 拒绝才可按可恢复错误重试。Codex 与 DSH 均不会盲目重发受理不明的消息。每个 origin 按 FIFO 投递，unknown/rejected 阻塞后续消息。`session_delivery_resolve` 的 note 应记录核对与修复依据。

投递记录写盘失败时停止继续投递，健康检查返回 503。先修复磁盘或目录问题，再重启 gateway，按磁盘中已保存记录恢复；不在不可靠的内存状态上自动续投。重启时，持久化为 dispatching 的消息仍需按 unknown 核对，不能直接重发。

`accepted` 只证明宿主接受排队，不证明模型已运行或完成业务。DSH 的稳定 requestId 不构成 exactly-once 保证。A2A notice 在新建时若 origin 已绑定，会冻结 session 投递路由，使用 `messageId: "a2a-notice:<noticeId>"` 自动进入该层，优先于原 notificationTarget；未绑定的 notice 仍走旧 webhook/inbox，后来绑定不会自动迁移旧 notice。

自动消息先展示最终答复正文及其中的 Markdown 产物链接，随后列出 A2A artifact 明确提供的 HTTP(S) URL，末尾附 notice/task 定位 JSON。任务查询返回 `result` 与 `artifactLinks`，主 Agent 仍可使用 `remote_agent_get` 或 `remote_agent_inbox` 核验完整结果。超过 48 KiB 的正文显示有明确标注的节选，独立产物链接列表最多 8 KiB；完整内容通过查询获取。已持久化的旧通知保留原正文，不因格式升级重发。

notice 继续保留在 inbox；主 Agent 真正处理结果后才调用 `remote_agent_ack`。ack 会记录对应 delivery 的 `processedAt`，并阻止尚未发出的通知再次触发。手工 `session_send` 没有自动业务 ack。`processedAt` 表示调用者确认已处理，不能当作独立验证的模型运行证据。完整配置、状态和恢复步骤见仓库 `docs/session-delivery.md`。

## 直接使用标准 A2A

请求体示例，认证与版本放在 HTTP headers 中：

```json
{
  "jsonrpc": "2.0",
  "id": "submit-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "unique-message-id",
      "role": "ROLE_USER",
      "parts": [{ "text": "只读检查项目 README 并总结", "mediaType": "text/plain" }]
    },
    "configuration": { "returnImmediately": true },
    "metadata": { "1agents": { "workspace": "demo", "agentPreset": "standard" } }
  }
}
```

响应在 `result.task`，包含 `id`、`contextId` 和已有的 `metadata.1agents.sessionId/cwd/agentPreset`。`returnImmediately: true` 返回受理任务；配置网络角色的冷下载和会话准备可在受理后进行，首回执可能尚无 sessionId。普通无角色任务保持会话准备后返回的时序；省略则默认等待终态或需要输入状态。

`metadata.1agents` 的调用输入支持 `cwd/workspace/agentPreset/preflight/resultContract/roleId/roleLockPath`。cwd 和 workspace 不可同时传，cwd 为远端现有绝对目录，workspace 为配置别名；省略位置与预设按远端默认值处理。roleId 必须在宿主可信映射中；roleLockPath 仅接受宿主缓存 locks 目录内已存在、身份与字节校验通过的父锁，不能通过任务参数覆盖 profile、网络或缓存根。

同一会话的新任务在 `message.contextId` 传已保存 context ID；保存的 cwd/preset 不能改变。已完成 task 不可重新打开。原 task 为 input-required 时可传 `message.taskId`，配合新的 `messageId` 继续；活跃 task 上的 follow-up 被拒绝。

| 标准方法 | 用法 |
| --- | --- |
| `GetTask` | `params: { "id": "task-id" }`；查询任务状态/历史/结果 |
| `ListTasks` | 按协议做作用域过滤与分页 |
| `SubscribeToTask` | `params: { "id": "task-id" }`；SSE，从当前任务快照开始；终态任务直接查询 |
| `SendStreamingMessage` | 提交并 SSE 观察；客户端断开不会取消独立执行 |
| `CancelTask` | `params: { "id": "task-id" }`；取消任务自己的排队或运行 |
| `Create/Get/DeleteTaskPushNotificationConfig`、`ListTaskPushNotificationConfigs` | webhook 配置生命周期 |

支持文本 prompt；不要发送附件或旧 v0.3 消息结构。终态包括 completed、failed、canceled、rejected；input-required/auth-required 需要继续处理，不是成功完成。

## 通知、持久化与恢复

发送配置里可加入标准 `taskPushNotificationConfig`（URL 的 origin 须被允许）：

```json
{
  "returnImmediately": true,
  "taskPushNotificationConfig": {
    "url": "http://caller-host:36815/a2a-events",
    "authentication": { "scheme": "Bearer", "credentials": "protected-callback-token" }
  }
}
```

DSH webhook 发送 A2A `StreamResponse`（`application/a2a+json`），含 task/artifactUpdate/statusUpdate。它按任务排序、超时 5 秒、拒绝重定向，尽力投递且不重试。回调提示不能替代可信的 GetTask 查询。

gateway 将状态、任务归属和通知原子落盘；通知有稳定 `noticeId`，读取不会确认。默认每 3 秒后台核对任务，丢失 webhook 或 gateway 重启后仍能补齐。主机离线只导致 `stale`，不会伪造远端 failed。

若要通知主 Agent 宿主，在 gateway 配置中增加 `notificationTargets` 名称映射，每项为 `{ "url": "http://host/notice", "token": "protected-token" }`，spawn 时传 `notificationTarget` 名称。这里接收的是 gateway notice（含 originSessionId/taskId/contextId/state/result），不是原始 A2A StreamResponse。

旧宿主通知使用 Bearer 与稳定 `Idempotency-Key`；失败或 gateway 重启后重试，直到接收端接受或通知被 ack。HTTP 2xx 后停止 HTTP 重投，但通知仍留在 inbox；接收宿主须先持久化/去重，再负责注入与恢复。HTTP 成功只代表接收，不证明主模型已运行。上面的新增 session 绑定提供 Codex/DSH 原会话队列适配；未绑定 origin 继续使用此旧路径。

执行端和 gateway 状态目录各由单个活跃实例拥有，不应手工删除运行中实例的 lock。gateway 重启不取消远端任务；DSH 重启会将中断任务标为 failed，保留已完成结果和 context 映射，新任务可用 context 恢复 DSH 会话，不自动重放中断工作。

## 共享实现

`@1agents/acp-service/a2a` 导出 `createA2AServer`、`FileA2AStore`、`RemoteAgentGateway`、`serveA2AGateway` 及类型。server 接收 `A2ABackend`，核心不依赖 DSH，工厂本身不创建网络 listener；DSH 通过公开 session-controller API 提供 backend 并挂载路由，独立入口可复用这套实现。


## 派单前预检和系统结果元数据

`remote_agent_preflight` 在真实执行宿主完成检查，经 Agent Card 的同源 JSONRPC 地址调用认证的 `/preflight` 扩展。参数除 remote/originSessionId/cwd 外，可含：

```json
{
  "jobDirectory": "/tmp/actual-job",
  "requiredFiles": ["/absolute/input.md"],
  "python": {"executable": "/absolute/python3", "modules": ["defusedxml"]},
  "node": {"executable": "/absolute/node", "modules": ["@oai/artifact-tool"], "moduleRoot": "/absolute/node_modules"}
}
```

目录须已存在；预检核验真实路径、任务目录属于项目或平台临时目录，并创建随后删除的小文件确认可写。Python/Node 使用指定解释器检查依赖，有超时且不经过 shell。返回 `ok, checkedAt, cwd, jobDirectory, checks`；ok=false 时不得派单。spawn/message 的可选 `preflight` 接收同一检查要求（不带 cwd/remote/originSessionId），gateway 在创建 A2A 任务前检查，DSH backend 在创建原生会话前重检。旧调用保持兼容，DSH 至少检查 cwd。预检是一时刻的检查，无法保证后续磁盘和依赖永不变化。

spawn/message 可传 `resultContract: {jobId, parentTaskId?, parentSessionId?, originSessionId?, artifactManifestPath?}`。身份不由模型填入：get/list 的 `resultMetadata` 来自执行宿主，包含真实 task/context/session/request ID、cwd/preset、起止时间、outcome、预检和验证后的产物。lineage 明确标为调用方声明。manifest 路径及所列文件均须在已通过预检的 jobDirectory 内，严格格式：

```json
{"artifacts":[{"path":"/tmp/actual-job/final.pptx","url":"http://actual-host/artifacts/job/final.pptx","mediaType":"application/vnd.openxmlformats-officedocument.presentationml.presentation"}]}
```

宿主计算文件大小和 SHA256，拒绝越界、符号链接和伪造字段；manifest 校验失败会使该轮任务失败，不将模型声称的交付当作成功。公开副本的 URL 由调用方/worker 提供，业务验收仍需下载对比。系统在任务目录写 `result-metadata.<taskId>.json`，已验证 URL 同时进入 A2A artifactLinks。续派返回新 taskId，每轮均有独立系统记录；不改变父任务覆盖范围、通知格式或 ack 机制。

本机完整安装包的来源、校验、离线重装及回滚见工程 `docs/local-reproducible-deployment.md`，不再以单个编译文件的临时替换作为部署来源。
