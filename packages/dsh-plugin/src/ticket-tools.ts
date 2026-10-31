/**
 * The executor's tools for its task ticket, which lives in the gateway's execution ledger on the executor's job.
 * Each call resolves the calling session to the job and attempt it is running, as bound by the A2A executor from the
 * gateway's own dispatch metadata, so the system decides whose ticket it is and that the caller acts as its executor.
 * The gateway re-checks that the attempt is current and unfinished and, once the host reported it, that it runs in
 * this session; it cannot tell this plugin from another local caller holding the same IDs (not defended in the MVP).
 */
import { currentA2AExecution } from '@1agents/acp-service/a2a';
import { defineTool } from '@deepseek-ai/dsh-tools';

interface TicketView {
  status: string; round: number;
  items: { id: string; severity: string; where: string; problem: string; suggestion?: string; evidence?: unknown[]; state: string; log: { by: string; action: string; note?: string }[] }[];
}
export interface TicketGateway { invoke(method: string, params: Record<string, unknown>): Promise<unknown> }
export type TicketTool = 'ticket_show' | 'ticket_mark' | 'ticket_submit';

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

const pending = (ticket: TicketView) => ticket.items.filter(item => item.state === 'open' || item.state === 'reopened');

function pendingText(ticket: TicketView): string {
  const lines = pending(ticket).flatMap(item => {
    const last = item.state === 'reopened' ? item.log.filter(entry => entry.note).at(-1) : undefined;
    return [`${item.id} [${item.severity === 'must' ? '必须改' : '建议改'}] ${item.where}：${item.problem}`,
      ...(item.suggestion ? [`  建议：${item.suggestion}`] : []),
      ...(item.evidence?.length ? [`  证据：${JSON.stringify(item.evidence)}`] : []),
      ...(last ? [`  上一次：${last.by} ${last.action}：${last.note}`] : [])];
  });
  return [...lines, `待处理 ${pending(ticket).length} 条，任务单状态 ${ticket.status}，第 ${ticket.round} 轮`].join('\n');
}

/** Runs one tool for a session; a rule the gateway enforces comes back as text for the agent. */
export async function runTicketTool(gateway: TicketGateway, sessionId: string, tool: TicketTool, args: { id?: string; state?: string; note?: string } = {}): Promise<string> {
  const execution = currentA2AExecution(sessionId);
  if (!execution) throw new Error('本会话不是正在执行的 A2A 任务会话，没有任务单。');
  const scope = { jobId: execution.jobId, attemptId: execution.attemptId, sessionId };
  let ticket: TicketView;
  try {
    ticket = await gateway.invoke(tool, tool === 'ticket_mark' ? { ...scope, itemId: args.id, state: args.state, note: args.note } : scope) as TicketView;
  } catch (error) { return `任务单操作被拒绝：${error instanceof Error ? error.message : String(error)}`; }
  if (tool === 'ticket_show') return pendingText(ticket);
  if (tool === 'ticket_mark') return `${args.id} 已标为 ${args.state}，还剩 ${pending(ticket).length} 条待处理。`;
  return `任务单已提交（第 ${ticket.round} 轮），等待宿主检查。`;
}

const output = { schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true } } },
  render: (_args: unknown, value: { message: string }) => [{ type: 'text' as const, text: value.message }] } as const;

export function ticketTools(gateway: TicketGateway) {
  const run = (tool: TicketTool, exec: { agent?: { id: string } }, args?: { id?: string; state?: string; note?: string }) => {
    if (!exec.agent) throw new Error(`${tool} requires an owning agent session`);
    return runTicketTool(gateway, exec.agent.id, tool, args).then(message => ({ message }));
  };
  return [
    defineTool({ name: 'ticket_show', description: '查看本会话 A2A 任务的任务单上待处理的意见：编号、轻重、位置、问题、建议、证据，以及重开意见上一次的说明。', parameters: {}, output,
      execute: (_args, exec) => run('ticket_show', exec) }),
    defineTool({ name: 'ticket_mark', description: '把任务单上一条 open 或 reopened 的意见标为 done（已改）或 disputed（不同意），并写说明。只在被打回修改时可用。',
      parameters: { id: { type: 'string', required: true, description: '意见编号，如 P1-P2、Q1-3。' },
        state: { type: 'string', enum: ['done', 'disputed'], required: true, description: 'done：已改；disputed：不同意。' },
        note: { type: 'string', required: true, description: '怎么改的（改了哪一页、改成了什么），或者不同意的理由和依据的文件。' } },
      output, execute: (args, exec) => run('ticket_mark', exec, args) }),
    defineTool({ name: 'ticket_submit', description: '任务单上的意见全部处理完后提交，交给宿主检查。还有待处理的意见时会被拒绝。', parameters: {}, output,
      execute: (_args, exec) => run('ticket_submit', exec) }),
  ];
}
