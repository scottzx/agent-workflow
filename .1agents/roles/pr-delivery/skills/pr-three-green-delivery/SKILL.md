---
name: pr-three-green-delivery
description: 承接本仓库开发 PR 时使用。在隔离 worktree 里改代码，跑 L1 机检，开 Draft PR，再由 magpie 上的 group/deepseek-v4.1 做只读异模型 CR，自动修到三绿后才 Ready for review。即使用户只说开 PR、三绿、交付分支或异模型审查，也先读本技能，不要跳过机检，也不要让实现模型自评。
whenToUse: 本仓功能、缺陷或角色技能需要走 PR 时；用户提到三绿、Draft PR、异模型 CR、worktree 投影或 Ready for review 时。
disable-model-invocation: false
user-invocable: true
---

# 三绿 PR 交付

真源是 Git 跟踪的 `.1agents/roles/pr-delivery/`。DSH 0.2.2-rc.5 不会扫描这个目录：它把最近的 `.git` 当作项目根，每个 step 热加载该根的 `AGENTS.md`、`AGENTS.local.md` 和 `.agents/skills`。因此 worktree 里看到的技能是投影，不是第二份真源。

DSH 目录只展示 `name` 和 `description`。可选路由字段的源码键是 `whenToUse`；写成 `when-to-use` 会被忽略。`disable-model-invocation` 和 `user-invocable` 必须是这两个 kebab-case 键。`disableModelInvocation`、`modelInvocable`、`userInvocable` 会让整份技能被静默丢弃。首行若带 UTF-8 BOM，或 `description` 不是字符串，DSH 同样会丢掉这份技能。

## 流程

严格按 `workflow.json`：

1. `implement`：在隔离 worktree 里开发。先确认 `<worktree>/.git` 存在。只改授权文件。不 push，不开 PR。
2. 把真源投影到该 worktree（`.agents/skills/`、`.claude/skills` 软链、`AGENTS.local.md`）。投影已被 `.gitignore` 挡住。没有 `.git` 的目录不要投影。
3. `l1_gate`：`node .1agents/roles/pr-delivery/checks/l1-gate.mjs --worktree <worktree>`。退出码不是 0 就停，不要用口头说明代替 JSON 摘要。
4. `draft_pr`：L1 通过之后才开 Draft PR。不要把投影文件、任务目录或凭据放进提交。
5. `cross_model_cr`：审查模型按 `routing.json`（v2：`primary + fallbacks[]`，向后兼容 v1）选路，默认 `magpie` / `group/deepseek-v4.1`，只读。通过 `execution_submit` 传入 `input.routingRoleId: "pr-delivery"` 与 `input.routingSlot: "worker" | "reviewer"`（审查节点同时传 `input.peerJobId: <workerJobId>`），网关会自动加载 `routing.json`、注入对应 `deliveryMode`（worker=`workspace_git`，reviewer=`none` + `readOnly: true`）、在派单边界遇 `quota/rate_limit/429/5xx/timeout` 60 秒内自动切换备用模型并落账实际执行路由，同时硬校验 `family(reviewer) !== family(actualWorker)`。实现模型不得自评通过。
6. 返工走 `workflow.json` 的 `qaRevise` / `programBounce`，回到 `implement` 后重新跑 L1。不要为了变绿删测试或放宽断言。
7. `ready_for_human`：自检、L1、异模型 CR、CI 都绿之后，才请人做一次验收。

`policies.trial` 可以缺 CI。`policies.formal` 要求 L1、异模型 CR、CI 都绿，人只验收一次。

## 不要做的事

- 不要把技能抄进 `~/.dsh/.agent-presets/`，也不要建 `.agents/hooks/`。
- 不要改 `AGENTS.md` 的 `<!-- aoci:begin -->` 到 `<!-- aoci:end -->`。
- 不要在提示、测试、日志或提交说明里写入 token、cookie、指纹或真实 `.env`。
- 测试要能在退回有缺陷的实现时失败。只断言“函数被调用过”不算数。
