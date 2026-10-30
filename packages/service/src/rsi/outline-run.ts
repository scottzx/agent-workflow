/**
 * One product-intro outline run on a role's case: the executor writes outline.json in a prepared
 * work directory, the role's program checks (P1–P7) run on it, and a failed check goes back to the
 * same session with its evidence. No model judges the result here; people accept it on the workbench.
 * The checked bytes are recorded by sha256, and a delivered copy in the job's artifact folder must match them.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const caseSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), kind: z.enum(['original', 'variant']), locked: z.boolean(),
  input: z.object({ repo: z.string().min(1), commit: z.string().regex(/^[0-9a-f]{40}$/),
    exclude: z.array(z.string().min(1)), audience: z.string().min(1) }).strict(),
  features: z.string().min(1).nullable(), accepted: z.unknown(),
}).strict();
const featuresSchema = z.object({ repo: z.string(), commit: z.string(), confirmation: z.unknown(),
  features: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).passthrough()).min(1) }).passthrough();
const resultsSchema = z.array(z.object({ itemId: z.string(), pass: z.boolean(), evidence: z.array(z.unknown()) }).strict());

const reviewSchema = z.object({
  verdict: z.enum(['pass', 'revise']),
  summary: z.string().trim().min(1).max(4000),
  scores: z.record(z.string(), z.number().int().min(1).max(5)),
  issues: z.array(z.object({ where: z.string().trim().min(1).max(300), problem: z.string().trim().min(1).max(2000),
    suggestion: z.string().trim().min(1).max(2000), severity: z.enum(['must', 'should']) }).strict()).max(30),
  /** On a re-review: what became of each issue from the previous review. */
  previous: z.array(z.object({ where: z.string().trim().min(1).max(300), status: z.enum(['fixed', 'partly', 'not_fixed', 'disagreed']),
    note: z.string().trim().max(2000).optional() }).strict()).max(30).optional(),
}).passthrough().refine(review => review.verdict === 'pass' || review.issues.length > 0, { message: 'A revise verdict needs at least one issue' });

export type CheckResult = z.infer<typeof resultsSchema>[number];
export type QualityReview = z.infer<typeof reviewSchema>;
/** One QA pass over a frozen copy of the outline, in its own session. */
export interface ReviewRecord { jobId?: string; executionStatus: string; outlineCopy: string; review?: QualityReview; error?: string }
export interface OutlineRound { round: number; jobId: string; executionStatus: string; passed: boolean; results: CheckResult[]; outlineSha256?: string; review?: ReviewRecord }
export interface OutlineRunReport {
  roleId: string; caseId: string; repo: string; commit: string; workDirectory: string; outlinePath: string;
  featuresConfirmed: boolean; rounds: OutlineRound[]; passed: boolean; startedAt: string; finishedAt: string;
}
export interface OutlineRunOptions {
  roleDirectory: string; caseId: string; projectPath: string; workspace: string;
  targetId: string; agentPreset: string; originSessionId: string;
  /** Times a failed check goes back to the executor. The design default is one. */
  maxBounces?: number; pollMs?: number; timeoutMs?: number; python?: string;
  /** A QA agent reviews each outline that passes the program checks and may send it back for revision. */
  qa?: { agentPreset?: string; targetId?: string; maxRevisions?: number };
  invoke: (method: string, params: Record<string, unknown>) => Promise<any>;
  log?: (line: string) => void; now?: () => Date;
}

const terminal = new Set(['completed', 'failed', 'canceled', 'rejected']);

function run(command: string, args: string[], options: { cwd?: string; input?: NodeJS.ReadableStream } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    if (options.input) options.input.pipe(child.stdin!);
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** The pinned commit as plain files, with the case's excluded paths removed. */
async function exportProject(repository: string, commit: string, destination: string, exclude: string[]): Promise<void> {
  if ((await run('git', ['-C', repository, 'cat-file', '-e', `${commit}^{commit}`])).code !== 0) throw new Error(`Commit ${commit} is not in ${repository}`);
  await mkdir(destination, { recursive: true });
  const archive = spawn('git', ['-C', repository, 'archive', '--format=tar', commit], { stdio: ['ignore', 'pipe', 'pipe'] });
  const archived = new Promise<number>((resolve, reject) => { archive.once('error', reject); archive.once('close', code => resolve(code ?? 1)); });
  const extracted = await run('tar', ['-x', '-C', destination], { input: archive.stdout! });
  if (await archived !== 0 || extracted.code !== 0) throw new Error(`Could not export ${commit}: ${extracted.stderr.trim()}`);
  for (const entry of exclude) {
    const target = path.resolve(destination, entry);
    if (path.isAbsolute(entry) || !target.startsWith(destination + path.sep)) throw new Error(`Excluded path leaves the project: ${entry}`);
    await rm(target, { recursive: true, force: true });
  }
}

function taskPrompt(role: string, kase: z.infer<typeof caseSchema>, work: string, python: string): string {
  return `${role}\n\n## 本次任务\n\n- 工作目录：${work}\n- 仓库：${kase.input.repo}\n- 提交：${kase.input.commit}\n- 受众：${kase.input.audience}\n- 自查用的 Python：\`${python}\`（已装好 jsonschema）\n\n读 \`project/\`，按 \`features.json\` 和 \`checks/outline.schema.json\` 写出 \`${path.join(work, 'outline.json')}\`。自查：\`${python} -I checks/check_outline.py outline.json features.json project\`。通过后结束，最终答复给出文件路径。`;
}

/** The checks need jsonschema, so the interpreter is resolved once and handed to the executor by absolute path. */
async function checkInterpreter(name: string): Promise<string> {
  const found = await run(name, ['-I', '-c', 'import sys, jsonschema; print(sys.executable)']);
  if (found.code !== 0) throw new Error(`${name} cannot run the role checks (needs jsonschema); pass another interpreter`);
  return found.stdout.trim();
}

function bouncePrompt(results: CheckResult[], round: number): string {
  const failed = results.filter(result => !result.pass).map(result => `- ${result.itemId}：${JSON.stringify(result.evidence)}`).join('\n');
  return `宿主程序检查没有通过（第 ${round} 轮），下面是未通过的检查项和证据：\n\n${failed}\n\n请在同一个 outline.json 上修改，用任务里给的 Python 再运行自查，P1 到 P7 全部通过后结束，最终答复给出文件路径。`;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function reviewPrompt(qaRole: string, kase: z.infer<typeof caseSchema>, work: string, copy: string, output: string): string {
  return `${qaRole}\n\n## 本次质检\n\n- 工作目录：${work}\n- 要审的大纲：\`${copy}\`\n- 项目副本（只读）：\`${path.join(work, 'project')}\`\n- 功能清单：\`${path.join(work, 'features.json')}\`\n- 仓库：${kase.input.repo}\n- 受众：${kase.input.audience}\n\n把质检结果写到 \`${output}\`，写完立即结束。不要修改其他任何文件。`;
}

/** A re-review continues the same QA session, so it remembers its own issues and checks them first. */
function reReviewPrompt(copy: string, output: string, round: number): string {
  return `执行者按你上一轮的意见改了大纲（第 ${round} 轮）。新版本：\`${copy}\`。\n\n按 QA.md 的复审要求：先在 previous 里逐条写清上一轮每条意见改到位没有，再用同样的标准打分，只提仍然存在的问题。把结果写到 \`${output}\`，写完立即结束。不要修改其他任何文件。`;
}

function revisePrompt(review: QualityReview, round: number): string {
  const issues = review.issues.map(issue => `- [${issue.severity === 'must' ? '必须改' : '建议改'}] ${issue.where}：${issue.problem}\n  建议：${issue.suggestion}`).join('\n');
  return `质检智能体审了你第 ${round} 轮的大纲，结论是需要修改：${review.summary}\n\n${issues}\n\n请在同一个 outline.json 上逐条修改。不同意的意见，在最终答复里说明理由。改完用任务里给的 Python 再运行自查，P1 到 P7 全部通过后结束，最终答复给出文件路径。`;
}

async function check(work: string, python: string, jobId: string): Promise<{ results: CheckResult[]; outlineSha256?: string }> {
  const outline = path.join(work, 'outline.json');
  const bytes = await readFile(outline).catch(() => undefined);
  if (!bytes) return { results: [{ itemId: 'P0', pass: false, evidence: [{ message: 'outline.json 不存在或不是普通文件' }] }] };
  const outlineSha256 = sha256(bytes);
  const result = await run(python, ['-I', path.join(work, 'checks', 'check_outline.py'), outline, path.join(work, 'features.json'), path.join(work, 'project')], { cwd: work });
  let results: CheckResult[];
  try { results = resultsSchema.parse(JSON.parse(result.stdout)); }
  catch { results = [{ itemId: 'P0', pass: false, evidence: [{ message: 'outline.json 不是可读的 JSON，或检查程序出错', stderr: result.stderr.slice(-2000) }] }]; }
  // The host delivers the copy in the job's artifact folder, so it must be the very bytes that were checked.
  const delivered = path.join(work, '.1agents', 'jobs', jobId, 'outline.json');
  const copy = await readFile(delivered).catch(() => undefined);
  if (copy) {
    const copySha256 = sha256(copy);
    results.push({ itemId: 'D1', pass: copySha256 === outlineSha256, evidence: copySha256 === outlineSha256 ? [] : [{ path: path.relative(work, delivered),
      message: `产物目录里的 outline.json（sha256 ${copySha256}）和工作目录的 outline.json（sha256 ${outlineSha256}）字节不一致，请让两份完全相同` }] });
  }
  return { results, outlineSha256 };
}

export async function runOutlineCase(options: OutlineRunOptions): Promise<OutlineRunReport> {
  const log = options.log ?? (() => {}), now = options.now ?? (() => new Date());
  const pollMs = options.pollMs ?? 10_000, timeoutMs = options.timeoutMs ?? 30 * 60_000, maxBounces = options.maxBounces ?? 1;
  const python = await checkInterpreter(options.python ?? 'python3'), startedAt = now().toISOString();
  const roleDirectory = path.resolve(options.roleDirectory);
  const roleId = z.object({ id: z.string().min(1) }).passthrough().parse(JSON.parse(await readFile(path.join(roleDirectory, 'profile.json'), 'utf8'))).id;
  const caseDirectory = path.join(roleDirectory, 'cases', options.caseId);
  const kase = caseSchema.parse(JSON.parse(await readFile(path.join(caseDirectory, 'case.json'), 'utf8')));
  if (!kase.features) throw new Error(`Case ${kase.id} has no confirmed feature list yet`);
  const features = featuresSchema.parse(JSON.parse(await readFile(path.join(caseDirectory, kase.features), 'utf8')));
  if (features.repo !== kase.input.repo || features.commit !== kase.input.commit) throw new Error('The feature list belongs to another repository or commit');

  const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const work = path.join(path.resolve(options.workspace), roleId, `${kase.id}-${stamp}`);
  await mkdir(work, { recursive: true });
  await exportProject(path.resolve(options.projectPath), kase.input.commit, path.join(work, 'project'), kase.input.exclude);
  await cp(path.join(roleDirectory, 'checklist.json'), path.join(work, 'checklist.json'));
  await cp(path.join(roleDirectory, 'checks'), path.join(work, 'checks'), { recursive: true });
  await cp(path.join(caseDirectory, kase.features), path.join(work, 'features.json'));
  log(`工作目录：${work}`);
  if (!features.confirmation) log('注意：这份功能清单还没有经人确认。');

  const wait = async (jobId: string): Promise<string> => {
    const deadline = Date.now() + timeoutMs; let last = '';
    for (;;) {
      const view = await options.invoke('execution_get', { originSessionId: options.originSessionId, jobId });
      const status = String(view.executionStatus ?? 'unknown');
      if (status !== last) { log(`任务 ${jobId}：${status}${status === 'input_required' ? '（等待人在工作台处理）' : ''}`); last = status; }
      if (terminal.has(status)) return status;
      if (Date.now() > deadline) { log(`任务 ${jobId}：${Math.round(timeoutMs / 60_000)} 分钟内没有结束，停止等待`); return 'timed_out'; }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  };

  const role = await readFile(path.join(roleDirectory, 'ROLE.md'), 'utf8');
  const qaRole = options.qa ? await readFile(path.join(roleDirectory, 'QA.md'), 'utf8') : '';
  const outlinePath = path.join(work, 'outline.json');
  /**
   * One QA session per task: the first review opens it and each re-review continues it. The QA agent reads a
   * frozen copy; if it touches the live outline anyway, the executor's version is restored.
   */
  let qaJobId: string | undefined;
  const review = async (round: number): Promise<ReviewRecord> => {
    await mkdir(path.join(work, 'reviews'), { recursive: true });
    const copy = path.join(work, 'reviews', `outline-r${round}.json`), output = path.join(work, 'reviews', `review-r${round}.json`);
    const bytes = await readFile(outlinePath);
    await writeFile(copy, bytes);
    const clientRequestId = `${roleId}:${kase.id}:${stamp}:review-${round}`;
    if (qaJobId) {
      await options.invoke('execution_continue', { originSessionId: options.originSessionId, jobId: qaJobId, clientRequestId, input: { prompt: reReviewPrompt(copy, output, round) } });
    } else {
      const submitted = await options.invoke('execution_submit', { originSessionId: options.originSessionId, targetId: options.qa!.targetId ?? options.targetId,
        title: `质检：产品介绍大纲 ${kase.input.repo}`, clientRequestId,
        input: { cwd: work, agentPreset: options.qa!.agentPreset ?? options.agentPreset, prompt: reviewPrompt(qaRole, kase, work, copy, output) } });
      qaJobId = String(submitted.jobId);
    }
    const record: ReviewRecord = { jobId: qaJobId, executionStatus: await wait(qaJobId), outlineCopy: copy };
    const after = await readFile(outlinePath).catch(() => undefined);
    if (!after || sha256(after) !== sha256(bytes)) { await writeFile(outlinePath, bytes); record.error = '质检智能体改动了 outline.json，已恢复执行者的版本'; }
    if (record.executionStatus !== 'completed') return { ...record, error: record.error ?? `质检任务没有完成（${record.executionStatus}）` };
    try { record.review = reviewSchema.parse(JSON.parse(await readFile(output, 'utf8'))); }
    catch (error) { record.error = [record.error, `质检结果读不出来：${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('；'); }
    return record;
  };
  const submitted = await options.invoke('execution_submit', { originSessionId: options.originSessionId, targetId: options.targetId,
    title: `产品介绍大纲：${kase.input.repo}`, clientRequestId: `${roleId}:${kase.id}:${stamp}:round-1`,
    input: { cwd: work, agentPreset: options.agentPreset, prompt: taskPrompt(role, kase, work, python) } });
  const jobId = String(submitted.jobId);
  const rounds: OutlineRound[] = [];
  let bounces = 0, revisions = 0;
  for (let round = 1; ; round++) {
    const executionStatus = await wait(jobId);
    const checked = executionStatus === 'completed' ? await check(work, python, jobId) : { results: [] };
    const results = checked.results, programPassed = executionStatus === 'completed' && results.every(result => result.pass);
    const record: OutlineRound = { round, jobId, executionStatus, passed: programPassed, results, ...(checked.outlineSha256 ? { outlineSha256: checked.outlineSha256 } : {}) };
    rounds.push(record);
    log(`第 ${round} 轮：${programPassed ? '程序检查通过' : executionStatus === 'completed' ? `未通过 ${results.filter(r => !r.pass).map(r => r.itemId).join('、')}` : `执行未完成（${executionStatus}）`}`);
    if (executionStatus !== 'completed') break;
    let feedback: string;
    if (!programPassed) {
      if (bounces >= maxBounces) break;
      bounces++; feedback = bouncePrompt(results, round);
    } else if (options.qa) {
      record.review = await review(round);
      const verdict = record.review.review?.verdict;
      record.passed = verdict === 'pass';
      log(`第 ${round} 轮质检：${verdict ? `${verdict === 'pass' ? '通过' : '需要修改'}，${JSON.stringify(record.review.review!.scores)}` : record.review.error}`);
      if (verdict !== 'revise' || revisions >= (options.qa.maxRevisions ?? 1)) break;
      revisions++; feedback = revisePrompt(record.review.review!, round);
    } else break;
    await options.invoke('execution_continue', { originSessionId: options.originSessionId, jobId,
      clientRequestId: `${roleId}:${kase.id}:${stamp}:round-${round + 1}`, input: { prompt: feedback } });
    log(`已打回执行者（第 ${round + 1} 轮）`);
  }
  const report: OutlineRunReport = { roleId, caseId: kase.id, repo: kase.input.repo, commit: kase.input.commit, workDirectory: work,
    outlinePath, featuresConfirmed: Boolean(features.confirmation), rounds,
    passed: rounds.at(-1)!.passed, startedAt, finishedAt: now().toISOString() };
  await writeFile(path.join(work, 'run.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
