/**
 * The coach's view of an executor's process requests (tool approvals, questions, plans) and its answer to them, the
 * same record the workbench page answers. Who decided is read from the environment, as for ticket proposals.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { WorkbenchProcessRequest } from '../src/execution/workbench.js';
import { gatewayInvoke } from './rsi.js';
import { settler } from './ticket.js';

const USAGE = `Usage: acp-service process list --job ID [--origin ID] [--url URL]
       acp-service process answer --job ID --id REQUEST approve|reject [--note TEXT] [--stop] [--origin ID] [--url URL]

An executor's request beyond its preset (a tool approval, a question or a plan) waits on its job until
someone answers it, here or on the workbench page. Answered from a coach agent's shell (Claude Code), the
answer is recorded as the coach and its session; otherwise as a person. --note gives the reason, and
--stop rejects and cancels the task. Questions are answered on the workbench page.

Options:
  --origin ID   originSessionId the job was submitted under (default rsi-cli)
  --url URL     gateway (default http://127.0.0.1:36814)`;

const outcomes = { approve: 'approved', reject: 'rejected' } as const;

/** One line per request: what was asked, its state, and the answer with who gave it and why. */
export function describeRequest(request: WorkbenchProcessRequest): string {
  const asked = request.kind === 'permission' ? `工具 ${request.toolTitle}` : request.kind === 'plan' ? '计划审批'
    : `提问 ${request.questions?.map(question => question.question).join('；')}`;
  const answer = request.answer;
  const by = answer?.decidedBy?.kind === 'coach' ? `教练 ${answer.decidedBy.agent ?? ''} ${answer.decidedBy.sessionId ?? ''}`.trim() : answer ? '人' : '';
  return `${request.requestId} [${request.status}] ${asked}${answer ? `  ——${answer.outcome}（${by}）${answer.note ? `：${answer.note}` : ''}` : ''}`;
}

export async function runProcessCli(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  if (argv[0] !== 'list' && argv[0] !== 'answer') throw new Error('Unknown process command; use process --help');
  const { values, positionals } = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: true, options: {
    job: { type: 'string' }, id: { type: 'string' }, note: { type: 'string' }, stop: { type: 'boolean', default: false },
    origin: { type: 'string', default: 'rsi-cli' }, url: { type: 'string', default: 'http://127.0.0.1:36814' },
  } });
  if (!values.job) throw new Error('--job is required');
  const invoke = gatewayInvoke(values.url!), scope = { originSessionId: values.origin!, jobId: values.job };
  if (argv[0] === 'list') {
    const { requests } = await invoke('execution_process_requests', scope) as unknown as { requests: WorkbenchProcessRequest[] };
    for (const request of requests) console.log(describeRequest(request));
    if (!requests.length) console.log('这个任务没有过程请求');
    return;
  }
  const outcome = outcomes[positionals[0] as keyof typeof outcomes];
  if (!values.id || !outcome || positionals.length !== 1) throw new Error('Use: process answer --job ID --id REQUEST approve|reject [--note TEXT] [--stop]');
  const answered = await invoke('execution_process_answer', { ...scope, requestId: values.id, clientRequestId: `cli:${randomUUID()}`, outcome,
    ...(values.note ? { note: values.note } : {}), ...(values.stop ? { stopTask: true } : {}), decidedBy: settler() }) as unknown as WorkbenchProcessRequest;
  console.log(describeRequest(answered));
}
