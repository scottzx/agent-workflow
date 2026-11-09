# PPT 美化大师常驻角色

这是 `ppt-beautifier` 固定角色的配置说明。角色不再带专属 DSH 预设或模型路由：固定目标默认跑在 DSH 的 `standard` 预设上，宿主按 `roleId` 在第一条消息前加上角色说明和技能指南路径，技能读自工作目录的 `.agents/skills`。每份上游 A2A 派单创建独立任务会话；同一 `contextId` 的后续指令复用该任务会话。

## 当前部署目录

- 角色定义：`/Users/scott/Documents/01-开发项目/1agents/network/1acp/.1agents/roles/ppt-beautifier`
- 技能分发源：`/Users/scott/Documents/01-开发项目/1agents/training/rsi-training/scenarios/ppt`
- 执行工作目录：`/Users/scott/Documents/01-开发项目/1agents/network/1acp/.1agents/runtime/ppt-beautifier/workspace`（技能在其中的 `.agents/skills`，`.claude/skills` 是指向它的软链）
- 角色状态及归档：`/Users/scott/Documents/01-开发项目/1agents/network/1acp/.1agents/runtime/ppt-beautifier/state`
- 项目网关登记、任务账本与通知：`/Users/scott/Documents/01-开发项目/1agents/network/1acp/.1agents/state/a2a-gateway`

目录和维护规则见 [项目 Agent 数据目录](../../.1agents/README.md)。

## 0.2.0 设计绑定

`0.2.0` 让角色先读取专属 `ppt-report-design` 与 `artifact-template-ai-value-report`。用户或合同显式指定的模板优先，否则从模板 manifest 导入15页参考的 master、layout、背景及页面骨架。默认视觉为米白、墨绿、赭金、砖红，不能仅换配色后继续使用旧蓝白稿。业务内容与机构品牌来自当前合同，不复制原报告的业务结论、机构名或图表库示例数字。

本次主模板来自聊天“围绕AI价值主线修订报告”（`01a156fc-998b-7a11-b811-fecbf1d5c139`）的 T12 最终交付快照“环节说明版”，共15页，SHA256 为 `7240b9d1b941e38c30f8449aff578089b85fa5cd3fcf0b9d9d50fc5f59af543d`。T12/E449记录最终文件和15页渲染，E451记录同hash交付，E452为最终答复。桌面同名文件后来被修改为18页，不作为此快照。

专属技能与资产布局：

```text
skills/
  artifact-template-ai-value-report/
    SKILL.md
    artifact-template.json
    assets/reference.pptx
    assets/preview.png
  ppt-report-design/
    SKILL.md
    references/design-profile.md
    references/design-profile.json
    references/output-records.md
    references/chart-library-index.md
    references/chart-library-provenance.json
    assets/curated-native-8-pages.pptx
    assets/curated-preview.png
```

图表原库实际202页（200张素材加封面、结尾），没有数据绑定Chart。精选8页对应原页3/9/19/43/50/51/52/109；只借用原生形状、文本、连接线与自定义几何，按语义选型后统一到主模板的字体、配色和间距。源库示例数据不是业务事实，整页截图不是可编辑图形。只有合同提供真实数据且适合数据图时，才创建数据绑定Chart。

本次部署由主控将 personal 模板目录完整复制至角色专属同名技能目录，再安装 `ppt-report-design`、设计档案、索引、精选原生PPTX及预览；部署记录位于 `/Users/scott/.local/share/1agents/ppt-beautifier/state/design-binding-0.2.0.json`，记录来源、hash、备份与文件清单。素材及模板均由明确路径复制，不自动遍历本机目录。该复制部署独立于bundle安装；部署其他机器时须重新提供授权素材路径与运行时说明。

Python辅助脚本使用3.12：`/Library/Frameworks/Python.framework/Versions/3.12/bin/python3`。Node与依赖位置以工作根目录 `RUNTIME.md` 为准，不使用系统 `python3` 猜测依赖。原模板微软雅黑在当前runtime不可用，采用已验证的 `PingFang SC` 并记录字体替换，不能声称精确雅黑保真。

每job额外交付 `design-plan.json`、`design-usage.json`，逐页记录模板页、原库页/精选页、native shape origins、输出对象映射及实际改造。最终PPT逐页与对应主源比较，复核可编辑性、示例内容清理与内容覆盖；页数遵从当前合同；未指定时按内容规划，脚本冻结后全页制作与全页验收，不固定6页。新任务使用fresh session，同一任务的message续派复用原session，node、profile、模型路由和A2A协议保持现有行为。

## 本地设计版本备份与恢复

`0.2.0` 设计快照保存在 `/Users/scott/.local/share/1agents/ppt-beautifier/state/design-releases/design-role-0.2.0.tar.gz`，同目录 `design-role-0.2.0.manifest.json` 记录归档SHA256、大小、白名单文件清单及逐文件校验结果。归档只含 `agent-bundle`、`skills/ppt-report-design`、`skills/artifact-template-ai-value-report`、`workspace/RUNTIME.md` 和 `state/design-binding-0.2.0.json`。binding的 `files` 覆盖两技能、bundle与RUNTIME；归档manifest另外记录binding自身hash。符号链接、凭据、其他技能、任务、日志、产物和node_modules不进入归档。

备份在references修订和独立技能检查完成后制作，文件按相对路径排序，tar元数据与gzip时间戳固定，重复生成可核对相同SHA256。它是角色设计文件的版本快照；现有DSH宿主、Presentations运行时、依赖、认证和网关仍需单独配置。

恢复时先对照manifest校验归档SHA256并查看成员列表，再解压到新的检查目录，逐文件核对hash。仅在确认目标角色没有运行中任务且获得恢复授权后，先备份现有白名单目标，再将检查后的同名目录与文件恢复到角色根目录，复核文件hash及RUNTIME中的本机路径。随后按既有安装与验证流程决定是否重载；备份包与这些说明均不会自动恢复文件、改网关或重启宿主。

设计增量 `0.2.1` 增加角色专属 `references/layout-planning.md` 并更新设计指令与记录要求；bundle版本仍为 `0.2.0`，新任务读取更新后的技能即可，无需重启、重装或更改模型及网关。变更来源记录在 `state/layout-upgrade-20261021/change-report.json`，新绑定为 `state/design-binding-0.2.1.json`。

对应快照为同一 `state/design-releases` 目录下的 `design-role-0.2.1.tar.gz` 与 `design-role-0.2.1.manifest.json`，沿用上述白名单并包含新增布局参考，归档内使用 `design-binding-0.2.1.json`。恢复时选择同一设计版本的归档、manifest与binding；原 `0.2.0` 绑定和备份保持原样，可按上述授权恢复流程回退。

## 预设与模型

固定目标 `binding.agentPreset` 是默认预设，不写时为 `standard`。模型是可选项：

- 不指定时，会话用宿主的默认模型。
- 每次派单可在 `input.provider` 和 `input.model` 临时指定，两者一起给，只对 DSH 原生预设（如 `standard`）有效；`oneagents-acp-*` 预设通过 `session/set_config_option` 换模型。
- 目标也可以在 `binding.provider`、`binding.model` 写一个默认模型，单次派单仍可覆盖。

改默认预设或默认模型用 `execution_target_update`；想保留原目标、另做一份不同配置的，用 `execution_target_fork` 复制一份副本，例如：

```json
{ "targetId": "ppt-beautifier", "newTargetId": "ppt-beautifier-grok",
  "patch": { "name": "PPT 美化大师（Grok）", "binding": { "agentPreset": "oneagents-acp-grok-build" } } }
```

`patch.binding` 只写要改的字段，其余沿用原目标；原目标不变，新目标版本从 1 开始。

## A2A 接入

`a2a-host.patch.example.yml` 是独立的宿主配置示例，**不属于角色 bundle 的自动安装内容**。应用前保留现有 `oneagents-acp` 的全部配置字段，替换 callback origin，安全提供宿主 token。`tokenEnv` 仅在该变量真实存在于受管理 DSH Web 进程环境时有效。也可以由部署过程将随机 token 写入权限 600 的既有宿主配置；不得把真实 token 保存到此示例。

在网关中添加指向本机 DSH A2A 的 remote，凭据只进入受保护网关配置。上游通过现有 `remote_agent_spawn` 派单：

```json
{
  "remote": "ppt-beautifier",
  "originSessionId": "<REAL_PARENT_SESSION_ID>",
  "cwd": "/Users/scott/Documents/01-开发项目/1agents/network/1acp/.1agents/runtime/ppt-beautifier/workspace",
  "agentPreset": "standard",
  "roleId": "ppt-maker",
  "title": "PPT 美化任务",
  "prompt": "请读取 <ABSOLUTE_CONTRACT_PATH>，按合同导入原稿并美化，输出可编辑 PPTX，逐页渲染并实际检查，最终答复附已存在的 PPTX 与预览链接。"
}
```

父会话须提前完成 `session_bind`。网关沿现有持久任务、状态查询、最终答复通知和 ack 链路回传，不由这个角色另行推送。原主会话读取实际产物、保存验收结论后再调用 `remote_agent_ack`。

`defaultAgentPreset` 是宿主默认值，现有通用 A2A API 仍允许调用者显式指定其他预设；角色职责约束和技能目录配置不等于操作系统级沙箱。

## 合同最低信息

合同应提供任务目标、源 PPTX 绝对路径、输出目录、页数、受众、语言、需要保留的内容、设计方向、最终格式及验收要求。可附上每页的文字和数据清单，便于核验无遗漏。所有路径必须在本任务授权范围内。用户明确要求美化时允许更改原稿样式，严格模板要求则应在合同中明确。

如未明确指定模板，使用上述默认设计绑定；另有模板时在合同中给出路径与使用要求。设计来源与业务资料分别记录，模板中的报告内容和素材库中的示例数据不能补成业务事实。

真实验收应覆盖：A2A 派单返回 taskId，状态进入 WORKING，模型实际读取合同与技能并导入原稿，最终可编辑 PPTX 真实存在，各页已渲染并实际检查，自动通知包含最终答复与产物链接，原主会话读取并确认产物后 ack。各阶段分别保留可核验记录。

## 固定角色与页数

角色规则以 [ROLE.md](ROLE.md) 为准，同步到角色 workspace/ROLE.md。页数可通过交付输入 `slideCount` 指定；省略时由事实脚本按内容规划，后续制作、预览、机器校验及独立验收按冻结脚本的实际 N 页执行。既有六页合同与产物不变。

## 技能

角色说明和技能清单由 [.1agents/roles/ppt-beautifier](../../.1agents/roles/ppt-beautifier) 维护。技能放在工作目录的 `.agents/skills`，修改技能源后执行：

```sh
acp-service roles sync --profile .1agents/roles/ppt-beautifier/profile.json \
  --cwd .1agents/runtime/ppt-beautifier/workspace \
  --source /Users/scott/Documents/01-开发项目/1agents/training/rsi-training/scenarios/ppt
```

不再网络下载、缓存或锁定版本，续派读目录当前内容。
