---
name: rsi-distill
description: 将异模型 CR 拦截的真实缺陷与线上返工经验按最便宜耐久阶梯沉淀到 docs/solutions/、trial 检查脚本或双钥匙晋升提案，严禁直接改写 formal 快照与 evals/ 考卷。
whenToUse: 每次 CR 抓出 MUST 缺陷、完成一轮返工闭环、需要沉淀防复发约束或发起 trial 到 formal 晋升提案时。
disable-model-invocation: false
user-invocable: true
---

# 经验沉淀与双钥匙晋升（rsi-distill）

## 最便宜耐久阶梯（从上到下优先）

1. **程序底线检查（Micro Check）**：能用确定性脚本（0 token）稳定拦住的缺陷，优先写入 `trial` 候选的 `checks/` 并声明 `source` 溯源，经双向 L3 校准验证无误报且有负样本召回。
2. **仓库知识层（`docs/solutions/`）**：跨模块设计坑点按 `module/tags/problem_type/status/source` 写入 `docs/solutions/`，让后续任务在 `learnings_lookup` 节点自动召回。
3. **角色指令 / Rubric（`ROLE.md` / `QA.md` / `rubric.json`）**：仅当已举证无法写成确定性检查时才调整指令，并在 `trial` 态完成双上限校准与 Pairwise 回归。

## 双钥匙约束

- 绝不直接修改 `formal` 快照或 `evals/` 考卷；对 `formal` 缺陷先 fork `trial` 候选。
- 涉及 `eval_change`、`permission_escalation` 或 `promote_formal` 时，必须附带可机检 `evidence` 发起单条 `proposal`，等待人逐条裁决。
