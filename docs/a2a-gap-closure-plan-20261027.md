# A2A 缺口收口方案

- 日期：2026-10-27（Asia/Shanghai）。
- 状态（2026-10-31 更新）：**P0–P3、G3 和 G9 已合进 `main` 和 `develop` 并推送，P2 的两项真机检查已通过。本机测试环境的网关 `com.1agents.a2a-gateway` 和 DSH web（`com.1agents.dsh-web`）在 2026-10-31 11:53 用当天 11:51 的 `develop` 构建重启过。当天 16:14 又换了 DSH web 的插件，补上关闭后的释放确认，并带上 `76125a84`。还剩一处断点：A2A 派单能用的进程名额太少。24 小时观察从 16:14 起才有意义。G4、G5、G6、G8 未开始。** 进度见 §5.1，剩余事项见 §7。
- 依据：文档里仍写着未完成的 A2A 缺口，并在当日源码上核对过仍成立的部分。会话关闭的代码位置见 [2026-10-26 核对记录](a2a-session-lifecycle-close-resume-20261026.md)。该文第九节的待决定项以本文为准。补充结论来自 `packages/runtime` 的 `ensureSession`、`close` 和 `connectAndLoadSession`，以及 ACP 服务与 DSH 适配器的现有调用。
- 源码基线：仓库 `@1agents/acp-service` **0.9.0**。2026-10-28 起本机测试环境运行的是这个版本号的本地构建（提交 `b3dc615`），不再是 0.8.3。

## 1. 仍开放的缺口

下表只收录文档明确留下、且没有后续验收记录宣布完成的项。已有 P0/P1 账本、通知、结果版本和项目探查不在本轮重做。

| 编号 | 文档记载 | 2026-10-27 源码核对 | 本方案处置 |
| --- | --- | --- | --- |
| G1 | 任务变成完成后，远端 DSH/ACP 会话和 grok 子进程不关闭，进程名额一直被占。终态任务不能 `remote_agent_cancel`。网关没有 close。容量层写明不回收空闲持久会话，但没有给调用方关闭入口。见 [会话生命周期核对](a2a-session-lifecycle-close-resume-20261026.md)、[容量与队列](device-capacity-queue-20261023.md) | runtime 和 ACP 服务已经能普通关闭并在下次附着时接回。缺口是 A2A 路径没有调用这次关闭：`REMOTE_AGENT_METHODS` 仍没有 close；`A2ABackend` 没有 close；executor 结束只释放任务名额；DSH 适配器只在新建失败时发 `session/close` | **本轮补上调用，不重写 runtime。** 关闭和 60 秒拆分在 P1 一起做，可观测性在 P1.5，接回在 P2，空闲回收在 P3 |
| G2 | 开机时 Tailscale 地址还不可用，回调 `listen` 失败会让整个网关起不来。2026-10-25 变更日志写明「开机时的服务启动顺序问题本轮未处理」 | `serveA2AGateway` 先听 `127.0.0.1`，再 `await listen(receiver, callback.port, callback.host)`，成功后才登记 DreamMate。回调绑定失败会中断这次启动 | **本轮先做，** 与会话关闭互不依赖 |
| G3 | 人工审核预览仍是 `slides.length(6)`，和可选页数的 PPT 合同冲突。源码隔离验证过，未部署。见 [阶段保存](a2a-workbench-stage-checkpoint-20261022.md)、[扩展计划](multi-agent-expansion-plan-20261022.md) | `packages/service/src/execution/human-review.ts` 的预览 schema 仍是 `.length(6)` | **不并进本轮。** 部署人审之前必须单独修，并补非六页回归。沿用扩展计划第 2 节 |
| G4 | 交付驱动、审核载荷、进度投影仍绑在 PPT 上；报告交付未做 | 未在本轮改这些模块。阶段保存已记录网关只有 `ppt_delivery` 分支 | **不启动。** 顺序仍是扩展计划：先收口 PPT 人审，再做报告试点 |
| G5 | 目标可以登记 workflow，执行 Provider 没有实现。通用 DAG 和 Activepieces 台账投影也没有。见 [账本验收](a2a-job-ledger-validation-20261021.md) | 未新增 workflow 执行 Provider | **继续不做。** 不能因为目标类型里有 workflow 就宣称能执行工作流 |
| G6 | 项目探查已上线。一键填入任务 cwd、自动登记、工作台选择器仍未做。见 [探查验收](project-role-discovery-20261023.md)、[账本方案 §4.5](a2a-job-ledger-plan.md) | 仍是 `execution_project_scan/list` 与探查配置读写。扫描不创建目标或任务 | **继续不做。** 手填 cwd 保持可用 |
| G7 | 任务工作台源码在，生产未启用 | 网关有 `/workbench/` 路由，未配置时返回 503 | **本轮不部署，不改工作台协议** |
| G8 | 2026-10-27 口播封面：Codex 桌面端没开时，`session_send` 仍返回 accepted，消息只进了 Codex 队列，没有开始执行。31 号封面因此停住 | `deliverCodex` 在 `codex queue` 退出码为 0 且回执线程匹配时，把投递记为 `accepted`。这个状态表示 CLI 已入队，不表示桌面端正在跑 | **不并进这次发布。** 单独立项，见 §4.7 和 §7 |
| G9 | 训练师核实：`standard` 派单不能指定模型，新会话用的是 DSH 当时的默认模型。DeepSeek 在 DSH 里有，经 1acp 派单选不到，因此有两份派单还没跑 | `defaultAgentPreset` 示例是 `standard`。`remote_agent_spawn` 和 `metadata.1agents` 只有 cwd、preset 等字段，没有 provider 或 model。`prepare` 的 `sessionController.create` 只传 cwd 和 agentPreset。执行器不调用 `selectModel`。把模型名写进 prompt 不会改会话模型 | **先记下，不排进 P0–P3。** 见 §4.10 |

主会话「3–5 次工具调用」没有达到，记录在 [阶段收尾](a2a-stage-closeout-20261021.md)。那是调用方式的测量目标，不是本方案要补的接口。

## 2. 本轮要完成的事

1. 调用方能显式关闭自己派出的 ACP 子进程。关闭后进程名额按现有 `onExit` 释放。
2. 一次性 ACP 任务可以声明终态后做这次关闭，不再靠人工清理 grok 进程。
3. 关闭保留 ACP 记录、DSH 绑定和 A2A context。之后同一 `contextId` 上的 message 走现有 `session/load` 或 `session/resume` 接回，并产生新的 `taskId`。
4. 不传新参数时，spawn、message、cancel 的请求形状与现在一致，模式仍是 persistent，不改成 one-shot。
5. 回调地址暂时不可用时，本机 `/invoke`、`/health` 和 DreamMate 登记仍然起来，只重试回调监听。
6. 进程名额已满时，排队阶段保持可查询的等待，带上队列位置和已等时长，不在 60 秒后变成 `ACP_TURN_FAILED`。这和终态关闭在 P1 一起做。
7. `remote_agent_get` 和 `/health` 把任务名额、进程名额分开报出。进程租约写上来源，会话列表按来源分开。两本账本轮不合并。
8. 本网关派出的 persistent ACP 会话，在回合结束并确认空闲后，默认再过 10 分钟没有后续就普通关闭。10 分钟内的追问仍打在原进程上。
9. 停在 `INPUT_REQUIRED` 超过 2 小时的会话只告警，计入 `/health` 的 busy，不关进程。

明确不做：

- 不把 `ensureSession` 改成 runtime 的 `oneshot`。那个模式会换新记录，不能接回原来的 ACP 会话。
- 不新写一套会话存储或恢复协议。`ensureSession` 来自上游 acpx，ACP 服务已经固定使用 `persistent`。
- 不关闭 DSH `standard` 预设。它不进入 ACP，没有 grok 子进程。
- 不关闭 ACP 服务为 grok-build 保留的预热进程。本轮只关闭本次任务自己的会话。
- 不改变 A2A 任务状态机，不让终态任务复活。
- 不为腾容量从网关杀进程，也不回收用户在 DSH 或 Codex 里自己打开的会话。
- 不在网关里迁移 cwd、Agent 或角色。
- 不热加载 `sessionPolicy`。改策略仍要重启 DSH，那是另一项工作。
- 不实现 G3–G7，也不把它们写成已经排进同一次发布。
- 不在 runtime 里加空闲超时。persistent 的回收仍由网关调用已有的普通 close。
- 不合并任务名额和进程名额。
- 不把凉会话写成已经卡在重新附着。先复现，确认卡点后再改这一条。
- 不实现 G8，也不把它算进这次发布的完成标准。
- 不在这次发布里给 `standard` 派单加模型参数，也不改 DSH 的默认模型。
- `INPUT_REQUIRED` 到时只告警，不关进程。

## 2.1 已核对的运行时行为

`ensureSession` 的模式只有 `persistent` 和 `oneshot`，定义在 `packages/runtime`。ACP 服务的 `bridge.js` 每次都传 `persistent`。回合结束后，`retainPersistentSessionOwnerAfterTurn` 把连接留在保留池里，`closeRuntimeTurnClient` 在保留成功时不调用 `client.close()`。所以 A2A 任务完成后 grok 进程继续占名额。这是当前调用方式的结果，不是 `persistent` 缺少恢复能力。

普通 `close`（不带 `discardPersistentState`）会停掉子进程，把记录标成 `closed`，并留下 `acpSessionId`。它不设置 `reset_on_next_ensure`。下次用同一个 session key、cwd 和启动命令 `ensureSession` 时复用这条记录。进程已经不在，下一轮由 `connectAndLoadSession` 按 `same-session-only` 调用 `session/resume`，agent 不支持 resume 时改用 `session/load`。恢复失败不会换成一次新对话。`prepareFreshSession` 和 `discardPersistentState: true` 才会要求下次新建。

DSH 适配器已经接在这条路上。绑定保存 `sessionId`；链路不在时，`openConnection` 用 `restoreMethod`，缺省是 `session/load`。ACP 连接层再把记录里的 `acpSessionId` 交给 bridge 的 `ensure_session`。因此网关要补的是「在正确的时机调用普通 close，并且不删绑定」。下一次 message 不需要新的恢复入口。

`standard` 预设不走 ACP 适配器，`agentName()` 对非 `oneagents-acp-` 前缀直接返回空。这类任务没有本方案要回收的子进程。

## 2.2 persistent：从进程启动到这一轮答完

这里只写 `oneagents-acp-*` 且网关生命周期为 persistent 的路径。`standard` 在准备阶段只建一条空白 DSH 会话，不启动 grok。grok-build 预热是另一条 `ensureSession`，不属于这次任务。下面前 10 步是 2026-10-27 的 0.9.0 源码；答完之后的空闲关闭当时还是方案，已由 P3 实现（§5.1）。

1. 网关收到 spawn。不传 `lifecycle` 就是 persistent。这一步不启动 grok。
2. 任务名额在 `prepare()` 之前申请。不够时任务停在 `TASK_STATE_SUBMITTED`，调用方看到 Pending。任务名额和进程名额是两本账。
3. DSH `prepare` 新建或找回 DSH 会话，记下 cwd 和 preset。原生 `create` 只有空白会话，没有 ACP 连接，也没有 grok。已有会话若 cwd 或 preset 不一致，在这里拒绝。
4. `run` 把这段 prompt 以 `mode: "queue"` 送进该 DSH 会话，然后只等这一轮自己的 `turn/end`。
5. 适配器发现 ACP 链路不在，就连接 ACP 服务。新绑定发 `session/new`；已有绑定发 `session/load`，导入历史则用保存的 `session/resume`。这次 RPC 目前被 `AbortSignal.timeout(60_000)` 包住。
6. ACP 服务的 `ensure_session` 固定调用 `ensureSession({ mode: "persistent" })`。runtime 在拉起子进程前申请进程名额。名额满就进 FIFO，大约每 750 毫秒看一次，队列自己没有 60 秒上限。这段等待目前算在第 5 步的 60 秒里，超时会变成 `ACP_TURN_FAILED`。方案 P1 把 60 秒改到出队之后的 grok 握手，等待期间任务保持 `CAPACITY_PENDING`。
7. 名额到手后 grok 子进程启动，`onSpawned` 记下进程租约。会话就绪时 `activeTurn` 仍为空。新会话若配置了 Agent 已公布的 `initialModeId`，在第一条 prompt 之前执行 `session/set_mode`。
8. prompt 进入这个子进程，这一轮开始，`activeTurn` 变为有值。工具调用、权限和提问都发生在这一轮里面。停在 `INPUT_REQUIRED` 时这一轮还没答完，进程保持占用；方案也不把这种状态当成可回收的空闲。
9. 模型结束这一轮。runtime 记下回合结果，并调用 `retainPersistentSessionOwnerAfterTurn`。模式是 persistent、记录未关闭、没有未完成的 prompt、而且会话还能复用时，连接留在保留池。`closeRuntimeTurnClient` 看到已经保留，就不调用 `client.close()`。grok 不退出，进程名额不释放。
10. DSH 收到 `turn/end` 后，A2A 任务可以变成完成。完成的是这一轮任务，不是进程。现在代码到这里停止：没有静默计时，也没有自动 close。

答完当时的状态：DSH 会话、ACP 记录和 A2A context 都还在；grok 进程还在并占着名额。下一条 message 若这进程仍在，就复用同一条链路，不再 `session/new`，也不再占用一个新的进程名额。

方案把计时放在这个点之后，由 P3 实现。`status` 确认空闲后再过 600 秒没有后续，网关做普通 close：进程退出，名额按 `onExit` 释放，记录留下，下次 message 用 `session/load` 或 `session/resume` 接回。这 600 秒内的追问不关闭、不新起进程。`idleTtlSeconds: 0` 则答完后一直留着，直到显式 close、进程自己退出或 DSH 重启。

## 2.3 改进落在哪一步

下表按优先级排列。one-shot 的关闭紧接在第 10 步之后；persistent 的 600 秒也从答完并确认空闲之后才计。省略 `idleTtlSeconds` 仍是 600 秒，写 `0` 才不自动回收。口播、报告、单次检查在调用时传 one-shot，不把「没写 lifecycle」改成 one-shot。

| 优先级 | 出在哪一步 | 做法 | 阶段 |
| --- | --- | --- | --- |
| 1 | 第 9–10 步：这一轮答完，grok 不退出 | 终态若是 one-shot，立刻普通 `session/close`（release）。记录和绑定保留，名额等观察到 `onExit` 再放。persistent 用 `remote_agent_close`，或按 `idleTtlSeconds` 回收 | 关闭在 P1。600 秒扫描在 P3 |
| 2 | 第 5–6 步：FIFO 等待被算进 60 秒 | 排队不计超时，对外是 `CAPACITY_PENDING`，带队列位置和已等时长。60 秒只计出队后的 grok 拉起和握手 | P1，和上一行一起做 |
| 3 | 第 2 步和第 6 步：任务名额、进程名额是两本账 | 不合并账本。`remote_agent_get` 和 `/health` 分开报 `taskSlot`、`processSlot`，并报进程名额 FIFO 的队首等待 | P1.5 |
| 4 | 第 4 步入队到第 8 步回合开始 | 凉会话可以停在 accepted 且模型不跑。卡在入队、重新附着，还是回合没有开始，都还没定位 | P2 先复现。修复不在本方案里预先写死 |
| 5 | 第 8 步：`INPUT_REQUIRED` 会一直占名额 | 单独计 2 小时。到时只告警，计入 `/health` 的 busy，不关进程 | P3 |
| 6 | 第 7 步旁边的预热进程 | 继续不关预热进程，也不关用户自己打开的会话。新租约记来源：`prewarm`、某个 job，或用户在 DSH 里打开。`remote_agent_sessions` 按来源分列 | P1.5 |
| 7 | 与这条时间线并列的 Codex 投递 | 桌面端没开时不再显示成已经在执行。宿主不在线用 `HOST_OFFLINE_QUEUED` | 不在这次发布 |

P1 必须同时包含第 1 行和第 2 行。只做关闭、不拆 60 秒时，漏关一次仍会变成 `ACP_TURN_FAILED`。只拆 60 秒、不做关闭时，答完的进程不退出，后面的任务会一直排在 FIFO 里。

## 3. 锁定的决定

这些决定替换 2026-10-26 核对记录第九节。实现时按此执行。

| 决定 | 选择 | 原因 |
| --- | --- | --- |
| 已关闭会话再收到 `remote_agent_message` | 默认沿用现有 message：DSH 按保存的 binding 做 `session/load` 或 `session/resume`，返回 `resumed: true` 和实际 `restoreMethod`。`autoResume: false` 时网关在调用远端前返回 `SESSION_CLOSED`，不发 `session/new` | 恢复已经在 runtime 和适配器里。网关只决定是否放行，并标明这次是重新附着 |
| 网关 one-shot 的实现 | 终态后调用普通 `session/close`，也就是 runtime 的 release。继续使用 `ensureSession({ mode: "persistent" })`。不传 `discardPersistentState`，不调用 `prepareFreshSession`，不调用 `session/delete` | runtime 的 `oneshot` 会新建记录。本方案要的是关掉进程后仍能接回同一 ACP 会话 |
| one-shot 何时关闭 | 默认进入 `COMPLETED`、`FAILED` 或 `CANCELED` 后关闭。`INPUT_REQUIRED` 不关。需要等主会话 ack 的调用显式传 `closeAfter: "ack"` | 容量被占的原因就是终态后进程还在。ack 可能很晚或不到。关闭后仍可按原 sessionId 附着 |
| 默认生命周期 | 不传 `lifecycle` 仍是 persistent，不改成 one-shot。persistent 在回合结束并确认空闲后，默认再等 600 秒没有后续就普通 close。`idleTtlSeconds: 0` 不自动回收；正数覆盖 600 秒 | 多轮会话结束后也不能一直占名额。10 分钟留给同一次任务的追问。正在执行、等待输入、状态未知的不关。必须常驻的会话显式写 0 |
| 适用预设 | 只关闭 `oneagents-acp-*` 拉起的 ACP 子进程。`standard` 收到 close 或 one-shot 时返回 `processReleased: true`、`acp: false`，不向 DSH 原生会话发 `session/close` | `standard` 没有 ACP 子进程。对它发 close 会关错对象 |
| 容量排队时提前回收未到 TTL 的闲置会话 | 关闭 | 容量文档禁止为腾空间强杀。提前回收和强杀只差在「进程已空闲」，仍会打断调用方以为还在的会话 |
| `delete` | 第一期接口不接受 `mode: "delete"`。后面要做时，网关配置 `sessionLifecycle.allowDelete` 默认 false，且不删除 DSH 原生会话历史 | 删除不能恢复。容量问题用 close 就够 |
| grok 模型上下文是否还在 | P1 不依赖这个结果。resume 先保证 ACP 历史和 A2A 身份能重新附着。技能说明在实测通过前只写「不保证模型侧上下文」 | 结论性内容本来就应落在文件或合同里。实测是上线前的检查，不是写 close 的前置条件 |
| 开发基线 | 在当前 0.9.0 源码上做。不先把线上 0.8.3 升上去再开工 | 线上升级是单独的发布，需要另一次同意。代码不为 0.8.3 保留第二套实现 |
| 远端扩展形态 | 沿用已有 `POST {path}/preflight`：同一 bearer token，不进 A2A JSON-RPC。新增 `POST {path}/sessions/close` 和 `POST {path}/sessions/status`，`contextId` 放在 JSON body | `createA2AServer` 已经用这条扩展路径做预检，鉴权和「不分配 Task」的边界是现成的。A2A 标准没有关闭会话的方法 |
| 归属 | `originSessionId` 只划定能看到和能关闭的 job，不是凭证。跨 origin 返回 `SESSION_NOT_FOUND` | 与现有派单范围一致。鉴权仍是 DreamMate 访问控制和远端 bearer token |
| 进行中的任务 | 默认 `SESSION_BUSY`。`force: true` 时先走现有 cancel，确认终态后再 close | 与「不强杀运行任务」一致。网关不直接向 PID 发信号 |
| 进程名额 | 网关不改容量账本。只有观察到子进程退出才报 `processReleased: true`，否则 `pending` 并告警 | 容量层只在 `onExit` 和 `onSpawnFailed` 时放名额 |
| 回调绑定 | 保持配置里的 Tailscale 地址，不改成 `0.0.0.0`。`EADDRNOTAVAIL` 只重试回调监听；本机网关和登记先起来 | 监听所有网卡不能让尚未出现的 Tailscale 地址提前可达，只会扩大暴露面 |
| 上线重启 | 代码可以先合并。重启 a2a-gateway 或 DSH 另要同意，并选在没有在跑任务的时候 | 2026-10-26 为腾容量重启 DSH 误伤过在跑会话 |

默认空闲时限是 600 秒，由网关配置 `sessionLifecycle.persistentIdleTtlSeconds` 给出，缺省即 600。调用方或目标配置里的 `idleTtlSeconds` 覆盖它。必须一直留着的会话写 `idleTtlSeconds: 0`。更长的保活写正数，例如 `1800`。本轮不修改已登记目标的配置；常驻角色要在上线 P3 前自己写上 0，否则按这 600 秒回收。

## 4. 接口

### 4.1 `remote_agent_close`

```jsonc
{
  "originSessionId": "…",
  "remote": "ppt-beautifier",
  "taskId": "…",          // taskId、contextId、sessionId 三选一
  "contextId": "…",
  "sessionId": "…",
  "force": false,
  "clientRequestId": "…"  // 可选
}
```

返回 `remote`、`contextId`、`sessionId`、`state: "closed"`、`alreadyClosed`、`processReleased: true | "pending"`、`canceledTaskIds`。

网关只在该 `originSessionId` 的 job 里解析目标。远端对 `oneagents-acp-*` 发送 ACP `session/close`，再 `link.close()` 并移出 `links`。这次 close 对应 runtime 的 release：进程退出，记录、DSH 绑定和 `FileA2AStore` 的 contextId → sessionId 都保留，target 标成 `closed`。重复关闭返回 `alreadyClosed: true`。`standard` 不发 `session/close`。

`A2ABackend` 增加可选方法。宿主没实现时网关返回 `UNSUPPORTED`，不把 job 标成已关闭。

```ts
close?(target: A2ATarget, options: { signal?: AbortSignal }): Promise<{ processReleased: true | 'pending' }>;
status?(target: A2ATarget): Promise<{ attached: boolean; activeTurn: boolean; lastUsedAt?: string }>;
```

### 4.2 message 接回已关闭会话

带 prompt 的接回就是现有 `remote_agent_message`。它仍创建新 `taskId`，复用 `contextId`。`DshA2ABackend.prepare` 继续按已有 sessionId 找回原 DSH 会话，并拒绝 cwd 或 preset 变化。适配器发现链路不在时，用绑定里的 `restoreMethod`，缺省 `session/load`。导入历史仍用已保存的 `session/resume`。这条路径不接受 cwd、agentPreset 或角色切换。

本轮不新增 `remote_agent_resume`。没有 prompt 的预先附着留到需要时再做，不挡住关闭。

已删除会话映射为 `SESSION_DELETED`，不自动 spawn。找不到映射为 `SESSION_NOT_FOUND`。cwd、preset 或 Agent 不一致映射为 `SESSION_CONFLICT`。`session/load` 因缺少完整回放返回 `-32000` 时，适配器按该绑定已有的 `restoreMethod` 处理；没有该字段时保持 `session/load` 的错误，不在网关里改写成一次 `session/new`。

接回会重新占用进程名额。容量队列本身可以一直等到有空位或被取消，默认每 750 毫秒看一次，没有自己的 60 秒上限。任务名额在 `prepare()` 之前申请，不足时 A2A 任务可以停在 `TASK_STATE_SUBMITTED`，文字为 `Pending`。

进程名额是在 ACP `session/new` 或 `session/load` 里面等的。DSH 适配器 `openConnection` 用 `AbortSignal.timeout(60_000)` 包住这次 RPC，导入原生会话的同一处也是 60 秒。名额要是在这 60 秒里腾不出来，RPC 被取消，外层变成 `ACP_TURN_FAILED`。28 号第一次失败就是这条路径：调用方没有拿到 Pending。容量文档里「等待不会变成任务失败」目前只覆盖任务名额，没有覆盖这个包在 60 秒里的进程名额。

P1 要把进程名额等待挪出这 60 秒，并和第 10 步之后的 one-shot 关闭一起做。`session/new` 进入 FIFO 后立即结束这次 RPC 的时限，任务保持 `TASK_STATE_SUBMITTED`。`remote_agent_get` 看到 `CAPACITY_PENDING`，并带上该任务的队列位置和已等时长。60 秒只留给出队之后的 grok 拉起和握手。取消仍撤掉对应队项。隔离测试要占满进程名额再 spawn，断言 60 秒后任务仍是 Pending，位置和已等时长都在，而不是 `ACP_TURN_FAILED`。one-shot 漏关时，下一次 spawn 也必须走这条等待，不能再以超时失败收场。任务名额和进程名额的汇总数字放到 P1.5，不在这里合并两本账。

### 4.3 spawn 的 `lifecycle`

```jsonc
"lifecycle": {
  "mode": "persistent" | "one-shot",  // 省略 = persistent；这是网关策略，不是 ensureSession 的 mode
  "idleTtlSeconds": 600,              // 仅 persistent。省略 = 600；0 = 不自动回收
  "closeAfter": "terminal" | "ack"    // 仅 one-shot，默认 terminal
}
```

`persistent` 表示回合结束后进程先留着，空闲满 TTL 再普通关闭。`one-shot` 表示终态后立刻做普通 `session/close`，不再多等这 10 分钟。两者在 runtime 里都仍然是 `ensureSession({ mode: "persistent" })`。

空闲从 `status` 确认会话已经空下来开始算：`activeTurn` 为 false，不是 busy，也不是 `INPUT_REQUIRED`，并且本回合已经结束。时钟用 `lastUsedAt`。新的 message 或新回合重新计时。10 分钟内的追问仍打在原进程上。

下面这些不关：回合仍应在执行；停在 `INPUT_REQUIRED`；`status` 问不到或状态未知；别的 origin；grok-build 预热进程；用户在 DSH 或 Codex 里自己打开的会话。名额满了也不提前回收还没到 TTL 的会话。`INPUT_REQUIRED` 另有 2 小时告警，见 §4.9，到时仍不关。

没写 `lifecycle` 的旧 job 同样适用这 600 秒，但要先用 `status` 对上。对不上就保持不关。关闭原因记 `idle-ttl`。这次关闭仍是普通 release，之后的 message 可以接回。实现放在 P3。P3 上线前，persistent 不会自己回收。

生命周期写入 gateway job 和远端 target。`remote_agent_message` 沿用原值；message 可以带新的 `lifecycle` 覆盖。`execution_submit` 的目标配置可以带默认 lifecycle，调用方对固定角色仍不能覆盖 cwd 和 preset，但可以覆盖 lifecycle。本轮不修改任何已登记目标的配置。

one-shot 自动关闭的幂等键是 `jobId` 加 `closeReason: "one-shot"`。网关重启后补关，不关第二次业务任务。

### 4.4 状态

```text
spawn / resume
  (none) → attached → busy
              ↑  ↓ close / TTL        任务终态后若仍 attached，则为 idle
           closed ←──────────────── idle
              ↓ delete（本轮不做）
           deleted
```

`closing` 表示已发出 close、尚未观察到进程退出。此期间的 resume 等待 closing 结束，不并行再开一条链路。

| 存储 | 变更 |
| --- | --- |
| 网关 job | 增加一等字段 `sessionId`、`lifecycle`、`sessionState`、`closedAt`、`closeReason`（`explicit`、`one-shot`、`idle-ttl`）。旧 job 没有这些字段时视为 persistent，空闲时限用默认 600 秒；会话状态未知时不回收，直到 `status` 对上 |
| `FileA2AStore` target | 增加 `state`、`lastUsedAt`、`lifecycle`。旧记录没有 `state` 时视为 `attached`。解析必须接受旧文件 |
| ACP `deleted` 标记和容量账本 | 不改 |

DSH 重启会关掉适配器链路并让子进程退出，效果等同全部 close。网关若仍显示 attached，下一次 `remote_agent_get` 或 reaper 用 `status` 纠正；问不到时标 `stale`，与现有离线缓存相同。关闭或恢复都不需要重启 DSH。

### 4.5 凉会话：先复现，不预设卡点

2026-10-27 的实测只说明现象：给闲置很久的 DSH 会话发后续消息，状态可以停在 accepted，模型没有开始跑。它可能停在第 4 步的队列里，也可能是第 5 步重新附着没有返回，于是 `run` 一直等 `turn/end`。这是推测，不是已定位的原因。

P2 用一次闲置后再 message 的检查把卡点记下来：停在入队、附着请求失败或挂起，还是附着已完成但回合没有开始。自动化测试用可控的空闲时钟模拟这段间隔，不断言它必须变成某一个错误码。真正隔几小时的那次放在上线前的只读检查里，不在单元测试里睡眠，也不回写生产任务。

复现写回本文之前，不实现下面两条候选：

- 第 5 步失败要变成任务失败，不能让 `run` 一直等 `turn/end`。
- 入队后若干分钟仍看不到回合开始，把任务标成 `ATTACH_STALLED`。分钟数等看到卡点再定。

先前草稿里的 5 分钟 `STALLED` 先撤回，避免在卡点不明时先选一种看门狗。

### 4.6 错误

| 代码 | 调用方处理 |
| --- | --- |
| `SESSION_NOT_FOUND` | 重新 spawn |
| `SESSION_DELETED` | 重新 spawn，不重试 resume |
| `SESSION_CLOSED` | 仅 `autoResume: false` 时出现；改为 resume 或去掉该开关 |
| `SESSION_BUSY` | 等待，或 `force: true` |
| `SESSION_ATTACH_IN_PROGRESS` | 稍后重试 |
| `SESSION_CONFLICT` | 不能 resume，只能新开 |
| `CAPACITY_PENDING` | 不是错误。进程名额不足，任务保持 submitted。get 里有队列位置和已等时长 |
| `REMOTE_UNAVAILABLE` | 稍后重试。重启完成后再次 close 应得到 `alreadyClosed` |
| `UNSUPPORTED` | 远端宿主未升级。spawn 和 message 保持旧行为 |
| `DELETE_DISABLED` | 网关没有打开 `sessionLifecycle.allowDelete`。改用普通 close |

错误文本继续走 `toSafeError`。日志只记 sessionId、contextId、taskId，不记 prompt 和 token。

### 4.7 Codex 投递只是入队（G8，不在这次发布）

`session_send` 今天的 `accepted` 表示宿主接收了入队请求。Codex 路径里，这是 `codex queue` 打印了匹配线程的回执，消息写入 `queue_1.sqlite`。桌面端没开时命令仍可成功，消息留在队列里，不会开始执行。31 号封面停在这里。DSH `session/prompt` 以 `mode: "queue"` 返回 `accepted: true` 时，同样只说明已入队。

这项单独立项，不改这次发布的代码，也不作为 P1–P3 的完成条件。立项时再区分三种结果：宿主不在线为 `HOST_OFFLINE_QUEUED`；宿主已开始执行才沿用 accepted；只是入队、宿主在线但还没开跑，与前两项分开。不把这种投递标成失败，也不自动改派。先前草稿用过的 `queued` 不在这次发布里出现。

### 4.8 回调启动

`serveA2AGateway` 在本机端口听上之后就登记 DreamMate，不等待回调绑定。回调 `listen` 遇到 `EADDRNOTAVAIL` 时按退避重试，成功前 `/health` 增加 `callback: "pending"`，失败原因写入带时间戳的日志。其他绑定错误（端口占用、权限）仍让进程失败，避免在错误配置上假装健康。回调服务器继续不暴露 `/invoke`。

### 4.9 两本账、进程来源、`INPUT_REQUIRED` 告警

P1.5 只加可观测性，不改名额的申请和释放。

- `remote_agent_get` 和 `/health` 分开给出 `taskSlot` 与 `processSlot`：各自的上限、在用数量，以及进程名额 FIFO 的队首已等时长。任务自己的队列位置和已等时长在 P1 的 `CAPACITY_PENDING` 里已经返回。
- 进程租约增加来源：`prewarm`、本网关的 job，或用户在 DSH 里自己打开。`remote_agent_sessions` 按来源分列，清理时不用进程号猜测。已经在跑、没有来源字段的进程保持不标注；48295/48296 在来源落地前仍不关闭。
- 不合并两本账，也不为了腾进程名额去改任务名额。

P3 给 `INPUT_REQUIRED` 单独计时，初值 2 小时。到时写一条带 sessionId 和时间的告警，并把该会话算进 `/health` 的 busy。不发 `session/close`，不把它算进空闲 TTL。有新的输入或回合就重新计时。

### 4.10 `standard` 派单选不了模型（G9）

这是 DSH 原生预设 `standard`，不是 ACP 的保留模式，也没有 grok 子进程。网关示例里的 `defaultAgentPreset` 就是它。

派单能传的是 cwd 和 `agentPreset`。`spawnSchema` 与 `metadata.1agents` 都不接受模型字段，多出来的键会报 `Unknown metadata.1agents field`。`DshA2ABackend.prepare` 新建会话时只调用 `sessionController.create({ cwd, agentPreset })`，随后 `prompt` 也不带模型。DSH 界面换模型走的是 `session.selectModel({ sessionId, provider, model })` 和 `modelCatalog()`，这条调用只出现在插件的界面代码里，A2A 执行器没有用它。

所以新的 `standard` 会话用 DSH 创建会话时的默认模型。训练师核实，当前落到的是 MiniMax-M3.1-Flash；DeepSeek 已经在 DSH 的模型目录里，但 1acp 派单选不到。因此有两份派单还没跑。本轮没有再读 DSH 的在线目录，不把这个模型名写成仓库里的常量。仓库里把 `minimax-cn/MiniMax-M3.1-Flash` 写死的是公众号草稿备份预设，不是 `standard` 本身。

`oneagents-acp-*` 是另一条模型路径：模型来自该 Agent 自己公布的选项，经 `session/set_config_option` 切换。给 `standard` 补 `selectModel` 不会让派单选到 Grok 或 Codex 的模型。

要做时单独开，不并进 P0–P3。候选形状是：只对 `standard` 增加可选的 provider 和 model；创建会话之后、第一条 prompt 之前，对照 `modelCatalog()` 调用 `selectModel`；目录里没有就让任务失败，不静默退回默认模型。不传时保持现在的宿主默认，避免旧派单改行为。同一 `contextId` 沿用已经选中的模型，除非这次明确带了新值。回执里写上实际使用的 provider 和 model。模型名只出现在这两个字段里，不靠 prompt 正文切换。

实现（2026-10-27，分支 `a2a-g9-standard-model-20261027`）按上面的形状：

- spawn、message 的 schema 加可选 `provider`、`model`，两者必须一起传。网关在预设已知为 `oneagents-acp-*` 时直接拒绝。`metadata.1agents` 解析器接受这两个字段并带进 `A2APrepareInput`。宿主执行器按实际生效的预设（请求、已存会话或宿主默认）再查一次，是 ACP 就让任务失败，代码 `MODEL_SELECTION_UNSUPPORTED`，不调用 `prepare`。
- `DshA2ABackend.prepare` 先查 `modelCatalog()`，provider 分组里没有这个模型 id 就失败（`MODEL_UNAVAILABLE`），不创建空白会话。然后 `create`，再 `selectModel({ sessionId, provider, model })`，第一条 prompt 在这之后。`selectModel` 自身报错也记成 `MODEL_UNAVAILABLE`。宿主没有回写所选模型时执行器同样失败，不静默用默认。
- 已有会话：不传就不调用目录和 `selectModel`，DSH 会话日志里已有的选择继续生效；执行器把已存 target 里的 provider、model 带到新回合的回执上。传了新值就核对目录后对同一 `sessionId` 再选一次。
- 回执：target、`resultMetadata` 和 `remote_agent_get` 带 DSH 返回的 `selected.provider`、`selected.model`。不传时这两个字段不出现。
- 已知副作用：DSH 的 `selectModel` 在选中后还会 `agentDefaultModel.saveSelection`，把这次选择存成宿主默认。派过一次 DeepSeek 之后，不写模型的 `standard` 派单和 DSH 界面里新开的会话都会用 DeepSeek，直到再有人换。已经跑过回合的会话不受影响。这与 DSH 界面换模型的行为一致。本轮不绕开它；若要隔离，需要 DSH 提供只改会话、不改默认的选择接口，或在派单后恢复默认。

## 5. 实施顺序

每期单独可审查。前一期的测试没过，不开始后一期。全部在新分支上做，不直接改正在跑的 release。

### P0：回调监听与本机网关拆开

- 文件：`packages/service/src/a2a/gateway.ts` 的 `serveA2AGateway`。
- 测试：回调地址不可用时，`/health` 仍为 ok 或带 `callback: "pending"`，登记照常；地址出现后回调端口开始听；`EADDRINUSE` 不进入重试。
- 不改会话行为，可以独立发布。

### P1：终态关闭，并把 60 秒从排队里拿开

两条一起做。只做关闭时，漏关一次仍会在满额后变成 `ACP_TURN_FAILED`。只拆超时时，答完的 grok 不退出，后面的任务会一直排着。

- `packages/service/src/a2a/types.ts`：可选 `close`、`status`。
- `packages/service/src/a2a/server.ts`：`/sessions/close`、`/sessions/status`，鉴权与 body 上限对齐 preflight。
- `packages/service/src/a2a/store.ts`：target 新字段，旧文件仍能读。
- `packages/dsh-plugin/src/adapter.ts`：对已有 ACP 绑定发送 `session/close`，然后关掉 link 并移出 `links`。保留 binding、`sessionId` 和 `restoreMethod`。不发 `session/delete`，也不要求 runtime `discardPersistentState`。`standard` 或非 ACP 预设直接返回没有 ACP 进程。`openConnection` 里包住 `session/new` 和 `session/load` 的 `AbortSignal.timeout(60_000)` 不再覆盖进程名额等待；60 秒只从出队后的 grok 握手算起。导入原生会话的同一时限同样处理。
- `packages/dsh-plugin/src/a2a-executor.ts`：`DshA2ABackend.close` 和 `status`。close 只转发适配器的普通关闭。
- `packages/service/src/a2a/gateway.ts`：`remote_agent_close`、spawn 的可选 `lifecycle`、终态后的 one-shot 关闭、job 字段。one-shot 的幂等关闭只调用上述 release。
- `packages/service/src/a2a/executor.ts`：终态通知网关时带上关闭所需的 context 和 session，不在 executor 里杀进程。
- 契约测试：新方法的参数顶层 `type` 仍是 `object`，描述非空。登记方法数从现在的 36 增加，测试里的数量一起改。
- 技能：`packages/service/skills/acp-service/references/a2a.md` 写上 close、网关 one-shot，以及「cancel 不能释放已完成会话」。说明 one-shot 仍使用 runtime `persistent`。

隔离测试使用单独的 state 目录和容量目录，不连接本机 DSH `:3080`。要通过的行为：

- one-shot 在三种终态后，ACP 子进程退出，容量租约消失，runtime 记录仍在且没有 `reset_on_next_ensure`。`INPUT_REQUIRED` 不关。
- `standard` 的 one-shot 不调用 `session/close`，并返回 `acp: false`。
- 重复 close 返回 `alreadyClosed`。别的 origin 看不到这会话。
- 进行中 close 返回 `SESSION_BUSY`；`force: true` 先取消再关。
- 不传 `lifecycle` 的现有 spawn、message 用例在当次请求上保持原结果。P1 不启动 10 分钟空闲回收，短测试里的进程仍在；回收断言放在 P3。
- 宿主没有 `close` 时返回 `UNSUPPORTED`，job 不记成 closed。
- 进程名额占满时，spawn 在 60 秒后仍是 `CAPACITY_PENDING`，并带有队列位置和已等时长，不是 `ACP_TURN_FAILED`。取消后队项消失，不留下半启动的 grok。出队后的握手仍受 60 秒限制。

### P1.5：分开看见两本账和进程来源

不改变名额何时申请、何时释放。前一期 P1 的测试没过，不开始这一期。

- `remote_agent_get` 和 `/health` 增加 `taskSlot`、`processSlot`，以及进程名额 FIFO 的队首已等时长。
- 进程租约记 `prewarm`、job 或用户在 DSH 中打开。`remote_agent_sessions` 按来源分列。没有来源的旧进程不标注，也不据此关闭。
- 测试：任务名额有空、进程名额已满时，get 仍是 `CAPACITY_PENDING`，两本账的数字能看出空的是哪一本。预热租约和任务租约出现在不同来源下。

### P2：确认 message 能接回，并复现凉会话

不新增恢复方法。测试现有 message 在 close 之后的行为：

- 同一个 DSH `sessionId` 和 ACP `acpSessionId` 被再次附着，调用的是 `session/load` 或绑定里的 `session/resume`，没有 `session/new`。
- 返回 `resumed: true` 和实际 `restoreMethod`。`autoResume: false` 时网关不向远端发 message。
- cwd 或 preset 冲突被拒绝。已删除返回 `SESSION_DELETED`。名额满时任务保持 `CAPACITY_PENDING`，不在适配器的 60 秒里失败。
- 用空闲时钟模拟数小时后再 message，把卡点记成入队、附着失败或挂起、附着完成但回合未开始，或已经出现 `activeTurn`。不预设错误码。结论写回本文之后，才决定要不要做失败回传或 `ATTACH_STALLED`。
- 上线前用一次只读任务检查 grok-build 在 close 再附着之后，模型是否还记得上文。另一次对真实闲置数小时的会话做同样的只读 message，并记下实际卡点。两条都不回写生产任务。没有模型记忆的结果时，技能只写 ACP 会话可以接回。口播验收以文件为准，不依赖这次记忆。

### P3：空闲回收、`INPUT_REQUIRED` 告警、其余指标、受控 delete

- 网关内约 60 秒扫描一次本网关派出的会话。one-shot 终态后超过 30 秒仍未关闭的，补一次 close。persistent 在 `status` 确认空闲，且 `lastUsedAt` 已超过该会话的空闲时限时关闭，原因 `idle-ttl`。时限默认 600 秒；`idleTtlSeconds: 0` 跳过；正数按调用方的值。busy、`INPUT_REQUIRED`、状态未知、未到时限的不关。名额已满也不提前关。
- 空闲时钟测试：走过 600 秒且确认空闲则关闭，记录仍可接回；599 秒内有 message 则不关并重新计时；`idleTtlSeconds: 0` 不再关；`1800` 未满不关；`activeTurn`、`INPUT_REQUIRED`、状态未知、别的 origin、预热进程不关。
- `INPUT_REQUIRED` 持续 2 小时则告警，并计入 `/health` 的 busy。测试要看到告警且进程仍在；未满 2 小时不告警。
- 在 P1.5 已有的两本账之外，再按 close reason、resume 的 restoreMethod、close 失败和 `process_release_pending` 分开计数。
- delete 仅在 `allowDelete: true` 时接受，并沿用 ACP `session/delete`。默认配置不打开。

G8 不排进 P0–P3。

### 5.1 实施进度（2026-10-31 更新）

改动先提交在分支 `workbench-a2a-e2e-20261027`（由 `a2a-gap-closure-20261027` 和 `a2a-g9-standard-model-20261027` 合入），之后合进 `main` 和 `develop`，均已推送到 `origin`（`scottzx/agent-workflow`）。两条线现在分叉：`develop` 上有 9 个提交不在 `main`（RSI 一串和 `76125a84`），`main` 上有 PR #3、#7 的合并提交不在 `develop`。`76125a84` 还没推送。

| 期 | 状态 | 提交 | 说明 |
| --- | --- | --- | --- |
| P0 | 已提交、已部署 | `21acef5` | `retryCallbackBind` 只重试 `EADDRNOTAVAIL`；`/health` 带 `callback: "pending"`。2026-10-28 线上 `/health` 没有 pending，回调已绑定 |
| P1 | 已提交、已部署 | `21acef5` | `remote_agent_close`、spawn/message 的 `lifecycle`、one-shot 终态关闭；宿主 `/sessions/close`、`/sessions/status`；DSH 适配器普通 `session/close`；进程名额等待移出 60 秒，任务保持 `CAPACITY_PENDING` |
| P1.5 | 已提交、已部署 | `21acef5` | `taskSlot`、`processSlot.headWaitMs`；`remote_agent_sessions` 按来源列租约 |
| P2 | 已提交、已部署，真机检查通过 | `21acef5` | 关闭后 message 接回同一会话并返回 `resumed`、`restoreMethod`；`autoResume: false`；删除与冲突不替换；满额时保持 Pending。`classifyColdAttach` 只记卡点。真机检查见下文「P2 真机检查」 |
| P3 | 已提交、已部署 | `21acef5`、`7e855ca` | 网关按 `sessionLifecycle.idleScanIntervalMs`（默认 60 秒）扫描。只处理 `oneagents-acp-*` 且整个 context 都已终态的会话；`status` 必须返回已附着且没有进行中的回合，查不到就不关。空闲从最后一轮的终态时间算起。时限：job 的 `idleTtlSeconds` 优先，否则 `sessionLifecycle.persistentIdleTtlSeconds`（默认 600）。`INPUT_REQUIRED` 超过 `inputRequiredAlertSeconds`（默认 7200）每轮只告警一次。`/health.sessions` 给出 busy、告警、按原因的关闭数、`restoreMethod` 计数、关闭失败数、`processReleasePending`。one-shot 补关沿用每次 reconcile 的重试，没有另设 30 秒。受控 delete：`remote_agent_close` 加 `mode: "delete"`，网关 `sessionLifecycle.allowDelete` 默认 false，未打开时返回 `DELETE_DISABLED` 且不联系远端。宿主 `/sessions/delete` 调 ACP `session/delete`，把 target 标成 `deleted`。进程已关时适配器只建裸连接发 delete，不重新附着、不拉起 agent。DSH 原生会话历史不删。之后 message 返回 `SESSION_DELETED`，网关和宿主两层都拒绝 |
| G3 | 已提交、已部署 | `4fbc500` | 人审预览按文字稿实际页数校验，不再固定 6 页。原计划不并进本轮，实际已单独提交 |
| G9 | 已提交、已部署 | `d7ad911` | 见 §4.10 末尾。spawn、message 可传 `provider`、`model`，仅限 `standard` 等非 ACP 预设；目录里没有则任务失败；不传保持宿主默认；回执带实际模型。DSH `selectModel` 会顺带改宿主默认模型 |

部署方式：`node scripts/local-deployment.mjs deploy --env test` 装到固定目录 `~/.local/share/1agents/a2a-gateway/test/runtime`，`current` 指向它。DSH 插件随 `@1agents/acp-service` 整包换进 `~/.dsh/profiles/web/node_modules`，旧包留在 `node_modules/.ignored/@1agents/`。这和 §6 写的不可变 release 目录不同：网关没有保留回滚快照，回滚要从 Git 重新构建。

网关配置里没有 `sessionLifecycle`，全部用默认值：空闲 600 秒回收，`INPUT_REQUIRED` 超过 7200 秒告警，`allowDelete` 关闭。

2026-10-31 的部署：网关和 DSH web 里的包与当天 11:51 的本地构建逐字节一致，两个服务在 11:53、11:54 重启。15:24 提交的 `76125a84`（DSH 完全访问下放行 ACP 工具审批）晚于这次构建；16:14 只换 DSH web 的插件、重启 `com.1agents.dsh-web`，把它和释放确认一起带上。网关没有重新部署，它已有把 `true` 记成 `closed` 的逻辑。

**P2 真机检查**（DSH web 插件，预设 `oneagents-acp-grok-build`，工作区 `ppt-beautifier`；两次都是只让模型记暗号、不调工具的任务，不回写生产任务）：

| 日期 | 生命周期 | 过程 | 结果 |
| --- | --- | --- | --- |
| 2026-10-28 20:21 | one-shot | 任务完成后立即普通关闭，grok 进程退出，进程租约消失；随后 message | `resumed: true`、`restoreMethod: session/load`，答对暗号 |
| 2026-10-29 | persistent，默认 600 秒 | 11:26 完成，11:37 按 `idle-ttl` 关闭，进程与租约在 2 秒内消失；11:38 追问接回后，新进程 11:49 再次按空闲关闭；14:50 追问，此时已关闭约 3 小时 | 同一 context 和 DSH 会话，`resumed: true`、`restoreMethod: session/load`，约 40 秒答对暗号；追问用上了预热进程 |

结论：grok-build 在普通 close 后经 `session/load` 接回，模型记得上文，闲置 3 小时也一样；没有复现凉会话卡住，`ATTACH_STALLED` 暂不需要。样本只有这两次，技能 `references/a2a.md` 里「不保证模型在进程关闭后仍记得上文」的说法尚未改。

**释放确认（2026-10-31 16:14 修复并部署）。** 修复前 DSH 适配器 `releaseSession` 在 ACP 会话上固定返回 `processReleased: 'pending'`，网关只有拿到 `true` 才把 `closing` 记成 `closed`，之后也不再复查：10-28 部署后检查过的 12 个 `oneagents-acp-*` 任务里，关闭的 11 个全部停在 `closing`，`/health` 的 `processReleasePending` 等于关闭总数（8）。现在 bridge 的 `close_session` 在关闭前读出运行时记录里的 agent pid，关闭后最多等 5 秒，确认进程已退出且没有进程租约再指向它，就回 `session_released`；`session/close` 据此在 `_meta['1agents']` 带 `processReleased: true`，插件原样交给网关。pid 未知或 5 秒内确认不了仍是 `pending`。部署后的一次 one-shot 任务（job `2427ffb0`）在答完约 2 秒内记成 `closed`、`processReleased: true`；追问经 `session/load` 接回、答对暗号，再次关闭也是 `closed`。`processReleasePending` 停在 8 没有再涨：这 8 个旧会话不会被回头改成 `closed`，往后看的是它的增量。

**进程名额。** 2026-10-31 的 `/health`：`processSlot` 4 个用了 3 个，租约来源是 2 个 `user-opened`、1 个 `prewarm`，A2A 派单只剩 1 个名额。网关按设计不回收这两类。调用方也还没按 §8 传 one-shot：上面 12 个任务里只有 2 个是 one-shot，都是这次真机检查；其余靠 600 秒空闲回收，每个任务答完后多占一个名额 10 分钟。

测试：2026-10-28 `packages/service` 412 项中 411 项通过。失败的「gateway shutdown cancels an in-flight Reader…」单独连跑 3 次都通过，属于负载下的时序抖动。插件 `service-process.test.mjs` 的「real Cordis startup failure」在本机仍失败，原因是正在运行的 DSH 占着默认 A2A 存储目录的租约，与这批改动无关。两者都会让 `pnpm test:integration` 退出码非 0。

## 6. 兼容、发布与回滚

- 新字段全部可选。先发布带新端点的 DSH 插件，再发布会调用这些端点的网关。旧网关忽略新端点。
- 这次发布分不开「只上关闭功能」和「从线上 0.8.3 升到仓库 0.9.0」。P1 的包就是当前源码。上线说明要列出本次 release 相对正在运行的 0.8.3 本地包的差异，和关闭功能一起交给同一次确认。不把升级写成可以后补的另一步。
- 发布沿用现有不可变 release 目录，保留当前正在使用的 release。回滚是把服务指回旧目录。
- 顺序是先换 DSH 插件并重启 DSH，再换网关并重启网关。重启 DSH 会停掉当时正在跑的会话。窗口选在口播批次的空档，重启前单独确认。本文不执行这次重启。
- 上线后看 24 小时：闲置 attached 数、`process_release_pending`、进程名额 FIFO 队首等待、`taskSlot` 与 `processSlot`，以及停在 `INPUT_REQUIRED` 超过 2 小时的数量。这些数没有采集前，不宣称容量问题已经消失。封面投递不在这次观察里。

## 7. 还没完成的事（2026-10-31 更新）

| 事项 | 状态 | 下一步 |
| --- | --- | --- |
| 释放确认 | 已修复并部署（2026-10-31 16:14） | 见 §5.1。旧的 8 个 `closing` 不回头改 |
| A2A 可用进程名额 | 断点，待决定 | 4 个名额里 `user-opened` 和 `prewarm` 占 3 个。三条路：调用方按 §8 传 one-shot；网关加一个让 `oneagents-acp-*` 默认 one-shot 的开关；调高上限。不为腾名额回收用户自己打开的会话 |
| DSH 完全访问下 ACP 工具被拒 | 已部署（2026-10-31 16:14），线上未复现验证，未推送 | `76125a84`：会话切到 `danger-full-access` 后审批策略变成 never，Grok 的 `terminal/create` 在 1 毫秒内被记成 rejected。修复后插件看到该沙箱模式直接放行 |
| 上线后 24 小时观察 | 未做，可以开始 | 从 2026-10-31 16:14 起按 §6 的指标采集。`processReleasePending` 看相对 8 的增量 |
| P2 真机检查 | 已通过 | 见 §5.1。要不要据此改技能里「不保证模型记得上文」的说法，单独决定 |
| 合并与发布 | 已合进 `main`、`develop` 并推送 | `main` 与 `develop` 已分叉，下一次合并时互相合回。`76125a84` 未推送 |
| G4 报告交付与通用交付接点 | 未开始 | 扩展计划 P1–P2。G3 已修，PPT 人审这道前置可以重新评估 |
| G5 workflow Provider、DAG、AP 投影 | 保持未实现 | 账本方案已把它们标成可选，现有派单不依赖它们 |
| G6 一键 cwd 与自动登记 | 保持手填 | 若要做，只填本次任务 cwd，不登记目标、不导入历史会话 |
| G7 工作台生产启用 | 测试环境已启用，方式变了 | 不再由父项目部署：网关自己在 `/workbench/ui/` 提供页面，可信网络下不配令牌。生产环境改用账号体系，尚未开始。父应用里旧的工作台页面与 Go 代理待确认后移除。见 [工作台阶段](agent-workbench-phases-20261027.md) |
| G8 Codex 只入队 | 未开始 | 单独立项。宿主不在线返回 `HOST_OFFLINE_QUEUED`，已开始执行才算 accepted |
| G3 六页人审 | 已完成 | `4fbc500` |
| G9 `standard` 不能指定模型 | 已完成 | `d7ad911` |

## 8. 调用约定（P1 上线之后）

- 使用 `oneagents-acp-*` 的口播、报告、单次检查，在 spawn 时传 `lifecycle: { "mode": "one-shot" }`，并使用默认的 `closeAfter: "terminal"`。口播验收看文件，返工在本地重渲染，不依赖模型还记得上文。不改成 `ack`：漏掉 ack 时进程会继续占名额。
- 这只安排终态后的普通 close，runtime 仍是 `persistent`。
- `standard` 预设不必传 one-shot。它没有 ACP 子进程，传了也只返回 `acp: false`。G9 部署后可以在 spawn 传 `provider`、`model` 指定模型，回执里看实际使用的模型；不传仍用 DSH 当时的默认模型。不要把模型名写进 prompt。
- 需要多轮追问的用 persistent。回合结束并空闲满 10 分钟后自动关闭；10 分钟内的追问仍在原进程上。用完也可以立刻 `remote_agent_close`。必须常驻的写 `idleTtlSeconds: 0`。
- 追问已关闭会话直接 `remote_agent_message`，看 `resumed`。grok-build 两次真机检查里模型都记得上文（§5.1），但样本少；结论必须可靠时仍从文件接续。
- 不用 cancel 释放已完成任务，也不为腾容量重启 DSH。

本方案不修改生产配置、不派模型任务、不重启 a2a-gateway 或 DSH。
