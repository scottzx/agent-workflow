/**
 * MCP server (stdio, newline-delimited JSON-RPC) that an ACP agent starts for an A2A session: the hand-back of a
 * taken-over session, and the executor's ticket tools. It holds no authority of its own: each call is forwarded to
 * the DSH host bound to this session.
 */
import { createInterface } from 'node:readline';
import { SUBMIT_DESCRIPTION, SUBMIT_TOOL, SUMMARY_DESCRIPTION } from './review.js';
import { TICKET_TOOLS } from './ticket-spec.js';

const url = process.env.ONEAGENTS_REVIEW_URL, ticketUrl = process.env.ONEAGENTS_TICKET_URL, session = process.env.ONEAGENTS_REVIEW_SESSION, token = process.env.ONEAGENTS_REVIEW_TOKEN;
const tools = [{ name: SUBMIT_TOOL, description: SUBMIT_DESCRIPTION,
  inputSchema: { type: 'object', properties: { summary: { type: 'string', description: SUMMARY_DESCRIPTION } }, required: ['summary'], additionalProperties: false } },
  ...(ticketUrl ? TICKET_TOOLS.map(spec => ({ name: spec.name, description: spec.description,
    inputSchema: { type: 'object', properties: spec.parameters, required: Object.keys(spec.parameters), additionalProperties: false } })) : [])];

const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function call(name: string, args: unknown): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const summary = (args as { summary?: unknown } | undefined)?.summary;
  if (name === SUBMIT_TOOL && (typeof summary !== 'string' || !summary.trim())) return { content: [{ type: 'text', text: 'summary is required' }], isError: true };
  const target = name === SUBMIT_TOOL ? url : ticketUrl;
  if (!target || !session || !token) return { content: [{ type: 'text', text: 'This MCP server was started without its DSH session binding' }], isError: true };
  try {
    const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Oneagents-Session': session },
      body: JSON.stringify(name === SUBMIT_TOOL ? { summary } : { tool: name, arguments: args ?? {} }), signal: AbortSignal.timeout(120_000) });
    const body = await response.json() as { text?: string; error?: string };
    return response.ok ? { content: [{ type: 'text', text: body.text ?? '' }] } : { content: [{ type: 'text', text: body.error ?? `HTTP ${response.status}` }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: `DSH host unreachable: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  let message: { id?: string | number; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } };
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications
  const result = (value: unknown) => write({ jsonrpc: '2.0', id, result: value });
  if (method === 'initialize') return result({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: '1agents-review', version: '1.0.0' } });
  if (method === 'ping') return result({});
  if (method === 'tools/list') return result({ tools });
  if (method === 'tools/call') {
    if (!tools.some(tool => tool.name === params?.name)) return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
    return void call(params!.name!, params!.arguments).then(result);
  }
  write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});
