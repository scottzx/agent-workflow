/**
 * The task ticket: one file in the work directory that the executor, QA and the host's checks all work against,
 * so every issue, how it was handled and who confirmed it stays on record. The host owns the structure. The
 * executor marks items done or disputed and submits through checks/ticket.py; QA reports through its review
 * file and the host merges it; failed program checks become items that the host verifies by re-running them.
 */
import type { CheckResult, QualityReview } from './outline-run.js';

export type ItemState = 'open' | 'done' | 'disputed' | 'verified' | 'reopened' | 'withdrawn';
export type TicketStatus = 'drafting' | 'in_revision' | 'ready_for_review' | 'in_review' | 'closed' | 'stopped';
export interface TicketLog { round: number; by: 'executor' | 'qa' | 'host'; action: string; note?: string }
export interface TicketItem {
  id: string; source: 'qa' | 'program'; raisedInRound: number; severity: 'must' | 'should'; where: string; problem: string;
  suggestion?: string; checkId?: string; evidence?: unknown[]; state: ItemState; log: TicketLog[];
}
export interface TicketProposal { id: string; kind: string; text: string; raisedInRound: number; state: 'open' | 'accepted' | 'rejected' | 'done' }
export interface Ticket {
  schemaVersion: 1; roleId: string; caseId: string; outline: 'outline.json'; status: TicketStatus;
  /** The executor round now under way; executor log entries carry it. */
  round: number; stopReason?: string;
  items: TicketItem[]; proposals: TicketProposal[];
  history: { round: number; by: 'executor' | 'qa' | 'host'; action: string; verdict?: string; scores?: Record<string, number>; summary?: string; note?: string }[];
}

const PENDING: ItemState[] = ['open', 'reopened'];
export const pendingItems = (ticket: Ticket) => ticket.items.filter(item => PENDING.includes(item.state));
/** Must-fix items nobody has confirmed as settled. */
export const unsettledMust = (ticket: Ticket) => ticket.items.filter(item => item.severity === 'must' && item.state !== 'verified' && item.state !== 'withdrawn');

export function newTicket(roleId: string, caseId: string): Ticket {
  return { schemaVersion: 1, roleId, caseId, outline: 'outline.json', status: 'drafting', round: 1, items: [], proposals: [], history: [] };
}

/** Failed checks become or reopen program items; program items whose check now passes are verified. */
export function applyChecks(ticket: Ticket, round: number, results: CheckResult[]): void {
  for (const result of results) {
    const item = ticket.items.find(entry => entry.source === 'program' && entry.checkId === result.itemId && entry.state !== 'verified');
    if (result.pass) {
      if (item) { item.state = 'verified'; item.log.push({ round, by: 'host', action: 'verified', note: `${result.itemId} 通过` }); }
    } else if (item) {
      item.evidence = result.evidence;
      if (item.state !== 'open') { item.state = 'reopened'; item.log.push({ round, by: 'host', action: 'reopened', note: `${result.itemId} 仍未通过` }); }
    } else {
      const where = (result.evidence[0] as { path?: unknown } | undefined)?.path;
      ticket.items.push({ id: `P${round}-${result.itemId}`, source: 'program', raisedInRound: round, severity: 'must',
        where: typeof where === 'string' ? where : result.itemId, problem: `程序检查 ${result.itemId} 未通过`, checkId: result.itemId,
        evidence: result.evidence, state: 'open', log: [{ round, by: 'host', action: 'raised' }] });
    }
  }
}

const settle = { fixed: 'verified', partly: 'reopened', not_fixed: 'reopened', withdrawn: 'withdrawn' } as const;

/** QA's verdicts on handled items, its new issues and its proposals, merged into the ticket. */
export function applyReview(ticket: Ticket, round: number, review: QualityReview): void {
  for (const entry of review.previous ?? []) {
    const item = ticket.items.find(candidate => candidate.id === entry.id && candidate.source === 'qa');
    if (!item || item.state === 'verified' || item.state === 'withdrawn') continue;
    item.state = settle[entry.status];
    item.log.push({ round, by: 'qa', action: entry.status, ...(entry.note ? { note: entry.note } : {}) });
  }
  review.issues.forEach((issue, index) => ticket.items.push({ id: `Q${round}-${index + 1}`, source: 'qa', raisedInRound: round, severity: issue.severity,
    where: issue.where, problem: issue.problem, suggestion: issue.suggestion, state: 'open', log: [{ round, by: 'qa', action: 'raised' }] }));
  (review.proposals ?? []).forEach((proposal, index) => ticket.proposals.push({ id: `R${round}-${index + 1}`, kind: proposal.kind, text: proposal.text,
    raisedInRound: round, state: 'open' }));
  ticket.history.push({ round, by: 'qa', action: 'reviewed', verdict: review.verdict, scores: review.scores, summary: review.summary });
}

/**
 * What the executor did to the ticket since `before`. Illegal changes are anything beyond marking pending items
 * done or disputed with a note in this round and submitting; incomplete means it never submitted.
 */
export function executorChanges(before: Ticket, raw: string): { illegal: string[]; incomplete: string[]; after?: Ticket } {
  let after: Ticket;
  try { after = JSON.parse(raw) as Ticket; } catch { return { illegal: ['ticket.json 不是可读的 JSON'], incomplete: [] }; }
  const illegal: string[] = [], same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const { items: beforeItems, history: beforeHistory, status: beforeStatus, ...beforeRest } = before;
  const { items: afterItems, history: afterHistory, status: afterStatus, ...afterRest } = after ?? {} as Ticket;
  if (!same(beforeRest, afterRest)) illegal.push('改动了任务单的编号、轮次或提议');
  if (!Array.isArray(afterItems) || !same(beforeItems.map(i => i.id), afterItems.map(i => i?.id))) illegal.push('增删或调换了意见');
  else beforeItems.forEach((item, index) => {
    const next = afterItems[index]!;
    const { state, log, ...fields } = item, { state: nextState, log: nextLog, ...nextFields } = next;
    if (!same(fields, nextFields)) illegal.push(`${item.id}：只能改状态和写说明，不能改意见本身`);
    else if (state === nextState) { if (!same(log, nextLog)) illegal.push(`${item.id}：没改状态却改了记录`); }
    else {
      const added = Array.isArray(nextLog) ? nextLog.at(-1) : undefined;
      const legal = PENDING.includes(state) && (nextState === 'done' || nextState === 'disputed') && Array.isArray(nextLog)
        && same(nextLog.slice(0, -1), log) && nextLog.length === log.length + 1 && added?.by === 'executor' && added.action === nextState
        && added.round === before.round && typeof added.note === 'string' && added.note.trim() !== '';
      if (!legal) illegal.push(`${item.id}：执行者只能把 open 或 reopened 的意见标为 done 或 disputed，并写明说明`);
    }
  });
  const submitted = { round: before.round, by: 'executor', action: 'submitted' };
  if (!Array.isArray(afterHistory) || !same(afterHistory.slice(0, beforeHistory.length), beforeHistory)
    || afterHistory.length > beforeHistory.length + 1 || (afterHistory.length > beforeHistory.length && !same(afterHistory.at(-1), submitted))) illegal.push('改动了任务单的历史记录');
  const isSubmitted = afterStatus === 'ready_for_review' && afterHistory?.length === beforeHistory.length + 1;
  if (afterStatus !== beforeStatus && !isSubmitted) illegal.push(`任务单状态只能由执行者提交为 ready_for_review，不能改成 ${String(afterStatus)}`);
  if (illegal.length) return { illegal, incomplete: [] };
  const incomplete = isSubmitted ? [] : [`还没有提交任务单（待处理 ${pendingItems(after).map(item => item.id).join('、') || '0 条'}）`];
  return { illegal, incomplete, after };
}
