# Syncing upstream

`packages/runtime` is the agent-workflow runtime, derived from [openclaw/acpx](https://github.com/openclaw/acpx). Upstream history is already in this repository. Attribution and the MIT text stay in [NOTICE](../NOTICE) and [packages/runtime/LICENSE](../packages/runtime/LICENSE).

Last synced upstream release: **acpx v0.22.0** plus post-release `main` fixes. The 2026-11-19 sync merged `upstream/main` at `48c1615057ae43893f80868f81cd3ee0445eb0ae` (`48c16150`, `docs: help readers understand acpx PRs without reading code`) into `sync/acpx-main-20261119` as a dual-parent merge, covering 84 commits since `afc076b`: releases **v0.21.0** (`c0b9dfdfad12ed4fc000b8ef2efc4b5644f1c3dc`), **v0.21.1** (`e6c782459a18a5b22d06210fde61d75003883ab0`), **v0.22.0** (`1ed28f28`) and post-release fixes up to [`#1006`](https://github.com/openclaw/acpx/pull/1006).

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
