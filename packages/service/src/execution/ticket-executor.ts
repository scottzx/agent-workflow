/**
 * The executor's three ticket operations and the text the agent reads back, shared by the three ways an executor
 * reaches its ticket: DSH's native tools, the MCP server DSH offers ACP agents (Grok, Codex), and the
 * `acp-service ticket` CLI in the executor's own shell. Each caller says which it is; the gateway records it.
 */
export type ExecutorTicketTool = 'ticket_show' | 'ticket_mark' | 'ticket_submit';
export type ExecutorTicketChannel = 'dsh' | 'mcp' | 'cli';
/** The tools name the running attempt and session; the CLI names only the job. */
export type ExecutorTicketScope = { jobId: string; attemptId: string; sessionId: string } | { jobId: string };
export interface ExecutorTicketArgs { id?: string; state?: string; note?: string }

interface TicketView {
  status: string; round: number;
  items: { id: string; severity: string; where: string; problem: string; suggestion?: string; evidence?: unknown[]; state: string; log: { by: string; action: string; note?: string }[] }[];
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

/** Runs one operation; a rule the gateway enforces comes back as text for the agent, marked refused. */
export async function runExecutorTicket(invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  scope: ExecutorTicketScope, via: ExecutorTicketChannel, tool: ExecutorTicketTool, args: ExecutorTicketArgs = {}): Promise<{ text: string; refused?: true }> {
  const params = { ...scope, via, ...(tool === 'ticket_mark' ? { itemId: args.id, state: args.state, note: args.note } : {}) };
  let ticket: TicketView;
  try { ticket = await invoke(tool, params) as TicketView; }
  catch (error) { return { text: `任务单操作被拒绝：${error instanceof Error ? error.message : String(error)}`, refused: true }; }
  if (tool === 'ticket_show') return { text: pendingText(ticket) };
  if (tool === 'ticket_mark') return { text: `${args.id} 已标为 ${args.state}，还剩 ${pending(ticket).length} 条待处理。` };
  return { text: `任务单已提交（第 ${ticket.round} 轮），等待宿主检查。` };
}
