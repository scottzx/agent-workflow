# Syncing upstream

`packages/runtime` is the agent-workflow runtime, derived from [openclaw/acpx](https://github.com/openclaw/acpx). Upstream history is already in this repository. Attribution and the MIT text stay in [NOTICE](../NOTICE) and [packages/runtime/LICENSE](../packages/runtime/LICENSE).

Last synced upstream release: **acpx v0.20.0**. The imported release commit is `afc076b501774c6139c9732f5487dc721d5bd757` (`afc076b`, `chore: release acpx 0.20.0`). The 2026-10-21 import recorded that commit as the merge parent. Upstream has since tagged **v0.21.0** (`c0b9dfdfad12ed4fc000b8ef2efc4b5644f1c3dc`) and **v0.21.1** (`e6c782459a18a5b22d06210fde61d75003883ab0`). Those tags are not merged here.

## Add the upstream remote

```sh
git remote add upstream https://github.com/openclaw/acpx.git
git fetch upstream
```

If `upstream` already exists, `git fetch upstream` is enough. Do not replace `origin`. `origin` is `https://github.com/scottzx/agent-workflow.git`.

## Merge into a branch

Upstream keeps its sources at the repository root (`src/`, `docs/`, and the upstream `README.md`). In this repository that tree lives under `packages/runtime/`. A default merge treats those paths as unrelated and will not line them up.

Use rename detection, or an explicit subtree / path mapping:

```sh
git checkout -b sync/acpx-v0.21.1
git merge -X find-renames upstream/v0.21.1
```

`-X find-renames` asks the recursive merge strategy to follow the `src/` → `packages/runtime/src/` move (and the same move for the other relocated files). If rename detection misses files, merge with a path mapping instead of resolving the two trees as unrelated roots. The 2026-10-21 sync used:

```sh
git merge-tree --write-tree --merge-base=969972c -X subtree=packages/runtime HEAD upstream/main
```

That command writes a tree; it does not update the worktree by itself. Details of that import are in [upstream-sync-2026-10-21.md](upstream-sync-2026-10-21.md). The earlier 228-commit import is in [upstream-sync-2026-09-30.md](upstream-sync-2026-09-30.md).

Keep these identities while merging:

- npm package name `@scottzx/1acp`
- binaries `1acp` and `acpx`
- `packages/runtime/LICENSE` (MIT, Copyright (c) 2025 OpenClaw Team)

Verify with `pnpm --filter @scottzx/1acp` typecheck, lint, and test before opening a pull request.
