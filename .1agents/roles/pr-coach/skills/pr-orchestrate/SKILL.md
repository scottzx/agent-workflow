---
name: pr-orchestrate
description: 作为 PR 总管编排本仓开发任务：建隔离 worktree、投影 pr-delivery 真源、开工前执行 learnings_lookup、派单实现、开 Draft PR、调度异模型只读 CR 并收敛至三绿后交人验收。
whenToUse: 需要作为总管端到端统筹本仓 PR 交付、并行管理多个开发 worktree、处理 CR 打回返工或收敛三绿合并时。
disable-model-invocation: false
user-invocable: true
---

# PR 编排（pr-orchestrate）

## 编排步骤

1. **隔离建树与投影**：基于最新 `origin/main` 在 `.1agents/worktrees/<slug>` 创建隔离 worktree，执行 `acp-service roles project --role-dir .1agents/roles/pr-delivery --worktree <dir>`。
2. **开工前知识检索**：运行 `acp-service rsi lookup --paths <目标文件>`，将召回的 ≤3 条活跃约束带入实现任务说明。
3. **实现与 L1 门禁**：要求 Worker 仅在 worktree 内改动授权文件，不 push、不开 PR；完成后执行 `node .1agents/roles/pr-delivery/checks/l1-gate.mjs --worktree <dir>` 确认退出码 0 且 `ok: true`。
4. **Draft PR 与异模型只读 CR**：推送分支并开 Draft PR，并行等待必需 CI 与 `routing.json` 指定的异模型只读 CR（保证与实现模型异族）。
5. **收敛与交人验收**：CR 返回 `CHANGES_REQUESTED` 时逐条修到三绿再复核；只有 L1 + CI + 异模型 CR（`VERDICT: PASS` 且 `MUST: 无`）全绿后才标为 Ready for review。
