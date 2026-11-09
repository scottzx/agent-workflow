# 项目 Agent 数据目录

角色定义、完整技能包缓存、任务工作目录和项目运行状态统一放在项目根 `./.1agents/`。角色定义与技能独立维护：profile 声明职责说明与技能引用，方法、脚本、模板及素材由能力网络发布。普通派单仍立即交接，技能解析由执行宿主后台完成。

创建角色、调用固定角色和派发临时任务的入口与参数见随包 [acp-service 技能](../packages/service/skills/acp-service/SKILL.md)及其 [API 路由](../packages/service/skills/acp-service/references/roles-and-tasks.md)。`resident-agent` 技能负责角色创建/维护；目标登记 API 不代替完整部署。

## 目录

```text
1acp/.1agents/
  README.md                     # Git：目录与维护约定
  roles/ppt-beautifier/          # Git：角色说明、技能引用和版本策略
  roles/wechat-stock-replenisher/ # Git：AP感应式角色说明及声明示例
  config/
    project-discovery.example.json # Git：可选项目探查配置示例
    wechat-stock.example.json   # Git：公众号候补补库配置示例
  skills/ppt/                   # 独立维护的技能分发源，忽略提交
  runtime/ppt-beautifier/        # 本机运行数据，忽略提交
    workspace/.agents/skills/   # 角色会话读取的技能（roles sync 写入）
    workspace/.claude/skills    # 指向 ../.agents/skills 的软链，供 Claude Code
    agent-bundle/               # 宿主加载的角色 bundle
    host-bundle/                # 本机宿主挂载配置
    workspace/                  # 执行 PWD、任务目录及产物
    state/                      # 角色绑定、A2A 会话关联与版本归档
  state/a2a-gateway/             # 项目网关登记、任务账本与通知，忽略提交
    project-discovery/discovery.json # 目录候选快照、探查模式与诊断
```

Git 只跟踪角色声明、说明及示例配置。技能包、缓存、素材、任务数据、产物、状态和本机私密配置不提交。共享宿主安装包、登录凭据、全局模型配置及原生 DSH/Codex 会话库仍由宿主管理；本目录保存项目的会话关联、任务回执和产物，其角色绑定指向上述目录。

[公众号补库专员](roles/wechat-stock-replenisher/ROLE.md)是AP流程角色，使用 `role.example.json` 描述规则和依赖；它不是网络模型角色的原生 `profile.json`，不参与该格式的自动探查或A2A目标注册。生产接点已补齐，每30分钟读取真实工作台并按10/15规则补候补内容池；具体启用和验收状态见[实施记录](../docs/wechat-stock-replenishment-implementation-20261023.md)，不以声明文件代替运行证据。

本机 macOS 的 launchd 不能打开 Documents 目录内的服务启动日志，三个启动器的 stdout/stderr 保存在 `~/Library/Logs/1agents/`，权限为目录 0700、文件 0600。该系统日志例外不改变角色任务的实际 PWD、技能缓存或产物位置。

技能分发源在 `.1agents/skills/ppt` 等目录维护；修改技能后用 `acp-service roles sync` 复制进角色工作目录。工作目录里的副本不是源，不在那里直接改。

## 可选项目与角色探查

网关可通过已安装的 Session Reader CLI 读取项目目录元数据，再只读检查项目中的 `.1agents/roles/*/profile.json` 结构，从项目/PWD 目录元数据形成角色候选。Reader 当前提供 `1session projects --json` CLI；不假设其 HTTP 服务存在 projects 接口。不安装 Reader，不读取会话正文、ROLE、技能脚本或执行角色代码。

参考 [project-discovery.example.json](config/project-discovery.example.json)，将其中 `projectDiscovery` 合入受保护网关配置，替换为本机真实可执行文件和允许根目录。`allowedRoots` 为非空绝对路径列表；`explicitRoots` 可补充已知项目根。默认 `timeoutMs=15000`、`maxProjects=200`，探查范围与单次数量有界。未配置时接口明确返回未启用，不自行扫描。示例文件不会被自动加载，也不代表当前服务已配置或部署。

| 可信管理接口 | 参数与作用 |
| --- | --- |
| `execution_project_scan` | `{}`；手动执行一次探查并保存候选快照，不创建任务或目标 |
| `execution_project_list` | `{}`；只读已保存快照，不隐式触发扫描 |
| `execution_discovery_config_get` | `{}`；只读持久的 manual/interval 模式与 intervalMs，不扫描 |
| `execution_discovery_config_update` | `{mode:"manual"}` 或 `{mode:"interval",intervalMs:60000}`；切换手动/定频模式 |

默认 `manual`。定频模式必须显式提供 `intervalMs`，范围为 60 秒至 24 小时，由网关后台维护；主会话不循环 scan/list，不等待目录变化，也不因目录更新被唤醒。切回 manual 停止周期探查，保留已有候选。执行范围和 Reader 路径由可信网关配置决定，普通任务参数不能覆盖。

快照位于 `.1agents/state/a2a-gateway/project-discovery/discovery.json`；Reader 失败或结果不完整时保留旧候选并标明 partial/stale 与诊断，不把旧快照冒记为最新成功。发现角色 profile 只说明存在候选，不代表宿主映射、技能加载、目录权限或模型已经就绪。登记角色/目标仍需显式管理操作；一键填入临时任务 cwd 和自动注册不在本次范围。Reader 缺失不影响手填目录或普通派单。

## 角色技能

角色的技能放在它的工作目录里：`<cwd>/.agents/skills/<name>/`。DSH 和 Codex 在会话开始时读这个目录，Claude Code 读 `<cwd>/.claude/skills`，后者是指向 `../.agents/skills` 的软链。宿主不再经能力网络下载技能，也不再锁定版本；同一角色的新任务、续派、返工和恢复读到的都是目录当前内容，漂移由验收规则兜底，需要版本控制的是验收规则和要求。

分发源（例如 `training/rsi-training/scenarios/ppt`，或 Skill Manager 的来源）只是源数据。大文件资源在建角色时随技能目录一起复制，之后工作目录可离线使用：

```sh
acp-service roles sync --profile .1agents/roles/ppt-beautifier/profile.json \
  --cwd .1agents/runtime/ppt-beautifier/workspace \
  --source /path/to/skills-distribution
acp-service roles check --profile .1agents/roles/ppt-beautifier/profile.json --cwd .1agents/runtime/ppt-beautifier/workspace
```

`sync` 把 profile 点名的技能逐个复制（先写临时目录再替换，源与目标是同一目录时跳过），然后校验并补软链；`check` 只校验与补链。若 `.claude/skills` 已是真实目录，只为这些技能各补一条软链；若它是指向别处的链接则报错，不覆盖。技能名同时是目录名，只允许字母数字及 `._-`。

## 接单规则

- 通用 A2A 宿主通过 `roleSkills: {profiles, presetRoles?}` 配置可信 profile；请求只传 `roleId`，不能替换 profile 或目录。profile 只有 `id/version/instructionsPath/skills/entrySkill`，skills 每项只有 `key/name`。
- 角色会话的工作目录（请求 `cwd`、续跑的已存 `cwd` 或宿主默认 `cwd`）里缺任何一个 profile 点名的技能，会话在启动模型之前失败，校验码 `role-skills-unavailable`。
- 宿主在第一条消息前加上角色说明和各技能的 `SKILL.md` 路径。路径智能体（`agentFile`）可以和宿主角色同时使用，两段前缀依次拼接。
- 固定目标设 `binding.loadRole: true` 时，网关把 `binding.roleId` 转发给宿主，宿主加载该角色及工作目录里的技能；不设时 `roleId` 只是标签。旧无角色会话不会中途升级。固定 PPT preset 可通过宿主 presetRoles 自动选择角色；通用 Codex/standard 不受影响。
- 系统结果 metadata 记录实际角色和各技能目录。

运行环境、MCP 工具权限和二进制依赖仍由宿主管理；同步技能不隐式安装依赖。
