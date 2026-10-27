# Private ERPNext daily report piece

This package is installed only in the existing Activepieces environment. Do not
publish it to npm. It uses framework 0.32.0, matching the sibling agent-workflow piece, and
requires Activepieces 0.92.1 or later. Build and package it with:

    npm ci
    npm test
    npm pack

Upload the archive through `POST /api/v1/pieces` with multipart fields
`packageType=ARCHIVE`, `scope=PLATFORM`,
`pieceName=@1agents/piece-erpnext-daily-report`, `pieceVersion=0.1.3`, and
`pieceArchive`. Create an encrypted CustomAuth connection with `siteUrl`, `apiKey`
and `apiSecret`. Use a dedicated ERPNext user able to create, read and update its
own Notes and link the target Project. Credentials belong only in this connection;
they must never be supplied to CODE actions or the intelligent agent.
For optional reader access, the writer also needs permission to share its own
Notes. The operator must first verify the configured reader may access the target
Project.
When `parentNote` is configured, the writer must also be able to read that parent
Note. A code-journal Note owned by an administrator can be shared read-only with
the writer and the intended reader without making it public.

Before using `upsert_daily_report`, provision these Note custom fields in ERPNext:

| Field | Type | Requirement |
| --- | --- | --- |
| `custom_project` | Link / Project | Existing project association |
| `custom_parent_note` | Link / Note | Required when using optional `parentNote` |
| `custom_daily_report_key` | Data | `unique=1`, read/write at permission level 0 |

Standard Note uses a random name. Frappe discards a client-provided name during
normal creation, so this action identifies the report by the database-enforced
unique key instead. Its namespace and format are
`1acp:github-daily:v1:YYYY-MM-DD:<first 32 hex chars of SHA256(lowercase owner/repository)>`.
The key represents the repository and report date; reusing it with another Project
is rejected. Display titles are deterministic too.

The action accepts `repository`, `reportDate`, `project` (default `PROJ-0007`),
and the completed agent's `reportMarkdown`. It finds and reads an existing Note,
creates or updates it, recovers a simultaneous create conflict (HTTP 409 or
Frappe `UniqueValidationError` 417), and reads the persisted Note again. Only
after identity, project, final content and private visibility checks pass does it
return `{name, url, created, hash, processed:true}`. An upstream A2A notice may be acknowledged
only after this action succeeds. Transport failures and server error bodies are
never presented as successful saves or leaked into outputs.
Set optional `processed=false` for duplicate or unclaimed notifications; this
returns `{processed:false}` immediately without contacting ERPNext.
`reportMarkdown` is optional at the Activepieces property layer so an empty report
can reach this skip branch. A real save still rejects absent or empty content.

Optional `parentNote` places the report under the project's code-journal Note.
Before writing, the action reads the parent and verifies its Project matches
`project`; it rejects making a report its own parent. After saving, it verifies
`custom_parent_note` in the persisted report before returning success. An omitted
or blank `parentNote` preserves the existing parent association. This association
does not change Project permissions or aggregate project progress. Moving an
existing report between Projects remains an explicit administrator operation;
the action continues to reject a report whose unique key is already associated
with a different Project.

Optional `readerUser` grants this configured project user read-only access to the
saved private Note. The action calls `frappe.share.add` with `read=1`,
`write=share=submit=everyone=notify=0`, then validates the returned saved DocShare.
It neither makes the Note public nor notifies the reader. Share failures leave the
action failed, allowing safe retries of the existing Note. Reader identities never
appear in action outputs or report content.

Markdown renders with raw HTML and images disabled. Ordinary headings, lists,
tables and links are supported; dangerous URL schemes are rejected by markdown-it.
The agent's process messages should remain in its execution log and must not be
passed as report content. `hash` is the SHA256 of the original final Markdown.
All authenticated network calls run in this PIECE action, preserving the existing
Activepieces CODE sandbox.
