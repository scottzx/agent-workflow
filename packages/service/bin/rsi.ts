/** Coach-facing commands for a role: run a case, propose a version, list versions, re-verify one. Publishing and acceptance stay on the workbench page. */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { evaluateVersion } from '../src/rsi/evaluate.js';
import { runOutlineCase } from '../src/rsi/outline-run.js';

const USAGE = `Usage:
  acp-service rsi run --role DIR --case ID --project REPO [run options]
  acp-service rsi propose --role-id ID --summary TEXT
  acp-service rsi versions --role-id ID
  acp-service rsi eval --role-id ID --version vN --project OWNER/NAME=REPO ... [run options]

run: exports the case's pinned commit, dispatches the executor, runs the role's program
checks and sends failures back to the same session.
propose: freezes the configured role directory as a candidate version; changes to locked
items are refused. Nothing goes live: a person publishes on the workbench page.
eval: runs every case of a proposed version from its frozen copy in fresh sessions and
records the results for the release gate. Cases without a local clone or a confirmed
feature list are recorded as failures.

Run options:
  --target ID            agent_host target on the gateway (default legacy:ppt-beautifier)
  --preset ID            DSH agent preset for the executor (default standard)
  --origin ID            originSessionId for the tasks (default rsi-cli)
  --workspace DIR        where run directories go (default .1agents/runtime/rsi)
  --max-bounces N        times a failed check goes back (default 1)
  --timeout-minutes N    per round (default 30)
  --python PATH          interpreter with jsonschema for the checks (default python3)
  --url URL              gateway (default http://127.0.0.1:36814)`;

export async function runRsiCli(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  const command = argv[0];
  if (!['run', 'propose', 'versions', 'eval'].includes(command!)) throw new Error('Unknown rsi command; use rsi --help');
  const { values } = parseArgs({ args: argv.slice(1), strict: true, options: {
    role: { type: 'string' }, case: { type: 'string' }, project: { type: 'string', multiple: true },
    'role-id': { type: 'string' }, summary: { type: 'string' }, version: { type: 'string' },
    target: { type: 'string', default: 'legacy:ppt-beautifier' }, preset: { type: 'string', default: 'standard' },
    origin: { type: 'string', default: 'rsi-cli' }, workspace: { type: 'string', default: '.1agents/runtime/rsi' },
    url: { type: 'string', default: 'http://127.0.0.1:36814' }, 'max-bounces': { type: 'string', default: '1' },
    'timeout-minutes': { type: 'string', default: '30' }, python: { type: 'string', default: 'python3' },
  } });
  const endpoint = new URL('/invoke', values.url);
  const invoke = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`${method} failed: ${String(data.error ?? response.status)}`);
    return data;
  };
  const run = { targetId: values.target!, agentPreset: values.preset!, originSessionId: values.origin!, workspace: resolve(values.workspace!),
    maxBounces: Number(values['max-bounces']), timeoutMs: Number(values['timeout-minutes']) * 60_000, python: values.python!,
    invoke, log: (line: string) => console.log(line) };

  if (command === 'run') {
    if (!values.role || !values.case || values.project?.length !== 1) throw new Error('--role, --case and one --project are required');
    const report = await runOutlineCase({ ...run, roleDirectory: resolve(values.role), caseId: values.case, projectPath: resolve(values.project[0]!) });
    console.log(`${report.passed ? '通过' : '未通过'}：${report.rounds.length} 轮，大纲 ${report.outlinePath}，记录 ${report.workDirectory}/run.json`);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (!values['role-id']) throw new Error('--role-id is required');
  const roleId = values['role-id'];
  if (command === 'propose') {
    if (!values.summary) throw new Error('--summary is required');
    const version = await invoke('rsi_version_propose', { roleId, summary: values.summary }) as any;
    console.log(`候选版本 ${version.version}（父版本 ${version.parent ?? '无'}）：新增 ${version.changes.added.length}，修改 ${version.changes.modified.length}，删除 ${version.changes.removed.length}${version.checklistChanged ? '，检查单有改动' : ''}`);
    return;
  }
  if (command === 'versions') {
    const listed = await invoke('rsi_version_list', { roleId }) as any;
    console.log(`已上线：${listed.published ?? '无'}`);
    for (const item of listed.versions) console.log(`${item.version}  ${item.status}  ${item.proposal.summary}${item.evaluation ? `  复验 ${item.evaluation.results.filter((r: any) => r.passed).length}/${item.evaluation.results.length}` : ''}`);
    return;
  }
  if (!values.version) throw new Error('--version is required');
  const projects = Object.fromEntries((values.project ?? []).map(entry => {
    const at = entry.indexOf('=');
    if (at < 1) throw new Error(`--project takes OWNER/NAME=REPO, got ${entry}`);
    return [entry.slice(0, at), resolve(entry.slice(at + 1))];
  }));
  const evaluated = await evaluateVersion({ ...run, roleId, version: values.version, projects });
  const results = evaluated.evaluation!.results;
  for (const item of results) console.log(`${item.caseId}（${item.kind === 'original' ? '原题' : '变体'}）：${item.passed ? '通过' : `未通过 ${item.failedItems.join('、')}`}`);
  console.log(`${values.version} 复验 ${results.filter(item => item.passed).length}/${results.length} 通过；上线由人在工作台上线门决定`);
  if (!results.every(item => item.passed)) process.exitCode = 1;
}
