/**
 * The executor's tools for its task ticket, which lives in the gateway's execution ledger on the executor's job.
 * Each call resolves the calling session to the job and attempt it is running, as bound by the A2A executor from the
 * gateway's own dispatch metadata, so the system decides whose ticket it is and that the caller acts as its executor.
 * The gateway re-checks that the attempt is current and unfinished and, once the host reported it, that it runs in
 * this session; it cannot tell this plugin from another local caller holding the same IDs (not defended in the MVP).
 */
import { currentA2AExecution, runExecutorTicket, type ExecutorTicketArgs } from '@1agents/acp-service/a2a';
import { TICKET_TOOLS, type TicketTool } from './ticket-spec.js';
import { defineTool } from '@deepseek-ai/dsh-tools';

export interface TicketGateway { invoke(method: string, params: Record<string, unknown>): Promise<unknown> }
export type { TicketTool };

/** The gateway's /invoke route on the workbench origin this host is configured with. */
export function createTicketGateway(options: { url: string; token?: string }): TicketGateway {
  const endpoint = new URL('/invoke', new URL(options.url).origin);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.token?.trim() ? { Authorization: `Bearer ${options.token}` } : {}) };
  return {
    async invoke(method, params) {
      const response = await fetch(endpoint, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(10_000), body: JSON.stringify({ method, params }) });
      const body = await response.json().catch(() => ({})) as { error?: unknown };
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `网关返回 ${response.status}`);
      return body;
    },
  };
}

/** Runs one tool for a session; a rule the gateway enforces comes back as text for the agent. */
export async function runTicketTool(gateway: TicketGateway, sessionId: string, tool: TicketTool, args: ExecutorTicketArgs = {}, via: 'dsh' | 'mcp' = 'dsh'): Promise<string> {
  const execution = currentA2AExecution(sessionId);
  if (!execution) throw new Error('本会话不是正在执行的 A2A 任务会话，没有任务单。');
  return (await runExecutorTicket((method, params) => gateway.invoke(method, params), { jobId: execution.jobId, attemptId: execution.attemptId, sessionId }, via, tool, args)).text;
}

const output = { schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true } } },
  render: (_args: unknown, value: { message: string }) => [{ type: 'text' as const, text: value.message }] } as const;

export function ticketTools(gateway: TicketGateway) {
  return TICKET_TOOLS.map(spec => defineTool({ name: spec.name, description: spec.description, output,
    // Every parameter is required in DSH's own schema form.
    parameters: Object.fromEntries(Object.entries(spec.parameters).map(([key, value]) => [key, { ...value, required: true }])),
    execute: (args: ExecutorTicketArgs, exec: { agent?: { id: string } }) => {
      if (!exec.agent) throw new Error(`${spec.name} requires an owning agent session`);
      return runTicketTool(gateway, exec.agent.id, spec.name, args).then(message => ({ message }));
    } }));
}
