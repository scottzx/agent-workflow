<!-- AUTO-GENERATED FROM .1agents/roles/pr-delivery — DO NOT EDIT -->

# Worktree 本地规则（投影）

本文件从 `.1agents/roles/pr-delivery/AGENTS.local.template.md` 单向投影而来。要改规则，改角色包真源后重新投影。不要手改本文件，也不要把同样的内容抄进 `AGENTS.md`。

- 当前目录是隔离 git worktree。只修改这一轮授权的文件。
- 不提交、不推送：禁止运行 `git add`、`git commit`、`git push`、`gh pr`，也不申请 `danger-full-access` 提权。`.git` 指向主仓 `.git/worktrees/<name>`，提交必然提权；由总管核验 `git diff`、L1 `--allowed-paths` 与测试后代为 commit/push 并开 Draft PR。
- `.agents/`、`.claude/`、`AGENTS.local.md` 是投影，不得纳入提交。
- 不创建 `.agents/hooks/`，不依赖 `~/.dsh/.agent-presets/`。
- 不读取、不打印、不写入凭据、token 或指纹。
- DSH `standard` 以本目录的 `.git` 为项目根，每个 step 热加载这里的指令和 `.agents/skills`。投影过期时，重新投影真源，不要在投影副本上改流程。
