# 角色管理、固定角色调用与临时任务

这是统一 API 技能的任务路由。`resident-agent` 若已安装，用于创建和维护专职角色；本技能负责实际接口调用。领域方法仍由角色引用的技能负责。创建角色是管理阶段，日常调用不重复创建、部署或预热角色。

## 三种工作

| 请求 | 操作 | 所需信息 |
| --- | --- | --- |
| 创建固定角色 | 配置角色与宿主，再登记 resident_agent 目标 | 职责、网络技能源、缓存、预设、工作根目录及交付约定 |
| 调用固定角色 | `execution_submit` 到已有 resident_agent target | targetId、完整任务要求；cwd/preset/role 由目标固定 |
| 一次性临时任务 | `execution_submit` 到已有 agent_host target | targetId、执行端 cwd、preset、完整任务要求；无需创建角色 |

没有一条 `role_create` API 可完成全部创建与部署。`execution_target_create` 只登记目标，不生成 persona/profile、不安装技能、不配置宿主、不证明模型能执行。固定角色的持久配置可反复接单，每个独立任务仍创建独立执行上下文；同目录不等于同会话。

## 可选项目与角色候选探查

已配置 `projectDiscovery` 时，网关通过 Session Reader 的 `1session projects --json` CLI 读取项目/PWD 元数据，并只读检查 `.1agents/roles/*/profile.json` 结构。Reader 没有 projects HTTP 接口；不臆造该接口，不安装 Reader，不读会话全文、ROLE 或脚本，不加载角色代码。能力为可选集成，缺失时保留手填目录。

可信网关配置为 `projectDiscovery:{readerExecutable,allowedRoots,explicitRoots?,timeoutMs?,maxProjects?}`：readerExecutable 指向已安装 CLI，allowedRoots 为非空绝对路径列表，explicitRoots 可补充已知项目根，timeoutMs 默认 15000、maxProjects 默认 200。任务参数不能更换可执行文件或扩展根目录范围。公开配置示例位于工程 `.1agents/config/project-discovery.example.json`，示例本身不自动激活服务；未配置时接口明确返回未启用，不隐式扫描。

| 可信管理接口 | 参数与行为 |
| --- | --- |
| `execution_project_scan` | `{}`；显式扫描一次，返回并保存有界候选与诊断 |
| `execution_project_list` | `{}`；读取已保存快照，不触发 Reader |
| `execution_discovery_config_get` | `{}`；读取持久的 manual/interval 模式与 intervalMs，不扫描 |
| `execution_discovery_config_update` | `{mode:"manual"}` 或 `{mode:"interval",intervalMs:60000}`；intervalMs 在定频模式必须显式填写，范围 60000–86400000 |

默认 manual；用户选择定频后，由网关后台扫描，切回 manual 停止周期扫描。目录探查不派模型任务、不创建或注册目标、不产生任务完成通知、不唤醒原主会话；主会话只执行用户要求的一次管理动作，不循环 scan/list 等待变化。

快照及模式保存在 `.1agents/state/a2a-gateway/project-discovery/discovery.json`，失败时保留旧候选并标 partial/stale。依据诊断与读取时间使用候选，不能把陈旧目录当作当前可执行位置；本机路径也不能默认当作远端 cwd。角色候选仍需完成宿主映射、运行环境和目标登记，目录权限由实际执行端接单验证。本次只实现发现；一键填入任务 cwd、自动注册目标及新工作台 UI 不属于本次能力。

## 创建与更新角色（管理阶段）

1. 复用当前网关、宿主及认证配置，明确职责、工具权限、读写目录、输入和交付。技能通过能力网络检索，精确记录来源及名称/标识；发现结果不等于实际加载。
2. 创建薄 `ROLE.md` 与网络技能 profile。profile 原生字段为 `id/version/instructionsPath/network/skills/entrySkill`；skills 每项包含 `key/name`，可用 `sourceId/skillId` 消除歧义，并可声明 `nodeUrl/assetsManifest`。不要把登记清单误当原生 profile，也不要把领域脚本和模板写入 persona。源码示例见工程 `.1agents/roles/ppt-beautifier`；项目运行数据统一放在 `./.1agents/`。
3. 在执行宿主 `a2a.roleSkills` 配置可信的 `cacheRoot`、`profiles: {逻辑roleId:绝对profile路径}`；可选 `presetRoles` 仅为专用 preset 自动绑定。通用 preset 不隐式改成某领域角色。DSH/Codex 共用宿主加载入口；运行依赖和工具仍由宿主管理。
4. 有专用预设时安装/更新该预设；也可使用已可用的通用预设配合目标绑定的 roleId。凭据只在受保护宿主/网关配置。需要重载共享宿主时先确认没有运行中会话。
5. 复用已登记 connection，通过可信本机管理入口登记或更新 resident_agent target。最小登记参数如下，值均需替换为真实部署值：

```json
{
  "targetId": "my-role",
  "kind": "resident_agent",
  "name": "角色显示名",
  "connectionId": "registered-connection",
  "binding": {
    "cwd": "/absolute/existing/role-workspace",
    "agentPreset": "installed-preset",
    "roleId": "host-configured-role-id",
    "skillPolicy": "network_pinned"
  }
}
```

`execution_target_update` 参数是 `targetId/expectedConfigVersion?/patch`；`patch.binding` 按整体替换，保留未改的 cwd/preset/role/目录限制。目标管理方法只开放可信本机管理入口，不能当远端公开任务 API。

6. 在管理阶段预热并校验完整技能包、资源及资产，核验宿主配置；只有用户授权实际试单时才测试模型执行和通知闭环。HTTP 200、目标已登记或 preset 可见仅证明对应管理步骤。

目录约定：角色定义为 `.1agents/roles/<role>`，技能缓存与锁为 `.1agents/cache/roles`，本地技能源为 `.1agents/skills`，角色 bundle/工作目录/产物/状态为 `.1agents/runtime/<role>`，项目网关账本与通知为 `.1agents/state/a2a-gateway`；私密配置在 `.1agents/config`，不提交 Git。

工程统一更新入口：`node scripts/update-role-skills.mjs --config .1agents/config/role-skills.local.json`。部署环境也可用 `acp-service roles sync --profile PROFILE --cache-root CACHE [--lock EXISTING]` 管理缓存。新任务解析当前版本；同任务续派、返工与恢复使用原锁。更新不会安装二进制依赖或隐式派模型任务。

## 调用固定角色

先读已登记 target；确认已具备原主会话绑定和输入条件后提交。以下为 `execution_submit` 的合法结构，示例不代表已执行：

```json
{
  "originSessionId": "actual-parent-session-id",
  "targetId": "ppt-beautifier",
  "clientRequestId": "stable-request-id",
  "title": "演示文稿设计",
  "input": {
    "prompt": "按已冻结合同执行，说明输入路径、授权目录、受众、交付要求和验收边界；完成后给出真实产物链接。"
  }
}
```

固定目标禁止传 `input.cwd/agentPreset/roleId/driver`，即使值与绑定相同也拒绝。任务目录等检查和系统产物清单使用 `input.preflight/resultContract`，详细字段见 [A2A](a2a.md#派单前预检和系统结果元数据)。需要由项目总结→制作→独立验收自动推进的完整 PPT 交付，应选择部署中绑定 `driver=ppt_delivery` 的目标及其输入契约；普通 PPT 角色调用只执行当前合同。

## 派发临时任务

向已登记的 agent_host 目标调用同一个 `execution_submit`，每单提供执行端目录与 preset：

```json
{
  "originSessionId": "actual-parent-session-id",
  "targetId": "registered-agent-host",
  "clientRequestId": "stable-temporary-request-id",
  "input": {
    "cwd": "/absolute/existing/project",
    "agentPreset": "oneagents-acp-codex",
    "prompt": "只读总结该项目，在本任务授权目录保存报告；不得修改项目源码。"
  }
}
```

preset 必须在执行宿主真实可用；要用普通 DSH 时显式选 `standard`。临时任务无需新建角色或复制技能。若需复用宿主已配置的网络角色，可显式传 `input.roleId`，仍不能自定义 profile、网络地址或缓存根。兼容旧客户端可使用 `remote_agent_spawn`，见 [A2A](a2a.md#远端任务工具)。

## 账本、通知与处理

提交参数共同使用 `originSessionId/targetId/input`，建议稳定 `clientRequestId`；返回后保存 `sourceId/jobId/attemptId` 及可用的 `remote/taskId/contextId/sessionId`，立即结束本轮。受理未知不自动换编号重派。父子任务用 `parentJobRef:{sourceId,jobId}` 和可选 `parentAttemptId/purpose/resultRevision/replacesJobRef` 关联，不另造“外层任务”术语。

| 操作 | 方法与关键参数 |
| --- | --- |
| 通知后或用户明确要求的单次读取 | `execution_get {originSessionId,jobId}`；保留历史 attempt，查询不唤醒主会话 |
| 同任务继续/返工 | `execution_continue {originSessionId,jobId,input,clientRequestId?}`；保留原 job，增加执行轮次 |
| 关闭任务并取消子任务 | `execution_cancel {originSessionId,jobId,cascade?}`；PPT 交付默认级联，通用任务需显式 cascade=true；未决取消不能冒记全部停止 |
| 记录业务接受/退回 | `execution_review {originSessionId,jobId,attemptId,resultRevision,resultDigest,reviewStatus,decidedBy,note?}`；reviewStatus 为 pending/accepted/changes_requested，值来自真实当前回执；decidedBy 必填，人写 `{kind:"person"}`，教练写 `{kind:"coach",agent,sessionId}`，`acp-service a2a invoke` 会按运行环境自动填写 |

通用 A2A 结果完成后由账本自动生成轮次内 `resultRevision` 与 `resultDigest`；从 `execution_get` 或 `remote_agent_get` 取真实值，不用技能 revision、请求中的父子关联版本或手工编号替代。digest 覆盖结果正文、回执引用、链接及宿主返回的文件大小/SHA256 清单；没有清单时不代表已验证文件字节。重复读取/重启保持版本稳定，结果变化追加新版本，`execution_get/list` 的 `resultHistory` 和 `attempts[].resultHistory` 留存版本快照。只接受当前已完成且结果可用的轮次及版本；新结果不继承旧验收。升级从缓存回执补齐旧任务缺失版本，不重派、不自动验收；需补登时核对本地既有结论与同一回执的身份、正文和产物清单后另调 `execution_review`。

**按实际通知类型选择收件箱和 ack，不能按提交方法推断。** 普通 resident_agent/agent_host 即使由 execution_submit 提交，也可能返回 A2A 通知。

| 通知定位 | 单次读取 | 保存结论后的确认 |
| --- | --- | --- |
| A2A 通知，含 remote/taskId | `remote_agent_get` 或已保存 job 的 `execution_get`；无 task 定位时用 `remote_agent_inbox` | `remote_agent_ack {originSessionId,noticeId}` |
| 领域交付通知，含 sourceId/jobId/attemptId | `execution_get` 或 `execution_inbox` | `execution_ack {originSessionId,noticeId}` |

业务接受和通知 ack 分开记录，均不能替代执行成功或独立验收证据。通知正文和已有产物不等于最终交付通过。主会话不主动轮询、不读子会话日志、不重复验收；真实通知后只核对合同要求的回执/新报告、记录结论并确认。现稿 PPT 只验收及 Codex 四步计数另用 [专用流程](async-caller.md)，普通任务不套用其报告字段与结论。
