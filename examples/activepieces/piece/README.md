# Private agent-workflow Activepieces piece

This local package is uploaded to the existing Activepieces installation; it is
not published to npm. Its CustomAuth connection stores gatewayUrl and the
SecretText automationToken in Activepieces' encrypted connection storage.

    npm ci
    npm run build
    npm pack

The archive contains only compiled CommonJS files and package metadata.
Activepieces 0.92.1 Community supports the platform-admin archive installation
API: POST /api/v1/pieces, multipart fields packageType=ARCHIVE, scope=PLATFORM,
pieceName=@1agents/piece-acp-automation, pieceVersion=0.1.0, and pieceArchive.
Use an authenticated administrator session when installing. The source is
provided here so subsequent versions can be built and reviewed independently.

Create a project-scoped connection with externalId oneacp-automation, then use
the sibling setup.mjs script to build the example flows. The connection's base
URL must be reachable from the Activepieces worker.

The three actions are dispatch_run, claim_notice and acknowledge_notice.
Dispatch automatically records the actual Activepieces flow run ID. Claim
returns claimed=false for a completed notice or another processor's live lease;
only write business results when claimed=true. Acknowledge with processed=false
performs no network call, allowing the duplicate-notice branch to finish safely.

Pieces perform authenticated network operations outside the CODE sandbox. The
example keeps CODE steps pure and preserves SANDBOX_CODE_ONLY. Credentials
are excluded from action outputs and errors. The webhook authentication token
is separate and only permits delivering notices; it is not the automation API
credential.
