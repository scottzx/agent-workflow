/**
 * CLI entrypoint for the lightweight A2A approval & task-ticket MCP server (`acp-service mcp`).
 */
import { parseArgs } from 'node:util';
import {
  A2A_APPROVAL_MCP_SERVER_NAME,
  A2A_APPROVAL_MCP_SERVICE_ID,
  DEFAULT_A2A_GATEWAY_URL,
  DEFAULT_COACH_AGENT,
  runA2AApprovalMcpStdio,
} from '../src/a2a/approval-mcp.js';

const USAGE = `Usage: acp-service mcp [--url URL] [--agent NAME] [--session ID]
                       [--origin-session ID] [--session-host HOST] [--host-session ID]
                       [--project-root DIR] [--auto-bind | --no-auto-bind]

Starts the lightweight A2A approval & task-ticket MCP server on stdio
(newline-delimited JSON-RPC 2.0), proxying to the local a2a-gateway.

Options:
  --url URL              a2a-gateway HTTP URL (default: $A2A_GATEWAY_URL or ${DEFAULT_A2A_GATEWAY_URL})
  --agent NAME           Default coach agent name for decidedBy (default: $A2A_MCP_COACH_AGENT or ${DEFAULT_COACH_AGENT})
  --session ID           Default coach sessionId for decidedBy (default: $A2A_MCP_COACH_SESSION_ID or originSessionId)
  --origin-session ID    Default owner originSessionId (default: $A2A_DEFAULT_ORIGIN_SESSION_ID)
  --session-host HOST    Default session host (default: $A2A_DEFAULT_SESSION_HOST)
  --host-session ID      Default host session id (default: $A2A_DEFAULT_HOST_SESSION_ID, else the origin session id)
  --project-root DIR     Fixed project root for a2a_role_rules_get (default: $A2A_PROJECT_ROOT, else the process cwd)
  --auto-bind            Bind that default host session before a dispatch that omits originSessionId (default)
  --no-auto-bind         Do not bind automatically
  -h, --help             Show this help message

DreamMate registration (local sharing):
  dreammate-node mcp add --config '{"mcpServers":{"${A2A_APPROVAL_MCP_SERVER_NAME}":{"command":"acp-service","args":["mcp","--url","${DEFAULT_A2A_GATEWAY_URL}"],"sharing":"local"}}}'

Direct DreamMate invoke (skip search/inspect):
  service_id: "${A2A_APPROVAL_MCP_SERVICE_ID}"
  methods (dispatch & lifecycle):
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_target_list
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_session_bind
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_task_dispatch
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_task_get
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_task_list
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_task_continue
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_task_cancel
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_notice_ack
  methods (approvals, tickets & reviews):
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_pending_approvals
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_process_requests
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_process_answer
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_ticket_get
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_ticket_proposal_decide
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_execution_review
  methods (local role rules, no gateway round-trip):
    ${A2A_APPROVAL_MCP_SERVICE_ID}.a2a_role_rules_get`;

export async function runMcpCli(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      url: { type: 'string' },
      agent: { type: 'string' },
      session: { type: 'string' },
      'origin-session': { type: 'string' },
      'session-host': { type: 'string' },
      'host-session': { type: 'string' },
      'project-root': { type: 'string' },
      'auto-bind': { type: 'boolean' },
      'no-auto-bind': { type: 'boolean' },
    },
  });
  const autoBind = values['no-auto-bind'] ? false : values['auto-bind'] ? true : undefined;
  await runA2AApprovalMcpStdio({
    ...(values.url ? { gatewayUrl: values.url } : {}),
    ...(values.agent ? { coachAgent: values.agent } : {}),
    ...(values.session ? { coachSessionId: values.session } : {}),
    ...(values['origin-session'] ? { defaultOriginSessionId: values['origin-session'] } : {}),
    ...(values['session-host'] ? { defaultSessionHost: values['session-host'] } : {}),
    ...(values['host-session'] ? { defaultHostSessionId: values['host-session'] } : {}),
    ...(values['project-root'] ? { projectRoot: values['project-root'] } : {}),
    ...(autoBind !== undefined ? { autoBindDefaultSession: autoBind } : {}),
  });
}
