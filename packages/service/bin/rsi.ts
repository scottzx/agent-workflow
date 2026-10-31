/** Coach-facing runs of a role's cases through the local A2A gateway. Publishing and acceptance stay on the workbench page. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkGate } from '../src/rsi/gate.js';
import { runOutlineCase } from '../src/rsi/outline-run.js';

const USAGE = `Usage: acp-service rsi run --role DIR --case ID --project REPO [options]
       acp-service rsi gate --role DIR [--workspace DIR] [--required N] [--url URL]

Runs one case of a product-intro outline role: exports the pinned commit, dispatches the
executor, runs the role's program checks and sends failures back to the same session.
With --qa, a QA agent then reviews each outline that passes the checks in its own session
against the role's QA.md, and its issues go back to the executor. Each run is appended to
the role's ledger.jsonl in the workspace. The task ticket lives on the executor's job in the gateway;
the run directory's ticket.json is a read-only export (see acp-service ticket --help).

rsi gate reads the ledger and says whether the committed role version may leave development:
N development runs in a row passed (default 2), each first draft passed the program checks,
QA left no must-fix issue, and every proposal to codify a check or change a locked item has
been settled on the ticket (acp-service ticket proposal). Runs whose executor or QA task did
not finish are not counted.

Options:
  --target ID            agent_host target on the gateway (default legacy:ppt-beautifier)
  --preset ID            DSH agent preset for the executor (default standard)
  --origin ID            originSessionId for the tasks (default rsi-cli)
  --workspace DIR        where run directories go (default .1agents/runtime/rsi)
  --url URL              gateway (default http://127.0.0.1:36814)
  --max-bounces N        times a failed check goes back (default 1)
  --timeout-minutes N    per round (default 30)
  --python PATH          interpreter with jsonschema for the checks (default python3)
  --qa                   add the QA agent review after the program checks
  --qa-preset ID         DSH agent preset for the QA agent (default: the executor's)
  --qa-max-revisions N   times QA issues go back to the executor (default 3)
  --phase dev|test       test needs a committed role directory, --qa and an open gate (default dev)`;

/** Calls methods on the local gateway's /invoke route. */
export function gatewayInvoke(url: string) {
  const endpoint = new URL('/invoke', url);
  return async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`${method} failed: ${String(data.error ?? response.status)}`);
    return data;
  };
}

export async function runRsiCli(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  if (argv[0] === 'gate') return runGate(argv.slice(1));
  if (argv[0] !== 'run') throw new Error('Unknown rsi command; use rsi --help');
  const { values } = parseArgs({ args: argv.slice(1), strict: true, options: {
    role: { type: 'string' }, case: { type: 'string' }, project: { type: 'string' },
    target: { type: 'string', default: 'legacy:ppt-beautifier' }, preset: { type: 'string', default: 'standard' },
    origin: { type: 'string', default: 'rsi-cli' }, workspace: { type: 'string', default: '.1agents/runtime/rsi' },
    url: { type: 'string', default: 'http://127.0.0.1:36814' }, 'max-bounces': { type: 'string', default: '1' },
    'timeout-minutes': { type: 'string', default: '30' }, python: { type: 'string', default: 'python3' },
    qa: { type: 'boolean', default: false }, 'qa-preset': { type: 'string' }, 'qa-max-revisions': { type: 'string', default: '3' },
    phase: { type: 'string', default: 'dev' },
  } });
  if (!values.role || !values.case || !values.project) throw new Error('--role, --case and --project are required');
  if (values.phase !== 'dev' && values.phase !== 'test') throw new Error('--phase is dev or test');
  if (values.phase === 'test') {
    const gate = await checkGate({ roleDirectory: resolve(values.role), workspace: resolve(values.workspace!), invoke: gatewayInvoke(values.url!) });
    if (!gate.ready) throw new Error(`The role has not left development yet:\n- ${gate.reasons.join('\n- ')}`);
  }
  const invoke = gatewayInvoke(values.url!);
  const report = await runOutlineCase({ roleDirectory: resolve(values.role), caseId: values.case, projectPath: resolve(values.project),
    workspace: resolve(values.workspace!), phase: values.phase, targetId: values.target!, agentPreset: values.preset!, originSessionId: values.origin!,
    maxBounces: Number(values['max-bounces']), timeoutMs: Number(values['timeout-minutes']) * 60_000, python: values.python!,
    ...(values.qa ? { qa: { ...(values['qa-preset'] ? { agentPreset: values['qa-preset'] } : {}), maxRevisions: Number(values['qa-max-revisions']) } } : {}),
    ticketCli: { command: `${process.execPath} ${fileURLToPath(new URL('./acp-service.js', import.meta.url))} ticket`, url: values.url! },
    invoke, log: line => console.log(line) });
  console.log(`${report.passed ? '通过' : '未通过'}（${report.stopReason}）：${report.rounds.length} 轮，大纲 ${report.outlinePath}，记录 ${report.workDirectory}/run.json`);
  if (!report.passed) process.exitCode = 1;
}


async function runGate(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    role: { type: 'string' }, workspace: { type: 'string', default: '.1agents/runtime/rsi' }, required: { type: 'string', default: '2' },
    url: { type: 'string', default: 'http://127.0.0.1:36814' },
  } });
  if (!values.role) throw new Error('--role is required');
  const gate = await checkGate({ roleDirectory: resolve(values.role), workspace: resolve(values.workspace!), required: Number(values.required),
    invoke: gatewayInvoke(values.url!) });
  console.log(`角色 ${gate.roleId}，版本 ${gate.role.commit?.slice(0, 8) ?? '未提交'}${gate.role.commit && gate.role.dirty ? '（有未提交的改动）' : ''}`);
  for (const run of gate.devRuns) {
    const totals = run.scores.map(scores => Object.values(scores).reduce((sum, score) => sum + score, 0)).join('→');
    console.log(`  开发 ${run.startedAt} ${run.caseId}：${run.passed ? '通过' : '未通过'}（${run.stopReason}），打回 ${run.bounces}，修改 ${run.revisions}，总分 ${totals || '无'}`);
  }
  if (gate.unfinished.length) console.log(`  另有 ${gate.unfinished.length} 次运行没跑完（${gate.unfinished.map(run => `${run.startedAt} ${run.stopReason}`).join('、')}），不计入`);
  console.log(gate.ready ? '可以进入测试。' : `还不能进入测试：\n- ${gate.reasons.join('\n- ')}`);
  for (const kase of gate.testCases) console.log(`  测试 ${kase.caseId}（${kase.kind === 'original' ? '原题' : '变体题'}）：${{ passed: '通过', failed: '未通过', not_run: '未跑' }[kase.result]}`);
  if (!gate.ready) process.exitCode = 1;
}
