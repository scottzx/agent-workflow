/** Durable Job/Attempt facts. This module does not execute or schedule work. */
import { createHash, randomUUID } from 'node:crypto';
import type { Handoff, HandoffConvention } from './handoff.js';
import type { ArtifactSpace } from './spaces.js';
import type { CaseRecord } from './cases.js';
import { caseKey } from './cases.js';
import type { CaseFact, CaseReceipt } from './externals.js';
import { TicketError, type Ticket, type TicketChange } from './ticket.js';
import type { SafeErrorSummary } from '../safe-error-summary.js';

export type ExecutionStatus = 'not_started' | 'submitted' | 'working' | 'input_required' | 'auth_required' | 'completed' | 'failed' | 'canceled' | 'rejected' | 'unknown';
export type SubmissionStatus = 'prepared' | 'dispatching' | 'accepted' | 'known_not_submitted' | 'submission_unknown';
export interface JobRef { sourceId: string; jobId: string }
export interface LedgerTargetSnapshot {
  targetId: string;
  configVersion?: number;
  targetConfigVersion?: number;
  connectionId?: string;
  connectionVersion?: number;
  provider?: string;
  roleId?: string;
  [key: string]: unknown;
}
export interface BackendRunRef {
  provider?: string; remote?: string; taskId?: string; contextId?: string; sessionId?: string; flowRunId?: string;
  [key: string]: unknown;
}
export interface LedgerResult {
  attemptId: string;
  resultSummary?: string;
  structuredResultRef?: unknown;
  resultDigest?: string;
  resultRevision?: string;
  artifactLinks: unknown[];
  /** Artifact byte receipts supplied by the execution host, when available. */
  resultArtifacts?: unknown[];
  resultAvailable: boolean;
  observedAt: string;
}
/** Who acted: a person, a coach agent naming its session, or an application holding the workbench credential. */
export interface LedgerActor {
  kind: 'person' | 'coach' | 'application';
  id?: string;
  agent?: string;
  sessionId?: string;
  /**
   * How this claim reached the ledger. `page` is the gateway's own page session; `relay` is a host
   * forwarding for its page with the shared secret. The two are indistinguishable to the gateway when
   * the caller runs as the same OS user, so the record says which one it was instead of implying both
   * are the same proof.
   */
  via?: 'page' | 'relay';
}
export interface BusinessAcceptance {
  attemptId: string; resultRevision: string; resultDigest: string;
  reviewStatus: 'pending' | 'accepted' | 'changes_requested'; note?: string; recordedAt: string;
  /** Absent on records written before acceptances named who decided. */
  decidedBy?: LedgerActor;
}
export interface LedgerAttempt {
  attemptId: string; jobId: string; operation: string; clientRequestId?: string; requestDigest: string;
  targetId: string; targetConfigVersion?: number; connectionId?: string; connectionVersion?: number;
  provider: string; targetSnapshot: LedgerTargetSnapshot; input: unknown; previousAttemptId?: string;
  backendRunRef?: BackendRunRef; submissionStatus: SubmissionStatus; executionStatus: ExecutionStatus;
  providerState?: string; phase?: string; cancellationRequestedAt?: string; checkedAt?: string; stale: boolean;
  createdAt: string | null; updatedAt: string; diagnostic?: string; result?: LedgerResult; resultHistory?: LedgerResult[];
  /** The whitelisted failure facts of this round. Absent while the round has not failed. */
  error?: SafeErrorSummary;
  /** The origin stopped waiting on this round before it ended (it timed out, or the caller itself failed); it may still run or have finished unseen. */
  unwatched?: { at: string; reason: string };
  /** Who asked for this round, when the caller named itself. */
  initiatedBy?: LedgerActor;
}
export interface LedgerJob {
  sourceId: string; jobId: string; title?: string; originSessionId: string; accessScopeRef: string;
  originKind: 'session' | 'legacy'; originRef: string; targetId: string; roleId?: string;
  currentAttemptId: string; executionStatus: ExecutionStatus; inFlightAttemptIds: string[]; unresolvedAttemptIds: string[];
  parentJobRef?: JobRef; parentAttemptId?: string; purpose?: string; resultRevision?: string; replacesJobRef?: JobRef;
  /** Set when the job is part of a case that can share an artifact space and handoffs. Absent on older jobs. */
  caseId?: string;
  jobVersion: number; createdAt: string | null; updatedAt: string; provenance: 'native' | 'legacy'; migratedAt?: string;
  /** Who asked for the task. originSessionId stays the access scope, and many callers share a default one. */
  initiatedBy?: LedgerActor;
}
export interface LedgerEvent {
  eventId: string; sourceId: string; sequence: number; jobId: string; attemptId?: string;
  jobVersion: number; type: string; observedAt: string; data?: unknown;
}
interface RequestRecord { digest: string; jobId: string; attemptId: string }
export interface LedgerState {
  version: 1; sourceId: string; jobs: Record<string, LedgerJob>; attempts: Record<string, LedgerAttempt>;
  requests: Record<string, RequestRecord>; events: LedgerEvent[]; nextSequence: number;
  acceptances: Record<string, BusinessAcceptance[]>;
  /** Task tickets by executor jobId; absent in state written before tickets existed. */
  tickets?: Record<string, Ticket>;
  /** Absent in state written before handoffs existed. */
  handoffs?: Handoff[];
  conventions?: HandoffConvention[];
  artifactSpaces?: ArtifactSpace[];
  /** One thing, by (originSessionId, caseId). Absent in state written before cases existed. */
  cases?: Record<string, CaseRecord>;
  /** External receipts, one per (channel, remote id). */
  receipts?: CaseReceipt[];
  /** External facts. The platform stores the number; it does not judge it. */
  facts?: CaseFact[];
}
export interface LedgerPrepareInput {
  originSessionId: string; targetSnapshot: LedgerTargetSnapshot; input: unknown; clientRequestId?: string;
  /** Trusted adapter only: hash the caller request before adding current-attempt defaults. */
  requestDigestInput?: unknown;
  jobId?: string; parentJobRef?: JobRef; parentAttemptId?: string; purpose?: string; title?: string; caseId?: string;
  operation?: string; resultRevision?: string; replacesJobRef?: JobRef; initiatedBy?: LedgerActor;
}
export interface LedgerObservation {
  executionStatus?: ExecutionStatus; providerState?: string; phase?: string; checkedAt?: string; stale?: boolean;
  resultSummary?: string; structuredResultRef?: unknown; resultDigest?: string; resultRevision?: string;
  artifactLinks?: unknown[]; resultArtifacts?: unknown[]; resultAvailable?: boolean; diagnostic?: string;
  /** The whitelisted failure facts of a failed round. */
  error?: SafeErrorSummary;
}
export interface LegacyLedgerRecord {
  originSessionId: string; remote: string; taskId: string; contextId?: string; sessionId?: string;
  cwd?: string; agentPreset?: string; title?: string; executionStatus?: ExecutionStatus; providerState?: string;
  resultSummary?: string; artifactLinks?: unknown[]; createdAt?: string | null; checkedAt?: string; stale?: boolean;
  targetSnapshot?: LedgerTargetSnapshot;
}
export interface LedgerJobView extends LedgerJob {
  attempts: LedgerAttempt[]; children: LedgerJob[]; result?: LedgerResult; resultHistory: LedgerResult[];
  businessAcceptance?: BusinessAcceptance; acceptanceHistory: BusinessAcceptance[];
  /** The whitelisted failure facts of the current round. */
  error?: SafeErrorSummary;
}

const terminal = new Set<ExecutionStatus>(['completed', 'failed', 'canceled', 'rejected']);
/** The statuses that may carry failure facts. */
const failedExecutionStatuses = new Set<ExecutionStatus>(['failed', 'canceled', 'rejected']);
const statuses = new Set<ExecutionStatus>(['not_started', 'submitted', 'working', 'input_required', 'auth_required', 'completed', 'failed', 'canceled', 'rejected', 'unknown']);
const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const resultContent = (result: LedgerResult) => canonical({ resultSummary: result.resultSummary,
  structuredResultRef: result.structuredResultRef, artifactLinks: result.artifactLinks, resultArtifacts: result.resultArtifacts ?? [] });
function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
}
/** Canonical JSON, including nested object keys; unsupported values cannot acquire a misleading digest. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('Ledger request must contain JSON values');
}
function safeSnapshot(value: LedgerTargetSnapshot): void {
  nonempty(value.targetId, 'targetId');
  const inspect = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const [key, nested] of Object.entries(item)) {
      if (/^(token|password|secret|authorization|apiKey|accessToken|refreshToken)$/i.test(key) && nested !== undefined) {
        throw new Error(`Plaintext credential field is not allowed in targetSnapshot: ${key}`);
      }
      inspect(nested);
    }
  };
  inspect(value); canonical(value);
}

export class JobLedger {
  private state: LedgerState;
  constructor(initial: LedgerState | undefined, private readonly persist: (next: LedgerState) => void) {
    if (initial) {
      if (initial.version !== 1 || !initial.sourceId || !initial.jobs || !initial.attempts || !initial.requests || !Array.isArray(initial.events)
        || !Number.isSafeInteger(initial.nextSequence) || !initial.acceptances) throw new Error('Invalid execution ledger state');
      this.state = { ...clone(initial), tickets: clone(initial.tickets ?? {}), handoffs: clone(initial.handoffs ?? []),
        conventions: clone(initial.conventions ?? []), artifactSpaces: clone(initial.artifactSpaces ?? []),
        cases: clone(initial.cases ?? {}), receipts: clone(initial.receipts ?? []), facts: clone(initial.facts ?? []) };
    } else {
      this.state = { version: 1, sourceId: randomUUID(), jobs: {}, attempts: {}, requests: {}, events: [], nextSequence: 1, acceptances: {}, tickets: {},
        handoffs: [], conventions: [], artifactSpaces: [], cases: {}, receipts: [], facts: [] };
    }
  }
  snapshot(): LedgerState { return clone(this.state); }
  /** Trusted adapter use only; public reads must call scoped get/list. */
  getAttempt(attemptId: string): LedgerAttempt { return clone(this.attempt(this.state, attemptId)); }
  get sourceId(): string { return this.state.sourceId; }
  /** A crash during dispatch proves neither acceptance nor rejection; never silently send it again. */
  recoverAfterRestart(): string[] {
    const ids = Object.values(this.state.attempts).filter(attempt => attempt.submissionStatus === 'dispatching').map(attempt => attempt.attemptId);
    if (!ids.length) return [];
    return this.mutate(state => {
      for (const attemptId of ids) {
        const attempt = state.attempts[attemptId]!;
        attempt.submissionStatus = 'submission_unknown'; attempt.executionStatus = 'unknown'; attempt.stale = true;
        attempt.diagnostic = 'Gateway restarted before backend acceptance was durably confirmed'; attempt.updatedAt = now();
        this.event(state, state.jobs[attempt.jobId]!, attemptId, 'attempt.submission_unknown', { reason: 'restart_during_dispatch' });
      }
      return ids;
    });
  }
  private mutate<T>(operation: (next: LedgerState) => T): T {
    const next = clone(this.state), value = operation(next);
    this.persist(clone(next)); // The caller atomically persists ledger together with task/notice facts.
    this.state = next;
    return clone(value);
  }
  private job(state: LedgerState, origin: string, jobId: string): LedgerJob {
    const job = state.jobs[jobId];
    if (!job || job.originSessionId !== origin) throw new Error('Job not found in origin scope');
    return job;
  }
  private attempt(state: LedgerState, attemptId: string): LedgerAttempt {
    const attempt = Object.hasOwn(state.attempts, attemptId) ? state.attempts[attemptId] : undefined;
    if (!attempt) throw new Error('Attempt not found');
    return attempt;
  }
  private event(state: LedgerState, job: LedgerJob, attemptId: string | undefined, type: string, data?: unknown): void {
    const timestamp = now();
    job.jobVersion++; job.updatedAt = timestamp;
    this.refresh(state, job);
    state.events.push({ eventId: randomUUID(), sourceId: state.sourceId, sequence: state.nextSequence++, jobId: job.jobId,
      attemptId, jobVersion: job.jobVersion, type, observedAt: timestamp, ...(data === undefined ? {} : { data: clone(data) }) });
  }
  private refresh(state: LedgerState, job: LedgerJob): void {
    const attempts = Object.values(state.attempts).filter(attempt => attempt.jobId === job.jobId);
    job.executionStatus = state.attempts[job.currentAttemptId]!.executionStatus;
    job.inFlightAttemptIds = attempts.filter(attempt => attempt.submissionStatus === 'accepted' && !terminal.has(attempt.executionStatus)).map(attempt => attempt.attemptId);
    job.unresolvedAttemptIds = attempts.filter(attempt => attempt.submissionStatus === 'submission_unknown' || attempt.executionStatus === 'unknown').map(attempt => attempt.attemptId);
  }
  private checkRef(state: LedgerState, origin: string, ref: JobRef, name: string): LedgerJob {
    if (ref.sourceId !== state.sourceId) throw new Error(`${name} must use the same ledger source`);
    return this.job(state, origin, ref.jobId);
  }
  private requestIdentity(input: LedgerPrepareInput): { operation: string; digest: string; requestKey?: string } {
    nonempty(input.originSessionId, 'originSessionId'); nonempty(input.targetSnapshot.targetId, 'targetId');
    if (input.clientRequestId !== undefined) nonempty(input.clientRequestId, 'clientRequestId');
    const operation = input.operation ?? (input.jobId ? 'continue' : 'submit');
    nonempty(operation, 'operation');
    const request = { operation, targetId: input.targetSnapshot.targetId,
      input: input.requestDigestInput === undefined ? input.input : input.requestDigestInput, jobId: input.jobId,
      parentJobRef: input.parentJobRef, parentAttemptId: input.parentAttemptId, purpose: input.purpose,
      title: input.title, resultRevision: input.resultRevision, replacesJobRef: input.replacesJobRef, caseId: input.caseId };
    const digest = createHash('sha256').update(canonical(request)).digest('hex');
    const requestKey = input.clientRequestId === undefined ? undefined : canonical([this.state.sourceId, input.originSessionId, operation, input.clientRequestId]);
    return { operation, digest, requestKey };
  }
  /** Read-only idempotency check before resolving current target configuration or contacting a Provider. */
  replay(input: LedgerPrepareInput): { job: LedgerJob; attempt: LedgerAttempt; idempotent: true } | undefined {
    const { digest, requestKey } = this.requestIdentity(input);
    const existing = requestKey ? this.state.requests[requestKey] : undefined;
    if (existing) {
      if (existing.digest !== digest) throw new Error('clientRequestId conflicts with an existing request');
      return { job: clone(this.job(this.state, input.originSessionId, existing.jobId)), attempt: clone(this.state.attempts[existing.attemptId]!), idempotent: true };
    }
    return undefined;
  }
  prepare(input: LedgerPrepareInput): { job: LedgerJob; attempt: LedgerAttempt; idempotent: boolean } {
    safeSnapshot(input.targetSnapshot);
    const replay = this.replay(input);
    if (replay) return replay;
    const { operation, digest, requestKey } = this.requestIdentity(input);
    return this.mutate(state => {
      const timestamp = now();
      let job: LedgerJob;
      if (input.jobId) {
        job = this.job(state, input.originSessionId, input.jobId);
        if (job.targetId !== input.targetSnapshot.targetId) throw new Error('Continue must preserve the original target');
        if (Object.values(state.attempts).some(attempt => attempt.jobId === job.jobId && attempt.submissionStatus === 'submission_unknown')) {
          throw new Error('Job has submission_unknown; reconcile before dispatching another attempt');
        }
        if (input.parentJobRef && canonical(input.parentJobRef) !== canonical(job.parentJobRef ?? null)
          || input.parentAttemptId && input.parentAttemptId !== job.parentAttemptId) throw new Error('A job cannot change its parent');
        if (input.caseId && job.caseId && input.caseId !== job.caseId) throw new Error('A job cannot change its case');
        if (input.caseId && !job.caseId) job.caseId = input.caseId;
      } else {
        if (Boolean(input.parentJobRef) !== Boolean(input.parentAttemptId)) throw new Error('parentJobRef and parentAttemptId are required together');
        if (input.parentJobRef) {
          const parent = this.checkRef(state, input.originSessionId, input.parentJobRef, 'parentJobRef');
          if (this.attempt(state, input.parentAttemptId!).jobId !== parent.jobId) throw new Error('parentAttemptId does not belong to parent job');
        }
        if (input.replacesJobRef) this.checkRef(state, input.originSessionId, input.replacesJobRef, 'replacesJobRef');
        job = { sourceId: state.sourceId, jobId: randomUUID(), originSessionId: input.originSessionId, accessScopeRef: input.originSessionId,
          originKind: 'session', originRef: input.originSessionId, targetId: input.targetSnapshot.targetId, currentAttemptId: '',
          executionStatus: 'not_started', inFlightAttemptIds: [], unresolvedAttemptIds: [], jobVersion: 0, createdAt: timestamp,
          updatedAt: timestamp, provenance: 'native', ...(input.title ? { title: input.title } : {}),
          ...(input.targetSnapshot.roleId ? { roleId: input.targetSnapshot.roleId } : {}),
          ...(input.parentJobRef ? { parentJobRef: clone(input.parentJobRef), parentAttemptId: input.parentAttemptId } : {}),
          ...(input.purpose ? { purpose: input.purpose } : {}), ...(input.resultRevision ? { resultRevision: input.resultRevision } : {}),
          ...(input.replacesJobRef ? { replacesJobRef: clone(input.replacesJobRef) } : {}),
          ...(input.caseId ? { caseId: input.caseId } : {}),
          ...(input.initiatedBy ? { initiatedBy: clone(input.initiatedBy) } : {}) };
        state.jobs[job.jobId] = job;
      }
      const attempt: LedgerAttempt = { attemptId: randomUUID(), jobId: job.jobId, operation, requestDigest: digest,
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}), targetId: input.targetSnapshot.targetId,
        targetConfigVersion: input.targetSnapshot.configVersion ?? input.targetSnapshot.targetConfigVersion,
        connectionId: input.targetSnapshot.connectionId, connectionVersion: input.targetSnapshot.connectionVersion,
        provider: input.targetSnapshot.provider ?? 'a2a', targetSnapshot: clone(input.targetSnapshot), input: clone(input.input),
        ...(job.currentAttemptId ? { previousAttemptId: job.currentAttemptId } : {}), submissionStatus: 'prepared',
        executionStatus: 'not_started', stale: false, createdAt: timestamp, updatedAt: timestamp,
        ...(input.initiatedBy ? { initiatedBy: clone(input.initiatedBy) } : {}) };
      state.attempts[attempt.attemptId] = attempt; job.currentAttemptId = attempt.attemptId;
      if (requestKey) state.requests[requestKey] = { digest, jobId: job.jobId, attemptId: attempt.attemptId };
      this.event(state, job, attempt.attemptId, input.jobId ? 'attempt.prepared' : 'job.created', { operation, ...(input.initiatedBy ? { initiatedBy: input.initiatedBy } : {}) });
      return { job, attempt, idempotent: false };
    });
  }
  markDispatching(attemptId: string): LedgerAttempt {
    return this.mutate(state => {
      const attempt = this.attempt(state, attemptId);
      if (attempt.submissionStatus !== 'prepared') throw new Error('Only a prepared attempt may begin dispatch');
      attempt.submissionStatus = 'dispatching'; attempt.updatedAt = now();
      this.event(state, state.jobs[attempt.jobId]!, attemptId, 'attempt.dispatching'); return attempt;
    });
  }
  accept(attemptId: string, backendRunRef: BackendRunRef, observation: LedgerObservation = {}): LedgerAttempt {
    canonical(backendRunRef);
    if (![backendRunRef.taskId, backendRunRef.flowRunId, backendRunRef.runId].some(value => typeof value === 'string' && value.trim())) throw new Error('Backend acceptance requires a run reference');
    return this.mutate(state => {
      const attempt = this.attempt(state, attemptId);
      if (!['dispatching', 'submission_unknown', 'accepted'].includes(attempt.submissionStatus)) throw new Error('Attempt is not awaiting backend acceptance');
      if (attempt.backendRunRef) {
        for (const [key, value] of Object.entries(attempt.backendRunRef)) {
          if (backendRunRef[key] !== undefined && canonical(backendRunRef[key]) !== canonical(value)) throw new Error('Backend run reference cannot be replaced');
        }
      }
      attempt.backendRunRef = { ...attempt.backendRunRef, ...clone(backendRunRef) }; attempt.submissionStatus = 'accepted';
      this.applyObservation(attempt, { ...observation, executionStatus: observation.executionStatus ?? (attempt.executionStatus === 'not_started' ? 'submitted' : attempt.executionStatus) });
      this.event(state, state.jobs[attempt.jobId]!, attemptId, 'attempt.accepted', { backendRunRef: attempt.backendRunRef }); return attempt;
    });
  }
  knownNotSubmitted(attemptId: string, input: { executionStatus: 'failed' | 'rejected' | 'canceled'; diagnostic?: string }): LedgerAttempt {
    if (!['failed', 'rejected', 'canceled'].includes(input.executionStatus)) throw new Error('A dispatch failure requires an execution terminal status');
    return this.mutate(state => {
      const attempt = this.attempt(state, attemptId);
      if (!['prepared', 'dispatching', 'submission_unknown'].includes(attempt.submissionStatus)) throw new Error('An accepted attempt cannot become not submitted');
      attempt.submissionStatus = 'known_not_submitted'; attempt.executionStatus = input.executionStatus;
      attempt.diagnostic = input.diagnostic; attempt.updatedAt = now();
      this.event(state, state.jobs[attempt.jobId]!, attemptId, 'attempt.submission_failed', input); return attempt;
    });
  }
  markUnknown(attemptId: string, diagnostic?: string): LedgerAttempt {
    return this.mutate(state => {
      const attempt = this.attempt(state, attemptId);
      if (!['dispatching', 'submission_unknown'].includes(attempt.submissionStatus)) throw new Error('Only an uncertain dispatch can become submission_unknown');
      attempt.submissionStatus = 'submission_unknown'; attempt.executionStatus = 'unknown'; attempt.stale = true;
      attempt.diagnostic = diagnostic; attempt.updatedAt = now();
      this.event(state, state.jobs[attempt.jobId]!, attemptId, 'attempt.submission_unknown', { diagnostic }); return attempt;
    });
  }
  private applyObservation(attempt: LedgerAttempt, input: LedgerObservation): boolean {
    const timestamp = input.checkedAt ?? now(), completedBefore = attempt.executionStatus === 'completed'; let conflict = false;
    if (input.executionStatus !== undefined) {
      if (!statuses.has(input.executionStatus)) throw new Error('Unknown execution status');
      const previous = attempt.executionStatus, next = input.executionStatus;
      if (terminal.has(previous) && next !== previous || previous === 'working' && ['not_started', 'submitted'].includes(next)
        || previous !== 'not_started' && next === 'not_started') {
        attempt.diagnostic = `Conflicting execution observation: ${previous} -> ${next}`; conflict = true;
      } else attempt.executionStatus = next;
    }
    if (input.providerState !== undefined && !conflict) attempt.providerState = input.providerState;
    if (input.phase !== undefined && !conflict) attempt.phase = input.phase;
    if (input.diagnostic !== undefined && !conflict) attempt.diagnostic = input.diagnostic;
    if (input.error !== undefined && !conflict) attempt.error = clone(input.error);
    // A non-conflicting transition into a non-failed status carries no failure facts.
    if (!conflict && input.executionStatus !== undefined && !failedExecutionStatuses.has(input.executionStatus)) delete attempt.error;
    attempt.stale = input.stale ?? false; attempt.checkedAt = timestamp; attempt.updatedAt = timestamp;
    if (!conflict && (input.resultSummary !== undefined || input.structuredResultRef !== undefined || input.resultDigest !== undefined
      || input.artifactLinks !== undefined || input.resultArtifacts !== undefined || input.resultAvailable !== undefined || input.resultRevision !== undefined)) {
      const previous = attempt.result;
      const result: LedgerResult = { ...previous, attemptId: attempt.attemptId, artifactLinks: clone(input.artifactLinks ?? previous?.artifactLinks ?? []),
        resultAvailable: input.resultAvailable ?? previous?.resultAvailable ?? true, observedAt: timestamp,
        ...(input.resultSummary !== undefined ? { resultSummary: input.resultSummary } : {}),
        ...(input.structuredResultRef !== undefined ? { structuredResultRef: clone(input.structuredResultRef) } : {}),
        ...(input.resultArtifacts !== undefined ? { resultArtifacts: clone(input.resultArtifacts) } : {}),
        ...(input.resultDigest !== undefined ? { resultDigest: input.resultDigest } : {}),
        ...(input.resultRevision !== undefined ? { resultRevision: input.resultRevision } : {}) };
      if (attempt.executionStatus === 'completed' && result.resultAvailable) {
        if (input.resultRevision !== undefined) nonempty(input.resultRevision, 'resultRevision');
        const content = resultContent(result), unchanged = previous && resultContent(previous) === content;
        result.resultDigest = input.resultDigest ?? (unchanged ? previous.resultDigest : undefined)
          ?? createHash('sha256').update(content).digest('hex');
        nonempty(result.resultDigest, 'resultDigest');
        const history = attempt.resultHistory ??= [];
        if (!history.length && completedBefore && previous?.resultRevision && previous.resultDigest) history.push(clone(previous));
        result.resultRevision = input.resultRevision ?? (unchanged && previous.resultDigest === result.resultDigest ? previous.resultRevision : undefined);
        if (!result.resultRevision) {
          let sequence = history.length + 1;
          while (history.some(item => item.resultRevision === `result-${sequence}`)) sequence++;
          result.resultRevision = `result-${sequence}`;
        }
        nonempty(result.resultRevision, 'resultRevision');
        const existing = history.find(item => item.resultRevision === result.resultRevision);
        if (existing && (existing.resultDigest !== result.resultDigest || resultContent(existing) !== content
          || previous?.resultRevision !== result.resultRevision)) throw new Error('A result revision cannot be overwritten or reused after supersession');
        if (!existing) history.push(clone(result));
      }
      attempt.result = result;
    }
    return conflict;
  }
  observe(attemptId: string, input: LedgerObservation): LedgerAttempt {
    return this.mutate(state => {
      const attempt = this.attempt(state, attemptId);
      if (attempt.submissionStatus !== 'accepted') throw new Error('Observe requires confirmed backend acceptance');
      const previous = clone(attempt), conflict = this.applyObservation(attempt, input);
      // Repeated polling with no changed facts updates checkedAt without growing the immutable event log.
      const relevant = (item: LedgerAttempt) => ({ status: item.executionStatus, providerState: item.providerState, phase: item.phase, stale: item.stale,
        diagnostic: item.diagnostic, error: item.error, result: item.result ? { ...item.result, observedAt: undefined } : undefined });
      if (canonical(relevant(previous)) !== canonical(relevant(attempt))) this.event(state, state.jobs[attempt.jobId]!, attemptId,
        conflict ? 'attempt.observation_conflict' : previous.executionStatus !== attempt.executionStatus ? 'attempt.state_changed' : 'attempt.result_updated',
        attempt.result?.resultRevision && previous.result?.resultRevision !== attempt.result.resultRevision
          ? { resultRevision: attempt.result.resultRevision, resultDigest: attempt.result.resultDigest, previousResultRevision: previous.result?.resultRevision } : undefined);
      return attempt;
    });
  }
  requestCancellation(attemptId: string): LedgerAttempt {
    const existing = this.attempt(this.state, attemptId);
    if (existing.cancellationRequestedAt) return clone(existing);
    return this.mutate(state => {
      const attempt = this.attempt(state, attemptId);
      attempt.cancellationRequestedAt ??= now(); attempt.updatedAt = now();
      this.event(state, state.jobs[attempt.jobId]!, attemptId, 'attempt.cancellation_requested'); return attempt;
    });
  }
  get(originSessionId: string, jobId: string): LedgerJobView {
    const job = this.job(this.state, originSessionId, jobId), current = this.state.attempts[job.currentAttemptId]!;
    const history = this.state.acceptances[jobId] ?? [];
    const acceptance = current.executionStatus === 'completed' && current.result?.resultAvailable && [...history].reverse().find(item => item.attemptId === current.attemptId
      && item.resultRevision === current.result?.resultRevision && item.resultDigest === current.result?.resultDigest);
    return clone({ ...job, attempts: Object.values(this.state.attempts).filter(item => item.jobId === jobId),
      children: Object.values(this.state.jobs).filter(item => item.parentJobRef?.sourceId === this.sourceId && item.parentJobRef.jobId === jobId),
      ...(current.result ? { result: current.result } : {}), resultHistory: current.resultHistory ?? [],
      ...(current.error ? { error: current.error } : {}),
      ...(acceptance ? { businessAcceptance: acceptance } : {}), acceptanceHistory: history });
  }
  list(originSessionId: string): LedgerJobView[] {
    return Object.values(this.state.jobs).filter(job => job.originSessionId === originSessionId).map(job => this.get(originSessionId, job.jobId));
  }
  events(originSessionId: string, jobId?: string, afterSequence = 0): LedgerEvent[] {
    if (jobId) this.job(this.state, originSessionId, jobId);
    return clone(this.state.events.filter(event => event.sequence > afterSequence && (!jobId || event.jobId === jobId)
      && this.state.jobs[event.jobId]?.originSessionId === originSessionId));
  }
  findByBackend(originSessionId: string, ref: { remote?: string; taskId?: string; flowRunId?: string }): { job: LedgerJob; attempt: LedgerAttempt } | undefined {
    if (!ref.taskId && !ref.flowRunId) throw new Error('Backend lookup requires a run ID');
    const attempt = Object.values(this.state.attempts).find(item => this.state.jobs[item.jobId]?.originSessionId === originSessionId
      && Object.entries(ref).every(([key, value]) => value === undefined || item.backendRunRef?.[key] === value));
    return attempt ? clone({ job: this.state.jobs[attempt.jobId]!, attempt }) : undefined;
  }
  /**
   * The origin stopped waiting on the job's current round while it was still running. The round itself is unchanged:
   * the workbench lists the job as abnormal until a re-query finds the round ended.
   */
  unwatch(originSessionId: string, jobId: string, reason: string): LedgerAttempt {
    return this.mutate(state => {
      const job = this.job(state, originSessionId, jobId), attempt = this.attempt(state, job.currentAttemptId);
      nonempty(reason, 'reason');
      if (!terminal.has(attempt.executionStatus) && !attempt.unwatched) {
        attempt.unwatched = { at: now(), reason };
        this.event(state, job, attempt.attemptId, 'attempt.unwatched', { reason });
      }
      return clone(attempt);
    });
  }
  acceptance(originSessionId: string, jobId: string, input: Omit<BusinessAcceptance, 'recordedAt'>): BusinessAcceptance {
    return this.mutate(state => {
      const job = this.job(state, originSessionId, jobId), attempt = this.attempt(state, input.attemptId);
      if (attempt.jobId !== jobId || attempt.attemptId !== job.currentAttemptId || attempt.executionStatus !== 'completed' || !attempt.result?.resultAvailable)
        throw new Error('Acceptance must reference the current completed attempt with an available result');
      nonempty(input.resultRevision, 'resultRevision'); nonempty(input.resultDigest, 'resultDigest');
      if (attempt.result?.resultRevision !== input.resultRevision || attempt.result?.resultDigest !== input.resultDigest) throw new Error('Acceptance does not match the recorded result revision and digest');
      if (!['pending', 'accepted', 'changes_requested'].includes(input.reviewStatus)) throw new Error('Unknown business acceptance status');
      const record = { ...clone(input), recordedAt: now() };
      (state.acceptances[jobId] ??= []).push(record);
      this.event(state, job, input.attemptId, 'job.acceptance_recorded', record); return record;
    });
  }
  /** A process request changed. The request itself is stored by the gateway; this puts it on the job's timeline. */
  processEvent(jobId: string, attemptId: string, type: string, data: unknown): void {
    this.mutate(state => { this.event(state, state.jobs[jobId]!, attemptId, type, data); });
  }
  /** The originator waits on the job again, so it is no longer listed as abandoned. */
  rewatch(originSessionId: string, jobId: string): LedgerAttempt {
    return this.mutate(state => {
      const job = this.job(state, originSessionId, jobId), attempt = this.attempt(state, job.currentAttemptId);
      if (attempt.unwatched) {
        delete attempt.unwatched;
        this.event(state, job, attempt.attemptId, 'attempt.rewatched', {});
      }
      return clone(attempt);
    });
  }
  handoffsFor(originSessionId: string, jobId: string): Handoff[] {
    this.job(this.state, originSessionId, jobId);
    return clone((this.state.handoffs ?? []).filter(item => item.fromJobId === jobId || item.childJobId === jobId));
  }
  conventionsFor(originSessionId: string): HandoffConvention[] {
    return clone((this.state.conventions ?? []).filter(item => item.originSessionId === originSessionId));
  }
  artifactSpace(originSessionId: string, caseId: string): ArtifactSpace | undefined {
    return clone((this.state.artifactSpaces ?? []).find(item => item.originSessionId === originSessionId && item.caseId === caseId));
  }
  findHandoff(originSessionId: string, handoffId: string): Handoff | undefined {
    const handoff = (this.state.handoffs ?? []).find(item => item.handoffId === handoffId);
    const job = handoff ? this.state.jobs[handoff.fromJobId] : undefined;
    if (!handoff || !job || job.originSessionId !== originSessionId) return undefined;
    return clone(handoff);
  }
  /** The scope a job belongs to. */
  originOf(jobId: string): string | undefined {
    return this.state.jobs[jobId]?.originSessionId;
  }
  /** Trusted handoff module: append or replace one edge and record it on the from-job. Binds caseId if the job has none. */
  commitHandoff(originSessionId: string, handoff: Handoff, event: string): Handoff {
    return this.mutate(state => {
      const job = this.job(state, originSessionId, handoff.fromJobId);
      if (job.caseId && job.caseId !== handoff.caseId) throw new Error('Job is already bound to another case');
      job.caseId ??= handoff.caseId;
      const list = state.handoffs ??= [];
      const index = list.findIndex(item => item.handoffId === handoff.handoffId);
      if (index >= 0) list[index] = clone(handoff); else list.push(clone(handoff));
      this.event(state, job, handoff.fromAttemptId, event, { handoffId: handoff.handoffId, status: handoff.status,
        toTargetId: handoff.toTargetId, purpose: handoff.purpose, caseId: handoff.caseId, artifactRevision: handoff.artifactRevision,
        artifactDigest: handoff.artifactDigest, ...(handoff.childJobId ? { childJobId: handoff.childJobId } : {}),
        ...(handoff.conventionId ? { conventionId: handoff.conventionId } : {}) });
      return handoff;
    });
  }
  markHandoffTaken(originSessionId: string, handoffId: string, childJobId: string): Handoff {
    return this.mutate(state => {
      const handoff = (state.handoffs ?? []).find(item => item.handoffId === handoffId);
      if (!handoff) throw new Error('Handoff not found');
      const job = this.job(state, originSessionId, handoff.fromJobId);
      if (handoff.status === 'taken') {
        if (handoff.childJobId !== childJobId) throw new Error('Handoff already opened a different job');
        return clone(handoff);
      }
      if (handoff.status !== 'accepted') throw new Error('Only an accepted handoff opens a job');
      const child = this.job(state, originSessionId, childJobId);
      if (child.parentJobRef?.jobId !== handoff.fromJobId || child.parentAttemptId !== handoff.fromAttemptId
        || child.targetId !== handoff.toTargetId || child.purpose !== handoff.purpose || child.caseId !== handoff.caseId) {
        throw new Error('Child job does not match the handoff');
      }
      handoff.status = 'taken'; handoff.childJobId = childJobId; handoff.updatedAt = now();
      this.event(state, job, handoff.fromAttemptId, 'handoff.taken', { handoffId, childJobId, toTargetId: handoff.toTargetId, purpose: handoff.purpose });
      return clone(handoff);
    });
  }
  commitConvention(convention: HandoffConvention): HandoffConvention {
    return this.mutate(state => {
      const list = state.conventions ??= [];
      const prior = convention.clientRequestId ? list.find(item => item.originSessionId === convention.originSessionId && item.clientRequestId === convention.clientRequestId) : undefined;
      if (prior) return clone(prior);
      list.push(clone(convention));
      return convention;
    });
  }
  commitArtifactSpace(space: ArtifactSpace): ArtifactSpace {
    return this.mutate(state => {
      const list = state.artifactSpaces ??= [];
      const prior = list.find(item => item.originSessionId === space.originSessionId && item.caseId === space.caseId);
      if (prior) {
        if (prior.root !== space.root) throw new Error('Artifact space for this case already has a different root');
        return clone(prior);
      }
      list.push(clone(space));
      return space;
    });
  }
  /** One thing. The record is written once; a second write with the same id keeps the first. */
  commitCase(record: CaseRecord): CaseRecord {
    return this.mutate(state => {
      const list = state.cases ??= {};
      const key = caseKey(record.originSessionId, record.caseId);
      const prior = list[key];
      if (prior) return clone(prior);
      list[key] = clone(record);
      return record;
    });
  }
  findCase(originSessionId: string, caseId: string): CaseRecord | undefined {
    const record = this.state.cases?.[caseKey(originSessionId, caseId)];
    return record ? clone(record) : undefined;
  }
  casesFor(originSessionId?: string): CaseRecord[] {
    return Object.values(this.state.cases ?? {})
      .filter(record => !originSessionId || record.originSessionId === originSessionId)
      .map(record => clone(record));
  }
  /** One external receipt per (channel, remote id). A different digest for the same key is a conflict. */
  commitReceipt(receipt: CaseReceipt): CaseReceipt {
    return this.mutate(state => {
      const list = state.receipts ??= [];
      const prior = list.find(item => item.originSessionId === receipt.originSessionId && item.caseId === receipt.caseId
        && item.channel === receipt.channel && item.remoteId === receipt.remoteId);
      if (prior) {
        if (prior.artifactDigest !== receipt.artifactDigest) throw new Error('Receipt key already holds another digest');
        return clone(prior);
      }
      list.push(clone(receipt));
      return receipt;
    });
  }
  receiptsFor(originSessionId: string, caseId: string): CaseReceipt[] {
    return clone((this.state.receipts ?? []).filter(item => item.originSessionId === originSessionId && item.caseId === caseId));
  }
  commitFact(fact: CaseFact): CaseFact {
    return this.mutate(state => {
      const list = state.facts ??= [];
      list.push(clone(fact));
      return fact;
    });
  }
  factsFor(originSessionId: string, caseId: string): CaseFact[] {
    return clone((this.state.facts ?? []).filter(item => item.originSessionId === originSessionId && item.caseId === caseId));
  }
  ticket(originSessionId: string, jobId: string): Ticket {
    this.job(this.state, originSessionId, jobId);
    const ticket = this.state.tickets![jobId];
    if (!ticket) throw new TicketError('这个任务还没有任务单');
    return clone(ticket);
  }
  /**
   * One ticket operation: it gets the job's ticket (undefined before one is opened) to change in place and reports
   * its changes, each appended as a `ticket.*` event stamped with `caller` (attempt, session, QA job).
   */
  changeTicket(originSessionId: string, jobId: string, operation: (ticket: Ticket | undefined) => { ticket: Ticket; changes: TicketChange[] },
    caller: { attemptId?: string; [key: string]: unknown } = {}): Ticket {
    return this.mutate(state => {
      const job = this.job(state, originSessionId, jobId), tickets = state.tickets ??= {};
      const { ticket, changes } = operation(tickets[jobId]);
      tickets[jobId] = ticket;
      for (const change of changes) this.event(state, job, caller.attemptId, change.type, { ...change.data, ...caller });
      return ticket;
    });
  }
  /**
   * Trusted adapter use only: the origin of the job whose current, unfinished attempt `attemptId` is. When the
   * host reported which session runs the attempt, the caller must be that session.
   */
  executorOrigin(jobId: string, attemptId: string, sessionId: string): string {
    const job = Object.hasOwn(this.state.jobs, jobId) ? this.state.jobs[jobId] : undefined;
    const attempt = Object.hasOwn(this.state.attempts, attemptId) ? this.state.attempts[attemptId] : undefined;
    if (!job || !attempt || attempt.jobId !== jobId || job.currentAttemptId !== attemptId) throw new TicketError('这一轮执行不是该任务的当前轮次');
    if (terminal.has(attempt.executionStatus)) throw new TicketError('这一轮执行已经结束，不能再处理任务单');
    const recorded = attempt.backendRunRef?.sessionId;
    if (recorded !== undefined && recorded !== sessionId) throw new TicketError('调用的会话不是执行这一轮的会话');
    return job.originSessionId;
  }
  /** Trusted adapter use only: the job's current attempt and the session the host reported for it, for a caller that names only the job. */
  currentAttempt(jobId: string): { attemptId: string; sessionId?: string } {
    const job = Object.hasOwn(this.state.jobs, jobId) ? this.state.jobs[jobId] : undefined;
    const attempt = job && Object.hasOwn(this.state.attempts, job.currentAttemptId) ? this.state.attempts[job.currentAttemptId] : undefined;
    if (!attempt) throw new TicketError('没有这个任务');
    return { attemptId: attempt.attemptId, ...(attempt.backendRunRef?.sessionId !== undefined ? { sessionId: attempt.backendRunRef.sessionId } : {}) };
  }
  /**
   * The origin of the job whose current attempt `attemptId` is, for a caller that only names the attempt and its
   * session. Unlike a ticket operation this accepts a finished round: handing over the result of a completed round
   * is exactly what a handoff proposal is for.
   */
  executorHandoffOrigin(jobId: string, attemptId: string, sessionId: string): string {
    const job = Object.hasOwn(this.state.jobs, jobId) ? this.state.jobs[jobId] : undefined;
    const attempt = Object.hasOwn(this.state.attempts, attemptId) ? this.state.attempts[attemptId] : undefined;
    if (!job || !attempt || attempt.jobId !== jobId || job.currentAttemptId !== attemptId) throw new TicketError('这一轮执行不是该任务的当前轮次');
    const recorded = attempt.backendRunRef?.sessionId;
    if (recorded !== undefined && recorded !== sessionId) throw new TicketError('调用的会话不是执行这一轮的会话');
    return job.originSessionId;
  }
  /** Each old Task gets one legacy Job; matching context IDs never merge jobs. */
  migrateLegacy(records: LegacyLedgerRecord[]): Array<{ remote: string; taskId: string; jobId: string; attemptId: string }> {
    return this.mutate(state => records.map(record => {
      nonempty(record.originSessionId, 'originSessionId'); nonempty(record.remote, 'remote'); nonempty(record.taskId, 'taskId');
      const existing = Object.values(state.attempts).find(item => state.jobs[item.jobId]?.originSessionId === record.originSessionId
        && item.backendRunRef?.remote === record.remote && item.backendRunRef?.taskId === record.taskId);
      if (existing) return { remote: record.remote, taskId: record.taskId, jobId: existing.jobId, attemptId: existing.attemptId };
      const timestamp = now(), jobId = randomUUID(), attemptId = randomUUID();
      const snapshot = record.targetSnapshot ?? { targetId: `legacy:${record.remote}`, provider: 'a2a', remote: record.remote,
        ...(record.cwd ? { cwd: record.cwd } : {}), ...(record.agentPreset ? { agentPreset: record.agentPreset } : {}) };
      safeSnapshot(snapshot);
      const executionStatus = record.executionStatus ?? 'unknown';
      if (!statuses.has(executionStatus)) throw new Error('Invalid legacy execution status');
      const attempt: LedgerAttempt = { attemptId, jobId, operation: 'legacy_import', requestDigest: '', targetId: snapshot.targetId,
        provider: 'a2a', targetSnapshot: clone(snapshot), input: null,
        backendRunRef: { remote: record.remote, taskId: record.taskId, ...(record.contextId ? { contextId: record.contextId } : {}), ...(record.sessionId ? { sessionId: record.sessionId } : {}) },
        submissionStatus: 'accepted', executionStatus, stale: record.stale ?? false, createdAt: record.createdAt ?? null,
        updatedAt: record.checkedAt ?? timestamp, ...(record.checkedAt ? { checkedAt: record.checkedAt } : {}),
        ...(record.providerState ? { providerState: record.providerState } : {}) };
      if (record.resultSummary !== undefined || record.artifactLinks?.length) attempt.result = { attemptId, resultSummary: record.resultSummary,
        artifactLinks: clone(record.artifactLinks ?? []), resultAvailable: true, observedAt: record.checkedAt ?? timestamp };
      const job: LedgerJob = { sourceId: state.sourceId, jobId, originSessionId: record.originSessionId, accessScopeRef: record.originSessionId,
        originKind: 'legacy', originRef: record.taskId, targetId: snapshot.targetId, title: record.title, currentAttemptId: attemptId,
        executionStatus, inFlightAttemptIds: [], unresolvedAttemptIds: [], jobVersion: 0, createdAt: record.createdAt ?? null,
        updatedAt: record.checkedAt ?? timestamp, provenance: 'legacy', migratedAt: timestamp };
      state.attempts[attemptId] = attempt; state.jobs[jobId] = job;
      this.event(state, job, attemptId, 'job.migrated', { remote: record.remote, taskId: record.taskId });
      return { remote: record.remote, taskId: record.taskId, jobId, attemptId };
    }));
  }
}
