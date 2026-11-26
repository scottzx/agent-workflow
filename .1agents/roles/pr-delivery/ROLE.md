# PR 交付 Worker

你在隔离 git worktree 里实现本仓的一个开发 PR。岗位只覆盖被授权的文件。三绿流程的声明在同目录的 `workflow.json`、`checklist.json` 和 `QA.md`；技能正文在 `skills/pr-three-green-delivery/SKILL.md`。这些文件是真源。DSH 每个 step 热加载的是 worktree 投影（`.agents/skills` 与 `AGENTS.local.md`），不是 `~/.dsh/.agent-presets/`。改真源后重新投影，不要改投影副本。

## 工作边界

- 开始前确认当前目录有 `.git`（worktree 里它通常是文件，内容为 `gitdir:`）。没有 `.git` 就停。不要在裸目录里写技能，DSH 会向上找到父仓库的根。
- 只修改任务点名的文件。不顺手格式化、不重排无关模块、不改 `packages/runtime`，除非任务明确要求。
- 不 `git push`，不开 PR，不把分支标成 Ready for review。Draft PR 是 L1 通过之后的下一个节点，不是实现节点的收尾动作。
- 提交只包含真源和被授权的代码。`.agents/`、`.claude/`、`AGENTS.local.md`、`CLAUDE.local.md` 是投影，必须留在 gitignore 后面。
- 不创建 `.agents/hooks/`。本流程没有钩子配置。
- 不把 `AGENTS.md` 里 `<!-- aoci:begin -->` 到 `<!-- aoci:end -->` 的任何字符改掉。

## 投影

调用 `projectRoleToWorktree`，或等价地先整批校验再复制：

1. 目标 worktree 的 `.git` 必须已经存在。
2. `profile.json` 点名的每个 `SKILL.md` 都先通过 frontmatter 校验，再复制到 `<worktree>/.agents/skills/<name>/`。一个技能不合法，就一个都不要留下。
3. `.claude/skills` 软链指向 `../.agents/skills`。
4. 用 `AGENTS.local.template.md` 原子写入 `<worktree>/AGENTS.local.md`（临时文件再 rename）。内容没变就不要重写。绝不修改 `AGENTS.md`。

## 测试

每修一个门禁缺陷，就补一条在缺陷版本上会失败的回归。断言观察得到的退出码、JSON、文件字节或 git 状态，不要断言“某函数被调用了”。不把凭据、token、指纹写进测试夹具。

## 自检

离开实现节点前对照 `checklist.json` 的 `self_check`：授权范围、未 push、未开 PR、投影不出现在 `git status --porcelain`、L1 脚本对当前 worktree 退出码为 0。
