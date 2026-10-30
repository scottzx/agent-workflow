# DSH plugin in @1agents/acp-service

Use persistent native Codex, Claude Code, Grok Build and other locally discovered ACP Agent sessions inside DeepSeek Harness. Choose native models and settings, use advertised commands, and answer tool permissions in DSH. The plugin is embedded with the runtime and service in the single public **`@1agents/acp-service`** package. This directory is its private source module.

The CI API baseline is **DSH 0.1.7-rc.2**, commit `21638c56315ae6a2b552d6091945d3144c9af32e`. Additional installed-package and interactive checks used an isolated profile on a locally modified DSH build labeled `0.2.0-rc.1`; see the [verification record](https://github.com/scottzx/1acp/blob/main/docs/marketplaces/verification-2026-10-09.md) for the exact scope. Other DSH releases require checking their plugin and preset APIs.

The same host supports opt-in A2A 1.0 delegation, disabled by default: remote text messages create or restore DSH sessions, return task IDs, and continue execution independently of HTTP clients. Configure `a2a` on the existing plugin row, set the host's `DSH_A2A_TOKEN`, and choose its public origin, default cwd and preset. Query and subscribe through the official A2A interfaces; allowed webhook origins enable completion callbacks. Waking a caller's main Agent requires its receiving host adapter. See the [service README's DSH A2A section](https://github.com/scottzx/1acp/blob/main/packages/service/README.md#dsh-a2a) for configuration, metadata and recovery behavior. The shared server is exported as `@1agents/acp-service/a2a` and remains independent of DSH imports.

## Install and start a session

Requires **Node.js 22.13+**, a working DSH installation, and each selected native Agent's CLI and authentication on the DSH host. Adapter-backed Agents require their ACP adapter as well; the native Codex CLI does not replace `@agentclientprotocol/codex-acp`. Ensure these executables and credentials are available to the DSH process.

Install the one public package:

```sh
dsh plugin --profile web add @1agents/acp-service@^0.7.0
```

If pnpm pauses or fails with an ignored transitive `esbuild` build script, follow its prompt or configure that individual package's approval in the profile's `pnpm-workspace.yaml`, then repeat the install. Approve or deny it according to your policy. A successful isolated package smoke used `--ignore-scripts`; the interactive pnpm 11 profile check approved only `esbuild`. A partial install can leave the bundle disabled, so check the Plugins page afterward.

Restart DSH after updating packages, confirm **`@1agents/acp-service`** is enabled on its Plugins page, and choose a discovered **ACP · Agent** preset for a new session. Select an existing workspace, then send a text prompt. Replace `web` with your profile name, such as `desktop`; from a DSH source checkout, use `pnpm dsh` in place of `dsh`.

For a pinned fallback, install the identical npm artifact from [GitHub Release 0.6.0](https://github.com/scottzx/1acp/releases/tag/acp-service-v0.6.0):

```sh
dsh plugin --profile web add https://github.com/scottzx/1acp/releases/download/acp-service-v0.6.0/1agents-acp-service-0.6.0.tgz
```

The package declares `dsh.bundle.patch` and its browser entry, so installation selects the bundle automatically.

The plugin starts its bundled ACP service on `127.0.0.1:36812` when no service is listening. An existing healthy ACP service is reused. Start DSH normally; no separate service command is needed. To manage the service yourself, set `serviceMode: external` and run:

```sh
npx --yes @1agents/acp-service@^0.7.0 serve --host 127.0.0.1 --port 36812 --no-report
```

Installing the package alone starts no process; activating the plugin starts the service. For local development, install the built checkout with `pnpm dsh plugin --profile web add /absolute/path/1acp/packages/service`.

ACP routes are not listed as ordinary DSH models, and the adapter rejects requests from ordinary presets, including previously saved ACP routes. Before the first turn, switching the Agent preset replaces the discovery connection and its native commands. Once a turn starts, the session keeps its remote Agent and workspace; start a new session to change Agent. Native Agent binaries and authentication belong to acp-service.

### Migrate an older installation

For an existing `@1agents/dsh-acp` installation, stop DSH, remove that bundle and add `@1agents/acp-service`. Keep existing binding files and copy any custom row configuration. The same plugin and preset IDs preserve session identity. Custom preset rows now load `@1agents/acp-service/dsh/preset`. Enable only the unified bundle.

## Session behavior

The bundle registers an ACP adapter through DSH's public streaming extension and routes the ACP presets to it. It sends newly admitted messages whose source is `user` to `session/prompt`, not to `subagent-acp`; there is no coordinating DeepSeek model call. DSH-generated workspace instructions and runtime-context messages are excluded. The external Agent owns its model, prompt, tools and native history, including any project instructions it discovers itself. DSH owns its UI and local user/assistant transcript. External tool progress is preserved as display metadata on empty text blocks in DSH's existing assistant stream records and projected onto collapsed groups of peer tool cards, separated by native prose and reasoning. ACP updates retain previously supplied fields, and replay is deduplicated by the managed turn sequence. These snapshots contain no visible text and never dispatch local tools; they use the existing persisted session format so conversations can reopen normally. Only Agent thought chunks enter the thinking stream.

## Continue imported native sessions

History import is optional. Install the separate history browser only when needed:

```sh
dsh plugin --profile web add @1agents/session-reader
```

With `@1agents/session-reader` installed, choose **在 DSH 中继续原会话** on a Claude, Codex or Grok history. The original workspace must still exist. The plugin restores the native session through acp-service's `_1agents/session/import`, creates DSH history under the matching ACP preset, and attaches it to that workspace. Importing sends no prompt. Subsequent messages go to the original Agent; imported messages are never resent, including an unfinished trailing user message. Unsupported sources stay readable in session-reader.

Imported bindings use `session/resume` because the service does not own a complete ACP replay of earlier native history. Existing ordinary ACP bindings continue using `session/load`. Endpoint, source provider and native ID identify an import; repeated admission reuses its DSH session without refreshing or replacing history. Old history-only DSH copies are not adopted. Original Agent history can continue changing outside DSH; the imported DSH history is a snapshot.

The service ID is saved before DSH creation. A failed local creation or workspace attachment can be retried after restart without importing again. When the original session reports `already has an active writer`, DSH still creates and opens its historical session. The composer is disabled with an explanation; capability refresh retries the original identity and restores input after its writer releases it. A pending import survives plugin restart. Other native restoration and authentication failures are reported, never replaced by a new empty session. If the transport is lost before the import response reaches the plugin, the plugin cannot know the service ID and does not automatically retry that RPC.

### Plugin service API

`ctx.oneagentsAcpSessions` is a Cordis service owned by this plugin; consumers may declare it optional so history browsing works without ACP. Its TypeScript declarations are exported from `@1agents/acp-service/dsh/imports`. Consumers call the service from the Host and must not instantiate it or write its binding files.

- `availability(provider)` returns `{ available, agent?, reason? }` without restoring a session. It checks configuration and the service inventory; successful native restoration remains the final capability/authentication check.
- `importSession({ provider, nativeSessionId, cwd, events })` accepts current DSH events starting at sequence zero. It returns `{ success: true, dshSessionId, workspace, workspaceId, agent, continuation: 'native', writable, blocked? }` after DSH creation and workspace attachment. An active native writer returns `writable: false, blocked: 'active-writer'` while leaving history available.

Provider mapping is `claude → claude`, `codex → codex`, `grok → grok-build`. The service validates history through DSH before restoring a new native binding. No DSH Session format changes are required.

## Native commands and configuration

Opening an ACP session initializes or restores its remote session without sending a prompt. The plugin consumes `available_commands_update`, `config_option_update`, and mode updates. Advertised slash commands with names accepted by DSH (`[a-z][a-z0-9_-]*`) are registered in that session and forwarded verbatim through `session/prompt`, including their arguments. `/model` opens the model options advertised by the remote Agent. Choosing a model or reasoning setting uses `session/set_config_option`; choosing a mode uses `session/set_mode`. Unsupported options are not invented. Configuration changes are rejected while a turn runs.

A successful choice in **ACP 设置** is remembered for that absolute workspace and that ACP agent. Grok Build and Codex keep separate records, each with the mode id and config-option ids that agent accepted. The file is `agent-session-settings.json` in `stateDirectory`, beside session bindings. A later new session replays only its own record before the first prompt: model options first, then the other options against each catalog returned by `session/set_config_option`, then the mode through `session/set_mode`. A missing id or value fails before the prompt and closes the new remote session. When the record includes a mode, that mode is used. An agent with no record still receives only `initialModeId`. A record with options and no mode still applies `initialModeId`. Continuing, loading, or importing an existing session keeps the settings already on that session. `initialModeId` and untouched session defaults are not written into the file. Choosing the same option again replaces that id. `execution_submit` does not carry these values.

The bundle disables the stock `ui-model-selection` row and supplies a session-aware model selector using DSH's existing UI slot and command contribution APIs. Ordinary sessions still select their DSH provider/model and reasoning effort; ACP sessions select only native Agent options. The Agent's additional options appear under **ACP 设置**. An idle ACP connection is retained so metadata updates and controls share the same session owner. The visible browser refreshes its capability snapshot every five seconds.

The bundle registers `oneagents-acp-*` presets with DSH's preset registry. Older filesystem presets remain untouched; DSH 0.1.7 uses registry declarations instead of scanning those files. ACP bindings are stored separately under `$DSH_HOME/plugins/1agents-acp/sessions`.

## Interactions and reconnection

ACP one-shot tool permissions use DSH's approval UI and policy. Grok questions and plan approval use its question UI. Persistent grants are not synthesized. Read operations follow acp-service's `approve-reads` policy; operations requiring permission are presented to the user.

When `a2a.workbench` is configured, DSH's own tool approvals inside an A2A task (for example a `danger-full-access` escalation from `tool-bash` under the `standard` preset) become `permission` process requests on the gateway workbench. The workbench is the only place to answer them, because DSH's approval UI keeps its prompt for the request's whole lifetime and could not withdraw it after a workbench answer. Approve grants that one call, reject denies it, and an expired or closed request cancels it. If the workbench cannot be reached, DSH's approval UI answers as before. Sessions outside A2A tasks, and ACP presets (which open their own request), are unaffected.

Transport reconnects load the same service session and replay the current managed turn. Stable request IDs prevent duplicate execution, and update sequence numbers suppress duplicate output. A browser refresh leaves the Host request running. Stopping a DSH turn sends ACP cancellation. Provider errors fail the turn without automatic resubmission.

The owned ACP Adapter sanitizes provider failures before the official DSH host normalizes them. Category, provider code, retryability, outcome uncertainty, origin and request identity are persisted in the plugin's `oneagents_acp_diagnostics` domain, using official `storageDomain` and JSON storage plugins. The plugin owns their lifetime so cancellation and A2A drain before storage closes. DSH source, native `LlmFailure` and Session event schemas stay unchanged; its ordinary logs can retain only code and message. Complete diagnostics appear under A2A `metadata['1agents'].error`, with the A2A caller's operation identity. Host error properties and arbitrary in-band metadata cannot supply missing diagnostics.

Each attempt is bound to its DSH session, turn/start sequence, step/start sequence, input message identities and native request identity. Only user messages admitted in the current turn establish association; each identity is at most 256 characters and each identity list at most 128 entries. Oversized identities fail before native delivery. Records contain only bounded safe fields, never provider text, credentials or authentication URLs. A newer pending attempt cannot borrow an older failure. The storage owner-token lease rejects concurrent writers and reclaims only demonstrably dead owners after restart. Invalid versions or records fail initialization without deleting evidence. Writes resolve after durability; a storage failure fails the call instead of acknowledging diagnostics that were not saved.

Confirmed remote cancellation reports `cancelled` with `outcomeUnknown: false`. A received terminal RPC reply establishes the outcome even when local cancellation races with its delivery; no further output is emitted after cancellation. A submitted request without a terminal reply remains uncertain, while work cancelled before delivery is certain. Claimed disposal without a result remains uncertain. Root teardown waits for the official Agent idle barrier if subscriptions disappear before the final event. Cancellation does not automatically resubmit, and a racing local abort does not replace a received provider error.

A2A startup reconciles interrupted tasks using their saved context and exact task/message request identity. A durable plugin failure restores its safe fields; an unfinished submitted attempt stays unknown. Reconciliation records a failed interrupted task and never dispatches execution. Already terminal tasks remain unchanged. Historical host logs without plugin diagnostics cannot reconstruct missing fields, and other DSH providers are not classified from host error text.

This plugin supports **text prompts**. Attachments and specialized external-tool cards are not implemented. Auxiliary DSH title/compaction calls cannot use this adapter; an advertised native compaction command runs in the external Agent. Existing standard-preset sessions that selected an old ACP route must choose a normal DSH model or start a new ACP-preset session.

## Configuration

The bundle's `oneagents-acp` row accepts `serviceUrl`, `serviceMode`, `serviceStartupTimeoutMs`, `serviceShutdownTimeoutMs`, `agents`, `stateDirectory`, `diagnosticsDirectory`, `reconnectAttempts` and `reconnectDelayMs`. Change it through the profile's `cordis.patch.yml`, not the DSH repository. Use a new session after changing endpoint or workspace. When `agents` is omitted, plugin startup fetches `GET /agents` from acp-service and registers presets for entries with `chat_ready: true`, using their service-provided names. Discovery runs on the service host. Restart the plugin after installing or removing a harness. An explicit `agents` list bypasses discovery and preserves manual registry selection; `[]` registers no presets. Service startup, connection errors and invalid inventory responses fail plugin initialization instead of selecting fallback agents.

Explicitly authorized unattended work can declare `sessionPolicies`, with an exact absolute `cwd`, ACP registry `agent`, and optional `initialModeId`. A policy matches only that workspace and Agent; wildcards and duplicate scopes are rejected. New sessions select the advertised native mode before sending any prompt; an unavailable mode fails without prompting. A stored ACP 设置 record for the same workspace and Agent is applied on that new session, and its mode replaces `initialModeId`. Existing sessions keep their native mode and any ACP settings already selected or imported. `permissionMode` (`approve-reads`, `approve-all`, `deny-all`) may still appear in older configs and is ignored: the bridge does not apply that three-state shield. Mode and reasoning effort come from ACP 设置 (`session/set_mode`, `session/set_config_option`) or from the native session an import resumes. For example, an authorized Codex video workspace can use `initialModeId: "agent-full-access"` without changing the host's global model or other workspaces. Remove the declaration when the authorized batch ends; existing native sessions retain their own stored mode.

Diagnostic storage defaults to `stateDirectory/diagnostics`; `diagnosticsDirectory` selects a separate explicit location. Keep this directory with the A2A state when moving a host. Its version is independent of DSH Session formats. The plugin privately mounts official storage components; it does not require a shared host storage-domain configuration. Only one plugin instance may write the directory at a time.

### Local service lifecycle

`serviceMode` defaults to `auto`. Only plain HTTP root URLs on `127.0.0.1`, `localhost` or `[::1]` can start a process. Remote URLs, HTTPS and URLs with a path or credentials remain external connections. `external` disables process management for every address. Use a stable nonzero port: native session bindings include the endpoint.

Before spawning, the plugin validates `/health`. Connection refusal permits startup; HTTP errors, authentication failures, timeouts and another application occupying the port fail explicitly. Startup waits for the child to listen and pass its health check before discovering Agent presets. `serviceStartupTimeoutMs` defaults to 15000 for each startup/health phase; `serviceShutdownTimeoutMs` defaults to 5000 before forced process exit.

Plugin disposal closes ACP connections before shutting down its owned service and awaiting process exit. Concurrent plugin instances in the same DSH process share an owned service until the last instance disposes. An existing service is never stopped. A worker also exits if its DSH parent crashes or is killed. If the worker itself crashes, requests fail through the normal ACP connection errors; restart the plugin to start a replacement. A service shared by separate DSH processes should be managed externally so stopping its owning DSH instance does not interrupt the others.

The child inherits DSH's environment, including native Agent configuration and credentials, and uses the service's existing state directory (`ACP_STATE_DIR` or `~/.1agents/acpx-state`). It starts with node reporting disabled. The plugin neither downloads executables at startup nor launches native Agents until a session needs one.

## Development and removal

Install and build from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm link:dsh /absolute/path/DSH
pnpm build
pnpm test:integration
```

The DSH checkout must already have its dependencies installed and declaration outputs built. Development type checking links its matching packages into `node_modules/@deepseek-ai`; generated JavaScript uses the Host's public packages and services. The `dsh-zod` dependency alias pins the record-schema dialect to Zod 4.4.3 for the tested official DSH 0.1.7-rc.2 API, independently of the service's Zod dependency. A different DSH version requires its own compile and lifecycle compatibility checks. Tests cover real-WebSocket streaming, permissions, questions, cancellation, reconnection and saved bindings.

For manual service debugging on this machine, start it from `../service` with:

```sh
CODEX_PATH=/Applications/ChatGPT.app/Contents/Resources/codex \
npm_config_cache="$HOME/.dsh/plugins/1agents-acp/npm-cache" \
node dist/bin/acp-service.js serve --host 127.0.0.1 --port 36812 --no-report
```

For automatic startup, set these environment variables on the DSH process instead. `CODEX_PATH` selects the installed app's newer Codex runtime; the global CLI on this machine rejects its configured `gpt-6-astra` model. The separate npm cache avoids a broken pre-existing npx cache. Neither setting changes the global Codex configuration.

Remove using `pnpm dsh plugin --profile web remove @1agents/acp-service`, then restart DSH; removing the bundle also restores the stock model-selection row. The preset registrations are removed with the bundle. Keep binding files if sessions may be reattached later.
