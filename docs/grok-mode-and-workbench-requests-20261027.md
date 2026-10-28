# Grok 权限模式与工作台的两类人工事项

- 日期：2026-10-27（Asia/Shanghai）
- 状态：模式行为按当前源码核对。过程请求已写入网关状态、工作台投影和 DSH 插件竞速。试跑接受的 ACP 设置按工作区与 Agent 记在插件里，新建会话自动回放。源码测试已通过。未重启 DSH，未部署。
- 相关实现：[任务工作台](task-workbench-implementation-20261022.md)、[人工审核设计](human-in-the-loop-design-20261022.md)

## Grok 的 mode

Grok 有 `bypassPermissions`。ACP 设置里的名称是 Always Approve。新建 Grok 会话的默认值是 `acceptEdits`，不是 bypass。

取值和短路结果定义在 `packages/runtime/src/acp/client.ts` 的 `GROK_PERMISSION_MODE_IDS` 与 `grokModeOutcome`。桥接侧 `packages/service/src/bridge.js` 用同一套默认值和同一套判定。权限请求先在 runtime 里短路；没有短路的才进入 DSH 的 `approval.request`。

| mode | 界面名称 | 工具权限 | 无人值守的 A2A 任务 |
| --- | --- | --- | --- |
| `bypassPermissions` | Always Approve | 全部直接允许 | 不因工具审批停下 |
| `acceptEdits` | Accept Edits | 改文件直接允许；执行命令仍要人批 | 第一条终端命令会停住 |
| `default` | Ask | 不短路，工具调用都要人批 | 停住 |
| `auto` | Auto | 不短路 | 停住 |
| `plan` | Plan | 写文件和命令直接拒绝 | 工具被拒绝；退出计划时还要人批计划 |
| `dontAsk` | Deny | 全部直接拒绝 | 不停下等人，工具执行被拒绝 |

`session/set_mode` 本身不等待人工确认。没有试跑记录时，插件在新会话上套用 `sessionPolicies.initialModeId`，先核对 `session/new` 返回的 `availableModes`；目录里没有该 id 就失败，并有 60 秒上限。试跑已经接受的 mode 和配置按下一节回放。Grok 要让分发任务跳过工具审批，试跑里接受的 mode 是 `bypassPermissions`。

bypass 只覆盖工具权限。下面两类仍会停下等人，与 mode 无关：

- Grok `_x.ai/ask_user_question`，DSH 插件 `adapter.question` 调用 `userQuestions.ask`。
- 退出计划 `_x.ai/exit_plan_mode`，`adapter.plan` 用同一提问接口，选项是批准或拒绝。

桥接里提问保存在内存，5 分钟无答复就取消（`bridge.js` 的 `ask_user_question`）。DSH 轮次因此停在 `blocked` 时，A2A 记为 `input-required`，说明是「DSH blocked the task before its next model step」。

## 试跑后按 Agent 固定

试跑在 DSH 的 ACP 设置里改动并被 Agent 接受后，插件把结果记到状态目录的 `agent-session-settings.json`，和会话绑定放在一起。键是工作区的绝对路径加上 ACP Agent 名称。预设 `oneagents-acp-grok-build` 对应 Agent `grok-build`，`oneagents-acp-codex` 对应 `codex`。每条记录保存该 Agent 自己被接受的 `modeId` 和有序 `{id, value}`。Grok Build 可以记下 `model`、`reasoningEffort` 和 `bypassPermissions`；Codex 可以记下 `model`、`verbosity` 和它自己公布的 mode。选项 id 以该 Agent 当时公布并被选中的为准。

之后同一工作区、同一 Agent 新建会话时，插件在 `session/new` 返回后、首条 prompt 前回放这份记录。带模型标记的选项在前，其余选项保持当初的相对顺序。每一项先对照手头的目录，再调用 `session/set_config_option`，并用这次返回的新目录检查下一项。模式放在最后，调用 `session/set_mode`。记录里有 mode 时使用该 mode。记录里只有配置、没有 mode 时，仍套用该 Agent 的 `initialModeId`。没有任何试跑记录时，只套用 `initialModeId`。

目录里缺少当初的 id，或缺少当初的值时，这次新建会话在 prompt 前失败，并关闭刚创建的远端会话。同一条已经存在的会话，包括导入后恢复的会话，保持它自己的设置。同一选项再次在 ACP 设置里选定会覆盖该 id 的值。`initialModeId` 和未改动的会话默认值不写入这份文件。调用方的 `execution_submit` 保持原有字段。

Grok 的分发任务要避开工具审批时，试跑接受的 mode 是 `bypassPermissions`，并且只写在 Grok 自己的记录里。Codex 固定的是 Codex 试跑接受的 mode。文件损坏时插件拒绝读取。文件不存在表示还没有试跑记录。

## 结果验收

任务工作台的结果验收仍来自 `HumanReviewRequest`（`packages/service/src/execution/human-review.ts`）。它绑定 Job、Attempt、阶段、版本和 SHA-256。生产者那一轮可以已经结束，父流程停在 `input_required / awaiting_human`。决定是评论、通过、要求修改、放弃。通过之后由父流程续跑。最终成品的 `humanAcceptance` 也是结果验收，和文字稿阶段审核分开。

过程请求是另一份记录（`packages/service/src/execution/process-request.ts`）。它不进入 `HumanReviewRequest`，也不改账本上的 `executionStatus`。提问期间任务可以仍是 `working`，展示状态变为 `awaiting_human`。

## 同一页面上的第二类事项

审批工作台负责两类内容，记录分开。

| | 结果验收 | 过程请求 |
| --- | --- | --- |
| 何时出现 | 某一版产物已经形成 | 模型这一轮还停在提问或计划审批上 |
| 绑定 | `reviewId`、版本、digest | 当次 `requestId`、DSH `sessionId`、Job、Attempt |
| 人的动作 | 通过、要求修改、放弃、评论 | 按问题选择或填写；计划只有批准或拒绝 |
| 系统接着做什么 | 父流程按决定续跑或退回作者 | 用同一 `requestId` 完成正在等待的 `userQuestions` 调用 |
| 不能当成 | 对一条活着的 RPC 的答复 | 对产物版本的业务验收 |

过程请求的种类先做两个：

- `question`：`adapter.question` 收到的题目、选项、是否多选。
- `plan`：计划正文，决定映射为 `approved` 或 `rejected`。取消映射为现有的 `abandoned`。

2026-10-28 起，没被 mode 短路的工具审批也作为第三类过程请求 `permission` 进入这个队列：记录工具名和待批准的参数（例如命令），人只能允许本次、拒绝或取消，5 分钟内无人回答按取消处理，工具被拒绝。每次工具调用单独成一条，先前的允许不覆盖之后同样的命令。Grok 试跑接受了 `bypassPermissions` 之后，该工作区新建的 Grok 会话会套用这个 mode，工具审批在 runtime 里短路，不再出现这类请求。

## 接入方式

网关每次 `sendMessage` 在 `metadata.1agents` 里带上 `execution: { jobId, attemptId }`。工作台凭据留在插件配置 `a2a.workbench` 的 `url` 与 `token`，不进入 A2A metadata。

DSH 执行器在 `execute()` 期间把这份引用绑到当前会话，回合结束即解除。配置了工作台且当前会话有绑定时，`adapter.question` 和 `adapter.plan` 登记过程请求，并让 `userQuestions.ask` 与工作台轮询竞速。先到的答复完成原来那次等待。没有配置、交互会话没有绑定，或登记失败时，仍只等 DSH 界面。

DSH 界面先答复时，插件把该答复回写工作台，卡片关闭。工作台先答复时，插件中止 DSH 提问，并把 `accepted` / `approved` / `rejected` 交回 ACP。取消和过期分别交回问题的 `cancelled` 或计划的 `abandoned`。这次答复不另发 A2A 用户消息。

同一 `clientRequestId` 配同一正文只记一次。同一 id 换正文返回冲突。已经决定后再换一个 id，返回已决定。期限是 5 分钟。读取过期只改展示；超时后的提交把记录写成过期并拒绝。题目和计划正文留在过程请求里，不写入账本通知。

「待我确认」同时计入未决的结果验收和未过期的过程请求。子任务上的过程请求会显示到父任务。详情在结果验收旁边列出过程请求，当前尝试且仍在执行时才可提交。

回合结束后，当前尝试里若有工具审批没有得到允许（过期、取消或拒绝），页面不把它显示为已完成，而显示「工具未获批准」，说明有几个工具调用未获批准、结果可能不完整，并计入「失败」筛选。账本里的 `completed` 不变，只改展示。发起会话用 `execution_review` 记录「已验收」后，按验收结论显示。页面在任务清单和详情里显示当前结果的业务验收（已验收、验收要求修改、验收待定），详情另有「业务验收」一节，列出结论、结果版本、时间和说明。验收只认当前结果版本和摘要，结果换了版本就不再显示旧验收。页面不提供验收按钮，验收仍由发起会话核对结果后记录。这条规则只看过程请求，工具审批进入工作台之前的回合无法据此识别。

工作台沿用既有 bearer，并拒绝带 Origin 的请求：

- `POST /workbench/tasks/:jobId/process-requests`
- `GET /workbench/tasks/:jobId/process-requests/:requestId`
- `POST /workbench/tasks/:jobId/process-requests/:requestId/answers`

请求正文只保留题目、选项、计划文本，以及工具审批的工具名和待批准参数（上限 16KB），不写入凭据、完整 prompt 或工具输出。

工作台下一层按 [智能体开发阶段与运行阶段](agent-workbench-phases-20261027.md) 扩展：任务与智能体同级，试跑和正式任务进入同一清单和同一审核。该结构已写入网关投影、命名发布存储和父应用页面。发布名字尚未同步到 DSH 的 `agent-session-settings.json`。六页人审预览、报告交付、workflow 执行、一键 cwd 和工作台生产启用不在这次改动里。六页人审预览仍按 [缺口收口方案](a2a-gap-closure-plan-20261027.md) 单独处理。试跑后按 Agent 固定 mode 与配置选项已写入 DSH 插件。编辑这份源码不会改变已经安装的网关，要等发布后再加载。未重启 DSH，未部署。
