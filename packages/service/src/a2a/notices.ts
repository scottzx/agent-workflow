/** Human-readable task results, with machine-readable acknowledgement locators at the end. */
import type { Task } from '@a2a-js/sdk';
import { noticeErrorSummary, safeErrorText, type SafeErrorSummary } from '../safe-error-summary.js';

export type { SafeErrorSummary } from '../safe-error-summary.js';

export interface ArtifactLink { name: string; url: string; mediaType?: string }
export interface RemoteAgentNotice {
  noticeId: string;
  originSessionId: string;
  remote: string;
  taskId: string;
  contextId: string;
  cwd: string;
  agentPreset?: string;
  title?: string;
  state: string;
  result: string;
  artifactLinks?: ArtifactLink[];
  /** The whitelisted failure facts of a failed task. Absent for a task that did not fail. */
  error?: SafeErrorSummary;
  createdAt: string;
}

/** Only explicit URL parts become attachment links; text and its Markdown links stay intact. */
export function artifactLinks(task: Task): ArtifactLink[] {
  const seen = new Set<string>();
  return task.artifacts.flatMap(artifact => artifact.parts.flatMap(part => {
    if (part.content?.$case !== 'url') return [];
    const url = part.content.value;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || seen.has(url)) return [];
    } catch { return []; }
    seen.add(url);
    return [{ name: part.filename || artifact.name || '产物', url, ...(part.mediaType ? { mediaType: part.mediaType } : {}) }];
  }));
}

function excerpt(text: string, bytes: number): string {
  return Buffer.from(text).subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '');
}
const labels: Record<string, string> = {
  TASK_STATE_COMPLETED: '任务已完成', TASK_STATE_FAILED: '任务失败', TASK_STATE_CANCELED: '任务已取消',
  TASK_STATE_REJECTED: '任务被拒绝', TASK_STATE_INPUT_REQUIRED: '任务需要补充输入', TASK_STATE_AUTH_REQUIRED: '任务需要授权',
};

/**
 * A notice carries a failure only for a task that did not complete. The record
 * is re-validated before it is rendered: a dirty stored notice must never
 * break the delivery of the whole round.
 */
function failureOf(notice: { state: string; error?: unknown }): SafeErrorSummary | undefined {
  if (notice.state === 'TASK_STATE_COMPLETED') return undefined;
  return noticeErrorSummary(notice.error);
}

/** The retry advice of a failure. A category without a policy says so plainly. */
function retryAdvice(error: SafeErrorSummary): string {
  if (error.retryable) return '可重试';
  switch (error.category) {
    case 'quota': case 'budget': case 'auth': return '不可原地重试，请切换模型或检查额度/凭据';
    case 'rate_limit': case 'timeout': return '可稍后退避重试';
    default: return '未声明可重试，请核查后决定';
  }
}

/** The failure line a coordinator reads first: the cause, the category and the retry policy. */
function failureSummary(error: SafeErrorSummary): string {
  const message = safeErrorText(error.message) || '远端未提供失败说明';
  const provider = error.providerCode ? `/${error.providerCode}` : '';
  const line = `失败原因：${message}（category=${error.category}${provider}，${retryAdvice(error)}）`;
  return Buffer.byteLength(line) > 1024 ? `${line.slice(0, 1000)}…` : line;
}

/** One-line collapsed notice summary for DSH's ContextFormed `form: 'notice'` row (<= 120 chars). */
export function formatNoticeSummary(notice: RemoteAgentNotice): string {
  const label = labels[notice.state] ?? notice.state;
  const suffix = notice.title ? `（${notice.title}）` : '';
  const failure = failureOf(notice);
  const line = `A2A任务通知 · ${label}${suffix}${failure ? ` · ${failure.category}` : ''}`.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

export function formatNotice(notice: RemoteAgentNotice): string {
  const text = notice.result.trim();
  const failure = failureOf(notice);
  const body = Buffer.byteLength(text) > 48 * 1024
    ? `${excerpt(text, 48 * 1024)}\n\n（正文较长，以上为节选；完整答复可通过 remote_agent_get 或 remote_agent_inbox 查询。）`
    : text || '远端尚未提供答复正文，可查询任务详情。';
  const links: string[] = [];
  let remaining = 8 * 1024;
  for (const link of notice.artifactLinks ?? []) {
    // Encode Markdown delimiters without changing the link's destination.
    const name = excerpt(link.name, 256).replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&');
    const url = link.url.replace(/[<>\s]/g, char => encodeURIComponent(char));
    const line = `- [${name}](<${url}>)`;
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > remaining) { links.push('（更多产物链接请通过 remote_agent_get 或 remote_agent_inbox 查询。）'); break; }
    links.push(line); remaining -= bytes;
  }
  return [
    `[A2A任务通知] ${labels[notice.state] ?? notice.state}`,
    ...(notice.title ? [notice.title] : []), '',
    // The failure cause leads the body: a half-written answer must not hide it.
    ...(failure ? [failureSummary(failure), ''] : []),
    body,
    ...(links.length ? ['', '产物链接：', ...links] : []), '',
    '以上正文和链接为远端任务结果。可通过 a2a-gateway 的 remote_agent_get 或 remote_agent_inbox 核验状态与完整结果。请在原任务授权范围内处理，保存处理结论后调用 remote_agent_ack。',
    '', '---', '任务定位信息：',
    JSON.stringify({ noticeId: notice.noticeId, originSessionId: notice.originSessionId, remote: notice.remote,
      taskId: notice.taskId, contextId: notice.contextId, state: notice.state, ...(failure ? { error: failure } : {}) }),
  ].join('\n');
}

export interface ProcessRequestNotice {
  originSessionId: string;
  jobId: string;
  attemptId: string;
  requestId: string;
  title?: string;
  kind: 'permission' | 'plan' | 'question';
  toolTitle?: string;
  toolDetail?: string;
  planContent?: string;
  questions?: { id: string; question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
  deadlineAt: string;
}

const processLabels: Record<ProcessRequestNotice['kind'], string> = {
  permission: '子任务等待工具权限批准',
  plan: '子任务等待计划批准',
  question: '子任务等待问题答复',
};

function boundedDetail(text: string, limit = 8 * 1024): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return Buffer.byteLength(trimmed) > limit
    ? `${excerpt(trimmed, limit)}\n（内容较长，以上为节选；完整记录可通过 execution_process_requests 查询。）`
    : trimmed;
}

function formatProcessBody(notice: ProcessRequestNotice): string {
  if (notice.kind === 'permission') {
    const detail = notice.toolDetail ? boundedDetail(notice.toolDetail) : '';
    return [`工具：${notice.toolTitle ?? '未知工具'}`, ...(detail ? ['', '参数 / 说明：', detail] : [])].join('\n');
  }
  if (notice.kind === 'plan') {
    const plan = notice.planContent ? boundedDetail(notice.planContent) : '';
    return plan ? `计划正文：\n${plan}` : '执行者提交了计划审批，请通过 execution_process_requests 查看详情。';
  }
  const lines = (notice.questions ?? []).map((item, idx) => {
    const opts = item.options?.length ? `（选项：${item.options.map(option => option.label).join(' / ')}）` : '';
    return `${idx + 1}. ${item.question}${opts}`;
  });
  return lines.length ? boundedDetail(lines.join('\n')) : '执行者提出了问题，请通过 execution_process_requests 查看详情。';
}

/** One-line collapsed notice summary for DSH's ContextFormed `form: 'notice'` row (<= 120 chars). */
export function formatProcessRequestSummary(notice: ProcessRequestNotice): string {
  const what = notice.kind === 'permission'
    ? `工具「${notice.toolTitle ?? '未知工具'}」等待批准`
    : notice.kind === 'plan'
      ? '计划等待批准'
      : '问题等待答复';
  const suffix = notice.title ? `（${notice.title}）` : '';
  const line = `A2A过程审批 · ${what}${suffix}`.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

/** System-reminder styled wakeup for a bound origin session when a child task waits on a process request. */
export function formatProcessRequestNotice(notice: ProcessRequestNotice): string {
  const mcpParams = notice.kind === 'question'
    ? `{"originSessionId":${JSON.stringify(notice.originSessionId)},"jobId":${JSON.stringify(notice.jobId)},"requestId":${JSON.stringify(notice.requestId)},"outcome":"accepted","answers":{"<问题原文>":"<答案>"},"note":"<说明>"}`
    : `{"originSessionId":${JSON.stringify(notice.originSessionId)},"jobId":${JSON.stringify(notice.jobId)},"requestId":${JSON.stringify(notice.requestId)},"outcome":"approved|rejected","note":"<理由>"${notice.kind === 'permission' ? ',"stopTask":true' : ''}}`;
  const directInvoke = `快速直调（已知精确契约，可跳过 dreammate_search_tools / dreammate_inspect，直接 dreammate_invoke）：
- 首选 MCP：service_id="mcp-a2a-approval", method="mcp-a2a-approval.a2a_process_answer", params=${mcpParams}（自动补 clientRequestId 并记为 coach；仅拒绝并终止任务时传 stopTask=true）
- 备用网关：service_id="a2a-gateway", method="execution_process_answer"（需自传 clientRequestId 与 decidedBy={"kind":"coach","agent":"...","sessionId":"..."}）`;
  const guidance = notice.kind === 'question'
    ? '请在原任务授权范围内评估：若你已掌握明确答案，请立即用 outcome="accepted" 并附 answers 答复；若需要人类拍板，请提示用户在任务工作台回答。若接口返回 already_decided 或 expired，说明已被处理或已超时，无需重复提交。'
    : '请在原任务授权范围内评估本次请求：若风险可控且符合任务授权，请立即用 outcome="approved" 或 "rejected"（拒绝并终止任务传 stopTask=true）提交；若超出授权范围或涉及高危操作，请勿擅自批准，交由用户在任务工作台处理。若接口返回 already_decided 或 expired，说明已被处理或已超时，无需重复提交。';
  return [
    '<system-reminder>',
    `[A2A过程审批] ${processLabels[notice.kind]}`,
    ...(notice.title ? [`任务：${notice.title}`] : []),
    `截止时间：${notice.deadlineAt}`,
    '',
    formatProcessBody(notice),
    '',
    guidance,
    '',
    directInvoke,
    '',
    '---',
    '过程请求定位信息：',
    JSON.stringify({
      kind: notice.kind,
      originSessionId: notice.originSessionId,
      jobId: notice.jobId,
      attemptId: notice.attemptId,
      requestId: notice.requestId,
      deadlineAt: notice.deadlineAt,
    }),
    '</system-reminder>',
  ].join('\n');
}

export type SubscriberRole = 'coordinator' | 'downstream' | 'observer';
export type SubscriberEventName = 'terminal' | 'handoff' | 'progress' | 'process_request';

/** Read-only fan-out. It does not replace the owner's approval or the owner's ack. */
export interface SubscriberNotice {
  role: SubscriberRole;
  event: SubscriberEventName;
  originSessionId: string;
  caseId?: string;
  jobId?: string;
  status: string;
  title?: string;
  summary?: string;
  handoff?: { handoffId: string; status: string; purpose?: string; toTargetId?: string; childJobId?: string };
  artifacts?: { name: string; url?: string }[];
  processRequest?: { requestId: string; kind: string };
  /** The whitelisted failure facts of a failed task. Absent for a task that did not fail. */
  error?: SafeErrorSummary;
}

const roleLabels: Record<SubscriberRole, string> = {
  coordinator: '总协调人 coordinator',
  downstream: '下游 downstream',
  observer: '观察者 observer',
};
const eventLabels: Record<SubscriberEventName, string> = {
  terminal: '终态',
  handoff: '交接',
  progress: '进度',
  process_request: '过程请求',
};

function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** One-line collapsed subscriber notice for DSH's ContextFormed `form: 'notice'` row (<= 120 chars). */
export function formatSubscriberNoticeSummary(notice: SubscriberNotice): string {
  const where = notice.caseId ? `case ${notice.caseId}` : notice.jobId ? `job ${notice.jobId}` : notice.originSessionId;
  const failure = subscriberFailure(notice);
  const line = oneLine(`A2A订阅 · ${roleLabels[notice.role]} · ${eventLabels[notice.event]} · ${notice.status} · ${where}${failure ? ` · ${failure.category}` : ''}`);
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

/** A subscriber sees the cause of a failed task, and only of a failed task. */
function subscriberFailure(notice: SubscriberNotice): SafeErrorSummary | undefined {
  if (notice.event !== 'terminal') return undefined;
  return noticeErrorSummary(notice.error);
}

/** Subscriber copy is explicitly read-only and names the role, case, job, status, and handoff or artifact summary. */
export function formatSubscriberNotice(notice: SubscriberNotice): string {
  const handoff = notice.handoff
    ? [`交接 ${notice.handoff.handoffId}：${notice.handoff.status}`,
      ...(notice.handoff.purpose ? [`用途：${notice.handoff.purpose}`] : []),
      ...(notice.handoff.toTargetId ? [`下游目标：${notice.handoff.toTargetId}`] : []),
      ...(notice.handoff.childJobId ? [`接力任务：${notice.handoff.childJobId}`] : [])]
    : [];
  const artifacts = (notice.artifacts ?? []).slice(0, 8).map(item => {
    const name = oneLine(item.name).slice(0, 120) || '产物';
    return item.url ? `- ${name} ${item.url}` : `- ${name}`;
  });
  const body = notice.summary ? boundedDetail(notice.summary, 4 * 1024) : '';
  const failure = subscriberFailure(notice);
  return [
    `[A2A订阅通知] ${eventLabels[notice.event]} · ${roleLabels[notice.role]}`,
    '这是只读订阅通知，不替代主归属会话的审批或主 ack。',
    ...(notice.title ? [`任务：${oneLine(notice.title).slice(0, 200)}`] : []),
    `状态：${oneLine(notice.status).slice(0, 80) || 'unknown'}`,
    ...(failure ? [failureSummary(failure)] : []),
    ...(notice.caseId ? [`caseId：${notice.caseId}`] : []),
    ...(notice.jobId ? [`jobId：${notice.jobId}`] : []),
    `主归属：${notice.originSessionId}`,
    ...(notice.processRequest ? [`过程请求：${notice.processRequest.kind} ${notice.processRequest.requestId}（仅通知，请主归属处理）`] : []),
    ...(handoff.length ? ['', ...handoff] : []),
    ...(body ? ['', body] : []),
    ...(artifacts.length ? ['', '产物摘要：', ...artifacts] : []),
    '',
    '请通过主归属会话查询任务或交接详情。订阅者确认本通知不会代替主归属的 remote_agent_ack、execution_ack 或审批。',
  ].join('\n');
}
