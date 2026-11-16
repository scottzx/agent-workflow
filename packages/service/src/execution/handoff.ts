/**
 * A handoff is a ledger edge, not a dispatch and not a drawn flow.
 * An agent proposes one. A standing convention can accept one when its predicate is already true.
 * Only an accepted handoff may be marked taken, and only by the submit that opens the next job.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LedgerActor, LedgerJob, LedgerJobView } from './ledger.js';
import { JobLedger } from './ledger.js';
import { TicketError } from './ticket.js';

const id = z.string().trim().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(4000);
export const handoffWhenSchema = z.enum(['acceptance_accepted', 'ticket_closed']);
export type HandoffWhen = z.infer<typeof handoffWhenSchema>;
export type HandoffStatus = 'proposed' | 'accepted' | 'taken' | 'rejected';

export interface Handoff {
  handoffId: string;
  caseId: string;
  fromJobId: string;
  fromAttemptId: string;
  toTargetId: string;
  purpose: string;
  artifactRevision: string;
  artifactDigest: string;
  reason: string;
  status: HandoffStatus;
  clientRequestId?: string;
  conventionId?: string;
  childJobId?: string;
  decidedBy?: LedgerActor;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** One implication, not a graph. Several may match; more than one match never auto-picks. */
export interface HandoffConvention {
  conventionId: string;
  originSessionId: string;
  caseId: string;
  fromPurpose?: string;
  fromTargetId?: string;
  toTargetId: string;
  toPurpose: string;
  when: HandoffWhen;
  requireHuman: boolean;
  clientRequestId?: string;
  recordedAt: string;
}

export class HandoffError extends Error {}
const fail = (message: string): never => { throw new HandoffError(message); };

export interface LegalNext {
  conventionId: string;
  toTargetId: string;
  purpose: string;
  requireHuman: boolean;
  when: HandoffWhen;
  /** True when the convention's predicate already holds for the current result. */
  achieved: boolean;
}

const actorSchema = z.object({ kind: z.enum(['person', 'coach']), agent: z.string().optional(), sessionId: z.string().optional() }).strict()
  .refine(actor => actor.kind === 'coach' || (!actor.agent && !actor.sessionId), 'Only a coach names an agent session');
const proposeFields = {
  caseId: id, toTargetId: id, purpose: id, artifactRevision: id, artifactDigest: digest, reason: text,
  clientRequestId: id.optional(),
};
const proposeByOriginSchema = z.object({ originSessionId: id, jobId: id, attemptId: id, ...proposeFields }).strict();
const proposeByExecutorSchema = z.object({ jobId: id, attemptId: id, sessionId: id, via: z.enum(['dsh', 'mcp', 'cli']).optional(), ...proposeFields }).strict();
const decideSchema = z.object({ originSessionId: id, handoffId: id, decision: z.enum(['accept', 'reject']),
  note: z.string().trim().max(4000).optional(), decidedBy: actorSchema }).strict();
const offerSchema = z.object({ originSessionId: id, caseId: id, fromPurpose: id.optional(), fromTargetId: id.optional(),
  toTargetId: id, toPurpose: id, when: handoffWhenSchema, requireHuman: z.boolean().optional(), clientRequestId: id.optional() }).strict();
const spaceSchema = z.object({ originSessionId: id, caseId: id,
  root: z.string().min(1).max(4096).refine(value => value.startsWith('/') && !value.includes('\0') && !value.split('/').includes('..'), 'artifact space must be an absolute remote path') }).strict();
const readSchema = z.object({ originSessionId: id, jobId: id }).strict();

function applies(rule: HandoffConvention, job: Pick<LedgerJob, 'originSessionId' | 'caseId' | 'purpose' | 'targetId'>): boolean {
  return rule.originSessionId === job.originSessionId && rule.caseId === job.caseId
    && (!rule.fromPurpose || rule.fromPurpose === job.purpose)
    && (!rule.fromTargetId || rule.fromTargetId === job.targetId)
    && rule.toTargetId !== job.targetId;
}

function ticketClosed(ledger: JobLedger, origin: string, jobId: string): boolean {
  try { return ledger.ticket(origin, jobId).status === 'closed'; }
  catch (error) { if (error instanceof TicketError) return false; throw error; }
}

function achieved(rule: HandoffConvention, view: LedgerJobView, closed: boolean): boolean {
  if (rule.when === 'ticket_closed') return closed;
  const acceptance = view.businessAcceptance;
  return acceptance?.reviewStatus === 'accepted'
    && acceptance.resultDigest === view.result?.resultDigest
    && acceptance.resultRevision === view.result?.resultRevision
    && view.result?.resultAvailable === true;
}

export function legalNextFor(ledger: JobLedger, originSessionId: string, jobId: string): LegalNext[] {
  const view = ledger.get(originSessionId, jobId);
  if (!view.caseId) return [];
  const closed = ticketClosed(ledger, originSessionId, jobId);
  return ledger.conventionsFor(originSessionId).filter(rule => applies(rule, view)).map(rule => ({
    conventionId: rule.conventionId, toTargetId: rule.toTargetId, purpose: rule.toPurpose,
    requireHuman: rule.requireHuman, when: rule.when, achieved: achieved(rule, view, closed),
  }));
}

function sameProposal(existing: Handoff, input: z.infer<typeof proposeByOriginSchema>): boolean {
  return existing.caseId === input.caseId && existing.toTargetId === input.toTargetId && existing.purpose === input.purpose
    && existing.artifactRevision === input.artifactRevision && existing.artifactDigest === input.artifactDigest && existing.reason === input.reason;
}

/** Record a proposal. A single matching convention with requireHuman false accepts it. Nothing here opens a job. */
export function proposeHandoff(ledger: JobLedger, originSessionId: string, raw: unknown): Handoff {
  const input = proposeByOriginSchema.parse({ ...(raw as object), originSessionId });
  const view = ledger.get(originSessionId, input.jobId);
  const attempt = view.attempts.find(item => item.attemptId === input.attemptId) ?? fail('Attempt does not belong to this job');
  if (attempt.attemptId !== view.currentAttemptId) fail('Handoff must name the job\'s current attempt');
  if (input.toTargetId === view.targetId) fail('Handoff must name a different target; continue the same job to revise');
  if (!attempt.result?.resultAvailable || attempt.result.resultDigest !== input.artifactDigest || attempt.result.resultRevision !== input.artifactRevision) {
    fail('Handoff must name the current result revision and digest');
  }
  const existing = ledger.handoffsFor(originSessionId, input.jobId);
  const replay = input.clientRequestId ? existing.find(item => item.clientRequestId === input.clientRequestId) : undefined;
  if (replay) return sameProposal(replay, input) ? replay : fail('clientRequestId conflicts with an existing handoff');
  const open = existing.find(item => item.status !== 'rejected' && item.toTargetId === input.toTargetId && item.purpose === input.purpose && item.artifactDigest === input.artifactDigest);
  if (open) return open;
  const closed = ticketClosed(ledger, originSessionId, input.jobId);
  const matches = ledger.conventionsFor(originSessionId).filter(rule => applies(rule, { ...view, caseId: input.caseId })
    && rule.toTargetId === input.toTargetId && rule.toPurpose === input.purpose && achieved(rule, { ...view, caseId: input.caseId }, closed));
  if (matches.filter(rule => !rule.requireHuman).length > 1) fail('More than one achieved convention matches this handoff; a person must choose');
  const now = new Date().toISOString();
  const handoff: Handoff = {
    handoffId: randomUUID(), caseId: input.caseId, fromJobId: input.jobId, fromAttemptId: input.attemptId,
    toTargetId: input.toTargetId, purpose: input.purpose, artifactRevision: input.artifactRevision, artifactDigest: input.artifactDigest,
    reason: input.reason, status: matches.some(rule => !rule.requireHuman) ? 'accepted' : 'proposed',
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    ...(matches.some(rule => !rule.requireHuman) ? { conventionId: matches.find(rule => !rule.requireHuman)!.conventionId } : {}),
    createdAt: now, updatedAt: now,
  };
  return ledger.commitHandoff(originSessionId, handoff, handoff.status === 'accepted' ? 'handoff.accepted' : 'handoff.proposed');
}

export function decideHandoff(ledger: JobLedger, raw: unknown): Handoff {
  const input = decideSchema.parse(raw);
  const current = ledger.findHandoff(input.originSessionId, input.handoffId) ?? fail('Handoff not found');
  if (current.status === 'taken') fail('A taken handoff already opened a job');
  if (current.status === 'rejected') return input.decision === 'reject' ? current : fail('A rejected handoff cannot be accepted');
  if (current.status === 'accepted') return input.decision === 'accept' ? current : fail('An accepted handoff cannot be rejected without a new proposal');
  const now = new Date().toISOString();
  const next: Handoff = { ...current, status: input.decision === 'accept' ? 'accepted' : 'rejected', decidedBy: input.decidedBy,
    ...(input.note ? { note: input.note } : {}), updatedAt: now };
  return ledger.commitHandoff(input.originSessionId, next, input.decision === 'accept' ? 'handoff.accepted' : 'handoff.rejected');
}

/**
 * When exactly one convention's predicate holds and it does not ask for a person, record an accepted handoff.
 * Zero or several matches record nothing. This does not submit the next job.
 */
export function continueByConvention(ledger: JobLedger, originSessionId: string, jobId: string): Handoff | undefined {
  const view = ledger.get(originSessionId, jobId);
  if (!view.caseId || !view.result?.resultAvailable || !view.result.resultDigest || !view.result.resultRevision) return undefined;
  const closed = ticketClosed(ledger, originSessionId, jobId);
  const ready = ledger.conventionsFor(originSessionId).filter(rule => applies(rule, view) && !rule.requireHuman && achieved(rule, view, closed));
  if (ready.length !== 1) return undefined;
  const rule = ready[0]!;
  const digest = view.result.resultDigest;
  const existing = ledger.handoffsFor(originSessionId, jobId);
  if (existing.some(item => item.fromAttemptId === view.currentAttemptId && item.artifactDigest === digest && item.status !== 'rejected')) return undefined;
  const clientRequestId = `convention:${rule.conventionId}:${digest}`;
  const now = new Date().toISOString();
  return ledger.commitHandoff(originSessionId, {
    handoffId: randomUUID(), caseId: view.caseId, fromJobId: jobId, fromAttemptId: view.currentAttemptId,
    toTargetId: rule.toTargetId, purpose: rule.toPurpose, artifactRevision: view.result.resultRevision, artifactDigest: digest,
    reason: '约定已达成', status: 'accepted', clientRequestId, conventionId: rule.conventionId, createdAt: now, updatedAt: now,
  }, 'handoff.accepted');
}

export function offerConvention(ledger: JobLedger, raw: unknown): HandoffConvention {
  const input = offerSchema.parse(raw);
  if (input.fromTargetId && input.fromTargetId === input.toTargetId) fail('A convention must name a different target');
  return ledger.commitConvention({
    conventionId: randomUUID(), originSessionId: input.originSessionId, caseId: input.caseId,
    ...(input.fromPurpose ? { fromPurpose: input.fromPurpose } : {}), ...(input.fromTargetId ? { fromTargetId: input.fromTargetId } : {}),
    toTargetId: input.toTargetId, toPurpose: input.toPurpose, when: input.when, requireHuman: input.requireHuman ?? false,
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}), recordedAt: new Date().toISOString(),
  });
}

export function grantArtifactSpace(ledger: JobLedger, raw: unknown) {
  const input = spaceSchema.parse(raw);
  return ledger.commitArtifactSpace({ ...input, recordedAt: new Date().toISOString() });
}

export function readHandoff(ledger: JobLedger, raw: unknown) {
  const input = readSchema.parse(raw);
  const view = ledger.get(input.originSessionId, input.jobId);
  const space = view.caseId ? ledger.artifactSpace(input.originSessionId, view.caseId) : undefined;
  return {
    caseId: view.caseId, handoffs: ledger.handoffsFor(input.originSessionId, input.jobId),
    legalNext: legalNextFor(ledger, input.originSessionId, input.jobId),
    ...(space ? { artifactSpace: space.root } : {}),
  };
}

export const HANDOFF_METHODS = {
  handoff_propose: { description: '提议把当前轮次已记录的产物交给另一个执行目标。只写账本，不派下一单。唯一匹配且不要求人确认的约定会直接接受；多条匹配则拒绝代选。', parameters: z.toJSONSchema(proposeByOriginSchema) },
  handoff_decide: { description: '人或教练接受或拒绝一条提议。接受后仍要另调 execution_submit 并带上 handoffId，才会开下一张任务。', parameters: z.toJSONSchema(decideSchema) },
  handoff_offer: { description: '登记一条约定：某件事在验收通过或任务单关闭后可以交给哪个目标。这不是流程图，多条同时成立时不会自动挑选。', parameters: z.toJSONSchema(offerSchema) },
  handoff_space: { description: '把一个已有的宿主目录登记为这件事的共享产物空间。不创建目录，也不把它当成角色公开目录或某个任务的私有目录。', parameters: z.toJSONSchema(spaceSchema) },
  handoff_get: { description: '读取这件事上的交接、当前允许的下一跳，以及已登记的共享产物空间。不派单。', parameters: z.toJSONSchema(readSchema) },
};

/** Gateway entry. An executor may omit originSessionId; the current attempt's session identifies the job. */
export function invokeHandoff(ledger: JobLedger, method: string, params: unknown): unknown {
  switch (method) {
    case 'handoff_propose': {
      const body = params && typeof params === 'object' ? params as Record<string, unknown> : {};
      if (typeof body.originSessionId === 'string') return proposeHandoff(ledger, body.originSessionId, params);
      const executor = proposeByExecutorSchema.parse(params);
      const origin = ledger.executorOrigin(executor.jobId, executor.attemptId, executor.sessionId);
      return proposeHandoff(ledger, origin, { ...executor, originSessionId: origin });
    }
    case 'handoff_decide': return decideHandoff(ledger, params);
    case 'handoff_offer': return offerConvention(ledger, params);
    case 'handoff_space': return grantArtifactSpace(ledger, params);
    case 'handoff_get': return readHandoff(ledger, params);
    default: throw new Error(`Unknown handoff method: ${method}`);
  }
}
