/**
 * Read-only projection of one 1acp job onto the DreamMate Network L0 `DelegationMirror` (L0 0.6.0).
 *
 * Two rules from the L0 protocol (§13 / `delegation.schema.json`) drive this module:
 *
 * 1. **This is not an Execution.** It is the caller-side mirror of "how far did the delegation get";
 *    nothing here is written back into the execution ledger.
 * 2. **`a2a_task_id` is the remote's own opaque task id.** It is never the local Task id, and it must
 *    never appear as `task_id` — the L0 vocabulary deliberately has no `task_id` inside a delegation.
 *
 * The mirror reuses L0 `ExecutionStatus` for coarse progress instead of inventing a second status
 * vocabulary, and keeps the review conclusion in `review_status` (`pending` / `accepted` /
 * `changes_requested`).
 */
import type {
  DelegationMirror,
  ExecutionStatus as L0ExecutionStatus,
  LifecycleMode as L0LifecycleMode,
  ReviewStatus as L0ReviewStatus,
} from '@1agents/dreammate-network';
import type { BusinessAcceptance, ExecutionStatus, LedgerAttempt, LedgerJob } from './ledger.js';
import { isGovernanceProposalKind, type Ticket } from './ticket.js';

export type { DelegationMirror, L0ExecutionStatus, L0LifecycleMode, L0ReviewStatus };

/**
 * Map 1acp's ten internal execution states onto the six L0 `ExecutionStatus` values.
 *
 * `input_required` / `auth_required` both mean "a person has to do something", which L0 names
 * `waiting_for_user`. `rejected` and the unconfirmed `unknown` are failures from the caller's point of
 * view: the delegation did not produce work. The `default` branch keeps a status added by a future
 * 1acp release from crashing the projection — L0's compatibility rule requires consumers to tolerate
 * unknown enum members rather than treat them as errors.
 */
export function toL0ExecutionStatus(status: ExecutionStatus): L0ExecutionStatus {
  switch (status) {
    case 'not_started':
    case 'submitted':
      return 'queued';
    case 'working':
      return 'running';
    case 'input_required':
    case 'auth_required':
      return 'waiting_for_user';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'rejected':
    case 'unknown':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'failed';
  }
}

/** Open two-key governance proposals nobody has settled yet: the count L0 mirrors in `pending_proposal_count`. */
export function countPendingGovernanceProposals(ticket: Ticket | undefined): number {
  if (!ticket) return 0;
  return ticket.proposals.filter(proposal => proposal.state === 'open' && isGovernanceProposalKind(proposal.kind)).length;
}

export interface ProjectDelegationMirrorParams {
  job: Pick<LedgerJob, 'jobId' | 'targetId' | 'roleId' | 'resultRevision' | 'updatedAt'>;
  /** The round the mirror describes; omitted only for a job whose attempt has not been read. */
  attempt?: Pick<LedgerAttempt, 'attemptId' | 'executionStatus' | 'backendRunRef' | 'updatedAt'> & {
    result?: { resultRevision?: string; resultDigest?: string };
  };
  /** The latest business acceptance for this round, when the origin recorded one. */
  acceptance?: Pick<BusinessAcceptance, 'reviewStatus'>;
  /** The executor's ticket, when this job has one; its open governance proposals are counted. */
  ticket?: Ticket;
  /** The process request currently waiting for a person, if any. */
  pendingApprovalId?: string;
  /** `trial` / `formal` for a delegated agent task; omitted for a standalone job. */
  lifecycleMode?: L0LifecycleMode;
  /** The delegated session, when the host reported one. Falls back to the attempt's run reference. */
  sessionId?: string;
  /** The remote A2A task id, when the caller already read it. Falls back to the attempt's run reference. */
  a2aTaskId?: string;
  /** Defaults to now; supplied by callers that must produce a stable projection. */
  updatedAt?: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Build the L0 `DelegationMirror` for one job.
 *
 * Every key is `snake_case` and every field is either a string, an integer or `null`, so the result
 * validates against `delegation.schema.json` without a second normalisation pass. `null` is used
 * (rather than omitting the key) for a fact that is genuinely absent, which is what L0 documents:
 * a stored row carries `null`, not a missing field.
 */
export function projectDelegationMirror(params: ProjectDelegationMirrorParams): DelegationMirror {
  const { job, attempt, acceptance, ticket } = params;
  const result = attempt?.result;
  const sessionId = nonEmpty(params.sessionId) ?? nonEmpty(attempt?.backendRunRef?.sessionId);
  const a2aTaskId = nonEmpty(params.a2aTaskId) ?? nonEmpty(attempt?.backendRunRef?.taskId);
  const roleId = nonEmpty(job.roleId);
  const resultRevision = nonEmpty(result?.resultRevision) ?? nonEmpty(job.resultRevision);
  const resultDigest = nonEmpty(result?.resultDigest);
  const pendingApprovalId = nonEmpty(params.pendingApprovalId);
  const updatedAt = nonEmpty(params.updatedAt) ?? nonEmpty(job.updatedAt) ?? nonEmpty(attempt?.updatedAt) ?? new Date().toISOString();
  return {
    job_id: job.jobId,
    attempt_id: nonEmpty(attempt?.attemptId) ?? null,
    a2a_task_id: a2aTaskId ?? null,
    session_id: sessionId ?? null,
    target_id: nonEmpty(job.targetId) ?? null,
    role_id: roleId ?? null,
    lifecycle_mode: params.lifecycleMode ?? null,
    status: attempt ? toL0ExecutionStatus(attempt.executionStatus) : null,
    result_revision: resultRevision ?? null,
    result_digest: resultDigest ?? null,
    review_status: acceptance ? (acceptance.reviewStatus as L0ReviewStatus) : null,
    pending_approval_id: pendingApprovalId ?? null,
    pending_proposal_count: countPendingGovernanceProposals(ticket),
    updated_at: updatedAt,
  };
}
