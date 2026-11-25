/**
 * The executor's ticket operations and the text the agent reads back, shared by the three ways an executor
 * reaches its ticket: DSH's native tools, the MCP server DSH offers ACP agents (Grok, Codex), and the
 * `acp-service ticket` CLI in the executor's own shell. Each caller says which it is; the gateway records it.
 */
export type ExecutorTicketTool = 'ticket_show' | 'ticket_mark' | 'ticket_submit' | 'ticket_self_check';
export type ExecutorTicketChannel = 'dsh' | 'mcp' | 'cli';
/** The tools name the running attempt and session; the CLI names only the job. */
export type ExecutorTicketScope = { jobId: string; attemptId: string; sessionId: string } | { jobId: string };
export interface ExecutorTicketArgs { id?: string; state?: string; status?: string; note?: string }

interface TicketView {
  status: string; round: number;
  selfChecks?: { id: string; severity: string; rule: string; state: string; note?: string }[];
  items: { id: string; severity: string; where: string; problem: string; suggestion?: string; evidence?: unknown[]; state: string;
    log: { by: string; action: string; note?: string }[];
    crossCheck?: { kind: string; claimedState: string; claimedNote?: string; actualVerdict: string; actualNote?: string } }[];
}

const pending = (ticket: TicketView) => ticket.items.filter(item => item.state === 'open' || item.state === 'reopened');

function pendingText(ticket: TicketView): string {
  const checks = ticket.selfChecks ?? [];
  const pendingChecks = checks.filter(check => check.state === 'pending');
  const checkLines = checks.map(check => `${check.id} [${check.severity === 'must' ? '必填' : '建议'}] ${check.state}：${check.rule}${check.note ? `\n  依据：${check.note}` : ''}`);
  const items = pending(ticket);
  const itemLines = items.flatMap(item => {
    const last = item.state === 'reopened' ? item.log.filter(entry => entry.note).at(-1) : undefined;
    const finding = item.crossCheck;
    return [`${item.id} [${item.severity === 'must' ? '必须改' : '建议改'}] ${item.where}：${item.problem}`,
      ...(item.suggestion ? [`  建议：${item.suggestion}`] : []),
      ...(item.evidence?.length ? [`  证据：${JSON.stringify(item.evidence)}`] : []),
      ...(finding ? [`  对校分歧 ${finding.kind}：自检 ${finding.claimedState}${finding.claimedNote ? `（${finding.claimedNote}）` : ''}，实际 ${finding.actualVerdict}${finding.actualNote ? `（${finding.actualNote}）` : ''}`] : []),
      ...(last ? [`  上一次：${last.by} ${last.action}：${last.note}`] : [])];
  });
  return [
    `预置自检清单（待打卡 ${pendingChecks.length} 条 / 已完成 ${checks.length - pendingChecks.length} 条）`,
    ...checkLines,
    `待处理修改意见（共 ${items.length} 条）`,
    ...itemLines,
    `待处理 ${items.length} 条，任务单状态 ${ticket.status}，第 ${ticket.round} 轮`,
  ].join('\n');
}

/** Runs one operation; a rule the gateway enforces comes back as text for the agent, marked refused. */
export async function runExecutorTicket(invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  scope: ExecutorTicketScope, via: ExecutorTicketChannel, tool: ExecutorTicketTool, args: ExecutorTicketArgs = {}): Promise<{ text: string; refused?: true }> {
  const extra = tool === 'ticket_mark' ? { itemId: args.id, state: args.state, note: args.note }
    : tool === 'ticket_self_check' ? { checkId: args.id, status: args.status, note: args.note } : {};
  const params = { ...scope, via, ...extra };
  let ticket: TicketView;
  try { ticket = await invoke(tool, params) as TicketView; }
  catch (error) { return { text: `任务单操作被拒绝：${error instanceof Error ? error.message : String(error)}`, refused: true }; }
  if (tool === 'ticket_show') return { text: pendingText(ticket) };
  if (tool === 'ticket_mark') return { text: `${args.id} 已标为 ${args.state}，还剩 ${pending(ticket).length} 条待处理。` };
  if (tool === 'ticket_self_check') {
    const left = (ticket.selfChecks ?? []).filter(check => check.severity === 'must' && check.state === 'pending');
    return { text: `${args.id} 已自检为 ${args.status}，还剩 ${left.length} 条必填自检待完成。` };
  }
  return { text: `任务单已提交（第 ${ticket.round} 轮），等待宿主检查。` };
}
