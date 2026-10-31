# agent-workflow — the agent task-flow engine

[agent-workflow 发布页](https://scottzx.github.io/agent-workflow/) · [npm package](https://www.npmjs.com/package/@1agents/acp-service) · [变更日志](CHANGELOG.md)

agent-workflow is the agent task-flow engine in 一芥天地 (DreamMate World), from 一芥智能. It creates and runs A2A tasks: register a resident role or a one-off host, submit the work, and keep the job, its attempts and its results on the execution ledger. DeepSeek Harness (DSH) hosts the sessions. Codex, Claude Code, Pi and Cursor are built-in ACP agents, together with the other agents this runtime already registers.

agent-workflow dispatches that work and accepts it. In the delivery flows in this repository, a stage's output moves on when that stage's acceptance passes, and a person stays on the loop. 给 Agent 猛猛套上缰绳，库库干活。

Package names and command names are unchanged for compatibility: `@scottzx/1acp`, `@1agents/acp-service`, `@1agents/dsh-acp`, and the `1acp`, `acpx`, and `acp-service` commands. Role and state files stay under [`.1agents/`](.1agents/README.md).

A PPT script is structure-checked and, under the default policy, waits for a human decision before production starts. The deck then goes through a deterministic machine check. An independent agent reviewer is dispatched after that check passes, and the deck is delivered after that review passes. A report workflow file-checks the Markdown, then finishes when a person approves that exact file. Code checks, a separate agent reviewer and a human decision are the acceptance steps these deliveries use, each tied to its own stage.

Use Codex, Claude Code, Grok Build and other locally discovered ACP Agents inside DeepSeek Harness (DSH). Continue persistent native sessions, choose the models and settings exposed by each Agent, and handle tool permissions in DSH's approval UI. The same **`@1agents/acp-service`** package also provides a standalone CLI and ACP HTTP/WebSocket service.

- Keep the native Agent's workspace, tools and session identity when reconnecting.
- Select native models, reasoning settings, modes and advertised slash commands from the session UI.
- Optionally continue native history with `@1agents/session-reader`.
- Enable A2A 1.0 task delegation, status queries and completion callbacks when needed. A2A is off by default; waking a caller's main Agent requires its receiving host adapter.

## 快速开始

需要 **Node.js >= 22.13** 和 **pnpm 11**（可用 `corepack enable` 或 `npx pnpm@11`）。

```sh
git clone https://github.com/scottzx/agent-workflow.git && cd agent-workflow
pnpm install --frozen-lockfile
pnpm build && pnpm test
```

整个仓库可一条命令构建和测试；DSH 插件运行时依赖 DeepSeek Harness 内置的包，需在装好 DSH 的环境中使用。`@deepseek-ai/*` 包由 DeepSeek Harness 宿主提供；npm 上有同名的 rc 版本包，请不要从 npm 安装它们。

（未链接 DSH 时，`packages/dsh-plugin` 用 `types/dsh-host.d.ts` 中的宿主类型声明做类型检查；要用真实类型，先运行 `pnpm link:dsh /path/to/DSH`；未链接时，需要真实 DSH 运行时的 8 个插件测试文件和 2 个 “real Cordis” 用例会被跳过并在输出中列出。第三方依赖许可证见 [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES)。）

## Install in DSH

Requires **Node.js 22.13+**, DSH, and the native Agent CLI with working authentication on the DSH host. Adapter-backed Agents also need their ACP adapter; installing the native Codex CLI alone does not install `codex-acp`.

```sh
dsh plugin --profile web add @1agents/acp-service@^0.9.0
```

Restart DSH, confirm **`@1agents/acp-service`** is enabled on the Plugins page, then create a session with an **ACP · Agent** preset and an existing workspace. The plugin starts or reuses its local ACP service automatically. Replace `web` with your profile name; from a DSH source checkout, use `pnpm dsh` in place of `dsh`.

If pnpm reports an ignored `esbuild` build script, follow its prompt or configure that package's approval in the profile, then repeat the install. Approve or deny the individual script according to your policy. Check the Plugins page afterward: a partial install can leave the bundle disabled.

The current npm release is `0.9.0`. For a pinned GitHub Release artifact, install the tarball attached to the latest release on this repository, [acp-service-v0.6.0](https://github.com/scottzx/agent-workflow/releases/tag/acp-service-v0.6.0):

```sh
dsh plugin --profile web add https://github.com/scottzx/agent-workflow/releases/download/acp-service-v0.6.0/1agents-acp-service-0.6.0.tgz
```

Install `@1agents/session-reader` separately if you want to browse and continue existing Claude, Codex or Grok histories. See the [DSH user guide](packages/dsh-plugin/README.md), [service and A2A guide](packages/service/README.md), and [installation verification](docs/marketplaces/verification-2026-10-09.md).

## Screenshots and compatibility

Choose a locally discovered native Agent:

![DSH ACP Agent preset picker](packages/service/assets/dsh-agent-presets.png)

Open the native Codex model and ACP controls:

![Native Codex model and ACP settings in DSH](packages/service/assets/dsh-codex-controls.png)

These unmodified screenshots come from a fresh isolated profile on a locally modified DSH build labeled `0.2.0-rc.1`; they show discovery and native capability loading, without sending a model prompt. The CI baseline is **DSH 0.1.7-rc.2**, commit [`21638c5`](https://github.com/deepseek-ai/deepseek-harness/commit/21638c56315ae6a2b552d6091945d3144c9af32e). See the verification record for the installed-artifact, profile, Loader, browser and lifecycle checks. Compatibility with other releases requires checking their plugin APIs.

The plugin currently accepts text prompts. Available controls depend on the selected native Agent, adapter and account.

## Standalone CLI

```sh
npm install -g @1agents/acp-service@^0.9.0
acp-service --help
acp-service serve --host 127.0.0.1 --port 36812 --no-report
```

The runtime and service can be used outside DSH. Installing the npm package starts no process.

## Source workspace

One published package contains the runtime, CLI, service and DSH plugin. The upstream runtime and DSH plugin remain private source modules in one repository with one pnpm lockfile. The DSH plugin communicates with the service through ACP JSON-RPC, while a managed child process loads the service when a local endpoint needs starting.

Project-owned roles, skill caches, workspaces and runtime state live under [`.1agents/`](.1agents/README.md). Role definitions and public examples are tracked; local data and credentials are excluded from Git.

| Directory             | npm package            | Responsibility                                                               |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `packages/runtime`    | Private workspace only | Upstream agent runtime and CLI, embedded in the service                      |
| `packages/service`    | `@1agents/acp-service` | ACP CLI/service, A2A delegation and bundled usage skill                     |
| `packages/dsh-plugin` | private source module | DSH session presets, native commands, model selection and interactions       |

## Development

Use Node 24 and the pnpm version pinned in package.json. Install from this root; package-level npm lockfiles are replaced by the root pnpm lockfile.

```sh
pnpm install --frozen-lockfile
# DSH must already be installed and built, matching the plugin's supported API.
pnpm link:dsh /absolute/path/DSH
pnpm build
pnpm test:integration
# Includes the full runtime test suite:
pnpm test
```

Build runtime, then service, then the private DSH source module; `pnpm build` also embeds the DSH host entry, browser bundle and patch into the service. Consumers can import `@1agents/acp-service/runtime`, `@1agents/acp-service/flows` and `@1agents/acp-service/agent-registry`, or use the unified `acp-service` CLI. The DSH development links supply types only; the Host provides those services at runtime.

```sh
# Run from the DSH checkout; the plugin starts or reuses its local service:
pnpm dsh plugin --profile web add /absolute/path/agent-workflow/packages/service
pnpm dsh web --no-open
```

Agent binaries, authentication, service state and DSH session bindings remain outside this repository. Moving the checkout does not migrate or delete session data.

## Package releases

Only `@1agents/acp-service` is published. Version 0.7.0 includes the runtime, CLI, service and DSH plugin in one tarball. Runtime and DSH source modules stay private; there is one public version to bump and one package to publish.

Version 0.7.0 adds [Activepieces scheduled tasks](docs/activepieces-automation.md) through the existing A2A gateway, with durable occurrence admission, result claims and acknowledgement. Codex commentary stays in DSH execution logs while A2A reports contain the final answer; explicit empty answers survive replay. The [scheduled-chain verification](docs/activepieces-final-answer-proof.json) records the completed WSL deployment test.

Version 0.6.0 adds DSH A2A 1.0 execution, remote-agent gateway tools, a durable completion inbox and the bundled ACP Service usage skill. Tasks return IDs before completion, run in the selected remote workspace and preset, and support standard queries, subscriptions and allowed completion callbacks. The gateway reconciles remote status after reconnect or restart; main-model wake-up still requires a receiving host adapter.

Version 0.5.4 introduced ordered DSH tool groups, native commentary and reasoning: ACP tool updates retain their titles, input and output, and consecutive calls appear as collapsed peer Tool groups, separated by native prose or reasoning in stream order. The DSH components already registered by the host render the cards and prose. Remote tools remain owned by the ACP Agent and are never executed again by DSH.

```sh
# Ordinary CLI installation:
npm install -g @1agents/acp-service@^0.9.0
acp-service --help
# DSH installation (run from its checkout):
pnpm dsh plugin --profile web add @1agents/acp-service@^0.9.0
```

The CLI uses the package's `bin`; DSH selects its `dsh.bundle.patch` and activates the package-root Cordis entry. The root preserves service API exports and lazily loads plugin code when DSH invokes `apply`. DSH scans only package-root rows for browser metadata, so the patch deliberately loads the root, rather than `/dsh`. `/service` offers the service API; `/dsh`, `/dsh/preset` and `/dsh/imports` offer typed plugin APIs. Installing the package does not start a service or require DSH dependencies.

Push CI builds each source module once and packs the unified release package once, after service and plugin checks. Runtime integration tests run in four disjoint lanes; remaining tests, viewer, coverage and Python Autoreview run independently. Fixed-ref DSH build outputs are cached by ref, lockfile, OS, architecture and Node version. CI installs the tarball outside the workspace and verifies the CLI, runtime flows and service, then uses the real DSH profile reader, Cordis Loader and client registry to check plugin startup, browser discovery and cleanup.

Run the root **Release** workflow on `main`. It locates successful push CI for the exact commit, waits if that CI is running, and downloads its single existing tarball. The optional `ci_run_id` pins the source run; SHA, repository, workflow, branch and success are verified. Release performs no install, build or test. If matching CI is absent or artifacts have expired, run CI first.

Release checks artifact SHA/checksum, manifests, dependencies, runtime and DSH entrypoints, then publishes via `NPM_TOKEN`. Retry Release on the same commit after a publish or registry error: it reuses the CI tarball and skips an already published version only after verifying its contents and permissions. Registry propagation retries are bounded to eight attempts with five-second intervals. Changed published contents require a version bump.

For local packaging, build first, then run `pnpm run pack` from this root. Packing checks existing outputs and never rebuilds them. To verify the resulting package:

```sh
node scripts/smoke-service-package.mjs release/1agents-acp-service-0.7.0.tgz /absolute/path/DSH
```

### Migrate a DSH profile

The former `@1agents/dsh-acp` package stops receiving independent releases. With DSH stopped, remove the old bundle before installing the unified one:

```sh
pnpm dsh plugin --profile web remove @1agents/dsh-acp
pnpm dsh plugin --profile web add @1agents/acp-service
```

Restart DSH after migration. Plugin IDs, preset IDs, binding paths and service state remain the same; existing sessions retain their identity. Update any custom plugin rows from `@1agents/dsh-acp` to `@1agents/acp-service`, presets to `@1agents/acp-service/dsh/preset`, and native-session imports to `@1agents/acp-service/dsh/imports`. Do not enable both old and new bundles together. Preserve custom row configuration when replacing its package name.

## Repository migration

This repository preserves the original runtime history and merges the complete service and plugin histories without squashing. `git log --all` includes their original commits.

`1agents_app/modules/1acp` remains a pinned consumer submodule of this repository. Its runtime is now under `packages/runtime`; package build tooling and adapter discovery use that path. Push this repository's referenced commit before sharing the updated consumer submodule pointer.

In the shared local workspace, keep `1agents_app/modules/1acp` as the real checkout and make `services/1acp` a relative symlink to `../1agents_app/modules/1acp`. This lets App builds and service discovery use the same source while preserving the consumer submodule. Archive any pending work and repository metadata before replacing an existing standalone checkout.

See each package README for its protocol, configuration and usage details.

## Acknowledgements

The embedded runtime is derived from [openclaw/acpx](https://github.com/openclaw/acpx) (MIT, Copyright (c) 2025 OpenClaw Team). Its upstream history stays in this repository, and the full MIT text stays in the [runtime license](packages/runtime/LICENSE). See [NOTICE](NOTICE) and [Syncing upstream](docs/upstream-sync.md). The [DSH plugin license](packages/dsh-plugin/LICENSE) is unchanged. The unified npm artifact includes its component licenses.

The source-maintained [ACP Service skill](packages/service/skills/acp-service/SKILL.md) ships in the unified npm package, including ACP, DSH and A2A references. Use `acp-service --skill list`, `--skill show acp-service`, or `--skill export acp-service` to discover, read or export it; the existing `acpx` runtime skill remains available.
