/** One task's record from one query: who asked, what ran, who approved what, what came out, who read it. */
import { parseArgs } from 'node:util';
import type { LedgerActor, LedgerEvent, LedgerJobView } from '../src/execution/ledger.js';
import type { WorkbenchProcessRequest } from '../src/execution/workbench.js';
import { gatewayInvoke } from './rsi.js';

const USAGE = `Usage: acp-service trail --job ID [--origin ID] [--url URL]

Prints the record of one task. --origin is the session that started it (default rsi-cli);
--url is the gateway (default http://127.0.0.1:36814).`;

const actor = (by?: LedgerActor) => !by ? '未记录' : by.kind === 'person' ? '人' : `教练 ${[by.agent, by.sessionId].filter(Boolean).join(' ')}`;

export function describeTrail(job: LedgerJobView, requests: WorkbenchProcessRequest[], events: LedgerEvent[]): string {
  const lines = [`${job.title ?? job.jobId}（${job.executionStatus}）`, `任务：${job.jobId}`,
    `发起：${actor(job.initiatedBy)}（来源 ${job.originSessionId}）`];
  if (job.parentJobRef) lines.push(`上级任务：${job.parentJobRef.jobId}${job.purpose ? `（${job.purpose}）` : ''}`);
  lines.push('', `执行（${job.attempts.length} 轮）：`);
  for (const attempt of job.attempts) {
    const { remote, agentPreset, cwd } = attempt.targetSnapshot as { remote?: string; agentPreset?: string; cwd?: string };
    lines.push(`- ${attempt.attemptId} ${attempt.executionStatus}，${[attempt.targetId, remote, agentPreset, cwd].filter(Boolean).join(' · ')}，发起：${actor(attempt.initiatedBy)}`);
    if (attempt.result?.resultRevision) lines.push(`  结果 ${attempt.result.resultRevision}，摘要 ${attempt.result.resultDigest ?? '无'}`);
  }
  lines.push('', `过程审批（${requests.length} 条）：`);
  for (const { requestId, kind, toolTitle, status, answer } of requests) {
    lines.push(`- ${requestId} ${toolTitle ?? kind}：${answer ? `${answer.outcome}，${actor(answer.decidedBy)}${answer.note ? `：${answer.note}` : ''}` : status}`);
  }
  lines.push('', `验收（${job.acceptanceHistory.length} 条）：`);
  for (const item of job.acceptanceHistory) {
    lines.push(`- ${item.recordedAt} ${item.reviewStatus}，${actor(item.decidedBy)}，结果 ${item.resultRevision}${item.note ? `：${item.note}` : ''}`);
  }
  if (job.children.length) {
    lines.push('', `子任务（${job.children.length} 个）：`);
    for (const child of job.children) lines.push(`- ${child.jobId} ${child.executionStatus}${child.purpose ? `（${child.purpose}）` : ''} ${child.title ?? ''}`.trimEnd());
  }
  lines.push('', `事件（${events.length} 条）：`);
  for (const event of events) lines.push(`- ${event.observedAt} ${event.type}`);
  return lines.join('\n');
}

export async function runTrailCli(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  const { values } = parseArgs({ args: argv, strict: true, options: {
    job: { type: 'string' }, origin: { type: 'string', default: 'rsi-cli' }, url: { type: 'string', default: 'http://127.0.0.1:36814' },
  } });
  if (!values.job) throw new Error('--job is required');
  const invoke = gatewayInvoke(values.url!), scope = { originSessionId: values.origin!, jobId: values.job };
  const job = await invoke('execution_get', scope) as unknown as LedgerJobView;
  // A gateway without a workbench has no process requests to read.
  const { requests = [] } = await invoke('execution_process_requests', scope).catch(() => ({})) as { requests?: WorkbenchProcessRequest[] };
  const events: LedgerEvent[] = [];
  for (let afterSequence: number | undefined; ;) {
    const page = await invoke('execution_events', { ...scope, limit: 500, ...(afterSequence === undefined ? {} : { afterSequence }) }) as unknown as { events: LedgerEvent[]; hasMore: boolean; nextSequence?: number };
    events.push(...page.events);
    if (!page.hasMore) break;
    afterSequence = page.nextSequence;
  }
  console.log(describeTrail(job, requests, events));
}
