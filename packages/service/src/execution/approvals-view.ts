/**
 * One read-only queue of everything a person still has to decide.
 * The approvals tab, the sidebar badge and a case inbox all call this, so they cannot drift apart.
 */
import type { Handoff } from './handoff.js';
import type { HumanReviewRequest } from './human-review.js';
import { projectProcessRequest, type ProcessRequest } from './process-request.js';
import type { Ticket, TicketProposal } from './ticket.js';
import { describeTaskDevelopment } from './agent-registry.js';
import type { WorkbenchSource } from './workbench.js';

export type ApprovalKind = 'process_request' | 'review' | 'handoff' | 'proposal';
export type ApprovalChannel = 'trial' | 'formal' | 'standalone';

export interface ApprovalCounts {
  process_request: number;
  review: number;
  handoff: number;
  proposal: number;
}

/** A handoff the page can accept or reject without reading the case again. */
export interface ApprovalHandoff {
  handoffId: string;
  toTargetId: string;
  purpose: string;
  reason: string;
  artifactRevision: string;
  artifactDigest: string;
  snapshots?: Handoff['snapshots'];
}

export interface ApprovalItem {
  kind: ApprovalKind;
  id: string;
  jobId: string;
  originSessionId: string;
  caseId?: string;
  channel: ApprovalChannel;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  canDecide: boolean;
  deadlineAt?: string;
  revision?: string;
  digest?: string;
  roleId?: string;
  proposalId?: string;
  proposalKind?: TicketProposal['kind'];
  text?: string;
  /** The pending process request, so the page can answer it in place. */
  processRequest?: ProcessRequest & { canAnswer: boolean };
  handoff?: ApprovalHandoff;
}

export interface ApprovalsView {
  totalPending: number;
  counts: ApprovalCounts;
  /** Newest `createdAt` among the pending items, or null when the queue is empty. */
  latestCreatedAt: string | null;
  items: ApprovalItem[];
}

export interface ApprovalsScope {
  /** Only items whose job is in this set. A case inbox passes its jobs. */
  jobIds?: ReadonlySet<string>;
  /** When set, a proposal must also name this case. */
  caseId?: string;
}

const PRIORITY: Record<ApprovalKind, number> = { process_request: 0, review: 1, handoff: 2, proposal: 3 };
const emptyCounts = (): ApprovalCounts => ({ process_request: 0, review: 0, handoff: 0, proposal: 0 });

function channelOf(source: WorkbenchSource, jobId: string): ApprovalChannel {
  const job = source.ledger.jobs[jobId];
  const attempt = job ? source.ledger.attempts[job.currentAttemptId] : undefined;
  const snapshot = attempt?.targetSnapshot as { development?: unknown; targetKind?: unknown; targetName?: unknown } | undefined;
  const resident = snapshot?.targetKind === 'resident_agent';
  const name = typeof snapshot?.targetName === 'string' ? snapshot.targetName : undefined;
  return describeTaskDevelopment(snapshot?.development, { targetId: job?.targetId ?? '', resident, ...(name ? { residentName: name } : {}) }).channel;
}

function visible(source: WorkbenchSource, jobId: string, scope?: ApprovalsScope): boolean {
  const job = source.ledger.jobs[jobId];
  if (!job) return false;
  if (source.allowedOrigins && !source.allowedOrigins.includes(job.originSessionId)) return false;
  if (scope?.jobIds && !scope.jobIds.has(jobId)) return false;
  return true;
}

function reviewItem(source: WorkbenchSource, review: HumanReviewRequest): ApprovalItem | undefined {
  if (review.status !== 'pending' || review.reviewerId !== source.actorId) return;
  const job = source.ledger.jobs[review.jobId];
  if (!job) return;
  return { kind: 'review', id: review.reviewId, jobId: review.jobId, originSessionId: job.originSessionId,
    ...(job.caseId ? { caseId: job.caseId } : {}), channel: channelOf(source, review.jobId), title: review.title,
    summary: `确认 ${review.revision}`, createdAt: review.createdAt, updatedAt: review.updatedAt, canDecide: true,
    revision: review.revision, digest: review.digest };
}

function processItem(source: WorkbenchSource, request: ProcessRequest, now: number): ApprovalItem | undefined {
  const projected = projectProcessRequest(request, now);
  if (projected.status !== 'pending') return;
  const job = source.ledger.jobs[request.jobId];
  if (!job) return;
  const title = projected.kind === 'plan' ? '计划待批准' : projected.kind === 'permission' ? `工具「${projected.toolTitle ?? ''}」待批准` : '有待回答的问题';
  const summary = projected.kind === 'plan' ? projected.planContent ?? '' : projected.kind === 'permission' ? projected.toolTitle ?? '' : projected.questions?.[0]?.question ?? '';
  return { kind: 'process_request', id: projected.requestId, jobId: request.jobId, originSessionId: job.originSessionId,
    ...(job.caseId ? { caseId: job.caseId } : {}), channel: channelOf(source, request.jobId), title, summary,
    createdAt: projected.createdAt, updatedAt: projected.updatedAt, canDecide: true, deadlineAt: projected.deadlineAt,
    processRequest: { ...projected, canAnswer: true } };
}

function handoffItem(source: WorkbenchSource, handoff: Handoff): ApprovalItem | undefined {
  if (handoff.status !== 'proposed') return;
  const job = source.ledger.jobs[handoff.fromJobId];
  if (!job) return;
  return { kind: 'handoff', id: handoff.handoffId, jobId: handoff.fromJobId, originSessionId: job.originSessionId,
    caseId: handoff.caseId, channel: channelOf(source, handoff.fromJobId), title: '交接提议',
    summary: `${handoff.reason}（交给 ${handoff.toTargetId}）`, createdAt: handoff.createdAt, updatedAt: handoff.updatedAt,
    canDecide: true, revision: handoff.artifactRevision, digest: handoff.artifactDigest,
    handoff: { handoffId: handoff.handoffId, toTargetId: handoff.toTargetId, purpose: handoff.purpose, reason: handoff.reason,
      artifactRevision: handoff.artifactRevision, artifactDigest: handoff.artifactDigest, ...(handoff.snapshots ? { snapshots: handoff.snapshots } : {}) } };
}

function proposalItem(source: WorkbenchSource, jobId: string, ticket: Ticket, proposal: TicketProposal, scope?: ApprovalsScope): ApprovalItem | undefined {
  if (proposal.state !== 'open' || (proposal.kind !== 'locked' && proposal.kind !== 'check')) return;
  if (scope?.caseId && ticket.caseId !== scope.caseId) return;
  const job = source.ledger.jobs[jobId];
  if (!job) return;
  return { kind: 'proposal', id: `${jobId}:${proposal.id}`, jobId, originSessionId: job.originSessionId,
    caseId: ticket.caseId || job.caseId, channel: channelOf(source, jobId),
    title: proposal.kind === 'locked' ? '规范红线' : '检查项提议', summary: proposal.text,
    createdAt: job.updatedAt, updatedAt: job.updatedAt, canDecide: true, roleId: ticket.roleId,
    proposalId: proposal.id, proposalKind: proposal.kind, text: proposal.text };
}

/** Pending process requests, reviews this person may decide, proposed handoffs, and open locked/check proposals. */
export function projectApprovals(source: WorkbenchSource, scope?: ApprovalsScope): ApprovalsView {
  const now = source.now ?? Date.now();
  const items: ApprovalItem[] = [];
  for (const request of source.processRequests ?? []) {
    if (!visible(source, request.jobId, scope)) continue;
    const item = processItem(source, request, now);
    if (item) items.push(item);
  }
  for (const review of source.reviews) {
    if (!visible(source, review.jobId, scope)) continue;
    const item = reviewItem(source, review);
    if (item) items.push(item);
  }
  for (const handoff of source.ledger.handoffs ?? []) {
    if (!visible(source, handoff.fromJobId, scope)) continue;
    const item = handoffItem(source, handoff);
    if (item) items.push(item);
  }
  for (const [jobId, ticket] of Object.entries(source.ledger.tickets ?? {})) {
    if (!visible(source, jobId, scope)) continue;
    for (const proposal of ticket.proposals) {
      const item = proposalItem(source, jobId, ticket, proposal, scope);
      if (item) items.push(item);
    }
  }
  items.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.createdAt.localeCompare(b.createdAt));
  const counts = emptyCounts();
  for (const item of items) counts[item.kind] += 1;
  const latestCreatedAt = items.reduce<string | null>((latest, item) => !latest || item.createdAt > latest ? item.createdAt : latest, null);
  return { totalPending: items.length, counts, latestCreatedAt, items };
}
