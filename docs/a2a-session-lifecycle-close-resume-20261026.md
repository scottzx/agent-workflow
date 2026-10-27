# a2a-gateway 会话生命周期改造方案：关闭（close）与续聊（resume）

- 整理日期：2026-10-26（Asia/Shanghai）
- 状态：**代码核对记录，未实现**。第九节的待决定项已由 [缺口收口方案](a2a-gap-closure-plan-20261027.md) 锁定；实施以该方案为准。本文没有改代码、没有重启任何服务。
- 起因：口播样片 02–06 批次（2026-10-26）中，已完成任务留下的 grok 会话长期占用 ACP 进程容量，后续 spawn 卡在容量 FIFO，最后只能人工清理进程。
- 代码依据：仓库 `develop` 分支源码（`packages/service` 为 0.9.0）。Mac 上正在跑的是 `@1agents/acp-service` **0.8.3**，本文引用的行为需要在 0.8.3 上再核对一遍（见第九节）。
- 项目目录：`/Users/scott/Documents/01-开发项目/1agents/1agents_app/modules/1acp`

## 一、背景与问题

### 1.1 现象

1. 一个 A2A 任务变成 `TASK_STATE_COMPLETED`，主会话在收件箱 `remote_agent_ack` 之后，远端 DSH 会话和它下面的 ACP 会话**都不会关闭**，grok 子进程也不会退出。
2. 子进程不退出，设备容量账本（`~/.1agents/state/acp-capacity/`）里的进程名额就一直被占着。02–06 批次后段，新的 `remote_agent_spawn` 一直停在：
   `Pending: waiting in FIFO order for device memory and ACP capacity.`
   最后清掉 4 组陈旧 grok 会话之后，06 才派出去。
3. 对已经结束的任务调 `remote_agent_cancel` 会直接报 `Task not cancelable: <taskId>`，没法用 cancel 释放会话。
4. ACP 服务本身支持 `session/resume`、`session/load`、`session/close`、`session/delete`，但网关对外没有开放 close 和 resume。每次 spawn 都新建会话，`remote_agent_message` 也只能复用还活着的上下文。

### 1.2 调用链与代码位置

```text
主会话 ──(dreammate / acp-service a2a invoke)──▶ a2a-gateway  (packages/service/src/a2a/gateway.ts)
   ──A2A HTTP──▶ DSH 上的 A2A 服务 + A2AExecutor            (packages/service/src/a2a/executor.ts, server.ts, store.ts)
   ──A2ABackend──▶ DshA2ABackend.prepare/run              (packages/dsh-plugin/src/a2a-executor.ts)
   ──DSH 会话──▶ ACP 适配器（每个 DSH agent 一条 ACP 链路）     (packages/dsh-plugin/src/adapter.ts)
   ──ACP WebSocket──▶ acp-service 连接层 ensure/close/delete  (packages/service/src/acp-connection.ts)
   ──runtime──▶ grok 子进程（受 capacity-lifecycle 管名额）     (packages/service/src/capacity-lifecycle.ts)
```

| 层 | 已确认的行为 | 对本问题的意义 |
| --- | --- | --- |
| 网关方法表 `REMOTE_AGENT_METHODS`（gateway.ts:104 起） | 只有 `preflight / spawn / get / cancel / message / list / inbox / ack`。spawn 的描述写明「每次 spawn 创建新会话」。 | 没有 close 和 resume 入口。 |
| `remote_agent_cancel`（gateway.ts:952 起） | 转发为 A2A `CancelTask`。 | 只对进行中的任务有效。 |
| A2A SDK 1.3.0 `cancelTask` | 已是 CANCELED 直接返回；其他终态抛 `TaskNotCancelableError`。 | 这就是 `Task not cancelable` 的来源，不是网关的 bug。 |
| `A2AExecutor.execute` 的 `finally`（executor.ts 末尾） | 只 `capacityLease.release()` 释放**任务**名额，然后 `active.delete`。 | 任务名额会释放，但不碰会话和进程。 |
| `FileA2AStore.saveTarget(contextId, target)`（store.ts:279） | 持久保存 contextId → `{sessionId, cwd, agentPreset, roleSkills}`。 | 「同一 contextId 再来消息就回到同一会话」的映射已经存在。 |
| `DshA2ABackend.prepare`（a2a-executor.ts:82） | 带 sessionId 时 `sessionController.inspect` 找回原会话，并校验 cwd 和 preset 不能变。不带时 `sessionController.create` 新建。 | 续聊的身份校验已有现成实现。 |
| `capacity-lifecycle.ts` | 「The runtime owns child termination; capacity remains reserved until its exit is observed」，只在 `onExit` 时释放进程名额。 | 进程不退出，名额就永远不放。 |
| `docs/device-capacity-queue-20261023.md` | 明确写了「本层不会为腾空间强杀运行任务，亦不强制回收空闲的持久会话。持久进程达到上限时需要关闭不再需要的会话」。 | 设计上本来就要求有人去关会话，只是网关没给调用方关的入口。 |
| acp-connection.ts `ensure()`（约 293–420 行） | `session/new` 新建；`session/load` 和 `session/resume` 重新附着已有会话。已删除返回 `-32003 Session was deleted`；找不到返回 `-32001`；cwd 或 Agent 变化返回 invalidParams；load 缺完整回放返回 `-32000 … use session/resume`。 | 恢复和报错语义都现成。 |
| acp-connection.ts `session/close`（约 459 行） | `close_session` 后从 attached 移除，并把挂起的 prompt 结束为 `cancelled`。**不删除记录**，之后还能 load 或 resume。 | close = 释放进程，保留历史。 |
| acp-connection.ts `session/delete`（约 478 行） | 先 close，再 `delete_session`，然后标记 `deleted: true`。 | delete = 彻底删除，不能再恢复。 |
| adapter.ts（约 290–350 行） | 没有 binding 时 `session/new`；有 binding 时按 `restoreMethod ?? 'session/load'` 恢复（新建的 binding 记为 `session/resume`）。链路断开后下一次 prompt 会懒恢复。 | DSH 已具备「链路断了，下次用时再恢复」的能力，但只在 DSH 内部用，网关没有主动关链路的入口。 |

### 1.3 根因

**「任务结束」和「会话结束」是两件事，系统只处理了前者。** 现在没有任何一层会在任务终态后关闭会话：A2A 协议本身没有会话关闭语义，executor 只管任务名额，DSH 把会话当长期对象，容量层又明确规定不强制回收。结果是：一次性任务（口播出片、报告生成）也按持久会话处理，每 spawn 一次就多一组常驻 grok。

## 二、目标与非目标

**目标**

1. 调用方能显式关闭一个远端会话，关闭后对应子进程退出，进程名额释放。
2. 关闭（可恢复）和删除（不可恢复）分开，语义清楚。
3. 关闭后可以续聊：在同一个 contextId 和 sessionId 上重新附着，尽量保留上下文。
4. 一次性任务可以声明「完成即关」，不再靠人工清理。
5. 闲置会话有兜底回收（TTL 加 reaper），并且有指标可看。
6. 向后兼容：不传新参数时行为与现在一致，旧调用方不受影响。

**非目标**

- 不改变 A2A 任务状态机，也不让终态任务「复活」。续聊永远产生新的 taskId。
- 不为腾容量强杀正在执行的任务（与容量文档一致）。
- 不在网关里做跨 Agent 或跨 cwd 的会话迁移。
- 不处理用户在原生 DSH、Codex 里直接开的会话，只管 A2A 派出的会话。
- 不在本轮改审批策略（sessionPolicy）的加载方式。「改策略要重启 DSH」是另一个问题，见第九节。

## 三、接口设计

### 3.1 `remote_agent_close`

```jsonc
// 入参
{
  "originSessionId": "…",          // 路由与归属范围，见第六节
  "remote": "ppt-beautifier",
  "taskId": "…",                   // 三选一定位：taskId / contextId / sessionId
  "contextId": "…",
  "sessionId": "…",
  "mode": "close" | "delete",      // 默认 close
  "force": false,                  // 会话有进行中的任务时：false 报错，true 先取消再关
  "clientRequestId": "…"           // 可选，幂等
}
// 出参
{
  "remote": "…", "contextId": "…", "sessionId": "…",
  "state": "closed" | "deleted",
  "alreadyClosed": false,
  "processReleased": true | "pending",   // 子进程退出事件是否已观察到
  "canceledTaskIds": []
}
```

- **定位**：网关先在本地 `state.jobs` 里按 `originSessionId` 范围找到 job，得到 `contextId` 和 `sessionId`（job 的 `task.metadata['1agents'].sessionId`，gateway.ts:214/284/710 已经在投影这个字段）。只能关闭本 origin 派出的会话。
- **close 语义**：远端依次执行：DSH 侧通过适配器对该 agent 的 ACP 链路发 `session/close`，然后关闭链路；acp-service 执行 `close_session`，runtime 结束子进程，`onExit` 触发后 `capacity-lifecycle` 释放进程名额。DSH 会话记录、ACP 绑定和 runtime 记录都**保留**，`FileA2AStore` 里 contextId → target 的映射也保留。
- **delete 语义**：在 close 的基础上，ACP 执行 `session/delete`（标记 `deleted: true`），远端 store 把 contextId 标记为 `deleted`。之后 resume 和 message 一律失败。DSH 原生会话历史是否一起删除见第九节，默认**不删**宿主历史，只断开 A2A 和 ACP 绑定。
- **进行中任务**：默认返回 `SESSION_BUSY`。`force: true` 时先对该上下文的活动任务走现有 cancel 路径（`A2AExecutor.cancelTask`），等任务进入终态后再关。
- **重复调用**：已关闭再关返回 `alreadyClosed: true`，不报错。

**远端怎么承接（关键实现点）**：A2A 标准里没有「关闭会话」，所以需要 DSH 上的 A2A 服务新增一个**扩展端点**。有两种做法，倾向 B：

- A. 用 A2A 的 extension 方法，例如 JSON-RPC `1agents/session.close`。好处是走同一端点、同一份 remote token。
- B. 在 `server.ts` 加 REST 路由 `POST /1agents/sessions/{contextId}:close`，鉴权复用该 remote 现有的 token 校验。

无论选哪种，`A2ABackend` 接口都要新增两个**可选**方法，没实现的宿主返回 `UNSUPPORTED`：

```ts
close?(target: A2ATarget, options: { mode: 'close' | 'delete'; signal?: AbortSignal }): Promise<{ processReleased: boolean | 'pending' }>;
status?(target: A2ATarget): Promise<{ attached: boolean; activeTurn: boolean; lastUsedAt?: string }>;
```

`DshA2ABackend.close` 的实现方向：在 adapter 里新增按 DSH agent 关闭 ACP 链路的方法（发 `session/close` 后执行 `link.close()` 和 `links.delete()`，复用 adapter.ts 约 252–255 行已有的退役逻辑），**不**销毁 DSH 会话本身。

### 3.2 `remote_agent_resume`

```jsonc
{
  "originSessionId": "…", "remote": "…",
  "taskId" | "contextId" | "sessionId": "…",
  "prompt": "…",                   // 可选；不带则只重新附着，不产生任务
  "clientRequestId": "…"
}
```

- **带 prompt**：等价于对已关闭的会话调 `remote_agent_message`。新建 taskId，复用 contextId，executor 用 `loadTarget` 拿到原 sessionId，`DshA2ABackend.prepare` 进入「已有会话」分支。适配器发现没有链路，会用 binding 的 `restoreMethod`（`session/resume` 或 `session/load`）重新附着。acp-service `ensure()` 把 `record.acpSessionId` 作为 `resumeSessionId` 交给 runtime。**这条链路代码上已经基本存在**，新接口主要补的是显式入口、错误语义和容量排队提示。
- **不带 prompt**：只预热，重新附着后保持空闲，并受 idle TTL 约束（见 3.3）。主要用于「先拉起来再连续发几条」的场景，优先级低，可以放到第二期。
- **恢复方式**：优先 `session/resume`。导入会话或缺完整回放时 load 会返回 `-32000 … use session/resume`，此时只能 resume，不再尝试 load。
- **校验**（全部复用现有实现）：
  - cwd 必须与原会话一致（ensure 里的 `Session workspace cannot change`，加上 prepare 里的 `Existing session cwd conflicts`）。
  - agentPreset 不能变（`Existing session preset conflicts` / `Session Agent cannot change`）。resume 入参**不接受** cwd 和 agentPreset，避免误传。
  - 审批策略（sessionPolicy）在 adapter 重连时按 `cwd + agent` 重新匹配 `this.config.sessionPolicies`。如果策略在会话关闭期间被撤回，恢复后按**当前**策略执行，而不是创建时的策略。这是预期行为，需要写进 SOP。
  - 固定角色（roleId 或 roleLockPath）沿用原 target 的 `roleSkills`，不允许 resume 时切换角色。
- **已删除的会话**：ACP 返回 `-32003 Session was deleted`，网关映射为 `SESSION_DELETED`，不重试也不自动新建。调用方必须显式 spawn。
- **找不到会话**：`-32001`，或 DSH `Session … not found`，映射为 `SESSION_NOT_FOUND`。
- **grok 自身能否恢复上下文**：取决于 runtime 记录里有没有 `acpSessionId`，以及 grok-build 是否支持原生 resume。如果不支持，就只能恢复 ACP 侧的回放历史，模型侧上下文可能丢失。**这一点需要实测**（见第九节），结果要写进 profile。

### 3.3 spawn 新增 `lifecycle` 选项

```jsonc
"lifecycle": {
  "mode": "persistent" | "one-shot",   // 不传 = persistent，与现状一致
  "idleTtlSeconds": 1800,               // 仅 persistent，可选
  "closeAfter": "terminal" | "ack"      // 仅 one-shot，默认 terminal
}
```

- **one-shot**：任务进入 COMPLETED、FAILED 或 CANCELED 后（`closeAfter: "ack"` 则在主会话 ack 之后），网关自动发起 `remote_agent_close(mode: close)`。只是 close，不是 delete，所以事后仍可 resume 追问。`INPUT_REQUIRED` 不算终态，不关。
- **persistent**：保持现状，另外可以设置 `idleTtlSeconds`，由 reaper 兜底回收（第五节）。
- 生命周期写入 job 和远端 store，`remote_agent_message` 和 resume 后沿用原值，可在 message 时覆盖。
- `execution_submit` 的目标登记（targets）可以给出默认 lifecycle，例如口播、报告类目标默认 one-shot。固定角色不接受调用方覆盖 cwd 和 preset，但**允许**覆盖 lifecycle。

### 3.4 `remote_agent_message` 遇到已关闭会话

建议：**默认自动恢复，但必须在返回值和任务元数据里标明**，不悄悄恢复。

- 返回值增加 `resumed: true` 和 `restoreMethod: "session/resume" | "session/load"`。
- 会话是 `deleted` 状态：返回 `SESSION_DELETED`，不自动新建。
- 提供开关 `autoResume: false`。设为 false 时，遇到已关闭会话返回 `SESSION_CLOSED`，交给调用方决定。
- 恢复需要重新申请进程名额。名额不足时与 spawn 一样进入 FIFO，状态文字仍是 `Pending: waiting in FIFO order…`，不算失败。

这样旧调用方不需要改，现有「message 复用 contextId」的行为也成立。区别只是名额释放之后再续聊，要多一次冷启动。

## 四、状态模型与持久化

### 4.1 会话状态

```text
            spawn / resume
   (none) ───────────────▶ attached ──任务运行──▶ busy
                              ▲  │                 │
               resume/message │  │ close / TTL     │ 任务终态
                              │  ▼                 ▼
                           closed ◀──────────── attached(idle)
                              │
                              │ delete
                              ▼
                           deleted（终态，不可恢复）
```

- `closed`：没有子进程、不占进程名额，记录保留，可以恢复。
- `closing`：中间态。已发 close，但还没观察到子进程退出（`processReleased: "pending"`）。这时的 resume 需要等 closing 结束。

### 4.2 持久化位置

| 位置 | 新增或修改 | 说明 |
| --- | --- | --- |
| 网关 `stateDirectory`（当前 `…/1acp/.1agents/state/a2a-gateway`）中的 job | job 增加 `sessionId`（目前只在 `task.metadata` 里，建议提升为一等字段）、`lifecycle`、`sessionState`、`closedAt`、`closeReason`（`explicit / one-shot / idle-ttl / admin`）。 | 网关重启后仍能知道哪些会话应该关、哪些已关。 |
| 远端 `FileA2AStore`（contextId → target） | target 增加 `state: attached/closed/deleted`、`lastUsedAt`、`lifecycle`。 | resume 必须靠这份映射找回 sessionId。**store 必须持久化**，内存态不行。 |
| acp-service 连接层 state（`state.create({...deleted})`） | 不变。 | 已持久化 deleted 标记，`-32003` 由它产生。 |
| 设备容量账本 | 不变。 | 名额只跟随子进程退出事件，不由网关直接改账本。 |

### 4.3 与 DSH 重启的关系

- DSH 重启后适配器链路全部断开，子进程退出，名额释放。重启后 store 和 binding 仍在，所以下一条 message 会走懒恢复。也就是说，**DSH 重启本身就相当于一次「全部 close」**。
- 网关侧状态可能滞后（仍显示 attached）。reaper 和 `remote_agent_get` 要能通过 `A2ABackend.status` 查询纠正，未知时标 `stale`，与现有离线缓存语义一致。
- 关闭时如果 DSH 正在重启，close 请求失败就返回 `REMOTE_UNAVAILABLE`。重启完成后会话已经实际 closed，再次 close 返回 `alreadyClosed: true`。
- 关闭与恢复**都不需要重启 DSH**。这一点要写进 SOP，避免再为腾容量去重启 DSH、误伤正在跑的会话（2026-10-26 19:49 就发生过一次）。

## 五、容量与回收

### 5.1 reaper（闲置回收）

- 网关内置一个定时器（建议 60 秒一次），扫描本网关派出的 `attached + idle` 会话：
  - `one-shot`：终态后超过宽限期（默认 30 秒）仍未关闭的，补发 close。这是自动关闭失败后的兜底。
  - `persistent` 且设置了 `idleTtlSeconds`：超过 TTL 未使用的，执行 close。
  - 未设置 TTL 的 persistent：只上报指标，不回收（保持现状）。
- 「idle」的判定以远端 `status()` 为准，必须是 `activeTurn=false`、没有挂起的 prompt、不在 `INPUT_REQUIRED`。**绝不关闭忙碌的会话。**
- 可选：容量 FIFO 有排队项、且队首已经等待超过 N 秒时，reaper 提前回收 TTL 已过半的闲置会话。这一项默认关闭，需要 Scott 决定（第九节）。

### 5.2 安全的强杀兜底

- close 之后 30 秒内没有观察到子进程退出：网关只标记 `processReleased: "pending"` 并告警，**不**在网关里 kill。
- 由宿主侧（acp-service runtime）按 launchId/PID 走现有的「停止子进程」路径。网关只能请求，不能直接发信号。
- 只允许处理本 A2A 派出、且登记在容量账本里的 PID，避免误杀用户原生会话。
- 人工清理（例如这次的 4 组 grok）应该被新接口取代。如果仍需人工清理，SOP 要求先 `status` 确认空闲，并取得 Scott 同意。

### 5.3 指标

在 `/health` 或新的 `remote_agent_sessions` 只读方法中提供：

- 按 remote 统计的 `attached / busy / idle / closed` 数量，以及 idle 时长最长的前 N 个会话。
- 进程名额：`soft / hard / used`，FIFO 队列长度和队首等待时长（来自容量账本，只读）。
- 计数：`close`（按 reason 分）、`resume`（按 restoreMethod 分）、`close_failed`、`process_release_pending`。

## 六、错误码、幂等与安全

### 6.1 错误码

| 网关错误码 | 来源 | 调用方处理 |
| --- | --- | --- |
| `SESSION_NOT_FOUND` | ACP `-32001`，或 DSH `Session … not found` | 重新 spawn |
| `SESSION_DELETED` | ACP `-32003 Session was deleted` | 重新 spawn，不重试 |
| `SESSION_CLOSED` | 会话已关闭，且 `autoResume:false` | 显式 resume |
| `SESSION_BUSY` | 有进行中的任务，或 ACP `-32000 Session is busy` | 等待，或 `force:true` |
| `SESSION_ATTACH_IN_PROGRESS` | ACP `-32000 Session attachment is already in progress` | 稍后重试 |
| `SESSION_CONFLICT` | cwd、preset 或 Agent 不一致（invalidParams） | 不能 resume，只能新开 |
| `REPLAY_UNAVAILABLE` | load 缺回放（`-32000 … use session/resume`） | 网关自动改用 resume |
| `CAPACITY_PENDING` | 进入容量 FIFO | 不是错误，按 Pending 轮询 |
| `REMOTE_UNAVAILABLE` | 远端离线或正在重启 | 稍后重试 |
| `UNSUPPORTED` | 远端宿主版本不支持 close/status | 升级宿主，或沿用旧流程 |

### 6.2 幂等

- close：同一会话重复 close 返回 `alreadyClosed`。带 `clientRequestId` 时，网关持久保存请求和结果，重复请求返回同一结果。
- resume 带 prompt：与 message 一样，靠 `clientRequestId` 加账本里的 attempt 保证不重复派发。没带 prompt 的 resume 天然幂等（已 attached 就直接返回）。
- one-shot 的自动 close 用 `closeReason: one-shot` 加 jobId 作为幂等键，网关重启后重放也不会重复关闭。

### 6.3 安全

- `originSessionId` **只是路由和归属范围的 ID，不是凭证**。它决定能看到、能关闭哪些 job，但不能用来鉴权。真正的鉴权仍然是 dreammate 节点访问控制加上网关到远端的 remote token。文档和 SOP 都不应把它当作秘密，也不应把它当作授权依据。
- close 和 resume 只能作用于本 origin 自己派出的会话，跨 origin 返回 `SESSION_NOT_FOUND`（不泄露存在性）。
- 远端扩展端点必须复用现有 remote token 校验。返回内容不包含 token、cookie 或宿主绝对路径以外的敏感信息。错误信息继续走 `toSafeError` 的脱敏投影。
- `delete` 是破坏性操作。建议网关配置开关 `allowDelete`（默认 false），或者要求 `mode:"delete"` 时附带 `confirm: true`。
- 日志里只记 sessionId、contextId 和 taskId，不记 prompt 原文和配置里的凭证。

## 七、实施与上线计划

1. **新分支**：从 `develop` 拉 `feat/a2a-session-lifecycle`。所有改动先给 Scott 看 diff，不直接合并。
2. **分期**：
   - P1（解决容量问题）：`A2ABackend.close/status`、DSH 适配器关闭链路、远端扩展端点、`remote_agent_close`（只做 close）、spawn 的 `lifecycle: one-shot` 加自动关闭、job 字段持久化。
   - P2：`remote_agent_resume`、message 的 `resumed` 标记和 `autoResume` 开关、错误码映射。
   - P3：reaper、TTL、指标、`delete`、目标级默认 lifecycle。
3. **测试**：
   - 单元测试：网关方法 schema 与 `methodContractViolations`；close 幂等；按 origin 隔离；错误码映射（mock ACP 返回 `-32001/-32003/-32000`）；one-shot 在 COMPLETED、FAILED、CANCELED 时触发，在 INPUT_REQUIRED 时不触发；reaper 不碰 busy 会话。
   - executor 和 backend：`close` 之后 `loadTarget` 仍能取回；resume 时 cwd、preset 冲突会被拒绝；deleted 映射正确。
   - 与 DSH 的集成测试（隔离 stateDirectory 和隔离容量目录，**不使用**线上 DSH :3080）：
     - spawn one-shot，完成后子进程退出，容量账本的 lease 消失。
     - persistent 会话 close 后 message 自动恢复，`restoreMethod` 正确，并验证上下文是否保留。
     - delete 之后 resume 返回 `SESSION_DELETED`。
     - close 过程中模拟 DSH 重启。
     - 名额满时 resume 进入 FIFO，并能正常出队。
   - 回归：现有 `packages/service` 和 `packages/dsh-plugin` 测试全部通过。不传 lifecycle 时行为不变（现有 spawn 和 message 用例必须原样通过）。
4. **向后兼容**：
   - 所有新字段都是可选的。远端宿主没升级时，close 返回 `UNSUPPORTED`，网关降级为「仅标记，不关闭」并告警，spawn 和 message 照常工作。
   - 网关和 DSH 插件分别升级，先升 DSH 插件（新增端点不影响旧网关），再升网关。
5. **上线与回滚**：
   - 按现有 release 目录方式发新版，保留当前 0.8.3 的 release 不删。回滚就是把服务指回旧 release。
   - 上线需要重启 a2a-gateway 和 DSH，**两者都要事先征得 Scott 同意**，并选在没有在跑任务的时候。
   - 上线后观察 24 小时：闲置会话数、`process_release_pending` 计数、FIFO 等待时长。

## 八、调用方 SOP 与能力目录坑点更新

### 8.1 调用方 SOP（上线后）

- 一次性任务（口播出片、报告、单次检查）在 spawn 时带 `lifecycle: { mode: "one-shot" }`。
- 需要多轮追问的任务用 persistent，并设置 `idleTtlSeconds`。用完主动 `remote_agent_close`。
- 追问已关闭的会话直接用 `remote_agent_message`，看返回的 `resumed` 字段。要求「必须同一上下文」时，检查 `restoreMethod` 和 grok 是否真的保留了上下文。
- **不要**对 COMPLETED 任务调用 cancel 来释放资源，用 close。
- **不要**为腾容量重启 DSH。先查看 `remote_agent_sessions` 或 `/health` 的闲置会话，再 close。
- 结论性内容仍写入文件或合同。resume 不保证模型侧上下文完整，新会话可以从文件接续。

### 8.2 a2a-capabilities 目录坑点（`~/.config/1agents/a2a-capabilities/catalog.md`）

在现有 11 条坑点后补充（上线前先按「现状」写，上线后改写）：

1. 任务 COMPLETED 加 ack 不会关闭远端会话，grok 子进程继续占进程名额。连续 spawn 会卡在 `waiting in FIFO order for device memory and ACP capacity`。
2. 对终态任务调 `remote_agent_cancel` 返回 `Task not cancelable`，没法用它释放会话。
3. 网关（≤0.8.3/0.9.0）没有 close 和 resume。同一 contextId 的 `remote_agent_message` 会复用原会话，链路断开后 DSH 会懒恢复，但不能主动关闭。
4. 修改 sessionPolicy 需要重启 DSH，会中断同一 DSH 上的所有在跑任务，必须事先征得 Scott 同意。
5. 恢复的会话按**当前**审批策略执行，不按创建时的策略。

## 九、待 Scott 决定的问题

1. **message 遇到已关闭会话**：默认自动恢复（本文建议），还是默认报 `SESSION_CLOSED` 让调用方显式 resume？
2. **one-shot 的关闭时机**：终态立即关（本文默认），还是等主会话 ack 后再关（便于在 ack 前马上追问）？
3. **默认 lifecycle**：口播和报告类目标是否在目标登记中默认 one-shot？persistent 的默认 idle TTL 定多少（建议 30 分钟）？
4. **容量紧张时**是否允许 reaper 提前回收 TTL 未到的闲置会话？
5. **delete 是否开放**给调用方？删除时是否连 DSH 原生会话历史一起删（本文建议不删）？
6. **grok 上下文恢复**：需要先做一次只读实测，确认 grok-build 在 close 加 resume 之后是否保留模型侧上下文。如果不保留，resume 的价值主要是保留 ACP 历史和 A2A 关联，需要决定是否还做 P2。
7. **版本基线**：方案按仓库 0.9.0 源码写，线上是 0.8.3。是否先把线上升到 0.9.0 再在其上开发？
8. **sessionPolicy 热加载**：要不要作为独立议题立项，去掉「改策略就得重启 DSH」？
9. **上线窗口**：a2a-gateway 和 DSH 需要各重启一次，由你指定时间。

## 附：本文核对过的代码位置

- `packages/service/src/a2a/gateway.ts`：`REMOTE_AGENT_METHODS`（约 104–113 行），方法分派（约 942–990 行），job 视图中的 sessionId（约 214、284、710 行）。
- `packages/service/src/a2a/executor.ts`：`execute` 的 finally 只释放任务名额；`cancelTask` 只处理 active 或 awaitingInput 的任务。
- `packages/service/src/a2a/store.ts`：`loadTarget / saveTarget`（约 272–285 行）。
- `packages/service/src/a2a/types.ts`：`A2ABackend` 接口（没有 close）。
- `packages/service/src/capacity-lifecycle.ts`：进程名额只在 `onExit` 和 `onSpawnFailed` 时释放。
- `packages/service/src/acp-connection.ts`：`ensure()`、`session/new|load|resume|close|delete`、`sessions/close_all` 扩展。
- `packages/dsh-plugin/src/a2a-executor.ts`：`DshA2ABackend.prepare`。
- `packages/dsh-plugin/src/adapter.ts`：`session/new` 与 `restoreMethod ?? 'session/load'` 恢复、链路退役逻辑。
- `@a2a-js/sdk` 1.3.0 `cancelTask`：终态（CANCELED 除外）抛 `TaskNotCancelableError`。
- `docs/device-capacity-queue-20261023.md`：「不强制回收空闲的持久会话」。
