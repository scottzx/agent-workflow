/**
 * What one thing looks like on the workbench page.
 *
 * The page projects the ledger: it draws the edges that happened, the proposals that are open, and the conventions
 * that are still waiting for their condition. It never invents an endpoint, and it never decides anything.
 */
import type { LedgerActor, LedgerJob, LedgerState } from './ledger.js';
import type { Handoff, HandoffConvention, HandoffStatus, HandoffWhen, HandoffSnapshot } from './handoff.js';
import type { CaseFact, CaseReceipt } from './externals.js';
import type { AcpTaskSummary, WorkbenchSnapshot, WorkbenchSource } from './workbench.js';
import { legalNextForJob } from './workbench.js';
import { projectApprovals, type ApprovalItem } from './approvals-view.js';

export interface WorkbenchCaseSummary {
  caseId: string;
  originSessionId: string;
  goal: string;
  title?: string;
  createdAt: string;
  createdBy?: LedgerActor;
  updatedAt: string;
  /** True when the case is projected from older jobs that only carried a case id. */
  legacy?: boolean;
  taskCount: number;
  /** How many things on this case wait for a person. */
  pendingCount: number;
  artifactSpace?: string;
  lastActivityAt: string;
}

export interface WorkbenchCaseEdge {
  handoffId: string;
  fromJobId: string;
  fromAttemptId: string;
  toTargetId: string;
  purpose: string;
  status: HandoffStatus;
  /** True once the edge really happened; a proposal is drawn dashed and names no destination job. */
  happened: boolean;
  artifactRevision: string;
  artifactDigest: string;
  reason: string;
  note?: string;
  decidedBy?: LedgerActor;
  childJobId?: string;
  snapshots?: HandoffSnapshot[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkbenchCaseConvention {
  conventionId: string;
  fromPurpose?: string;
  fromTargetId?: string;
  toTargetId: string;
  toPurpose: string;
  when: HandoffWhen;
  requireHuman: boolean;
  /** True when the condition already holds for the case's current job. */
  achieved: boolean;
  condition?: { metric: string; operator: string; value: number };
  recordedAt: string;
}

export interface WorkbenchCaseArtifact {
  revision: string;
  digest?: string;
  jobId: string;
  artifacts: unknown[];
}

export interface WorkbenchInboxItem {
  kind: 'review' | 'process_request' | 'handoff' | 'proposal';
  id: string;
  caseId?: string;
  jobId: string;
  title: string;
  summary: string;
  revision?: string;
  digest?: string;
  createdAt: string;
  /** True when the person on this page may answer it. */
  canDecide: boolean;
  channel?: 'trial' | 'formal' | 'standalone';
  proposalId?: string;
  proposalKind?: 'locked' | 'check' | 'role' | 'qa';
  text?: string;
  roleId?: string;
}

export interface WorkbenchCaseDetail extends WorkbenchCaseSummary {
  tasks: AcpTaskSummary[];
  edges: WorkbenchCaseEdge[];
  conventions: WorkbenchCaseConvention[];
  artifacts: WorkbenchCaseArtifact[];
  receipts: CaseReceipt[];
  facts: CaseFact[];
  inbox: WorkbenchInboxItem[];
}

export interface WorkbenchCaseList {
  items: WorkbenchCaseSummary[];
  total: number;
  counts: { all: number; pending: number };
}

const terminal = new Set(['completed', 'failed', 'canceled', 'rejected']);

function caseKey(originSessionId: string, caseId: string): string { return `${originSessionId}\u0000${caseId}`; }

function edgeOf(handoff: Handoff): WorkbenchCaseEdge {
  return { handoffId: handoff.handoffId, fromJobId: handoff.fromJobId, fromAttemptId: handoff.fromAttemptId,
    toTargetId: handoff.toTargetId, purpose: handoff.purpose, status: handoff.status,
    happened: handoff.status === 'taken', artifactRevision: handoff.artifactRevision, artifactDigest: handoff.artifactDigest,
    reason: handoff.reason, ...(handoff.note ? { note: handoff.note } : {}), ...(handoff.decidedBy ? { decidedBy: handoff.decidedBy } : {}),
    ...(handoff.childJobId ? { childJobId: handoff.childJobId } : {}), ...(handoff.snapshots ? { snapshots: handoff.snapshots } : {}),
    createdAt: handoff.createdAt, updatedAt: handoff.updatedAt };
}

/** Every case this scope can see, opened ones and the compatibility projections of older jobs. */
export function workbenchCases(source: WorkbenchSource, snapshot: WorkbenchSnapshot): { list: WorkbenchCaseList; details: Record<string, WorkbenchCaseDetail> } {
  const { ledger, actorId } = source;
  const allowed = source.allowedOrigins ? new Set(source.allowedOrigins) : undefined;
  const visible = snapshot.tasks;
  const visibleJobs = new Set(visible.map(job => job.jobId));
  const jobsByCase = new Map<string, LedgerJob[]>();
  for (const job of Object.values(ledger.jobs)) {
    if (!job.caseId) continue;
    if (allowed && !allowed.has(job.originSessionId)) continue;
    const key = caseKey(job.originSessionId, job.caseId);
    jobsByCase.set(key, [...(jobsByCase.get(key) ?? []), job]);
  }
  const opened = Object.values(ledger.cases ?? {});
  const records = new Map<string, { caseId: string; originSessionId: string; goal: string; title?: string; createdAt: string; createdBy?: LedgerActor; updatedAt: string; legacy?: boolean }>();
  for (const record of opened) {
    if (allowed && !allowed.has(record.originSessionId)) continue;
    records.set(caseKey(record.originSessionId, record.caseId), { ...record });
  }
  for (const [key, jobs] of jobsByCase) {
    if (records.has(key)) continue;
    const oldest = jobs.reduce((first, job) => ((first.createdAt ?? '') <= (job.createdAt ?? '') ? first : job));
    records.set(key, { caseId: oldest.caseId!, originSessionId: oldest.originSessionId, goal: oldest.title ?? '',
      createdAt: oldest.createdAt ?? new Date(0).toISOString(), updatedAt: oldest.updatedAt, legacy: true });
  }
  const details: Record<string, WorkbenchCaseDetail> = {};
  const items: WorkbenchCaseSummary[] = [];
  for (const [key, record] of records) {
    const jobs = jobsByCase.get(key) ?? [];
    const jobIds = new Set(jobs.map(job => job.jobId));
    const tasks = visible.filter(task => jobIds.has(task.jobId));
    const edges = (ledger.handoffs ?? []).filter(handoff => handoff.caseId === record.caseId
      && handoff.fromJobId && jobIds.has(handoff.fromJobId)).map(edgeOf);
    const conventions: WorkbenchCaseConvention[] = (ledger.conventions ?? [])
      .filter(rule => rule.originSessionId === record.originSessionId && rule.caseId === record.caseId)
      .map(rule => {
        const target = jobs.map(job => legalNextForJob(ledger, job).find(item => item.conventionId === rule.conventionId)).find(Boolean);
        return { conventionId: rule.conventionId, ...(rule.fromPurpose ? { fromPurpose: rule.fromPurpose } : {}),
          ...(rule.fromTargetId ? { fromTargetId: rule.fromTargetId } : {}), toTargetId: rule.toTargetId, toPurpose: rule.toPurpose,
          when: rule.when, requireHuman: rule.requireHuman, achieved: Boolean(target?.achieved),
          ...(rule.condition ? { condition: rule.condition } : {}), recordedAt: rule.recordedAt };
      });
    const artifacts: WorkbenchCaseArtifact[] = [];
    for (const task of tasks) {
      for (const entry of snapshot.details[task.jobId]?.artifacts ?? []) {
        artifacts.push({ revision: entry.revision, ...(entry.digest ? { digest: entry.digest } : {}), jobId: task.jobId, artifacts: entry.artifacts });
      }
    }
    const receipts = (ledger.receipts ?? []).filter(item => item.originSessionId === record.originSessionId && item.caseId === record.caseId);
    const facts = (ledger.facts ?? []).filter(item => item.originSessionId === record.originSessionId && item.caseId === record.caseId);
    const space = (ledger.artifactSpaces ?? []).find(item => item.originSessionId === record.originSessionId && item.caseId === record.caseId);
    const inbox = inboxFor(source, record.caseId, jobIds, actorId);
    const lastActivityAt = [...edges.map(edge => edge.updatedAt), ...tasks.map(task => task.updatedAt), record.updatedAt]
      .filter(Boolean).sort().at(-1) ?? record.updatedAt;
    const summary: WorkbenchCaseSummary = { caseId: record.caseId, originSessionId: record.originSessionId, goal: record.goal,
      ...(record.title ? { title: record.title } : {}), createdAt: record.createdAt, updatedAt: record.updatedAt,
      ...(record.createdBy ? { createdBy: record.createdBy } : {}), ...(record.legacy ? { legacy: true } : {}),
      taskCount: tasks.length, pendingCount: inbox.filter(item => item.canDecide).length,
      ...(space ? { artifactSpace: space.root } : {}), lastActivityAt };
    items.push(summary);
    details[key] = { ...summary, tasks, edges, conventions, artifacts, receipts, facts, inbox };
  }
  items.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const list: WorkbenchCaseList = { items, total: items.length, counts: { all: items.length, pending: items.filter(item => item.pendingCount > 0).length } };
  return { list, details };
}

function inboxItem(item: ApprovalItem): WorkbenchInboxItem {
  return { kind: item.kind, id: item.kind === 'proposal' ? item.proposalId ?? item.id : item.id, caseId: item.caseId, jobId: item.jobId,
    title: item.title, summary: item.summary, createdAt: item.createdAt, canDecide: item.canDecide, channel: item.channel,
    ...(item.revision ? { revision: item.revision } : {}), ...(item.digest ? { digest: item.digest } : {}),
    ...(item.proposalId ? { proposalId: item.proposalId } : {}), ...(item.proposalKind ? { proposalKind: item.proposalKind } : {}),
    ...(item.text ? { text: item.text } : {}), ...(item.roleId ? { roleId: item.roleId } : {}) };
}

/** The same four gates as the approvals tab, limited to this case, newest first. */
function inboxFor(source: WorkbenchSource, caseId: string, jobIds: Set<string>, _actorId: string): WorkbenchInboxItem[] {
  return projectApprovals(source, { jobIds, caseId }).items.map(inboxItem).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One case, or nothing when this scope cannot see it. */
export function getWorkbenchCase(details: Record<string, WorkbenchCaseDetail>, originSessionId: string, caseId: string): WorkbenchCaseDetail {
  const detail = details[caseKey(originSessionId, caseId)];
  if (!detail) throw new Error('Case not found in authorized scope');
  return structuredClone(detail);
}

/** The case a job belongs to, in the same scope. */
export function caseOfJob(details: Record<string, WorkbenchCaseDetail>, originSessionId: string, jobId: string): WorkbenchCaseDetail | undefined {
  return Object.values(details).find(detail => detail.originSessionId === originSessionId && detail.tasks.some(task => task.jobId === jobId));
}

export { terminal as terminalStatuses };
