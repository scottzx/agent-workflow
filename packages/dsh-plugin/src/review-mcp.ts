/**
 * MCP server (stdio, newline-delimited JSON-RPC) that an ACP agent starts for an A2A session: the hand-back of a
 * taken-over session, and the executor's ticket tools. It holds no authority of its own: each call is forwarded to
 * the DSH host bound to this session.
 */
import { createInterface } from 'node:readline';
import { SUBMIT_DESCRIPTION, SUBMIT_TOOL, SUMMARY_DESCRIPTION } from './review.js';
import { HANDOFF_TOOLS } from './handoff-spec.js';
import { ROLE_RULES_TOOL, roleRulesArguments } from './role-rules-spec.js';
import { TICKET_TOOLS } from './ticket-spec.js';

const url = process.env.ONEAGENTS_REVIEW_URL, ticketUrl = process.env.ONEAGENTS_TICKET_URL, handoffUrl = process.env.ONEAGENTS_HANDOFF_URL, roleRulesUrl = process.env.ONEAGENTS_ROLE_RULES_URL, session = process.env.ONEAGENTS_REVIEW_SESSION, token = process.env.ONEAGENTS_REVIEW_TOKEN;
const defaultHost = process.env.ONEAGENTS_SESSION_HOST?.trim() || 'dsh-local';
const origin = process.env.ONEAGENTS_DSH_ORIGIN ?? '';
const identity = { sessionId: session ?? '', defaultHost, origin };
const tools = [{ name: 'session_identity', description: '只读返回当前 ACP 会话身份：sessionId、默认宿主 defaultHost、以及 DSH origin。不返回任何凭据。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: SUBMIT_TOOL, description: SUBMIT_DESCRIPTION,
  inputSchema: { type: 'object', properties: { summary: { type: 'string', description: SUMMARY_DESCRIPTION } }, required: ['summary'], additionalProperties: false } },
  ...(ticketUrl ? TICKET_TOOLS.map(spec => ({ name: spec.name, description: spec.description,
    inputSchema: { type: 'object', properties: spec.parameters, required: Object.keys(spec.parameters), additionalProperties: false } })) : []),
  ...(handoffUrl ? HANDOFF_TOOLS.map(spec => ({ name: spec.name, description: spec.description,
    inputSchema: { type: 'object', properties: spec.parameters, required: Object.keys(spec.parameters), additionalProperties: false } })) : []),
  ...(roleRulesUrl ? [{ name: ROLE_RULES_TOOL.name, description: ROLE_RULES_TOOL.description,
    inputSchema: { type: 'object', properties: ROLE_RULES_TOOL.parameters, required: [...ROLE_RULES_TOOL.required], additionalProperties: false } }] : [])];

const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function postJson(target: string, body: unknown): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  if (!session || !token) return { content: [{ type: 'text', text: 'This MCP server was started without its DSH session binding' }], isError: true };
  try {
    const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Oneagents-Session': session },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const parsed = await response.json() as { text?: string; error?: string };
    return response.ok ? { content: [{ type: 'text', text: parsed.text ?? '' }] } : { content: [{ type: 'text', text: parsed.error ?? `HTTP ${response.status}` }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: `DSH host unreachable: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

async function call(name: string, args: unknown): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  if (name === 'session_identity') return { content: [{ type: 'text', text: JSON.stringify(identity) }] };
  const summary = (args as { summary?: unknown } | undefined)?.summary;
  if (name === SUBMIT_TOOL && (typeof summary !== 'string' || !summary.trim())) return { content: [{ type: 'text', text: 'summary is required' }], isError: true };
  if (name === ROLE_RULES_TOOL.name) {
    const parsed = roleRulesArguments(args);
    if ('error' in parsed) return { content: [{ type: 'text', text: parsed.error }], isError: true };
    if (!roleRulesUrl) return { content: [{ type: 'text', text: 'This MCP server was started without its DSH session binding' }], isError: true };
    return postJson(roleRulesUrl, { tool: name, arguments: parsed.value });
  }
  const handoff = HANDOFF_TOOLS.some(spec => spec.name === name);
  const target = name === SUBMIT_TOOL ? url : handoff ? handoffUrl : ticketUrl;
  if (!target) return { content: [{ type: 'text', text: 'This MCP server was started without its DSH session binding' }], isError: true };
  return postJson(target, name === SUBMIT_TOOL ? { summary } : { tool: name, arguments: args ?? {} });
}

createInterface({ input: process.stdin }).on('line', line => {
  let message: { id?: string | number; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } };
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications
  const result = (value: unknown) => write({ jsonrpc: '2.0', id, result: value });
  if (method === 'initialize') return result({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oneagents-review', version: '1.0.0' } });
  if (method === 'ping') return result({});
  if (method === 'tools/list') return result({ tools });
  if (method === 'tools/call') {
    if (!tools.some(tool => tool.name === params?.name)) return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
    return void call(params!.name!, params!.arguments).then(result);
  }
  write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});
