# 把一次 AI 研发成功变成持续复利：5 层概念模型、统一资产 `trial/formal` 生命周期与四路调研综合研判

> 调研日期：2026-11-27  
> 关联工作台事情：`case-compound-agent-research-20261127`  
> 关联文档：[业务全景与缺口地图](./compound-agent-business-flow-and-gap-map-20261127.md) · [分阶段 PR 拆分与现有场景演练](./compound-agent-staged-pr-plan-20261127.md)

本综合文档汇总四份独立一手调研报告（共 2,286 行，均已完成 GitHub 源码 / arXiv 原文 / 本仓代码只读核实；原始报告与原型脚本保留在本机未入库的 `.1agents/jobs/` 工作目录，其中 Rubric 原型脚本将在 `PR-R1` / `PR-R2` 正式入库），沉淀为本仓后续迭代的统一设计基准：

1. **调研 1（一线社区与开源复利实践，705 行）**：核实 `EveryInc/compound-engineering-plugin`、`obra/superpowers`、`Fission-AI/OpenSpec`、`microsoft/SkillOpt` 及 Claude Code / OpenAI Codex / Cursor / GitHub Copilot 一手文档。
2. **调研 2（自进化技能与记忆协同架构，503 行）**：核实 ACE（arXiv:2510.04618，ICLR 2026）、SkillClaw（arXiv:2604.08377 / `AMAP-ML/SkillClaw` 源码）、WikiSkill（arXiv:2608.27454）及 Trace2Skill / EvoSkill / GEPA / Reflexion / Mem0。
3. **调研 3（评测驱动迭代、总管治理与本仓诊断，424 行）**：核实 OpenAI / Anthropic Eval 与 Auto Mode 实践、SWE-bench Verified、MAST 归因体系，并逐行只读核查 `.1agents/roles/pr-delivery/` 与 `packages/service/src/rsi/`。
4. **调研 4（Rubric 评分 Eval 与 PPT 多维质量评测，654 行 + 7 个本机可运行原型）**：核实 HealthBench、Rubrics as Rewards、AutoRubric、PPTEval / PPTAgent、VLM-SlideEval、PPTBench、MT-Bench 换位双跑，并完成本机原型验证（`rubric.schema.json`、`check_pptx.py`、`calibrate_rubric.py` 计划随 `PR-R1` / `PR-R2` 正式入库）。

> **编号约定**：本文档用 **`A1–A5`** 表示 5 层系统架构层，保留 **`L1 / L2 / L3`** 专指本仓既有的三层质检对校体系（`L1` 自检↔机检、`L2` 自检↔质检、`L3` 规则↔历史样本回放），避免两套编号冲突（个别既有角色清单条目 id 如 `product-intro-outline/checklist.json` 中的 `A1`/`A2` 仅作条目编号，与架构层 `A1–A5` 无关）。

---

## 一、核心概念架构：5 层模型（`A1–A5`）

单纯按“Preset + Mini 质检 + DAG 工作流”三层思考时，运行时骨架虽已成形，但会缺失粘合三层的**产物契约接口**以及管跨轮次迭代的**横切演化元层**。将职责边界彻底拆清后，体系收敛为互不重叠的 **5 层架构模型（`A1–A5`）**：

| 架构层 | 名称 | 核心职责（只管一件事） | 关键构成（含现有与目标演进） | 明确边界 |
| --- | --- | --- | --- | --- |
| **A1** | **执行能力层（Preset）** | 单个 Agent 怎么干活 | 薄 Preset（模型路由 + DSH 工具/MCP 权限）+ Role Prompt（`ROLE.md`）+ 按需加载 Skills + 沙箱边界 | 只写“怎么做（How）”，不把确定性验收或长期考卷塞进 Prompt |
| **A2** | **质量裁决层（两级质检）** | 产出对不对、好不好 | **A2a 节点内 Mini 质检（Micro）**：自检打卡 + 本地确定性程序检查（现有 `l1-gate.mjs`、`check_outline.py`；目标新增 `check_pptx.py`、`rubric_lint.py`）；**A2b 独立 QA 节点（Macro）**：异模型 / VLM 校准 Rubric + 换位 Pairwise | A2a 零 token / 低成本就地打回，不惊动下游；A2b 强隔离、剥离执行者自辩话术，走 DAG 正式回边 |
| **A3** | **编排与契约层（Artifact Contract + DAG）** | 多节点怎么串、交付什么不可变快照 | **统一 Artifact Contract**（输入/输出 Schema + 不可变 `digest` 快照，解耦代码 PR / 大纲 / PPT / 调研）+ **DAG 拓扑**（并行扇出、条件分支、有限回边、人工关口） | 凡可固定成图的确定性流转全下沉到 DAG，不再依赖模型临时临场编排 |
| **A4** | **调度与人机层（总管 Coach + 人）** | 选 DAG、处异常、把最终关 | **总管薄 Preset**：拆单开 Case、选 DAG 模板、处理 DAG 外异常（quota/429 切 `routing v2` fallback、多 PR 文件冲突协调、卡死介入）、把 CR/翻车记录送入演化层；**人（Owner）**：业务最终验收 + `formal` 发布拍板 + 考卷唯一钥匙 | 总管管节奏与例外，但绝不可越权修改 `formal` 加锁资产或篡改考卷 |
| **A5** | **演化与治理层（横切 RSI 元层）** | 让 A1–A4 越跑越强且永不退化 | Raw 指标账本（含 usage/cost/duration/route）→ **Knowledge 知识层（正文永不回滚）** → 最便宜耐久阶梯 → `trial` 自主演化 / `formal` 晋升 `proposal` → 双边 L3 棘轮 + **不对称回滚** | 横切 A1–A4，独立版本化；退化时回滚坏技能/坏检查，但保留知识层失败教训 |

---

## 二、统一资产生命周期：`trial` 充分放权 vs `formal` 不可变加锁

为了同时解决 **“开发期审批太重导致演进慢”** 与 **“生产期放权太松导致线上漂移”** 的根本矛盾，将 A1–A3 中所有可演进的配置与代码全部抽象为**统一的一等资产**，并统一套用 **`trial`（试跑/开发开放区）** 与 **`formal`（正式上线加锁区）** 双态生命周期（与 A2A 工作台现有“开发中 / 已上线”、`workflow.json` 的 `trial/formal` 策略及 `checklist.json` 的 `locked: true` 语义完全一以贯之）。

### 2.1 五类资产与双态权限矩阵

| 资产类型 | 包含内容 | `trial` 态（总管权限） | `formal` 态（正式加锁后） | 晋升 `formal` 硬门禁 |
| --- | --- | --- | --- | --- |
| **1. Preset 能力资产** | `ROLE.md`、`skills/*/SKILL.md`、DSH 工具白名单、`routing.json` | **总管充分自主修改**（自动记录 `skillDigest` 与变更依据） | **不可变锁定，总管只读**（只能 fork 新 `trial` 草稿迭代） | 具备 `NOT for:` 负向触发边界；路由变更须过 canary 黄金回放 |
| **2. Micro 质检资产（A2a）** | 节点内自检项、`checks/` 本地程序检查 | **总管自主增改**（新检查默认以 `observe` 试跑） | **不可变锁定，总管只读** | 必填 `source` provenance；当前树 pass + 缺陷副本 fail；负样本零覆盖禁升 `block` |
| **3. Macro 质检资产（A2b）** | `QA.md`、`rubric.json`、Pairwise 配置 | **总管自主调优**（拆模糊条目、补锚点与反例） | **不可变锁定，总管只读** | 双上限校准 `min(人-人 α, 评委-金标 α)` 分三档：`α ≥ 0.8` 且 `n ≥ 40` 进 `auto` 阻断；`0.67 ≤ α < 0.8`（或 `α ≥ 0.8` 但 `n < 40`）一律落 `advise` 仅建议；`α < 0.67` 归 `split` 必须拆改模糊条目 |
| **4. DAG 工作流资产（A3）** | `workflow.json`、Artifact Contract、回边与人工关口 | **总管自主编排实验**（试新节点/并行/分支） | **不可变锁定，总管只读** | 原题 + 变体题跑通、质检 L1 `self_vs_program = 0`、闭环满足单向依赖 |
| **5. 考卷资产（独立）** | `evals/manifest.json`、冻结 `holdout`、人工金标 `gold.jsonl` | **总管只读**（仅可提议新增样本，严禁改删旧考卷） | **永久只读（仅人可改）** | **独立防线**：确保总管在 `trial` 充分放权时不等于能篡改考题 |

### 2.2 四条防穿透硬规则（写进程序门禁，而非提示词约定）

1. **单向依赖闭包（禁“正式套试跑”）**：`formal` 资产**只能引用 `formal` 资产**；若一个申请上线的 `formal` DAG 或 `formal` Preset 偷偷引用了某个 `trial` Skill / `trial` Rubric，发布校验直接失败。反过来，`trial` 资产允许混用已上线的 `formal` 资产 + 正在改造的 `trial` 资产，实现**单资产灰度试跑与单资产回滚**。
2. **物理路径与沙箱硬隔离**：在磁盘和沙箱写域层面区分 `trial` 与 `formal`（采取资产清单 `lifecycle: "trial" | "formal"` + 不可变 `formal/` 快照目录）；总管在 `trial/` 目录内拥有完整写权限，对 `formal/` 与 `evals/` 物理只读。
3. **`proposal` 语义彻底收口（零审批疲劳）**：
   - **`trial` 阶段**：任务跑完后，CR 意见、Rubric 失分与翻车轨迹回流到演化层，总管**直接自主修改 `trial` 资产**并自动记录进 `knowledge/` 与 `skill-impact.jsonl`，不打扰人。
   - **仅 3 类高杠杆事件向人发起工作台 `proposal`**：① 修改/新增**考卷（`evals/`）或越权工具权限**；② `trial` 资产经多轮打磨并全过门禁，申请**晋升上线为 `formal`（加锁发布）**；③ 线上 `formal` 资产出现严重退化需**人工确认紧急回滚或修改 `locked` 项**。
4. **线上发现缺陷的标准回流路径（Fork → Trial 自主修 → 过门禁 → 升级替换）**：当 `formal` 资产在线上命中新缺陷或用户打回时，总管不直接改 `formal`，而是自动从该 `formal` 版本 **fork 出新的 `trial` 候选版本**自主演进验证，全部达标后向人递交一张带对比 Scorecard 与 Pairwise 胜率的升级 `proposal`，人点一次“上线替换 `formal`”，旧版快照保留以便秒级回滚。

---

## 三、四路调研交叉印证的 6 条工程共识

1. **防膨胀靠“最便宜耐久形式阶梯”与“减法触发器”**：按 `Owner → 确定性 Check → Standard/Skill → Learning` 严格排序；Claude Code（`<200` 行）、Codex（`32 KiB`）、Cursor（`.mdc`）均要求薄常驻指令 + 按需 Skill + 减法审计（`refresh` / `stale` 元数据归档）。
2. **知识层与技能层必须不对称回滚**：ACE / WikiSkill / SkillClaw 均证实小粒度增量写入 + 确定性合并 + 单调验收的重要性；退化时回滚坏技能/坏检查，但**知识层正文永不回滚**（过期降级只改索引状态元数据），并将失败 diff 记入 `rejected-edits.jsonl` 防止反复提同一错方案。
3. **“更具体 ≠ 更好”，防范跨模型负迁移**：Qwen-3.5-4B 演化的技能曾把 Gemini-3.5-Flash 在 SpreadSheet 上从 `50.5` 打到 `18.1`；`SkillClaw` 直接拒收“只有通用最佳实践、无反例证据”的技能，每个 Skill 必须标注 `NOT for:` 边界。
4. **Checklist 守底线、Rubric 评好坏、Pairwise 判进步**：HealthBench 式原子正负加权 + 0–3 行为锚定 + Evidence-First 把编造/堆砌显式变成负分扣穿；PPT 等多模态必须拆分 **XML 程序几何层 + VLM 单页视觉层 + 文本骨架叙事层**；校准必须用双上限 `min(人-人 α, 评委-金标 α)` 并严格分 `auto / advise / split` 三档。
5. **质检 L3 评测必须双边**：只要求“正样本 0 误报”会让放宽检查变成免费通行证，必须同时要求正样本 `FP = 0` + 负样本 `negativeRecall` + 冻结 `holdout` + 版本级 `usage/cost/pass^k` 度量。
6. **审计者要盲、审批不批量**：Anthropic auto mode 实践表明，审计/独立 CR 必须剥离执行者自辩话术；一次人工采纳只覆盖该条提议对应的爆炸半径，禁止批量放行。

---

## 四、对照 `agent-workflow` 现状的 8 处缺口（`G1–G8`）

> 我们在“质检 L1 自检说谎拦截（`self_vs_program`）”、“可机审 CR 契约（`QA.md`）”、“`evalDigest` 判据绑定”和“反作弊字面量打分器”上已领先社区常见做法；真正卡住持续复利的是以下 8 处缺口：

| 编号 | 缺口 | 现状证据 |
| --- | --- | --- |
| **G1** | 开工前无历史检索节点与工具 | `.1agents/roles/pr-delivery/workflow.json` 直接 `"entry": "implement"` 起步，无 `learnings_lookup` 节点 |
| **G2** | 单模型硬编码路由 | `.1agents/roles/pr-delivery/routing.json` 写死单模型，无 fallback 与 canary |
| **G3** | 本机发版 DSH 插件断层 | `scripts/local-deployment.mjs` 只覆盖 `a2a-gateway`，未原子同步 DSH Desktop |
| **G4** | 账本无成本与稳定性度量 | `packages/service/src/rsi/outline-run.ts` 缺 `usage/cost/duration/route/env` |
| **G5** | 缺中间知识层与被拒缓冲 | 只有原始 `ledger.jsonl` 与无 frontmatter 的 `docs/bugs/` |
| **G6** | 质检 L3 单边 & 黄金回放未接门禁 | `calibrate.ts` 只看 `FP=0`；`rsi gate --role pr-delivery` 报 `ENOENT /cases` |
| **G7** | 资产无 `trial/formal` 硬隔离与双钥匙 | 规则、`checks/` 与考卷 `evals/` 同目录同写权限，缺 `formal` 加锁与闭包校验 |
| **G8** | QA 1–5 分制未校准 & PPT 缺多维评测 | `product-intro-outline/QA.md` 未校准、仅“吸引力”有端点示例、仅要求 `where` 位置未绑定原文证据；`ppt-beautifier` 缺几何检查与多模态 Rubric |

---

## 五、经验落位决策树与明确不做

### 经验落位决策树（按优先级从上到下，能落上层就不落散文）

| 经验 / 缺陷类型 | 落位资产 | 强制准入条件 |
| --- | --- | --- |
| 可机械判定的边界/契约（投影、AOCI 块、PPT 溢出/重叠、CSS media 作用域） | **Micro 质检（A2a）**：`checks/` + `checklist.json` | 必填 `source`；当前树 pass + 缺陷副本 fail；负样本零覆盖先 `observe` |
| 跨会话复用、按需触发的领域 SOP（派单编排、发版核验、蒸馏） | **Preset 能力（A1）**：独立 `SKILL.md` | 带 `NOT for:` 边界与无技能基线；独立 `skillDigest` 可单技能回滚 |
| 无法代码化的多维质量梯度（说服力、视觉层级、叙事连贯） | **Macro 质检（A2b）**：`rubric.json` | 原子正负权重 + 行为锚点 + 证据必填；双上限达 `auto` 才阻断，`split` 须拆改 |
| 跨模块高熵评判原则 | `QA.md` / `ROLE.md`（严控总条数） | 须举证为何写不成 Check；改动须过黄金回放对照 |
| 模块排错记录、架构上下文、被拒方案 | **Knowledge 层（A5）**：`docs/solutions/` + `rejected-edits.jsonl` | YAML frontmatter；正文只追加不回滚，超 90 天低频仅在索引元数据标 `stale` |
| 一次性偶发事故或已根治的问题 | `changelog/YYYY-MM-DD.md` | 不进入常驻规则与技能 |

### 明确不做（四路调研一致否决的反模式）

- 不允许总管绕过人工直接修改 `formal` 加锁资产或篡改 `evals/` 考卷；
- 不引入向量数据库充当规则记忆（坚持可追溯的判定血缘 `ledger + knowledge + git`）；
- 不做整份 Prompt/Skill 自动重写（坚持小粒度 delta + 不对称回滚）；
- 不在 `AGENTS.md` 或投影副本里维护第二份规则（绝不触碰 `<!-- aoci:begin -->` 至 `<!-- aoci:end -->`）；
- 不在未达双上限校准阈值前直接用未校准 Rubric 分数做自动阻断门禁。
