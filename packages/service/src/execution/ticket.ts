/**
 * The task ticket on an executor's job: every issue sent back, how the executor handled it and who confirmed it.
 * The ledger keeps it with the job; each operation here belongs to one actor and returns the changes it made,
 * which the ledger appends as `ticket.*` events, so who did what is recorded by the system rather than declared.
 * Failed program checks become items the host verifies by re-running them; the host merges QA's review.
 * When the ticket names an export path, every change also rewrites that read-only copy for people to read.
 */
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { JobLedger } from './ledger.js';

export const checkResultSchema = z.object({ itemId: z.string(), pass: z.boolean(), evidence: z.array(z.unknown()) }).strict();
export const qualityReviewSchema = z.object({
  verdict: z.enum(['pass', 'revise']),
  summary: z.string().trim().min(1).max(4000),
  scores: z.record(z.string(), z.number().int().min(1).max(5)),
  issues: z.array(z.object({ where: z.string().trim().min(1).max(300), problem: z.string().trim().min(1).max(2000),
    suggestion: z.string().trim().min(1).max(2000), severity: z.enum(['must', 'should']) }).strict()).max(30),
  /** On a re-review: QA's verdict on each ticket item the executor handled, by item id. */
  previous: z.array(z.object({ id: z.string().trim().min(1).max(40), status: z.enum(['fixed', 'partly', 'not_fixed', 'withdrawn']),
    note: z.string().trim().max(2000).optional() }).strict()).max(30).optional(),
  /** Changes to the role itself: a program check, the executor's or QA's instructions, or a locked item only a person can change. */
  proposals: z.array(z.object({ kind: z.enum(['check', 'role', 'qa', 'locked']), text: z.string().trim().min(1).max(2000) }).strict()).max(10).optional(),
}).passthrough().refine(review => review.verdict === 'pass' || review.issues.length > 0, { message: 'A revise verdict needs at least one issue' });
export type CheckResult = z.infer<typeof checkResultSchema>;
export type QualityReview = z.infer<typeof qualityReviewSchema>;

export type TicketActor = 'executor' | 'qa' | 'host' | 'person' | 'coach';
/** Who settled a proposal: a person, or a coach agent identified by the harness session it runs in. */
export interface ProposalSettler { kind: 'person' | 'coach'; agent?: string; sessionId?: string }
export type ItemState = 'open' | 'done' | 'disputed' | 'verified' | 'reopened' | 'withdrawn';
export type TicketStatus = 'drafting' | 'in_revision' | 'ready_for_review' | 'in_review' | 'closed' | 'stopped';
export interface TicketLog { round: number; by: TicketActor; action: string; note?: string }
export interface TicketItem {
  id: string; source: 'qa' | 'program'; raisedInRound: number; severity: 'must' | 'should'; where: string; problem: string;
  suggestion?: string; checkId?: string; evidence?: unknown[]; state: ItemState; log: TicketLog[];
}
export interface TicketProposal {
  id: string; kind: NonNullable<QualityReview['proposals']>[number]['kind']; text: string; raisedInRound: number;
  state: 'open' | 'accepted' | 'rejected' | 'done'; note?: string; by?: ProposalSettler;
}
export interface Ticket {
  schemaVersion: 1; roleId: string; caseId: string; outline: 'outline.json'; status: TicketStatus;
  /** The executor round now under way; executor log entries carry it. */
  round: number; stopReason?: string;
  /** The read-only copy rewritten on every change, usually <work>/ticket.json. */
  exportPath?: string;
  items: TicketItem[]; proposals: TicketProposal[];
  history: { round: number; by: TicketActor; action: string; verdict?: string; scores?: Record<string, number>; summary?: string; note?: string }[];
}
/** One change, appended to the ledger as an event of this type. */
export interface TicketChange { type: `ticket.${string}`; data: { actor: TicketActor; round: number; itemId?: string; note?: string; [key: string]: unknown } }
/** An operation the ticket's rules do not allow; the message is for the agent or person who asked. */
export class TicketError extends Error {}

const fail = (message: string): never => { throw new TicketError(message); };
const PENDING: ItemState[] = ['open', 'reopened'];
export const pendingItems = (ticket: Ticket) => ticket.items.filter(item => PENDING.includes(item.state));
/** Must-fix items nobody has confirmed as settled. */
export const unsettledMust = (ticket: Ticket) => ticket.items.filter(item => item.severity === 'must' && item.state !== 'verified' && item.state !== 'withdrawn');
const isFinal = (ticket: Ticket) => ticket.status === 'closed' || ticket.status === 'stopped';
const expect = (ticket: Ticket, allowed: TicketStatus[], what: string) => {
  if (!allowed.includes(ticket.status)) fail(`任务单状态是 ${ticket.status}，${what}`);
};

export function openTicket(roleId: string, caseId: string, exportPath?: string): { ticket: Ticket; changes: TicketChange[] } {
  return { ticket: { schemaVersion: 1, roleId, caseId, outline: 'outline.json', status: 'drafting', round: 1, ...(exportPath ? { exportPath } : {}),
    items: [], proposals: [], history: [] },
    changes: [{ type: 'ticket.opened', data: { actor: 'host', round: 1, roleId, caseId } }] };
}

/** Host: failed checks become or reopen program items, items whose check now passes are verified; all passing moves the ticket to review. */
export function applyChecks(ticket: Ticket, results: CheckResult[]): TicketChange[] {
  expect(ticket, ['drafting', 'ready_for_review'], '只有执行者交稿后才能合并程序检查');
  const round = ticket.round, changes: TicketChange[] = [];
  const settle = (item: TicketItem, state: ItemState, note: string) => {
    item.state = state; item.log.push({ round, by: 'host', action: state, note });
    changes.push({ type: 'ticket.item_settled', data: { actor: 'host', round, itemId: item.id, state, note } });
  };
  for (const result of results) {
    const item = ticket.items.find(entry => entry.source === 'program' && entry.checkId === result.itemId && entry.state !== 'verified');
    if (result.pass) { if (item) settle(item, 'verified', `${result.itemId} 通过`); }
    else if (item) {
      item.evidence = result.evidence;
      if (item.state !== 'open') settle(item, 'reopened', `${result.itemId} 仍未通过`);
    } else {
      const where = (result.evidence[0] as { path?: unknown } | undefined)?.path;
      const raised: TicketItem = { id: `P${round}-${result.itemId}`, source: 'program', raisedInRound: round, severity: 'must',
        where: typeof where === 'string' ? where : result.itemId, problem: `程序检查 ${result.itemId} 未通过`, checkId: result.itemId,
        evidence: result.evidence, state: 'open', log: [{ round, by: 'host', action: 'raised' }] };
      ticket.items.push(raised);
      changes.push({ type: 'ticket.item_raised', data: { actor: 'host', round, itemId: raised.id, source: 'program', severity: 'must', where: raised.where, problem: raised.problem } });
    }
  }
  const failed = results.filter(result => !result.pass).map(result => result.itemId);
  if (!failed.length) ticket.status = 'in_review';
  changes.push({ type: 'ticket.checked', data: { actor: 'host', round, passed: !failed.length, failed, status: ticket.status } });
  return changes;
}

const verdicts = { fixed: 'verified', partly: 'reopened', not_fixed: 'reopened', withdrawn: 'withdrawn' } as const;

/** Host, on QA's behalf: QA's verdicts on handled items, its new issues and its proposals, merged into the ticket. */
export function applyReview(ticket: Ticket, review: QualityReview, qaJobId?: string): TicketChange[] {
  expect(ticket, ['in_review'], '只有程序检查通过后才能合并质检意见');
  const round = ticket.round, changes: TicketChange[] = [], qa = qaJobId ? { qaJobId } : {};
  for (const entry of review.previous ?? []) {
    const item = ticket.items.find(candidate => candidate.id === entry.id && candidate.source === 'qa');
    if (!item || item.state === 'verified' || item.state === 'withdrawn') continue;
    item.state = verdicts[entry.status];
    item.log.push({ round, by: 'qa', action: entry.status, ...(entry.note ? { note: entry.note } : {}) });
    changes.push({ type: 'ticket.item_settled', data: { actor: 'qa', round, itemId: item.id, state: item.state, verdict: entry.status, ...(entry.note ? { note: entry.note } : {}), ...qa } });
  }
  review.issues.forEach((issue, index) => {
    const id = `Q${round}-${index + 1}`;
    ticket.items.push({ id, source: 'qa', raisedInRound: round, severity: issue.severity, where: issue.where, problem: issue.problem,
      suggestion: issue.suggestion, state: 'open', log: [{ round, by: 'qa', action: 'raised' }] });
    changes.push({ type: 'ticket.item_raised', data: { actor: 'qa', round, itemId: id, source: 'qa', severity: issue.severity, where: issue.where, problem: issue.problem, ...qa } });
  });
  // A proposal QA repeats word for word is already on the ticket.
  (review.proposals ?? []).forEach((proposal, index) => {
    if (ticket.proposals.some(known => known.kind === proposal.kind && known.text === proposal.text)) return;
    const id = `R${round}-${index + 1}`;
    ticket.proposals.push({ id, kind: proposal.kind, text: proposal.text, raisedInRound: round, state: 'open' });
    changes.push({ type: 'ticket.proposal_raised', data: { actor: 'qa', round, proposalId: id, kind: proposal.kind, text: proposal.text, ...qa } });
  });
  ticket.history.push({ round, by: 'qa', action: 'reviewed', verdict: review.verdict, scores: review.scores, summary: review.summary });
  changes.push({ type: 'ticket.reviewed', data: { actor: 'qa', round, verdict: review.verdict, scores: review.scores, summary: review.summary, ...qa } });
  return changes;
}

/** Host: the ticket goes back to the executor for the next round. */
export function startRevision(ticket: Ticket, note?: string): TicketChange[] {
  if (isFinal(ticket)) fail(`任务单已经 ${ticket.status}`);
  ticket.round++; ticket.status = 'in_revision';
  return [{ type: 'ticket.revision_started', data: { actor: 'host', round: ticket.round, ...(note ? { note } : {}) } }];
}

/** Executor: a pending item is done or disputed, with a note, in the current round. */
export function markItem(ticket: Ticket, itemId: string, state: string, note: string): TicketChange[] {
  expect(ticket, ['in_revision'], '现在不能修改');
  const item = ticket.items.find(entry => entry.id === itemId) ?? fail(`任务单上没有 ${itemId}`);
  if (!PENDING.includes(item.state)) fail(`${itemId} 已经是 ${item.state}，只能处理 open 或 reopened 的意见`);
  if (state !== 'done' && state !== 'disputed') fail('只能标为 done（已改）或 disputed（不同意）');
  const text = note.trim();
  if (!text) fail('说明不能为空：写清怎么改的，或者不同意的理由');
  item.state = state as ItemState;
  item.log.push({ round: ticket.round, by: 'executor', action: state, note: text });
  return [{ type: 'ticket.item_marked', data: { actor: 'executor', round: ticket.round, itemId, state, note: text } }];
}

/** Executor: everything is handled; the ticket is ready for the host's checks. */
export function submitTicket(ticket: Ticket): TicketChange[] {
  expect(ticket, ['in_revision'], '现在不能提交');
  const left = pendingItems(ticket);
  if (left.length) fail(`还有 ${left.length} 条没处理：${left.map(item => item.id).join('、')}`);
  ticket.status = 'ready_for_review';
  ticket.history.push({ round: ticket.round, by: 'executor', action: 'submitted' });
  return [{ type: 'ticket.submitted', data: { actor: 'executor', round: ticket.round } }];
}

/** Person or coach: what became of a proposal. Allowed after the run ends, which is when the coach reads them. */
export function setProposal(ticket: Ticket, proposalId: string, state: 'accepted' | 'rejected' | 'done', note?: string,
  by: ProposalSettler = { kind: 'person' }): TicketChange[] {
  const proposal = ticket.proposals.find(entry => entry.id === proposalId) ?? fail(`任务单上没有提议 ${proposalId}`);
  proposal.state = state; proposal.by = by;
  if (note) proposal.note = note;
  const { kind, ...who } = by;
  return [{ type: 'ticket.proposal_marked', data: { actor: kind, round: ticket.round, proposalId, state, ...(note ? { note } : {}), ...who } }];
}

/** The read-only copy; the ledger stays the record, so a copy that cannot be written does not undo the change. */
function writeExport(ticket: Ticket): void {
  if (!ticket.exportPath) return;
  try {
    rmSync(ticket.exportPath, { force: true });
    writeFileSync(ticket.exportPath, JSON.stringify(ticket, null, 2) + '\n', { mode: 0o444 });
  } catch { /* The next change, or ticket_get, has the current ticket. */ }
}

/** Host: the run is over, passed (closed) or not (stopped). */
export function closeTicket(ticket: Ticket, status: 'closed' | 'stopped', stopReason?: string): TicketChange[] {
  if (isFinal(ticket)) fail(`任务单已经 ${ticket.status}`);
  ticket.status = status;
  if (status === 'stopped' && stopReason) ticket.stopReason = stopReason;
  ticket.history.push({ round: ticket.round, by: 'host', action: status, ...(stopReason ? { note: stopReason } : {}) });
  return [{ type: `ticket.${status}`, data: { actor: 'host', round: ticket.round, ...(stopReason ? { note: stopReason } : {}) } }];
}

const id = z.string().trim().min(1).max(512);
const jobSchema = z.object({ originSessionId: id, jobId: id }).strict();
const openSchema = jobSchema.extend({ roleId: id, caseId: id,
  exportPath: z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && value.endsWith('.json'), 'exportPath must be an absolute .json path').optional() }).strict();
const settlerSchema = z.object({ kind: z.enum(['person', 'coach']), agent: id.optional(), sessionId: id.optional() }).strict()
  .refine(by => by.kind === 'coach' || (!by.agent && !by.sessionId), 'Only a coach names an agent session');
const checksSchema = jobSchema.extend({ results: z.array(checkResultSchema).max(200) }).strict();
const reviewSchema = jobSchema.extend({ review: qualityReviewSchema, qaJobId: id.optional() }).strict();
const reviseSchema = jobSchema.extend({ note: z.string().trim().max(2000).optional() }).strict();
const proposalSchema = jobSchema.extend({ proposalId: id, state: z.enum(['accepted', 'rejected', 'done']), note: z.string().trim().max(2000).optional(),
  by: settlerSchema.optional() }).strict();
const closeSchema = jobSchema.extend({ status: z.enum(['closed', 'stopped']), stopReason: id.optional() }).strict();
/** The executor names the attempt it is running and its session, never an origin or a role. */
const executorSchema = z.object({ jobId: id, attemptId: id, sessionId: id }).strict();
const markSchema = executorSchema.extend({ itemId: id, state: z.enum(['done', 'disputed']), note: z.string().max(4000) }).strict();

export const TICKET_METHODS = {
  ticket_get: { description: '读取执行者任务上的任务单（意见、状态、轮次、提议、历史）。每次改动都在 execution_events 里留有 ticket.* 事件。', parameters: z.toJSONSchema(jobSchema) },
  ticket_open: { description: '宿主：在执行者任务上开任务单，一个任务一张。exportPath 为只读导出的绝对路径，之后每次改动都会重写。', parameters: z.toJSONSchema(openSchema) },
  ticket_checks: { description: '宿主：执行者交稿后合并本轮程序检查结果。未通过的项成为或重开意见，通过的核实；全部通过则进入审阅。', parameters: z.toJSONSchema(checksSchema) },
  ticket_review: { description: '宿主：审阅中合并质检结果（previous 按意见编号 fixed/partly/not_fixed/withdrawn、新意见、去重后的提议），记录质检任务 qaJobId。质检自己不能改任务单。', parameters: z.toJSONSchema(reviewSchema) },
  ticket_revise: { description: '宿主：把任务单打回执行者，进入下一轮修改。', parameters: z.toJSONSchema(reviseSchema) },
  ticket_show: { description: '执行者：用正在执行的 jobId、attemptId 和 sessionId 读取自己的任务单。', parameters: z.toJSONSchema(executorSchema) },
  ticket_mark: { description: '执行者：修改中把本轮 open 或 reopened 的意见标为 done 或 disputed，必须写说明；只能由正在执行当前轮次的会话调用。', parameters: z.toJSONSchema(markSchema) },
  ticket_submit: { description: '执行者：没有待处理意见时提交任务单，等待宿主检查。', parameters: z.toJSONSchema(executorSchema) },
  ticket_proposal: { description: '人或教练：把一条提议标为 accepted、rejected 或 done，可写说明；运行结束后也可以。by 说明是人还是教练（教练写明所在的智能体会话），缺省为人。', parameters: z.toJSONSchema(proposalSchema) },
  ticket_close: { description: '宿主：运行结束时关单，通过为 closed，否则为 stopped 并写停止原因。', parameters: z.toJSONSchema(closeSchema) },
};

/**
 * The gateway's ticket methods. The method decides the actor: the host opens, merges checks and reviews, sends back
 * and closes; a person settles proposals; the executor shows, marks and submits. The executor's call names its
 * running attempt and session, and the ledger checks that the attempt is the job's current, unfinished one and,
 * once the host has reported which session runs it, that the session matches. Nothing here proves the call came
 * from that session's agent: the DSH plugin's tools resolve the session themselves, and this MVP does not defend
 * against a local caller that bypasses them with the right IDs.
 */
export function invokeTicket(ledger: JobLedger, method: string, params: unknown): Ticket {
  const change = (origin: string, jobId: string, operation: (ticket: Ticket) => TicketChange[], caller: Record<string, unknown> = {}) => {
    const ticket = ledger.changeTicket(origin, jobId, current => ({ ticket: current ?? fail('这个任务还没有任务单'), changes: operation(current!) }), caller);
    writeExport(ticket);
    return ticket;
  };
  switch (method) {
    case 'ticket_get': { const input = jobSchema.parse(params); return ledger.ticket(input.originSessionId, input.jobId); }
    case 'ticket_open': {
      const input = openSchema.parse(params);
      const ticket = ledger.changeTicket(input.originSessionId, input.jobId, current => current ? fail('这个任务已经有任务单') : openTicket(input.roleId, input.caseId, input.exportPath));
      writeExport(ticket);
      return ticket;
    }
    case 'ticket_checks': { const input = checksSchema.parse(params); return change(input.originSessionId, input.jobId, ticket => applyChecks(ticket, input.results)); }
    case 'ticket_review': { const input = reviewSchema.parse(params); return change(input.originSessionId, input.jobId, ticket => applyReview(ticket, input.review, input.qaJobId)); }
    case 'ticket_revise': { const input = reviseSchema.parse(params); return change(input.originSessionId, input.jobId, ticket => startRevision(ticket, input.note)); }
    case 'ticket_proposal': { const input = proposalSchema.parse(params); return change(input.originSessionId, input.jobId, ticket => setProposal(ticket, input.proposalId, input.state, input.note, input.by)); }
    case 'ticket_close': { const input = closeSchema.parse(params); return change(input.originSessionId, input.jobId, ticket => closeTicket(ticket, input.status, input.stopReason)); }
    case 'ticket_show': case 'ticket_mark': case 'ticket_submit': {
      const mark = method === 'ticket_mark' ? markSchema.parse(params) : undefined, input = mark ?? executorSchema.parse(params);
      const origin = ledger.executorOrigin(input.jobId, input.attemptId, input.sessionId);
      if (method === 'ticket_show') return ledger.ticket(origin, input.jobId);
      return change(origin, input.jobId, ticket => mark ? markItem(ticket, mark.itemId, mark.state, mark.note) : submitTicket(ticket),
        { attemptId: input.attemptId, sessionId: input.sessionId });
    }
    default: throw new Error(`Unknown ticket method: ${method}`);
  }
}
