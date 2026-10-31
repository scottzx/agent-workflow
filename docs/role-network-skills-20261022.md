# 常驻角色的网络技能与版本缓存

日期：2026-10-22。用户授权角色/技能分离、统一更新，并在 agent-workflow 根目录缓存角色；本轮不制作、不修改或重验业务 PPT。

## 实现

- `roles/ppt-beautifier` 保存薄角色说明与技能引用，角色 bundle 为 0.4.0。具体方法、脚本和素材统一维护在 `~/.local/share/1agents/skill-library/ppt`，不再从旧角色私有 skills 目录加载。
- `scripts/update-role-skills.mjs` 为统一发布入口：轻量技能投影 → Skill Manager 注册/刷新 → 新版本缓存预热 → 成功回执/current。独占事务覆盖整个更新；失败回滚发布树和已切指针，保留失败回执。只写独立技能源、缓存与授权素材目录，不调用模型。
- 发布源 `skills-1acp-ppt` 提供四个技能：ppt-report-design、artifact-template-ai-value-report、Presentations、pptx。100 项 PPTX/PNG 资源作为按 SHA256 定位的独立资产，避开 Manager 的单文件 8 MiB/包 32 MiB 上限；宿主按原相对路径恢复完整可用树。
- `packages/service/src/roles` 实现技能目录解析、逐资源下载、提供方整包 revision 与资产 hash 校验、角色快照及任务锁，缓存位于项目 `.cache/roles`。新任务取当前版本，已有锁完全离线复用。缓存包含原 profile 与角色说明，来源指令、脚本和素材保留对应字节与清单。
- 通用 A2A 宿主配置可信 role→profile 映射；metadata 只接受角色选择和受限父锁。首次受理先返回 Task，冷下载在后台执行；普通无角色任务保留原有首回执 sessionId 时序。DSH 与 Codex 都由宿主注入同一锁定入口，不依赖主会话 MCP 工具是否传入子会话。
- 固定 PPT preset 可按宿主 presetRoles 选择角色；通用 Codex/standard 不隐式绑定。旧有无角色上下文不自动补角色。PPT 新父任务的技能锁在受理后的后台准备，制作、复核和同任务恢复共享该锁；系统结果及交付回执保留角色和版本关联。

主会话提交后结束、真实通知后处理的纪律保持不变。运行依赖由宿主管理；技能热更不安装二进制或更改模型。更新目录存在短暂不可读窗口，不承诺全局无停顿交换；新加载遇冲突时停止，不启动模型。升级前未记录技能版本的历史数据不补造版本证明。

## 实际能力网络验证

真实 Node/Skill Manager 已成功发布并读回全部四技能、完整资源和 100 项资产。首次发现 `.xsd` 的 UTF-8 BOM 被 Manager TextDecoder 去掉；解析器依据清单字节数恢复 BOM，并仍通过提供方整包 revision，相关行为有单测。

修改独立设计技能源的版本/资源指引后执行统一更新：

- 旧设计 revision：`607b3376c94caeeeea7ce10b75648685b62c86bcdfedd358ef7337f2c7841cc6`。
- 新设计 revision：`c19faaceb8699e677db77b244b4466d8dac905d209853e5ad00ec664b7978fe8`。
- 旧任务锁逐字节未变，旧/新完整快照均可在禁用全部 fetch 的情况下校验使用。
- MCP 按来源精确检索返回同一新 revision。目录仍报告其他来源的 partial；本次所需四技能已完整读取并校验，不以全局 partial 冒称全目录健康。

证据：项目 `.cache/roles/live-update-verification.json`、`updates/` 和 `current/`。这些为本机缓存，不提交 Git；发布时另复制到私有 release evidence，完整独立技能源另归档。

## 验证与部署

基于主线隔离后的服务全量测试 244/244；DSH 158 通过、10 跳过；发布、更新事务和部署辅助测试 27/27；模型路由 4/4。另有 PPT 锁定集成测试，覆盖受理不联网、后台加载、制作/复核同父锁、旧父离线/新父新版、缓存坏停止派单及只验收恢复。独立审查发现并修复了更新失败未回滚及普通任务首回执兼容问题。实现独立整理在主线基础上，不包含工作台检查点 `bdb7ae4`。

本轮不派真实模型任务，不重跑 PPT。DSH/Codex 共用宿主加载路径的行为由真实 HTTP A2A 配合无模型测试后端验证；不冒称执行过新版本模型制作。

已部署到当前 A2A 网关与 DSH，共用从干净源码 `6c41c1e` 构建的完整本地包（服务包仍为 0.8.3，角色 bundle 为 0.4.0）。部署前真实 RPC 确认宿主无运行中会话，保留既有任务存储、通知、模型与历史产物；已同步薄 persona、角色当前绑定、运行时及调用技能。网关 health 为 ok，DSH PPT preset 未 broken，A2A agent-card 正常。

三个固定目标 ppt-beautifier / ppt-independent-review / ppt-codex-backup 已通过管理 API 更新为 network_pinned，分别对应宿主 ppt-maker / ppt-reviewer / ppt-backup；三个逻辑角色共用一个 profile，通用 preset 不新增隐式绑定。当前已部署 CLI 成功校验四技能和现有锁，未调用模型。完整证据放在 `/Users/scott/.local/share/1agents/a2a-gateway/releases/20261022-network-skills-01/evidence`，包括完整独立技能源清单与归档哈希、热更回执、旧锁离线证据、构建/测试日志及目标绑定；私密备份保留在 role state 和 release private。
