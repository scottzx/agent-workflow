# Historical daily-report test

This recipe verifies Activepieces → GitHub collection → agent-workflow A2A → ERPNext
with the existing gateway and a new agent session in a dedicated working
directory. It supplements Git facts with a small, timestamp-filtered 1session
summary prepared on the machine that owns the sessions.

`setup.mjs` creates an authenticated result receiver and a **disabled dispatch
draft** with an `Asia/Shanghai` 05:00 Cron. The date, session evidence and Trending
snapshot are fixed for a historical test. Run it using `ap_test_flow`; do not
enable the draft as a production daily schedule.

## Prerequisites

- Existing encrypted GitHub and agent-workflow automation connections in Activepieces. The connection externalId remains `oneacp-automation`.
- Install the private [ERPNext piece](../erpnext-piece/README.md) and create its
  encrypted CustomAuth connection; never place API credentials in flow inputs.
- A private ERPNext report user with create/read/write permissions on its own
  Notes. If a reader is configured, allow sharing its own Notes as well. Give it
  read access only to the intended Project.
- Add `Note.custom_daily_report_key` as a unique Data custom field. The existing
  `Note.custom_project` Link must point to Project.
- Verify that the configured `erpReaderUser` already has access to that Project.
  Only that account receives read-only access to the report; no notification is
  sent and `Note.public` remains false.
- For parent/child project organization, add `Project.custom_parent_project`
  (Link → Project) and `custom_github_repository` (Data, `owner/repository`).
  [provision-projects.py](provision-projects.py) idempotently creates `1acp` and
  `session-reader` under an existing parent, their private code-diary Notes,
  explicit report-user/reader access, and moves this recipe's old reports out
  of the parent. Run it with the site's bench Python, providing `--site`,
  `--parent-project`, `--report-user` and `--reader`. The reader must already
  belong to the parent. These are business links; they do not make Project a
  tree or automatically roll up costs, progress or permissions.
- Install [project-viewer.js](project-viewer.js) as an enabled Project / Form
  Client Script. The existing parent `PROJ-0007` shows child-project links;
  children show their code diary and recent reports. The Note viewer also
  displays each diary's child reports. Queries respect the logged-in user's
  permissions. The provided viewers recognize the `1acp` and `session-reader`
  diary names; adapt these guards when onboarding other projects.
- Use private ERPNext piece version `0.1.3` or newer when passing `erpParentNote`.
  The action verifies that the parent Note belongs to the target Project before
  saving, and reads back the parent association before acknowledging success.
- If migrated Note fields share a Section Break with `content`, install
  [note-viewer.js](note-viewer.js) as an enabled Note / Form Client Script. It
  keeps the report body visible in native read mode and only applies to this
  recipe's report-key namespace.
- Create the working directory on the A2A execution host and pin its repository
  checkout to the desired cutoff commit. Host paths and historical session paths
  are separate configuration values.

## Private setup configuration

Pass an absolute private JSON path to `node setup.mjs`. Keep the JSON and its
receipt mode 0600. It contains the following values (credentials remain in
encrypted connections and the existing private notification environment):

```json
{
  "receiptFile": "/private/session-reader-daily-report-flows.json",
  "proofFile": "/private/session-reader-daily-report-proof.json",
  "envFile": "/private/activepieces.env",
  "automationConnection": "oneacp-automation",
  "githubConnection": "existing-github-connection",
  "erpConnection": "oneacp-erpnext",
  "erpProject": "PROJ-0009",
  "erpParentProject": "PROJ-0007",
  "erpParentNote": "code-diary-note-id",
  "erpReaderUser": "existing-project-user@example.com",
  "repository": "scottzx/session-reader",
  "owner": "scottzx",
  "repo": "session-reader",
  "projectLabel": "session-reader",
  "branch": "main",
  "flowPrefix": "session-reader 日报测试",
  "reportDate": "2026-10-16",
  "windowStart": "2026-10-15T16:00:00Z",
  "windowEnd": "2026-10-16T16:00:00Z",
  "scheduledFor": "2026-10-16T21:00:00Z",
  "scheduleId": "session-reader-daily-report-test-20261016",
  "codeSnapshot": "cutoff-commit-sha",
  "sessionFacts": {},
  "trending": {}
}
```

After building the flows, append a gateway notification target for the result
webhook and a schedule allowlist entry with the dedicated remote `cwd`. Preserve
existing gateway entries, back up the private configuration and restart only
the gateway. The setup receipt prevents duplicate creation; restore it from
existing flow IDs if it is lost. Re-running setup does not edit existing flows.
Each repository uses its own receipt, dispatch/result flow pair, allowlisted
schedule ID, result notification target and execution directory. This prevents
an older repository's late result from being filed under the new repository.

## Verification

1. Run the dispatch draft with `ap_test_flow`. GitHub collection and A2A dispatch
   are real operations in the TESTING environment.
2. The authenticated result receiver runs in PRODUCTION. It claims the notice,
   validates the completed final answer, saves and reads back the ERP Note,
   grants the configured reader access and then acknowledges the notice.
3. Inspect the A2A terminal state and DSH journal: commentary stays in the log,
   and final-answer text matches the report. Check that turn/end precedes A2A
   completion and business acknowledgement.
4. Repeat the ERP save and verify there is exactly one Note for repository/date.
   Verify its child Project, parent Project and code diary associations, then
   check the report and project/diary navigation in the intended user's browser.

The report distinguishes yesterday's `[start,end)` commit/PR facts from current
Star/Fork totals and the explicitly timed live Trending snapshot. Without a
reliable previous snapshot, deltas are unavailable. Historical session claims
are labelled as such rather than counted as landed changes.

Before enabling a real daily schedule, replace the fixed test date and inputs
with per-occurrence collection, store durable metric snapshots, and configure
failure reconciliation. This test does not provide a recurring Mac-session
collector or automatic historical backfill. A failed result flow can be resumed
with `ap_retry_run` and `FROM_FAILED_STEP`; the ERP write is idempotent.
