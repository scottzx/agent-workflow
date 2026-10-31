/**
 * People's and the coach's view of a task ticket on the gateway and their one change, settling a proposal; and the
 * executor's three operations for an agent that has a shell but neither the DSH tools nor the MCP server.
 */
import { parseArgs } from 'node:util';
import type { Ticket } from '../src/execution/ticket.js';
import { runExecutorTicket } from '../src/execution/ticket-executor.js';
import { gatewayInvoke } from './rsi.js';

const USAGE = `Usage: acp-service ticket show --job ID [--origin ID] [--url URL]
       acp-service ticket events --job ID [--origin ID] [--url URL]
       acp-service ticket proposal --job ID --id R1-2 accept|reject|done [--note TEXT] [--origin ID] [--url URL]

The executor, from its own shell while its round is running:
       acp-service ticket pending --job ID [--url URL]
       acp-service ticket mark --job ID --id Q1-3 --state done|disputed --note TEXT [--url URL]
       acp-service ticket submit --job ID [--url URL]

The task ticket lives on the executor's job in the gateway's execution ledger; every change is a
ticket.* event. The job ID is the executor's jobId in the run's run.json. The executor's commands
act for the job's current round, the same operations as its ticket_show, ticket_mark and
ticket_submit tools, and are recorded as coming from the CLI.

Options:
  --origin ID   originSessionId the job was submitted under (default rsi-cli)
  --url URL     gateway (default http://127.0.0.1:36814)`;

const states = { accept: 'accepted', reject: 'rejected', done: 'done' } as const;

/**
 * Who settles a proposal, read from the environment the command runs in rather than from a flag: a coach agent's
 * harness marks its own shell with the session it runs in (Claude Code sets CLAUDECODE and CLAUDE_CODE_SESSION_ID);
 * anyone else is a person. Like the executor's tools, this does not defend against a caller faking that environment.
 */
export function settler(env: NodeJS.ProcessEnv = process.env): { kind: 'person' | 'coach'; agent?: string; sessionId?: string } {
  if (env.CLAUDECODE === '1' && env.CLAUDE_CODE_SESSION_ID) return { kind: 'coach', agent: 'claude-code', sessionId: env.CLAUDE_CODE_SESSION_ID };
  return { kind: 'person' };
}

export async function runTicketCli(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  if (!['show', 'events', 'proposal', 'pending', 'mark', 'submit'].includes(argv[0]!)) throw new Error('Unknown ticket command; use ticket --help');
  const { values, positionals } = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: true, options: {
    job: { type: 'string' }, id: { type: 'string' }, note: { type: 'string' }, state: { type: 'string' },
    origin: { type: 'string', default: 'rsi-cli' }, url: { type: 'string', default: 'http://127.0.0.1:36814' },
  } });
  if (!values.job) throw new Error('--job is required');
  const invoke = gatewayInvoke(values.url!), scope = { originSessionId: values.origin!, jobId: values.job };
  if (argv[0] === 'pending' || argv[0] === 'mark' || argv[0] === 'submit') {
    if (argv[0] === 'mark' && (!values.id || !values.state || values.note === undefined)) throw new Error('Use: ticket mark --job ID --id Q1-3 --state done|disputed --note TEXT');
    const result = await runExecutorTicket(invoke, { jobId: values.job }, 'cli', argv[0] === 'pending' ? 'ticket_show' : `ticket_${argv[0]}`,
      { id: values.id, state: values.state, note: values.note });
    console.log(result.text);
    if (result.refused) process.exitCode = 1;
    return;
  }
  if (argv[0] === 'show') return print(await invoke('ticket_get', scope) as unknown as Ticket);
  if (argv[0] === 'events') {
    for (let after = 0; ;) {
      const page = await invoke('execution_events', { ...scope, afterSequence: after, limit: 500 }) as { events: { sequence: number; type: string; observedAt: string; data?: Record<string, unknown> }[]; hasMore: boolean };
      for (const event of page.events.filter(item => item.type.startsWith('ticket.'))) {
        const { actor, round, itemId, proposalId, state, note } = event.data ?? {};
        console.log([event.sequence, event.observedAt, event.type, actor, `第 ${String(round)} 轮`, itemId ?? proposalId, state, note].filter(part => part !== undefined).join('  '));
      }
      if (!page.hasMore || !page.events.length) return;
      after = page.events.at(-1)!.sequence;
    }
  }
  const state = states[positionals[0] as keyof typeof states];
  if (!values.id || !state || positionals.length !== 1) throw new Error('Use: ticket proposal --job ID --id R1-2 accept|reject|done [--note TEXT]');
  print(await invoke('ticket_proposal', { ...scope, proposalId: values.id, state, ...(values.note ? { note: values.note } : {}), by: settler() }) as unknown as Ticket);
}

function print(ticket: Ticket): void {
  console.log(`任务单 ${ticket.roleId} / ${ticket.caseId}：${ticket.status}${ticket.stopReason ? `（${ticket.stopReason}）` : ''}，第 ${ticket.round} 轮`);
  for (const item of ticket.items) {
    console.log(`  ${item.id} [${item.severity === 'must' ? '必须改' : '建议改'}] ${item.state}  ${item.where}：${item.problem}`);
    for (const entry of item.log) console.log(`      第 ${entry.round} 轮 ${entry.by} ${entry.action}${entry.note ? `：${entry.note}` : ''}`);
  }
  for (const proposal of ticket.proposals) {
    const by = proposal.by ? `（${proposal.by.kind === 'coach' ? `教练 ${proposal.by.agent ?? ''} ${proposal.by.sessionId ?? ''}`.trim() : '人'}）` : '';
    console.log(`  ${proposal.id} 提议（${proposal.kind}）${proposal.state}${by}：${proposal.text}${proposal.note ? `  ——${proposal.note}` : ''}`);
  }
}
