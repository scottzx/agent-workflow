/** Coach-facing runs of a role's cases through the local A2A gateway. Publishing and acceptance stay on the workbench page. */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runOutlineCase } from '../src/rsi/outline-run.js';

const USAGE = `Usage: acp-service rsi run --role DIR --case ID --project REPO [options]

Runs one case of a product-intro outline role: exports the pinned commit, dispatches the
executor, runs the role's program checks and sends failures back to the same session.
With --qa, a QA agent then reviews each outline that passes the checks in its own session
against the role's QA.md, and its issues go back to the executor.

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
  --qa-max-revisions N   times QA issues go back to the executor (default 1)`;

export async function runRsiCli(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  if (argv[0] !== 'run') throw new Error('Unknown rsi command; use rsi run --help');
  const { values } = parseArgs({ args: argv.slice(1), strict: true, options: {
    role: { type: 'string' }, case: { type: 'string' }, project: { type: 'string' },
    target: { type: 'string', default: 'legacy:ppt-beautifier' }, preset: { type: 'string', default: 'standard' },
    origin: { type: 'string', default: 'rsi-cli' }, workspace: { type: 'string', default: '.1agents/runtime/rsi' },
    url: { type: 'string', default: 'http://127.0.0.1:36814' }, 'max-bounces': { type: 'string', default: '1' },
    'timeout-minutes': { type: 'string', default: '30' }, python: { type: 'string', default: 'python3' },
    qa: { type: 'boolean', default: false }, 'qa-preset': { type: 'string' }, 'qa-max-revisions': { type: 'string', default: '1' },
  } });
  if (!values.role || !values.case || !values.project) throw new Error('--role, --case and --project are required');
  const endpoint = new URL('/invoke', values.url);
  const invoke = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`${method} failed: ${String(data.error ?? response.status)}`);
    return data;
  };
  const report = await runOutlineCase({ roleDirectory: resolve(values.role), caseId: values.case, projectPath: resolve(values.project),
    workspace: resolve(values.workspace!), targetId: values.target!, agentPreset: values.preset!, originSessionId: values.origin!,
    maxBounces: Number(values['max-bounces']), timeoutMs: Number(values['timeout-minutes']) * 60_000, python: values.python!,
    ...(values.qa ? { qa: { ...(values['qa-preset'] ? { agentPreset: values['qa-preset'] } : {}), maxRevisions: Number(values['qa-max-revisions']) } } : {}),
    invoke, log: line => console.log(line) });
  console.log(`${report.passed ? '通过' : '未通过'}：${report.rounds.length} 轮，大纲 ${report.outlinePath}，记录 ${report.workDirectory}/run.json`);
  if (!report.passed) process.exitCode = 1;
}
