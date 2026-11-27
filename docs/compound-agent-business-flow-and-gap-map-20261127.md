# 业务逻辑全景与缺口地图：5 层模型 × 统一资产 `trial/formal` 双飞轮

> 日期：2026-11-27  
> 关联文档：[5 层概念模型与四路调研综合研判](./compound-agent-architecture-synthesis-20261127.md) · [分阶段 PR 拆分与现有场景演练](./compound-agent-staged-pr-plan-20261127.md)

本文用 6 张可视化流程图 + 1 张落点对照表，完整展示 **AS-IS 现状与缺口（图 1）**、**5 层概念模型（图 2）**、**统一资产 `trial/formal` 生命周期与总管权限边界（图 3）**、**单次交付 × 持续复利双飞轮（图 4）**、**双钥匙治理时序（图 5）**，以及 **Checklist × Rubric × Pairwise 三层质量漏斗（图 6）**。

---

## 图 1：当前真实业务逻辑（AS-IS）与 `G1–G7` 缺口定位

前半段“单次 PR 交付”已经跑通（蓝色实线）；真正断掉的是后半段“经验如何不靠记忆自动变成下一轮的默认能力”（红色虚线与缺口 `G1–G7`；`G8` 见图 6）。

```mermaid
flowchart TD
    U["人: 提需求 / 验收合并"] --> C["总管 Coach: 拆单 + 建 worktree + 投影 pr-delivery"]

    C -. "G1 缺口: 开工前未查历史教训" .-> W
    C -. "G2 缺口: routing.json 单模型硬编码, 无 fallback" .-> W

    subgraph Delivery["内环: 单次 PR 交付流 (当前已基本跑通)"]
        direction TB
        W["Worker: 隔离 worktree 开发 + 单测 + 自检"] --> L1["L1 机检: checks/l1-gate.mjs"]
        L1 -- "失败打回" --> W
        L1 -- "退出码 0" --> PR["建 Draft PR"]
        PR --> CI["GitHub Actions 路径过滤 CI"]
        PR --> CR["异模型只读 CR: deepseek-v4.1"]
        CI -- "红" --> W
        CR -- "MUST 阻塞打回" --> W
        CI -- "100% 绿" --> G0["三绿汇合: L1 + CI + CR PASS"]
        CR -- "PASS" --> G0
    end

    G0 --> M["人/总管: Ready & Merge 到 main"]
    M --> D["本机发布: a2a-gateway 自动 + DSH Desktop 手工"]
    D -. "G3 缺口: DSH 插件同步未进发布脚本" .-> END1["本次交付结束"]

    subgraph Broken["外环: 经验沉淀与评测回流 (当前断裂点)"]
        direction TB
        T["产出数据: ledger.jsonl + CR 报告 + git diff"]
        T -. "G4 缺口: 缺 token / 成本 / 时长 / 路由指纹" .-> K["G5 缺口: 缺中间知识层 knowledge 与被拒缓冲"]
        K -. "手工零散改文档, 无阶梯约束" .-> R["改 ROLE.md / QA.md / checks"]
        R -. "G6 缺口: L3 只拦误报不查召回; pr-delivery 黄金回放未接进 gate" .-> E["evals/manifest.json (仅 9 样本)"]
        R -. "G7 缺口: 无 trial/formal 资产加锁与考卷双钥匙隔离" .-> E
    end

    M -. "断裂: 没自动触发沉淀" .-> T

    style Delivery fill:#f0f6ff,stroke:#2563eb
    style Broken fill:#fff5f5,stroke:#dc2626,stroke-dasharray: 5 5
```

---

## 图 2：补齐承重层后的 5 层概念模型

在“Preset + 质检 + DAG”3 层基础上，显式补出 **统一 Artifact Contract（横向接口）**、**两级质检拆分（Micro vs Macro）**，以及 **总管调度（L4）与横切 RSI 演化治理（L5）**。

```mermaid
flowchart TB
    L4["L4 调度与人机层: 总管 Coach (薄 Preset) + 人 (最终验收 / formal 发布 / 考卷唯一钥匙)"]
    L3["L3 编排与契约层: DAG 工作流 (节点 / 并行 / 回边 / 人工关口) + 统一 Artifact Contract (Schema + 不可变 Digest)"]

    subgraph Run["单个 DAG 节点的执行与两级质检"]
        direction LR
        L1["L1 执行能力层: Preset (模型路由 + 工具/MCP + Role + 按需 Skills)"]
        L2A["L2a 节点内 Mini 质检 (Micro): 自检 + 程序 Check (0 token 就地打回)"]
        L2B["L2b 独立 QA 节点 (Macro): 异模型 / VLM 校准 Rubric + Pairwise (走 DAG 回边)"]
        L1 --> L2A --> L2B
    end

    L5["L5 横切演化与治理层 (RSI 元层): Raw 指标账本 -> Knowledge 知识层 (永不回滚) -> trial 自主迭代 / formal 晋升审批 -> 双边 Eval 棘轮 -> 不对称回滚"]

    L4 -- "选 DAG / 拆单 / 处异常" --> L3
    L3 -- "按节点绑定 Preset 与输入快照" --> L1
    L2B -- "交付不可变产物快照" --> L3
    L3 -. "每次运行沉淀轨迹与指标" .-> L5
    L5 -. "热更新反哺 trial 资产" .-> L1
    L5 -. "双上限校准与回滚门禁" .-> L2B
```

---

## 图 3：统一资产 `trial / formal` 双态生命周期与权限边界

Preset、Micro 质检、Macro 质检、DAG 工作流全部作为统一资产纳入 `trial / formal` 管理：**`trial` 对总管充分放权高速迭代，`formal` 不可变加锁防线上漂移，考卷 `evals/` 始终独立只读**。

```mermaid
flowchart LR
    subgraph Trial["trial 态 (开发试跑区: 总管充分放权)"]
        direction TB
        T1["4 类可演化资产: Preset / Micro 质检 / Macro Rubric / DAG (允许混用 formal 资产)"]
        T2["任务跑完 -> CR 意见 / Rubric 失分 / 翻车轨迹自动回流"]
        T3["总管直接自主修改 trial 资产, 无需逐条等人批 proposal"]
        T4["两条底线护栏: knowledge 只追加不回滚 + evals 考卷只读不可改"]
        T2 --> T3 --> T1
        T1 --> T2
    end

    subgraph Gate["晋升门禁 (trial -> formal)"]
        G1["闭包校验: formal 资产禁止引用任何 trial 资产"]
        G2["三绿 + 双边 L3 黄金回放 + Rubric 双上限 auto + Pairwise 胜率 >= 0.6"]
        G3["向工作台推升级 proposal -> 人 (person) 点一次正式发布"]
        G1 --> G2 --> G3
    end

    subgraph Formal["formal 态 (正式上线区: 不可变加锁)"]
        direction TB
        F1["冻结快照 vX.Y.Z + releaseDigest + locked: true"]
        F2["总管物理只读: 程序层硬拦截任何直接修改"]
        F3["线上翻车 -> 一键秒级回滚上一 formal 快照"]
    end

    T1 -- "打磨达标申请上线" --> G1
    G3 -- "加锁发布" --> F1
    F1 -- "线上发现新缺陷 -> 自动 fork 新 trial 候选版本迭代" --> T1

    style Trial fill:#fffbeb,stroke:#d97706
    style Gate fill:#f0f6ff,stroke:#2563eb
    style Formal fill:#f0fdf4,stroke:#15803d
```

---

## 图 4：目标业务逻辑（TO-BE）—— 单次交付环 × 持续复利飞轮

```mermaid
flowchart LR
    subgraph Inner["内环: 单次交付流 (薄 Preset 总管编排 + DAG 执行)"]
        direction TB
        S0["0. 开工前只读检索 learnings_lookup (docs/solutions + rejected-edits)"] --> S1["1. 派单给 Worker (routing v2 遇 quota/429 自动 fallback)"]
        S1 --> S2["2. 节点内 Micro 质检: 自检 + 程序 Check + Draft PR"]
        S2 --> S3["3. 并行 Macro 验收: 路径过滤 CI + 异模型只读 CR / Rubric"]
        S3 -- "有 MUST / 红灯" --> S1
        S3 -- "三绿通过" --> S4["4. 合并 + 一键发布 a2a-gateway 与 DSH Desktop"]
    end

    subgraph Outer["外环: 持续复利飞轮 (trial 放权演进 -> 门禁加锁晋升 formal)"]
        direction TB
        O1["Raw 证据层: ledger + usage/cost + CR MUST + 翻车记录"] --> O2["Knowledge 知识层 (永不回滚): patterns / docs/solutions / rejected-edits"]
        O2 --> O3{"最便宜耐久阶梯归类"}
        O3 -- "1. 能写程序 (优先)" --> A1["Micro: checks/ + checklist.json (必填 source)"]
        O3 -- "2. 跨任务 SOP" --> A2["Preset: 独立 SKILL.md (带 NOT for 与 skillDigest)"]
        O3 -- "3. 多维好坏 / 高熵原则" --> A3["Macro: rubric.json 或 ROLE/QA.md"]
        O3 -- "4. 偶发/一次性" --> A4["仅记 changelog, 不进常驻资产"]

        A1 --> EV["写回 trial 资产 (总管自主) -> 跑双边 Eval 棘轮"]
        A2 --> EV
        A3 --> EV
        EV -- "通过且达晋升水位" --> P["工作台待审批: 正式发布 proposal (人点一次加锁上线 formal)"]
        EV -- "发生退化" --> RB["不对称回滚: 回退坏技能/坏检查, 保留 Knowledge 教训"]
    end

    S4 -- "每次交付/CR 命中 MUST 自动落账" --> O1
    P -- "formal 新版本热加载反哺下一轮" --> S0
    RB -- "写入 rejected-edits 防重复提议" --> O2

    style Inner fill:#f0f6ff,stroke:#2563eb
    style Outer fill:#f0fdf4,stroke:#15803d
```

---

## 图 5：总管放权与双钥匙治理时序

清晰区分 **`trial` 阶段（总管自主快跑，不烦人）** 与 **`formal` 晋升及考卷变更（人握唯一钥匙，防越权与作弊）**。

```mermaid
sequenceDiagram
    actor Human as 人 (业务验收 / formal 上线 / 考卷唯一钥匙)
    participant Coach as 总管 pr-coach (薄 Preset + 热加载 Skills)
    participant Worker as 执行者 Worker (隔离 worktree)
    participant Gate as 机器门禁 (Micro Check / CI / L3 / Scorecard)
    participant CR as 独立 Macro QA (异模型 CR / Rubric)

    Human->>Coach: 下达需求 (指定跑 formal 稳定线 或 trial 试跑线)
    Coach->>Gate: learnings_lookup 查历史知识层 + 校验 routing v2
    Coach->>Worker: 派单 (按节点绑定 Preset, 物理隔离 QA.md 与 evals)
    Worker->>Gate: 节点内 Micro 质检 (自检 + l1-gate / check_pptx)
    Gate-->>Worker: 未过就地打回 (记录 self_vs_program)
    Worker-->>Coach: Micro 绿, 交付不可变产物快照 (commit SHA / artifact digest)
    Coach->>Gate: 触发 CI 并记录 usage/cost/duration
    Coach->>CR: 派发独立 Macro 验收 (剥离 Worker 自辩话术)
    CR-->>Coach: 返回可机审结果 (VERDICT / MUST / Rubric 证据打分)
    alt 任一门禁未绿
        Coach->>Worker: 按 DAG 回边转派修复
    else 全部通过
        Coach->>Human: 工作台弹出业务验收卡 (附三绿与 scorecard)
        Human->>Coach: 确认合并与一键发布
    end

    Note over Coach,Gate: 演化阶段: trial 自主迭代 vs formal 加锁只读
    alt 当前运行为 trial 资产
        Coach->>Gate: 直接修改 trial 下的 Preset / Check / Rubric / DAG (evals 只读)
        Gate->>Gate: 跑双边 L3 黄金回放 + Rubric 双上限校准
        alt 发生退化
            Gate-->>Coach: 自动回滚坏资产, 保留 Knowledge 与 rejected-edits
        else 全绿且达晋升门槛
            Coach->>Human: 推一张“晋升 formal”proposal (附对比 scorecard 与 Pairwise 胜率)
            Human->>Gate: 点一次“正式发布”-> 校验 formal 依赖闭包 -> 加锁冻结 vX.Y.Z
        end
    else 当前运行为 formal 加锁资产且线上发现新缺陷
        Coach->>Gate: 禁止直改 formal -> 自动 fork 新 trial 候选版本并在 trial 中修复验证
        Coach->>Human: 修复达标后推升级 proposal -> 人确认替换 formal
    end
```

---

## 图 6：补齐 `G8` —— 质量评估三层漏斗（Checklist × Rubric × Pairwise）

```mermaid
flowchart TD
    ART["待评产物快照: 大纲 JSON / PPTX + 逐页渲染 PNG / 代码 Diff"]

    subgraph Layer1["第一层: Program Checklist (Micro 守底线, 0 token 阻断)"]
        direction LR
        C1["结构与事实底线: P1-P15 / l1-gate"]
        C2["PPT 几何底线 check_pptx.py: 出画布 / 溢出 / 字号下限 / 文本块重叠 IoU"]
    end

    subgraph Layer2["第二层: Calibrated Rubric Eval (Macro 评好坏, 原子加权 + 锚定 + Evidence-First)"]
        direction LR
        R1["原子正负加权条目 (HealthBench 式): 满足加分, 编造或堆砌直接负分扣穿"]
        R2["单页视觉锚定 0-3 档 (VLM 看单页 PNG): 视觉层级 / 留白网格 / 风格一致"]
        R3["跨页叙事文本判据 (LLM 看标题骨架): 单页结论 / 跨页连贯 / 行动号召"]
    end

    subgraph Cal["校准门禁 calibrate_rubric.py (双上限: min 人-人 alpha, 评委-金标 alpha)"]
        direction LR
        B1["alpha >= 0.8 且 n >= 40: auto 档 (可自动 block 门禁, 平替 QA)"]
        B2["0.67 <= alpha < 0.8: advise 档 (只做建议, 不阻断)"]
        B3["alpha < 0.67: split 档 (标准含糊, 必须拆改条目)"]
    end

    subgraph Layer3["第三层: Pairwise 换位双跑 (仅在 trial -> formal 晋升回归时触发)"]
        PW["A/B 换位双评 + 双评委 (不一致判平): 校验 winRate >= 0.6, 防 Rubric 分数通胀"]
    end

    ART --> Layer1
    Layer1 -- "底线未过: 就地打回" --> REJ["打回执行者 (不到质检)"]
    Layer1 -- "底线全过" --> Layer2
    Layer2 --> Cal
    B1 --> GATE{"聚合分 >= passScore 且 must 全过?"}
    B2 -. "附建议进入报告" .-> GATE
    B3 -. "trial 中总管直接拆条目; formal 则 fork trial 拆改" .-> PROP["演化层调优 Rubric"]
    GATE -- "否" --> REJ
    GATE -- "是" --> Layer3
    Layer3 -- "真进步" --> PASS["放行交付 / 允许晋升 formal"]
    Layer3 -- "分数涨但胜率跌 (刷分信号)" --> PROP

    style Layer1 fill:#eff6ff,stroke:#2563eb
    style Layer2 fill:#f0fdf4,stroke:#15803d
    style Cal fill:#fefce8,stroke:#ca8a04
    style Layer3 fill:#faf5ff,stroke:#7c3aed
```

---

## 8 处缺口 ↔ 代码真实落点对照表

| 编号 | 缺口现象 | 当前代码真实位置 | 为什么卡住“持续复利” | 对应补齐阶段 |
| --- | --- | --- | --- | --- |
| **G1** | 开工前不查历史踩坑 | `.1agents/roles/pr-delivery/workflow.json` 直接从 `implement` 起步 | 同一模块换会话仍会重复踩坑 | Phase 1（PR-1B） |
| **G2** | 单模型硬编码路由 | `.1agents/roles/pr-delivery/routing.json` 写死单一模型 | 额度耗尽 / 429 时全链路卡死 | Phase 3（PR-3B） |
| **G3** | 本机发版 DSH 插件断层 | `scripts/local-deployment.mjs` 只管 `a2a-gateway` | 合并后手工同步 DSH Desktop 易撞旧包 | Phase 0（PR-0A） |
| **G4** | 账本缺成本与稳定性度量 | `packages/service/src/rsi/outline-run.ts` 无 `usage/cost/duration/route` | 无法量化“是否真的更稳、更省” | Phase 1（PR-1A） |
| **G5** | 缺中间知识层与被拒缓冲 | 仅有原始 `ledger.jsonl` 与无 frontmatter 的 `docs/bugs/` | 教训要么膨胀常驻文档，要么回滚即丢失 | Phase 1（PR-1B） |
| **G6** | L3 单边 + 黄金回放未接门禁 | `packages/service/src/rsi/calibrate.ts` 只看 `FP=0`；`gate.ts` 对 `pr-delivery` 报 `ENOENT /cases` | 放宽检查也能过 L3；改坏 `QA.md`/`ROLE.md` 无人拦截 | Phase 1–2（PR-1C / 2A） |
| **G7** | 缺统一 `trial/formal` 资产加锁与双钥匙 | `.1agents/roles/pr-delivery/` 下规则、`checks/` 与 `evals/` 同权同态 | 开发期批不完，生产期锁不住，缺 `formal` 依赖闭包保护 | Phase 3（PR-3A） |
| **G8** | QA 裸 1–5 分制无校准 & PPT 缺多维评测 | `.1agents/roles/product-intro-outline/QA.md`、`.1agents/roles/ppt-beautifier/ROLE.md` | 主观质量抖动、刷分编造可过审、PPT 缺几何与视觉分层评测 | 并行 Rubric 线（PR-R1 / R2 / R3） |
