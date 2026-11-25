/** Human-readable task results, with machine-readable acknowledgement locators at the end. */
import type { Task } from '@a2a-js/sdk';

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

/** One-line collapsed notice summary for DSH's ContextFormed `form: 'notice'` row (<= 120 chars). */
export function formatNoticeSummary(notice: RemoteAgentNotice): string {
  const label = labels[notice.state] ?? notice.state;
  const suffix = notice.title ? `（${notice.title}）` : '';
  const line = `A2A任务通知 · ${label}${suffix}`.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

export function formatNotice(notice: RemoteAgentNotice): string {
  const text = notice.result.trim();
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
    ...(notice.title ? [notice.title] : []), '', body,
    ...(links.length ? ['', '产物链接：', ...links] : []), '',
    '以上正文和链接为远端任务结果。可通过 a2a-gateway 的 remote_agent_get 或 remote_agent_inbox 核验状态与完整结果。请在原任务授权范围内处理，保存处理结论后调用 remote_agent_ack。',
    '', '---', '任务定位信息：',
    JSON.stringify({ noticeId: notice.noticeId, originSessionId: notice.originSessionId, remote: notice.remote,
      taskId: notice.taskId, contextId: notice.contextId, state: notice.state }),
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
