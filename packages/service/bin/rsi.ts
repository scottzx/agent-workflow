/** Coach-facing runs of a role's cases through the local A2A gateway. Publishing and acceptance stay on the workbench page. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { calibrateRole, calibrationPath } from '../src/rsi/calibrate.js';
import { checkGate, writeCrEvalReport } from '../src/rsi/gate.js';
import { formatLearningsLookupText, lookupLearnings } from '../src/rsi/learnings-lookup.js';
import { runOutlineCase } from '../src/rsi/outline-run.js';
import { coerceCrEvalResults, computeCrEvalDigest, findRepoRoot, loadCrEvalManifest, scoreCrEvalSuite, verifyCrEvalCommits } from '../src/rsi/pr-cr-eval.js';
import { computeRoleScorecard, formatScorecardText } from '../src/rsi/scorecard.js';
import { stampActor } from './ticket.js';

const USAGE = `Usage: acp-service rsi run --role DIR --case ID --project REPO [options]
       acp-service rsi gate --role DIR [--workspace DIR] [--required N] [--url URL]
       acp-service rsi calibrate --role DIR [--workspace DIR] [--python PATH] [--only P15,P14]
       acp-service rsi scorecard --role DIR [--workspace DIR] [--since VER] [--json]
       acp-service rsi lookup --paths FILE1,FILE2 [--repo DIR] [--limit N] [--json]
       acp-service rsi eval-cr --role DIR [--repo DIR] [--results FILE] [--workspace DIR] [--json]

Runs one case of a product-intro outline role: exports the pinned commit, dispatches the
executor, runs the role's program checks and sends failures back to the same session.
With --qa, a QA agent then reviews each outline that passes the checks in its own session
against the role's QA.md, and its issues go back to the executor. Each run is appended to
the role's ledger.jsonl in the workspace. The task ticket lives on the executor's job in the gateway;
the run directory's ticket.json is a read-only export (see acp-service ticket --help).

A run that stopped partway (the task timed out or failed, QA did not finish, the host failed) goes on
with --resume and its run directory, with the same options; --project is then not needed. The ticket
reopens where it stood, a task still running is waited on again, and a failed one is told to go on.

rsi gate reads the ledger and says whether the committed role version may leave development:
N development runs in a row passed (default 2), each first draft passed the program checks,
QA left no must-fix issue, and every proposal to codify a check or change a locked item has
been settled on the ticket (acp-service ticket proposal). Runs whose executor or QA task did
not finish are not counted. A recent run whose ticket has a self-check that disagreed with
the program (L1, self_vs_program) also blocks. When this version's checks differ from the
previous passing version, or a calibration.json is already present, it must match this commit
and checks digest and show zero false positives (acp-service rsi calibrate). A brand-new role
with nothing to compare is not held for calibration.

rsi calibrate replays the current checks, read-only, on historical outlines from the ledger.
Passed runs are positive samples; QA revise rounds are negative samples. A block failure on
a positive sample is a false positive and the command exits 1. --only scores just those item
ids. The report is <workspace>/<role-id>/calibration.json.

rsi eval-cr loads evals/manifest.json, checks that every baseCommit is an ancestor of its
headCommit, and prints the evalDigest of the manifest plus QA.md, checklist.json and routing.json.
With --results, each item is a structured CR result or { caseId, markdown }. The command exits 1
unless promotionReady: every negative defect was caught, every positive sample is a clean PASS,
and both kinds are present. Without --results the mode is verify-only and does not claim promotion.
--repo defaults to the nearest .git above --role.

Options:
  --target ID            agent_host target on the gateway (default legacy:ppt-beautifier)
  --preset ID            DSH agent preset for the executor (default standard)
  --provider ID          model provider for standard preset (must be paired with --model)
  --model ID             model id for standard preset (must be paired with --provider)
  --origin ID            originSessionId for the tasks (default rsi-cli)
  --workspace DIR        where run directories go (default .1agents/runtime/rsi)
  --url URL              gateway (default http://127.0.0.1:36814)
  --max-bounces N        times a failed check goes back (default 1)
  --timeout-minutes N    how long to wait on each task, an executor round or a QA review (default 60)
  --python PATH          interpreter with jsonschema for the checks (default python3)
  --qa                   add the QA agent review after the program checks
  --qa-preset ID         DSH agent preset for the QA agent (default: the executor's)
  --qa-max-revisions N   times QA issues go back to the executor (default 3)
  --phase dev|test       test needs a committed role directory, --qa and an open gate (default dev)
  --resume DIR           go on with the run recorded in this run directory
  --only IDS             calibrate only these checklist item ids, comma-separated (P15,P14)`;

/** Calls methods on the local gateway's /invoke route. */
export function gatewayInvoke(url: string) {
  const endpoint = new URL('/invoke', url);
  return async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: stampActor(method, params) }) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`${method} failed: ${String(data.error ?? response.status)}`);
    return data;
  };
}

export async function runRsiCli(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  if (argv[0] === 'gate') return runGate(argv.slice(1));
  if (argv[0] === 'calibrate') return runCalibrate(argv.slice(1));
  if (argv[0] === 'scorecard') return runScorecard(argv.slice(1));
  if (argv[0] === 'lookup') return runLookup(argv.slice(1));
  if (argv[0] === 'eval-cr') return runEvalCr(argv.slice(1));
  if (argv[0] !== 'run') throw new Error('Unknown rsi command; use rsi --help');
  const { values } = parseArgs({ args: argv.slice(1), strict: true, options: {
    role: { type: 'string' }, case: { type: 'string' }, project: { type: 'string' },
    target: { type: 'string', default: 'legacy:ppt-beautifier' }, preset: { type: 'string', default: 'standard' },
    provider: { type: 'string' }, model: { type: 'string' },
    origin: { type: 'string', default: 'rsi-cli' }, workspace: { type: 'string', default: '.1agents/runtime/rsi' },
    url: { type: 'string', default: 'http://127.0.0.1:36814' }, 'max-bounces': { type: 'string', default: '1' },
    'timeout-minutes': { type: 'string', default: '60' }, python: { type: 'string', default: 'python3' },
    qa: { type: 'boolean', default: false }, 'qa-preset': { type: 'string' }, 'qa-max-revisions': { type: 'string', default: '3' },
    phase: { type: 'string', default: 'dev' }, resume: { type: 'string' },
  } });
  if (!values.role || !values.case || (!values.project && !values.resume)) throw new Error('--role, --case and --project are required (--project not with --resume)');
  if (Boolean(values.provider) !== Boolean(values.model)) throw new Error('--provider and --model must be passed together');
  if (values.phase !== 'dev' && values.phase !== 'test') throw new Error('--phase is dev or test');
  if (values.phase === 'test') {
    const gate = await checkGate({ roleDirectory: resolve(values.role), workspace: resolve(values.workspace!), invoke: gatewayInvoke(values.url!) });
    if (!gate.ready) throw new Error(`The role has not left development yet:\n- ${gate.reasons.join('\n- ')}`);
  }
  const invoke = gatewayInvoke(values.url!);
  const report = await runOutlineCase({ roleDirectory: resolve(values.role), caseId: values.case, projectPath: resolve(values.project ?? '.'),
    ...(values.resume ? { resume: resolve(values.resume) } : {}),
    ...(values.provider && values.model ? { route: { provider: values.provider, model: values.model } } : {}),
    workspace: resolve(values.workspace!), phase: values.phase, targetId: values.target!, agentPreset: values.preset!, originSessionId: values.origin!,
    maxBounces: Number(values['max-bounces']), timeoutMs: Number(values['timeout-minutes']) * 60_000, python: values.python!,
    ...(values.qa ? { qa: { ...(values['qa-preset'] ? { agentPreset: values['qa-preset'] } : {}), maxRevisions: Number(values['qa-max-revisions']) } } : {}),
    cli: { command: `${process.execPath} ${fileURLToPath(new URL('./acp-service.js', import.meta.url))}`, url: values.url! },
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
  console.log(`L1 对校分歧：${gate.l1Mismatches}`);
  const calibrationLabel = { passed: '已通过', failed: '未通过', missing: '缺少', stale: '已过期', not_required: '不要求' }[gate.calibration.status];
  console.log(`L3 回放校准：${calibrationLabel}${gate.calibration.falsePositives ? `，误报 ${gate.calibration.falsePositives}` : ''}`);
  for (const kase of gate.testCases) console.log(`  测试 ${kase.caseId}（${kase.kind === 'original' ? '原题' : '变体题'}）：${{ passed: '通过', failed: '未通过', not_run: '未跑' }[kase.result]}`);
  if (!gate.ready) process.exitCode = 1;
}

async function runCalibrate(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    role: { type: 'string' }, workspace: { type: 'string', default: '.1agents/runtime/rsi' },
    python: { type: 'string' }, only: { type: 'string' },
  } });
  if (!values.role) throw new Error('--role is required');
  const only = values.only?.split(',').map(item => item.trim()).filter(Boolean);
  const report = await calibrateRole({ roleDirectory: resolve(values.role), workspace: resolve(values.workspace!),
    ...(values.python ? { python: values.python } : {}), ...(only?.length ? { only } : {}) });
  console.log(`角色 ${report.roleId}，版本 ${report.role.commit?.slice(0, 8) ?? '未提交'}${report.role.commit && report.role.dirty ? '（有未提交的改动）' : ''}`);
  console.log(`检查摘要 ${report.checksDigest.slice(0, 12)}，正样本 ${report.positiveSamples}，负样本 ${report.negativeSamples}`);
  if (report.only?.length) console.log(`只评估 ${report.only.join('、')}`);
  console.log(`误报 ${report.falsePositives.length}`);
  for (const hit of report.falsePositives) console.log(`  误报 ${hit.runDir} ${hit.artifactPath}：${hit.failedChecks.join('、')}`);
  console.log(`拦截历史缺陷 ${report.caughtHistoricalIssues.length}`);
  for (const hit of report.caughtHistoricalIssues) console.log(`  第 ${hit.round} 轮 ${hit.runDir} ${hit.artifactPath}：${hit.caughtBy.join('、')}${hit.qaSummary ? `（${hit.qaSummary}）` : ''}`);
  console.log(`校准报告：${calibrationPath(resolve(values.workspace!), report.roleId)}`);
  console.log(report.passed ? '回放校准通过（历史正样本 0 误报）。' : '回放校准未通过：历史正样本有误报。');
  if (!report.passed) process.exitCode = 1;
}

async function runScorecard(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    role: { type: 'string' },
    workspace: { type: 'string', default: '.1agents/runtime/rsi' },
    since: { type: 'string' },
    json: { type: 'boolean', default: false },
  } });
  if (!values.role) throw new Error('--role is required');
  const report = await computeRoleScorecard({
    roleDirectory: resolve(values.role),
    workspace: resolve(values.workspace!),
    ...(values.since ? { since: values.since } : {}),
  });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatScorecardText(report));
}

async function runLookup(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
    paths: { type: 'string', multiple: true },
    repo: { type: 'string' },
    limit: { type: 'string' },
    json: { type: 'boolean', default: false },
  } });
  const rawPaths = [
    ...(values.paths ?? []).flatMap(entry => entry.split(',')),
    ...positionals,
  ].map(item => item.trim()).filter(Boolean);
  if (!rawPaths.length) throw new Error('--paths <files> is required');
  const repoRoot = values.repo ? resolve(values.repo) : await findRepoRoot(process.cwd()).catch(() => resolve('.'));
  let limit: number | undefined;
  if (values.limit !== undefined) {
    const parsed = Number(values.limit);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error('--limit must be a non-negative integer');
    limit = parsed;
  }
  const report = await lookupLearnings({
    repoRoot,
    paths: rawPaths,
    ...(limit !== undefined ? { limit } : {}),
  });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatLearningsLookupText(report));
}

async function runEvalCr(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    role: { type: 'string' }, repo: { type: 'string' }, results: { type: 'string' },
    workspace: { type: 'string', default: '.1agents/runtime/rsi' },
    json: { type: 'boolean', default: false },
  } });
  if (!values.role) throw new Error('--role is required');
  const roleDirectory = resolve(values.role);
  const manifest = await loadCrEvalManifest(roleDirectory);
  const evalDigest = await computeCrEvalDigest(roleDirectory);
  const repoRoot = values.repo ? resolve(values.repo) : await findRepoRoot(roleDirectory);
  const verification = await verifyCrEvalCommits(manifest, repoRoot);
  const negativeCases = manifest.cases.filter(item => item.kind === 'negative').length;
  const positiveCases = manifest.cases.filter(item => item.kind === 'positive').length;
  if (!values.results) {
    const report = {
      mode: 'verify-only' as const, roleId: manifest.roleId, evalDigest, repoRoot,
      ok: verification.ok, checkedCommits: verification.checkedCommits, errors: verification.errors,
      totalCases: manifest.cases.length, negativeCases, positiveCases,
      totalDefects: manifest.cases.reduce((sum, item) => sum + (item.requiredDefects?.length ?? 0), 0),
      cases: manifest.cases.map(item => ({
        id: item.id, pr: item.pr, kind: item.kind, baseCommit: item.baseCommit, headCommit: item.headCommit,
        expectedVerdict: item.expectedVerdict, requiredDefects: item.requiredDefects?.length ?? 0,
      })),
    };
    if (values.json) console.log(JSON.stringify(report));
    else {
      console.log(`角色 ${report.roleId}，摘要 ${evalDigest.slice(0, 12)}，样本 ${report.totalCases}（负 ${negativeCases}，正 ${positiveCases}）`);
      console.log(`提交核验：${verification.checkedCommits} 个端点，${verification.ok ? '通过' : '未通过'}`);
      for (const error of verification.errors) console.log(`  ${error}`);
      console.log('mode: verify-only（未打分，不声明晋升）');
    }
    if (!verification.ok) process.exitCode = 1;
    return;
  }
  const resultsPath = resolve(values.results);
  let text: string;
  try { text = await readFile(resultsPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`results file does not exist: ${values.results}`);
    throw error;
  }
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`results file is not valid JSON: ${values.results}`); }
  const normalizedResults = coerceCrEvalResults(raw);
  const score = scoreCrEvalSuite(manifest, normalizedResults);
  const written = await writeCrEvalReport({
    roleDirectory,
    workspace: resolve(values.workspace!),
    results: normalizedResults,
    score,
  });
  const ready = verification.ok && score.promotionReady;
  const report = {
    mode: 'score' as const, roleId: manifest.roleId, evalDigest, roleDigest: written.report.roleDigest,
    reportPath: written.path, repoRoot,
    verification, ...score, ok: ready,
  };
  if (values.json) console.log(JSON.stringify(report));
  else {
    console.log(`角色 ${manifest.roleId}，摘要 ${evalDigest.slice(0, 12)}，样本 ${score.totalCases}（负 ${score.negativeCases}，正 ${score.positiveCases}）`);
    console.log(`提交核验：${verification.checkedCommits} 个端点，${verification.ok ? '通过' : '未通过'}`);
    for (const error of verification.errors) console.log(`  ${error}`);
    console.log(`负样本召回 ${score.negativeRecall}，缺陷召回 ${score.defectRecall}，误报率 ${score.falsePositiveRate}`);
    if (score.missingCases.length) console.log(`缺样本：${score.missingCases.join('、')}`);
    for (const item of score.caseResults.filter(row => !row.passed)) {
      console.log(`  未通过 ${item.caseId}：结论 ${item.actualVerdict}${item.missedDefects.length ? `，漏检 ${item.missedDefects.join('、')}` : ''}${item.falsePositive ? '，误报' : ''}`);
    }
    console.log(`已写入评估报告：${written.path}`);
    console.log(ready ? '达到 trial → formal 晋升门槛。' : '未达到 trial → formal 晋升门槛。');
  }
  if (!ready) process.exitCode = 1;
}
