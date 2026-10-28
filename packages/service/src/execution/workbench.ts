/** Human-readable projections of the execution ledger. Reading never dispatches or acknowledges work. */
import type { BusinessAcceptance, JobRef, LedgerAttempt, LedgerEvent, LedgerJob, LedgerState } from './ledger.js';
import type { ReportReviewRun } from './report-review.js';
import type { PptDeliveryRun } from './ppt-delivery.js';
import { deliveryProgress } from './delivery-progress.js';
import type { HumanReviewRequest, HumanReviewStatus } from './human-review.js';
import { projectProcessRequest, type ProcessRequest } from './process-request.js';
import { describeTaskDevelopment, projectWorkbenchAgents, type AgentDraft, type AgentRelease, type AgentTaskRef, type ResidentAgentRef, type WorkbenchAgentRow } from './agent-registry.js';

export interface WorkbenchServiceInfo {
  kind: 'a2a' | 'gateway_workflow' | 'activepieces' | 'unknown';
  source: 'backend_run' | 'target_snapshot' | 'workflow_run' | 'unrecorded';
  host?: string; port?: number; locality?: 'loopback' | 'network'; connectionAlias?: string;
}
export interface WorkbenchExecution {
  kind: 'temporary' | 'resident' | 'workflow' | 'unknown'; targetId: string; targetName?: string;
  roleId?: string; agentPreset?: string; presetStatus: 'recorded' | 'host_default' | 'unknown' | 'not_applicable';
  service?: string; serviceInfo?: WorkbenchServiceInfo; provider?: string; connectionId?: string;
}
export interface AcpTaskSummary {
  sourceId: string; jobId: string; title: string; originSessionId: string; parentJobRef?: JobRef;
  parentAttemptId?: string; purpose?: string; targetId: string; currentAttemptId: string;
  executionStatus: string; displayStatus: string; phase: string; createdAt: string | null; updatedAt: string;
  stale: boolean; reviewStatus?: HumanReviewStatus; pendingReviewId?: string; pendingProcessRequestId?: string; progressSummary: string;
  channel: 'trial' | 'formal' | 'standalone'; agentId?: string; agentName?: string; agentPhase?: 'developing' | 'published';
  inFlightAttemptIds: string[]; unresolvedAttemptIds: string[]; execution: WorkbenchExecution;
  /** The origin session's execution_review for the current result, if one was recorded. */
  businessAcceptance?: BusinessAcceptance;
  /** Tools the finished attempt asked for that nobody approved; its result may be incomplete. */
  blockedTools?: string[];
}
export interface WorkbenchStage { stage: string; name: string; status: string; planned: boolean; jobId?: string; attemptId?: string }
export interface WorkbenchProgress { stage: string; phase: string; stages: WorkbenchStage[]; completedStages: string[];
  remainingStages: string[]; executionElapsedMs?: number; humanWaitingMs?: number; updatedAt: string;
  availableResults?: ReturnType<typeof deliveryProgress>['availableResults'] }
export interface WorkbenchDependency { from: string; to: string; kind: 'parent' | 'depends_on' | 'replaces'; label: string; parentAttemptId?: string }
export type WorkbenchReview = HumanReviewRequest & { canReview: boolean; resumeStatus?: 'pending' | 'applied'; resumeError?: string };
export type WorkbenchProcessRequest = ProcessRequest & { canAnswer: boolean };
export type WorkbenchAttempt = Omit<LedgerAttempt, 'input' | 'targetSnapshot' | 'backendRunRef'> & { backendRunRef?: Record<string, string>; execution: WorkbenchExecution };
export interface AcpTaskDetail extends AcpTaskSummary {
  /** The first attempt's prompt: what the task was asked to do. Other input fields stay private. */
  description?: string;
  attempts: WorkbenchAttempt[]; children: AcpTaskSummary[]; ancestors: AcpTaskSummary[];
  progress: WorkbenchProgress; reviews: WorkbenchReview[]; processRequests: WorkbenchProcessRequest[]; events: LedgerEvent[]; dependencies: WorkbenchDependency[];
  artifacts: { revision: string; digest?: string; artifacts: unknown[] }[];
}
export interface WorkbenchSource { ledger: LedgerState; runs: readonly PptDeliveryRun[]; reviews: readonly HumanReviewRequest[];
  reportRuns?: readonly ReportReviewRun[]; processRequests?: readonly ProcessRequest[]; actorId: string; allowedOrigins?: readonly string[]; now?: number }
export type { AgentDraft, AgentRelease, WorkbenchAgentRow };
export interface WorkbenchSnapshot { sourceId: string; tasks: AcpTaskSummary[]; details: Record<string, AcpTaskDetail> }
export interface WorkbenchListQuery { filter?: 'all' | 'pending' | 'working' | 'failed'; limit?: number; offset?: number }
const stageNames: Record<string, string> = { summary: '文稿生成', human_review: '人工审核', make: '设计制作', validate: '机器校验', review: '独立验收', finished: '交付完成' };
const purposeNames: Record<string, string> = { project_script: '文稿生成', ppt_production: '设计制作', independent_review: '独立验收' };
const terminal = new Set(['completed', 'failed', 'canceled', 'rejected']);
const stateDescriptions: Record<string, string> = { not_started: '等待开始执行。', submitted: '任务已提交，等待执行角色开始。', working: '执行角色正在处理任务。',
  input_required: '任务等待补充输入。', auth_required: '任务等待完成认证。', completed: '执行已完成，可查看产物和执行记录。',
  failed: '执行失败，请查看异常原因。', canceled: '任务已取消，已有产物与历史保留。', rejected: '执行请求未被接受。', unknown: '执行状态尚未确认，请核实执行宿主。' };
function runDescription(run: PptDeliveryRun): string {
  if (terminal.has(run.executionStatus)) return stateDescriptions[run.executionStatus]!;
  if (run.stage === 'make' && !run.currentChild && !run.pending) return '文字稿已确认，等待启动设计制作。';
  return ({ summary: '文稿作者正在生成或修订文字稿。', make: '制作角色正在根据确认的文字稿设计 PPT。', validate: '正在检查制作产物的文件与结构。',
    review: '独立验收角色正在核对事实和页面效果。', finished: '交付已完成，可查看最终产物。' })[run.stage];
}
function byNewest<T extends { updatedAt: string }>(items: T[]): T[] { return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
function latestReview(reviews: readonly HumanReviewRequest[], job: LedgerJob): HumanReviewRequest | undefined {
  return byNewest(reviews.filter(r => r.jobId === job.jobId && r.attemptId === job.currentAttemptId).map(r => structuredClone(r)).reverse())[0];
}
function metadataText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= 512 && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}
function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function serviceEndpoint(value: unknown): Pick<WorkbenchServiceInfo, 'host' | 'port' | 'locality'> | undefined {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    const host = metadataText(url.hostname.replace(/^\[|\]$/g, ''));
    if (!host) return undefined;
    const locality = host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host) ? 'loopback' : 'network';
    return { host, port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80, locality };
  } catch { return undefined; }
}
/** Separate a connection alias from the service this attempt was recorded against. */
function serviceView(attempt: LedgerAttempt | undefined, snapshot: Record<string, unknown>, binding: Record<string, unknown>, workflow: boolean): WorkbenchServiceInfo {
  const backend = attempt?.backendRunRef;
  const connectionAlias = metadataText(backend?.remote) ?? metadataText(snapshot.remote);
  const alias = connectionAlias ? { connectionAlias } : {};
  const recordedWorkflow = workflow || backend?.provider === 'report_review' || backend?.provider === 'resident_role' && Boolean(metadataText(backend.runId));
  if (recordedWorkflow || binding.driver === 'ppt_delivery') return { kind: 'gateway_workflow', source: recordedWorkflow ? 'workflow_run' : 'target_snapshot', ...alias };
  const provider = metadataText(backend?.provider) ?? metadataText(snapshot.provider) ?? metadataText(attempt?.provider);
  const kind: WorkbenchServiceInfo['kind'] = provider === 'a2a' ? 'a2a' : provider === 'activepieces' ? 'activepieces' : 'unknown';
  const actual = serviceEndpoint(backend?.endpoint), configured = serviceEndpoint(snapshot.endpoint);
  return { kind, source: actual ? 'backend_run' : configured ? 'target_snapshot' : 'unrecorded', ...(actual ?? configured), ...alias };
}
/** Historical identities come only from this execution's frozen facts, never today's target directory. */
function executionView(attempt: LedgerAttempt | undefined, targetId: string, workflow = false): WorkbenchExecution {
  const snapshot: Record<string, unknown> = attempt?.targetSnapshot ?? {}, binding = metadataObject(snapshot.binding);
  const serviceInfo = serviceView(attempt, snapshot, binding, workflow);
  const snapshotRole = metadataText(snapshot.roleId), bindingRole = metadataText(binding.roleId);
  const roleConflict = Boolean(snapshotRole && bindingRole && snapshotRole !== bindingRole);
  const roleId = roleConflict ? undefined : snapshotRole ?? bindingRole;
  const hasRole = Boolean(snapshotRole || bindingRole);
  const targetKind = metadataText(snapshot.targetKind);
  let kind: WorkbenchExecution['kind'] = 'unknown';
  if (serviceInfo.kind === 'gateway_workflow' || targetKind === 'workflow') kind = 'workflow';
  else if (roleConflict || targetKind === 'agent_host' && hasRole) kind = 'unknown';
  else if (targetKind === 'resident_agent' || hasRole) kind = 'resident';
  else if (targetKind === 'agent_host' || targetId.startsWith('legacy:')) kind = 'temporary';
  const snapshotPreset = metadataText(snapshot.agentPreset), bindingPreset = metadataText(binding.agentPreset);
  const presetConflict = Boolean(snapshotPreset && bindingPreset && snapshotPreset !== bindingPreset);
  const presetUnusable = snapshot.agentPreset !== undefined && !snapshotPreset || binding.agentPreset !== undefined && !bindingPreset;
  const hasFrozenTarget = Boolean(attempt && metadataText(snapshot.targetId) === targetId);
  const agentPreset = kind === 'workflow' || presetConflict ? undefined : snapshotPreset ?? bindingPreset;
  const presetStatus: WorkbenchExecution['presetStatus'] = kind === 'workflow' ? 'not_applicable'
    : agentPreset ? 'recorded' : kind === 'temporary' && hasFrozenTarget && !presetConflict && !presetUnusable && snapshot.historicalConfigUnknown !== true ? 'host_default' : 'unknown';
  const targetName = metadataText(snapshot.targetName), service = metadataText(snapshot.remote) ?? metadataText(attempt?.backendRunRef?.remote);
  const provider = metadataText(snapshot.provider) ?? metadataText(attempt?.provider) ?? metadataText(attempt?.backendRunRef?.provider);
  const connectionId = metadataText(snapshot.connectionId) ?? metadataText(attempt?.connectionId);
  return { kind, targetId: metadataText(targetId) ?? '', presetStatus, serviceInfo,
    ...(targetName ? { targetName } : {}), ...(roleId ? { roleId } : {}), ...(agentPreset ? { agentPreset } : {}),
    ...(service ? { service } : {}), ...(provider ? { provider } : {}), ...(connectionId ? { connectionId } : {}) };
}
function safeArtifact(input: unknown): unknown | undefined {
  if (typeof input === 'string') { try { const url = new URL(input); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? input : undefined; } catch { return undefined; } }
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  // Path-only artifacts (no url) are listed by name/path without a link; a present but unsafe url is still dropped.
  if (value.url !== undefined ? typeof value.url !== 'string' || !safeArtifact(value.url) : typeof value.path !== 'string') return undefined;
  const result: Record<string, unknown> = value.url !== undefined ? { url: value.url } : {};
  for (const key of ['name', 'path', 'mediaType', 'size', 'sha256']) if (['string', 'number'].includes(typeof value[key])) result[key] = value[key];
  return result;
}
function attemptView(attempt: LedgerAttempt, workflow = false): WorkbenchAttempt {
  const { input: _input, targetSnapshot: _snapshot, backendRunRef, ...view } = structuredClone(attempt);
  const refs: Record<string, string> = {};
  for (const key of ['provider', 'remote', 'taskId', 'contextId', 'sessionId', 'flowRunId', 'runId']) if (typeof backendRunRef?.[key] === 'string') refs[key] = backendRunRef[key];
  for (const result of [view.result, ...view.resultHistory ?? []]) if (result) {
    result.artifactLinks = result.artifactLinks.map(safeArtifact).filter(item => item !== undefined);
    if (result.resultArtifacts) result.resultArtifacts = result.resultArtifacts.map(safeArtifact).filter(item => item !== undefined);
    delete result.structuredResultRef;
  }
  return { ...view, ...(Object.keys(refs).length ? { backendRunRef: refs } : {}), execution: executionView(attempt, attempt.targetId, workflow) };
}
function eventView(event: LedgerEvent): LedgerEvent {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|password|secret|authorization|apiKey|input|prompt|endpoint/i.test(key)).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  return { ...structuredClone(event), ...(event.data === undefined ? {} : { data: clean(event.data) }) };
}
function progress(job: LedgerJob, run: PptDeliveryRun | undefined, reviews: readonly HumanReviewRequest[], attempt: LedgerAttempt | undefined, now: number): WorkbenchProgress {
  if (!run) {
    const name = purposeNames[job.purpose ?? ''] ?? '任务执行', status = attempt?.executionStatus ?? job.executionStatus;
    return { stage: job.purpose ?? 'execution', phase: attempt?.phase ?? '', stages: [{ stage: job.purpose ?? 'execution', name, status, planned: false, jobId: job.jobId, attemptId: job.currentAttemptId }],
      completedStages: status === 'completed' ? [name] : [], remainingStages: status === 'completed' ? [] : [name], updatedAt: job.updatedAt };
  }
  const review = latestReview(reviews, job), latest = (purpose: string) => [...run.children].reverse().find(child => child.purpose === purpose);
  const script = latest('project_script'), maker = latest('ppt_production'), reviewer = latest('independent_review');
  const stage = (key: string, child: typeof script, status?: string): WorkbenchStage => ({ stage: key, name: stageNames[key]!, status: status ?? child?.child.executionStatus ?? 'not_started',
    planned: !child, ...(child ? { jobId: child.child.jobId, attemptId: child.child.attemptId } : {}) });
  const stages: WorkbenchStage[] = [stage('summary', script)];
  const human = run as PptDeliveryRun & { humanWaitStartedAt?: string; humanWaitingMs?: number };
  const requireReview = (run.policy as PptDeliveryRun['policy'] & { requireHumanReview?: boolean }).requireHumanReview;
  if (review || requireReview) stages.push({ stage: 'human_review', name: stageNames.human_review!, status: review?.status ?? 'not_started', planned: !review, jobId: job.jobId, attemptId: job.currentAttemptId });
  stages.push(stage('make', maker), { stage: 'validate', name: stageNames.validate!, status: run.validation ? 'completed' : run.stage === 'validate' ? run.executionStatus : 'not_started', planned: !run.validation && run.stage !== 'validate' },
    stage('review', reviewer, run.review?.verdict === 'passed' ? 'completed' : run.review?.verdict === 'changes_requested' ? 'changes_requested' : reviewer?.child.executionStatus));
  const complete = (s: WorkbenchStage) => ['completed', 'approved'].includes(s.status);
  return { stage: review?.status === 'pending' && !terminal.has(job.executionStatus) && !terminal.has(run.executionStatus) ? 'human_review' : run.stage, phase: run.phase, stages,
    completedStages: stages.filter(complete).map(s => s.name), remainingStages: stages.filter(s => !complete(s)).map(s => s.name),
    executionElapsedMs: run.metrics.elapsedMs, humanWaitingMs: (human.humanWaitingMs ?? 0) + (human.humanWaitStartedAt && Number.isFinite(Date.parse(human.humanWaitStartedAt)) ? Math.max(0, now - Date.parse(human.humanWaitStartedAt)) : 0),
    availableResults: deliveryProgress(run).availableResults, updatedAt: run.updatedAt };
}
function pendingProcessRequest(requests: readonly ProcessRequest[], job: LedgerJob, now: number): ProcessRequest | undefined {
  return requests.filter(request => request.jobId === job.jobId && request.attemptId === job.currentAttemptId)
    .map(request => projectProcessRequest(request, now)).filter(request => request.status === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
/** Same rule as the ledger view: acceptance counts only for the current completed result revision and digest. */
function currentAcceptance(job: LedgerJob, ledger: LedgerState): BusinessAcceptance | undefined {
  const attempt = ledger.attempts[job.currentAttemptId], result = attempt?.result;
  if (attempt?.executionStatus !== 'completed' || !result?.resultAvailable) return undefined;
  return (ledger.acceptances[job.jobId] ?? []).findLast(item => item.attemptId === attempt.attemptId
    && item.resultRevision === result.resultRevision && item.resultDigest === result.resultDigest);
}
/** A tool is blocked when its latest request was not approved; an agent's retry that a person allowed clears it. */
function blockedTools(requests: readonly ProcessRequest[], job: LedgerJob, now: number): string[] {
  if (job.executionStatus !== 'completed') return [];
  const latest = new Map<string, ProcessRequest>();
  for (const request of requests.filter(request => request.kind === 'permission' && request.jobId === job.jobId && request.attemptId === job.currentAttemptId)
    .map(request => projectProcessRequest(request, now)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    latest.set(JSON.stringify([request.toolTitle ?? '', request.toolDetail ?? '']), request);
  }
  return [...latest.values()].filter(request => request.answer?.outcome !== 'approved')
    .map(request => request.toolTitle ?? '').filter((name, index, all) => name && all.indexOf(name) === index);
}
function summary(job: LedgerJob, run: PptDeliveryRun | undefined, reviews: readonly HumanReviewRequest[], ledger: LedgerState, actorId: string, requests: readonly ProcessRequest[], now: number): AcpTaskSummary {
  const attempt = ledger.attempts[job.currentAttemptId], review = latestReview(reviews, job), pending = review?.status === 'pending' && !terminal.has(job.executionStatus) && (!run || !terminal.has(run.executionStatus));
  const pendingRequest = terminal.has(job.executionStatus) ? undefined : pendingProcessRequest(requests, job, now);
  const awaitingResume = review?.resume?.status === 'pending' && !terminal.has(job.executionStatus);
  const resumeError = awaitingResume ? run?.diagnostics?.findLast(item => item.startsWith('Human continuation deferred:')) : undefined;
  const acceptance = currentAcceptance(job, ledger), blocked = blockedTools(requests, job, now);
  const toolBlocked = blocked.length > 0 && acceptance?.reviewStatus !== 'accepted';
  const displayStatus = toolBlocked ? 'tool_blocked' : pending || pendingRequest ? 'awaiting_human' : awaitingResume && !resumeError ? 'resuming' : review?.status === 'changes_requested' && !terminal.has(job.executionStatus) ? 'changes_requested' : job.executionStatus;
  const phase = pending ? 'human_review' : pendingRequest ? 'process_request' : awaitingResume ? 'human_resume' : run?.phase ?? attempt?.phase ?? job.purpose ?? '';
  const progressSummary = pending ? `${review.title}已形成，等待确认 ${review.revision}；通过后开始设计制作。`
    : pendingRequest ? (pendingRequest.kind === 'plan' ? '计划待批准，请在过程请求里提交。' : pendingRequest.kind === 'permission' ? `工具「${pendingRequest.toolTitle}」待批准，请在过程请求里提交。` : '有待回答的问题，请在过程请求里提交。')
    : awaitingResume ? resumeError ? `决定已保存，继续执行受阻：${resumeError.slice('Human continuation deferred:'.length).trim()}` : '本版决定已保存，等待系统继续处理。'
    : review?.status === 'changes_requested' && !terminal.has(job.executionStatus) ? run?.summaryRevisionPending ? '修改意见已保存，正在提交原作者。' : '修改意见已提交原作者，等待新版本。'
    : toolBlocked ? `执行已结束，但有 ${blocked.length} 个工具调用未获批准，结果可能不完整，请核对后再验收。`
    : attempt?.diagnostic || (run ? runDescription(run) : attempt?.result?.resultSummary || stateDescriptions[job.executionStatus] || '等待同步执行进展。');
  const execution = executionView(attempt, job.targetId, Boolean(run));
  const development = describeTaskDevelopment(attempt?.targetSnapshot?.development, { targetId: job.targetId, resident: execution.kind === 'resident', residentName: execution.targetName });
  return { sourceId: job.sourceId, jobId: job.jobId, title: job.title ?? `${purposeNames[job.purpose ?? ''] ?? '执行任务'} ${job.jobId.slice(0, 8)}`,
    channel: development.channel, ...(development.agentId ? { agentId: development.agentId, agentName: development.name, agentPhase: development.phase } : {}),
    originSessionId: job.originSessionId, ...(job.parentJobRef ? { parentJobRef: job.parentJobRef } : {}), ...(job.parentAttemptId ? { parentAttemptId: job.parentAttemptId } : {}),
    ...(job.purpose ? { purpose: job.purpose } : {}), targetId: job.targetId, currentAttemptId: job.currentAttemptId, executionStatus: job.executionStatus, displayStatus, phase,
    createdAt: job.createdAt, updatedAt: [job.updatedAt, review?.updatedAt, pendingRequest?.updatedAt].filter((value): value is string => Boolean(value)).sort().at(-1)!, stale: attempt?.stale ?? true,
    inFlightAttemptIds: [...job.inFlightAttemptIds], unresolvedAttemptIds: [...job.unresolvedAttemptIds], execution,
    ...(review ? { reviewStatus: review.status } : {}), ...(pending && review.reviewerId === actorId ? { pendingReviewId: review.reviewId } : {}),
    ...(pendingRequest ? { pendingProcessRequestId: pendingRequest.requestId } : {}), progressSummary,
    ...(acceptance ? { businessAcceptance: structuredClone(acceptance) } : {}), ...(blocked.length ? { blockedTools: blocked } : {}) };
}
function bubbleProcessWait(summaries: Map<string, AcpTaskSummary>): void {
  const tasks = [...summaries.values()];
  for (let depth = 0; depth < 5; depth++) {
    let changed = false;
    for (const task of tasks) {
      if (task.pendingReviewId || task.pendingProcessRequestId || terminal.has(task.executionStatus)) continue;
      const child = tasks.filter(item => item.parentJobRef?.jobId === task.jobId && item.pendingProcessRequestId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!child?.pendingProcessRequestId) continue;
      task.pendingProcessRequestId = child.pendingProcessRequestId;
      if (!['awaiting_human', 'resuming', 'changes_requested'].includes(task.displayStatus)) {
        task.displayStatus = 'awaiting_human'; task.phase = 'process_request'; task.progressSummary = child.progressSummary;
        if (child.updatedAt > task.updatedAt) task.updatedAt = child.updatedAt;
      }
      changed = true;
    }
    if (!changed) break;
  }
}

export function workbenchSnapshot(source: WorkbenchSource): WorkbenchSnapshot {
  const { ledger, actorId } = source, allowed = source.allowedOrigins ? new Set(source.allowedOrigins) : undefined;
  const jobs = Object.values(ledger.jobs).filter(job => !allowed || allowed.has(job.originSessionId));
  const visible = new Set(jobs.map(job => job.jobId)), runFor = (job: LedgerJob) => source.runs.find(run => run.jobId === job.jobId && run.attemptId === job.currentAttemptId);
  const now = source.now ?? Date.now();
  const summaries = new Map(jobs.map(job => [job.jobId, summary(job, runFor(job), source.reviews, ledger, actorId, source.processRequests ?? [], now)]));
  bubbleProcessWait(summaries);
  const details: Record<string, AcpTaskDetail> = {};
  for (const job of jobs) {
    const run = runFor(job), ownReviews = source.reviews.filter(r => r.jobId === job.jobId || r.authorJobId === job.jobId && visible.has(r.jobId));
    const ancestors: AcpTaskSummary[] = [], visited = new Set([job.jobId]); let parent = job.parentJobRef;
    while (parent?.sourceId === ledger.sourceId && visible.has(parent.jobId) && !visited.has(parent.jobId)) {
      visited.add(parent.jobId); ancestors.unshift(summaries.get(parent.jobId)!); parent = ledger.jobs[parent.jobId]?.parentJobRef;
    }
    const children = jobs.filter(child => child.parentJobRef?.sourceId === ledger.sourceId && child.parentJobRef.jobId === job.jobId).map(child => summaries.get(child.jobId)!);
    const dependencies: WorkbenchDependency[] = children.map(child => ({ from: job.jobId, to: child.jobId, kind: 'parent', label: '子任务', parentAttemptId: child.parentAttemptId }));
    if (job.parentJobRef?.sourceId === ledger.sourceId && visible.has(job.parentJobRef.jobId)) dependencies.unshift({ from: job.parentJobRef.jobId, to: job.jobId, kind: 'parent', label: '子任务', parentAttemptId: job.parentAttemptId });
    for (const related of jobs.filter(item => item.jobId === job.jobId || item.parentJobRef?.jobId === job.jobId)) {
      if (related.replacesJobRef?.sourceId === ledger.sourceId && visible.has(related.replacesJobRef.jobId)) dependencies.push({ from: related.replacesJobRef.jobId, to: related.jobId, kind: 'replaces', label: '接替执行' });
    }
    // Only this explicit domain workflow supplies ordering. Parent refs alone never imply dependencies.
    if (run) {
      const last = (purpose: string) => [...run.children].reverse().find(item => item.purpose === purpose)?.child.jobId;
      const chain = [last('project_script'), last('ppt_production'), last('independent_review')].filter((id): id is string => Boolean(id && visible.has(id)));
      for (let index = 1; index < chain.length; index++) dependencies.push({ from: chain[index - 1]!, to: chain[index]!, kind: 'depends_on', label: '阶段依赖' });
    }
    const artifacts: AcpTaskDetail['artifacts'] = [];
    for (const item of [...(run?.artifactHistory ?? []), ...(run?.validation ? [{ revision: run.revision, validation: run.validation }] : [])]) {
      if (!artifacts.some(a => a.revision === `revision-${item.revision}` && a.digest === item.validation.artifactDigest)) artifacts.push({ revision: `revision-${item.revision}`, digest: item.validation.artifactDigest, artifacts: item.validation.artifacts.map(safeArtifact).filter(a => a !== undefined) });
    }
    const attempts = Object.values(ledger.attempts).filter(attempt => attempt.jobId === job.jobId)
      .map(attempt => attemptView(attempt, source.runs.some(item => item.jobId === job.jobId && item.attemptId === attempt.attemptId)));
    if (!run) for (const attempt of attempts) {
      const pathOnly = (attempt.result?.resultArtifacts ?? []).filter(item => !(item as { url?: string }).url);
      const links = [...(attempt.result?.artifactLinks ?? []), ...pathOnly];
      if (links.length) artifacts.push({ revision: attempt.result!.resultRevision ?? attempt.attemptId, digest: attempt.result!.resultDigest, artifacts: links });
    }
    const humanEvents: LedgerEvent[] = ownReviews.flatMap(review => review.history.map((decision, index) => ({ eventId: decision.decisionId, sourceId: ledger.sourceId, sequence: -(index + 1), jobId: review.jobId,
      attemptId: review.attemptId, jobVersion: 0, type: `human_review.${decision.action}`, observedAt: decision.at,
      data: { reviewId: review.reviewId, revision: review.revision, actor: decision.actor, ...(decision.note ? { note: decision.note } : {}) } })));
    const asked = Object.values(ledger.attempts).filter(attempt => attempt.jobId === job.jobId)
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))[0]?.input as { prompt?: unknown } | undefined;
    const description = typeof asked?.prompt === 'string' && asked.prompt.trim() ? asked.prompt.slice(0, 20_000) : undefined;
    details[job.jobId] = { ...summaries.get(job.jobId)!, ...(description ? { description } : {}), attempts, children, ancestors, progress: progress(job, run, source.reviews, ledger.attempts[job.currentAttemptId], source.now ?? Date.now()),
      processRequests: (source.processRequests ?? []).filter(request => request.jobId === job.jobId || children.some(child => child.jobId === request.jobId)).map(request => {
        const projected = projectProcessRequest(request, now);
        const owner = ledger.jobs[request.jobId];
        return { ...projected, canAnswer: projected.status === 'pending' && owner?.currentAttemptId === request.attemptId && !terminal.has(owner.executionStatus) };
      }),
      reviews: ownReviews.map(review => {
        const ownerRun = source.runs.find(item => item.jobId === review.jobId && item.attemptId === review.attemptId);
        const resumeError = review.resume?.status === 'pending' ? ownerRun?.diagnostics?.findLast(item => item.startsWith('Human continuation deferred:')) : undefined;
        return { ...structuredClone(review), canReview: review.status === 'pending' && review.reviewerId === actorId && ledger.jobs[review.jobId]?.currentAttemptId === review.attemptId && !terminal.has(ledger.jobs[review.jobId]!.executionStatus)
          && !ownerRun?.cancellationRequestedAt && (!ownerRun || !terminal.has(ownerRun.executionStatus))
          && latestReview(source.reviews, ledger.jobs[review.jobId]!)?.reviewId === review.reviewId,
          ...(review.resume ? { resumeStatus: review.resume.status } : {}), ...(resumeError ? { resumeError: resumeError.slice('Human continuation deferred:'.length).trim() } : {}) };
      }),
      events: [...ledger.events.filter(event => event.jobId === job.jobId).map(eventView), ...humanEvents].sort((a, b) => a.observedAt.localeCompare(b.observedAt)), dependencies, artifacts };
  }
  for (const report of source.reportRuns ?? []) {
    const detail = details[report.jobId], task = summaries.get(report.jobId);
    if (!detail || !task || detail.currentAttemptId !== report.attemptId) continue;
    const pending = report.humanReviews.at(-1), author = report.child;
    const stages: WorkbenchStage[] = [
      { stage: 'research', name: '临时智能体分析', status: author ? ledger.attempts[author.attemptId]?.executionStatus ?? 'unknown' : 'not_started', planned: !author,
        ...(author ? { jobId: author.jobId, attemptId: author.attemptId } : {}) },
      { stage: 'file_check', name: '报告文件检查', status: report.fileCheck ? report.fileCheck.passed ? 'completed' : 'failed' : 'not_started', planned: !report.fileCheck },
      { stage: 'human_review', name: '人工最终确认', status: pending?.status ?? 'not_started', planned: !pending, jobId: report.jobId, attemptId: report.attemptId },
    ];
    if (!detail.pendingProcessRequestId) {
      task.progressSummary = report.resultSummary ?? '临时智能体正在分析项目，输出报告后进行文件检查与人工最终确认。';
      detail.progressSummary = task.progressSummary;
    }
    detail.progress = { stage: report.stage, phase: report.phase, stages,
      completedStages: stages.filter(stage => ['completed', 'approved'].includes(stage.status)).map(stage => stage.name),
      remainingStages: stages.filter(stage => !['completed', 'approved'].includes(stage.status)).map(stage => stage.name), updatedAt: report.updatedAt };
  }
  return structuredClone({ sourceId: ledger.sourceId, tasks: byNewest([...summaries.values()]), details });
}

export function listWorkbenchTasks(snapshot: WorkbenchSnapshot, query: WorkbenchListQuery = {}) {
  const filter = query.filter ?? 'all', offset = Math.max(0, Math.trunc(query.offset ?? 0)), limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50)));
  const rootIds = new Set(snapshot.tasks.filter(task => !task.parentJobRef || !Object.hasOwn(snapshot.details, task.parentJobRef.jobId)).map(task => task.jobId));
  const needsPerson = (task: AcpTaskSummary) => Boolean(task.pendingReviewId || task.pendingProcessRequestId);
  const isWorking = (task: AcpTaskSummary) => task.displayStatus === 'resuming' || !needsPerson(task) && ['working', 'submitted', 'not_started'].includes(task.executionStatus);
  const isFailed = (task: AcpTaskSummary) => task.unresolvedAttemptIds.length > 0 || task.displayStatus === 'tool_blocked' || ['failed', 'rejected', 'unknown', 'auth_required', 'input_required'].includes(task.executionStatus) && !['awaiting_human', 'resuming'].includes(task.displayStatus);
  const roots = snapshot.tasks.filter(task => rootIds.has(task.jobId));
  const counts = { all: roots.length, pending: roots.filter(needsPerson).length, working: roots.filter(isWorking).length, failed: roots.filter(isFailed).length };
  const matches = snapshot.tasks.filter(task => filter === 'all' ? true : filter === 'pending' ? needsPerson(task) : filter === 'working' ? isWorking(task) : isFailed(task));
  return { items: structuredClone(matches.slice(offset, offset + limit)), total: matches.length, counts, offset, limit };
}

export function listWorkbenchAgents(snapshot: WorkbenchSnapshot, catalog: { drafts: readonly AgentDraft[]; releases: readonly AgentRelease[] }, residents: readonly ResidentAgentRef[] = []): { developing: WorkbenchAgentRow[]; published: WorkbenchAgentRow[] } {
  const tasks: AgentTaskRef[] = snapshot.tasks.map(task => ({ ...(task.agentId ? { agentId: task.agentId } : {}), ...(task.pendingReviewId ? { pendingReviewId: task.pendingReviewId } : {}), ...(task.pendingProcessRequestId ? { pendingProcessRequestId: task.pendingProcessRequestId } : {}) }));
  return projectWorkbenchAgents({ ...catalog, residents }, tasks);
}

export function getWorkbenchTask(snapshot: WorkbenchSnapshot, jobId: string): AcpTaskDetail {
  const detail = Object.hasOwn(snapshot.details, jobId) ? snapshot.details[jobId] : undefined;
  if (!detail) throw new Error('Task not found in authorized scope');
  return structuredClone(detail);
}
