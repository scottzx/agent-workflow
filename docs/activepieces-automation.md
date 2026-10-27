# Activepieces scheduled agent tasks

Activepieces owns schedules and business steps. The existing agent-workflow A2A gateway
owns remote task monitoring, durable completion notices and delivery retries.
The optional automation listener adds occurrence admission and processing claims.
DSH remains the execution host for the existing A2A backend.

## Configuration and deployment

Start from [the gateway example](../examples/activepieces/gateway.example.json).
Keep the actual configuration mode 0600 and its directory/state directory mode
0700. Each schedule fixes its remote, remote working directory, preset and
notification destination; requests cannot override these fields.

    acp-service a2a gateway --config /absolute/private/gateway.json

The original local invocation listener remains on 127.0.0.1. The automation
listener defaults to 127.0.0.1:36815. Choose a reachable private interface when
Activepieces runs in Docker or elsewhere. Every automation request requires the
configured Bearer token; browser Origin requests are rejected. DSH A2A must be
enabled, with an Agent Card advertising an address reachable by the gateway.
The configured remote URL and the advertised A2A endpoint must have the same
origin (scheme, host and port). Use the reachable relay origin for both when DSH
listens on loopback; the gateway deliberately rejects a cross-origin Agent Card.

## Automation API

| Method | Path | Input / behavior |
| --- | --- | --- |
| POST | /automation/runs | scheduleId, scheduledFor, prompt; optional flowRunId and businessRef |
| GET | /automation/runs?limit=100 | Latest occurrences and refreshed task state; maximum 500 |
| GET | /automation/runs/:runId | Refresh one occurrence |
| POST | /automation/runs/:runId/cancel | Cancel the associated confirmed remote Task |
| POST | /automation/notices/:noticeId/claim | originSessionId, processorId; acquire/renew processing lease |
| POST | /automation/notices/:noticeId/ack | Same origin/processor; confirm successful business processing |

Submissions return {run, created}: HTTP 201 for a new occurrence, 200 for a
duplicate. scheduledFor is canonicalized to UTC before deriving the occurrence
key. The same schedule and time return the existing record. A second occurrence
while a task is active or uncertain is recorded as skipped, reason schedule_busy.

Each record relates runId and originSessionId (automation:runId) to taskId,
contextId, sessionId and the optional business reference. The ledger is written
atomically under the gateway state directory and its existing single-owner lease.

## Two Activepieces flows

The [setup script](../examples/activepieces/setup.mjs) uses the deployment host's
existing DreamMate-connected native Activepieces MCP. Its private receipt keeps
flow IDs across retries:

1. Schedule (Asia/Shanghai) → persist the minute batch → dispatch.
2. Authenticated Webhook → persist processor ID → claim → save report → ack.

The demo saves the report as an Activepieces step output before acknowledgement.
Replace that step with an idempotent business write for production, using noticeId
or runId as its key.

The report contains the completed turn's final answer. For Codex, explicit
`commentary` / `final_answer` message phases survive the runtime, ACP transport
and DSH session journal. All commentary, tools and final text remain in the DSH
execution log; only final-answer text is written into the terminal answer and
A2A result. A durable terminal answer takes precedence over streamed text,
including an explicitly empty answer. A completed ACP turn with known phases
but no final answer is reported as failed rather than promoting commentary to a
report. Agents without phase metadata retain their previous output behavior.

The private piece uses an encrypted SecretText connection. Network calls run in
piece actions; CODE steps only prepare data or shape a report. This preserves
SANDBOX_CODE_ONLY and keeps the privileged gateway token out of flow definitions.

Start from [the setup example](../examples/activepieces/activepieces.example.json).
Create the result flow and dispatch draft, configure the gateway notification
target using the receipt's webhook URL, start the gateway, then publish dispatch.
Recover missing receipts from existing flow IDs instead of recreating named flows.

## Failure and recovery

- Save the occurrence before sending. An uncertain submission becomes
  submission_unknown and is never automatically resent. Existing gateway records
  can recover a missing linkage; a remote-acceptance/local-save crash window still
  requires investigation.
- Gateway polling fills missed callbacks. Gateway restart resumes monitoring;
  execution-host restart marks unfinished Tasks failed.
- Notification delivery and business processing are separate. Notices remain in
  the inbox until acknowledged. A duplicate cannot claim another live lease.
- A failed result flow retries with its persisted processor ID; another processor
  may take over an expired lease. Business writes must be idempotent around crashes.
- Persisted business completion can finish its pending local inbox ack on the
  existing gateway reconciliation tick after restart.
- Input-required tasks remain active and require a human. This release does not
  add a gateway method to resume the same input-required Task.

The template persists minute-precision occurrence data before its network step.
Step retries reuse that batch. Historical misfire backfill and distributed
exactly-once execution are not implemented.

## Verification and rollback

Run integration tests, typecheck, build and package the unified service. Observe
an actual scheduled Activepieces run, completed A2A Task, successful result flow
and persisted business acknowledgement. Manual submission alone is insufficient.

Disable the temporary every-minute demo after verification. Keep its result
receiver and gateway available; enable a production schedule after choosing its
business task and cadence.

Install the gateway in a separate release directory/service without replacing
DSH's package. Back up any DSH publicUrl change. Roll back by disabling dispatch,
stopping the gateway and restoring only the deployment-specific configuration.
Save results before removing its piece, connection or flows.

## Verified WSL deployment

The [initial verification receipt](activepieces-automation-proof.json) records a genuine
scheduled PRODUCTION run, Codex execution and successful result processing.
It also verifies that a gateway restart preserves the Task and that duplicate
submission/notification processing does not create new work.

The [final-answer verification receipt](activepieces-final-answer-proof.json)
records the follow-up run with separate commentary and final-answer phases. It
checks the saved DSH journal against the actual Activepieces report and verifies
that A2A completion and business acknowledgement follow the DSH turn ending.

| Item | Location / status |
| --- | --- |
| Gateway | system service 1acp-automation.service, enabled at boot |
| Release | /home/scott/.local/share/1acp-automation/releases/v5-final-answer/package |
| Private dependencies | releases/v5-final-answer/dependencies/node_modules; no dependency on a DSH release path |
| Configuration | /home/scott/.config/1acp-automation/gateway.json |
| Persistent state | /home/scott/.local/state/1acp-automation |
| Encrypted AP connection | oneacp-automation |
| Dispatch flow | 1LLAYCJcNyr6oqhopxqaT, published and DISABLED |
| Result flow | GoMSn0AWtoQB9OYVdLNJl, published and ENABLED |
| Successful Task | be0ca1c8-0d2b-4420-8020-bfa482ef1e90 |

The temporary dispatch flow uses every-minute Cron. Choose its real business
task and cadence before enabling it. The demo report is available in the result
run's “保存智能体报告” step. No Plane writeback is configured by this example.

WSL keeps its original Activepieces sandbox mode and container environment.
The DSH Agent Card origin was corrected to match the reachable relay; the
original profile configuration is backed up privately on WSL. The initial
pre-dispatch origin rejection and two skipped occurrences are retained for audit.
