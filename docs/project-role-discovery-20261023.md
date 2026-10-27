# 项目角色目录探查 · 2026-10-23

## 范围与入口

可选接入已安装 Session Reader 的 `1session projects --scope ... --page ... --limit ... --json`，取得项目与历史工作目录元数据，再只读检查受控目录的 `.1agents/roles/*/profile.json`。工作目录按真实物理路径校验，保留 worktree 的身份；项目名、聚合代表 workspace 和历史会话目录都不能证明当前可执行位置。

- `execution_project_scan {}`：执行一次探查并保存候选。
- `execution_project_list {}`：只读已保存候选，不调用 Reader。
- `execution_discovery_config_get {}`：读取手动/定频设置。
- `execution_discovery_config_update {mode:"manual"}` 或 `{mode:"interval",intervalMs:60000}`：持久切换模式，定频范围为 60 秒至 24 小时。

可信网关配置使用 `projectDiscovery`，指定 Reader 可执行文件、允许根目录和可选显式项目根；普通调用参数不能扩展范围或替换程序。缺少配置时明确返回未启用。默认手动，定频由后台网关维护，不占用主会话执行轮次。

## 数据与边界

候选、模式和诊断保存在 `.1agents/state/a2a-gateway/project-discovery/discovery.json`，属于本机状态，不进入 Git 或发布源码。读取 profile 仅作结构校验，不读取会话正文、ROLE 或技能脚本，也不执行项目代码。

Reader 缺失、分页不完整、超时或目录异常会记录诊断并保留旧候选，标明 partial/stale；列表不会假装旧数据是新一次成功。扫描不创建任务、通知、连接或目标，不自动加载技能、启动角色或唤醒主会话。候选需经过显式宿主映射、预检和目标登记后才能派单；一键填入任务 cwd、自动登记与工作台选择器不在本次范围。

已提供公开示例 `.1agents/config/project-discovery.example.json`。发布源码归档只增加此精确白名单，私密配置和实时 discovery.json 仍被排除。

## 验证与部署

- 服务完整回归 **312/312 通过**，类型检查通过。新增 13 项 scanner/gateway 集成覆盖手动不扫描、定频推进与停止、重启保留、路径越界与工作树身份、缓存别名、FIFO、失败保留、分页/字节预算及 Reader 忽略 SIGTERM 时的关闭。
- 完整包部署辅助回归 **10/10 通过**，公开示例收录且本机私密配置和实时状态仍被排除。
- 已从干净源码提交 `5dc0bcb` 完整构建、归档并部署到当前网关与 DSH 包槽；本机发布目录为 `~/.local/share/1agents/a2a-gateway/releases/20261023-project-discovery-01`。安装包 SHA256 为 `ff6e86f3765fa47151534d54e69a2f7498c14467ce8309ba43af4ebf6a2ba1d2`，完整包/依赖/源码清单及回退回执保留在该目录；未发布 npm。
- 本机可信配置只允许当前 agent-workflow 项目，使用 `/opt/homebrew/bin/1session`，生产模式保持 **manual**。真实 `execution_project_scan` 返回 `complete`，发现 `ppt-beautifier` 候选；随后 list 返回相同快照，持久状态与响应一致。另一个未就绪声明目录如实标为 missing，不冒充可执行角色。
- 网关、DSH Agent Card/预设及产物服务健康检查通过。部署/扫描前后的 job、attempt、A2A task、target、connection 身份指纹及通知数量一致：51 个任务、63 个执行轮次、55 个 A2A task、64 条通知、8 个目标和 2 个连接，sourceId 保留。本次没有新增业务任务或通知。
- Codex 用户级 `acp-service` 技能的主文件与接口引用已同步，摘要与项目源码一致；DSH 随完整包取得同一版技能。
- 实机回执位于 `.1agents/state/project-discovery-evidence/`（忽略提交）：`live-smoke.json`、`state-before.json`、`state-after.json`、`skill-sync.json`。生产定频未启用；后台频次、重启恢复及关闭行为由隔离 scanner/gateway 测试验证。此次不制作 PPT，也不调用模型。
