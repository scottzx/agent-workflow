/**
 * One product-intro outline run on a role's case: the executor writes outline.json in a prepared
 * work directory, the role's program checks run on it, and a failed check goes back to the
 * same session with its evidence. No model judges the result here; people accept it on the workbench.
 * The checked bytes are recorded by sha256, and a delivered copy in the job's artifact folder must match them.
 * Each run appends a line to the role's ledger, which the gate reads to decide when development is done.
 * Everything sent back goes through the task ticket on the executor's job (execution/ticket.ts), kept by the gateway:
 * the executor handles it with its ticket tools, every step is a ledger event, and ticket.json is a read-only export.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkResultSchema, pendingItems, qualityReviewSchema, type QualityReview, type CheckResult, type Ticket, unsettledMust } from '../execution/ticket.js';

const caseSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), kind: z.enum(['original', 'variant']), locked: z.boolean(),
  input: z.object({ repo: z.string().min(1), commit: z.string().regex(/^[0-9a-f]{40}$/),
    exclude: z.array(z.string().min(1)), audience: z.string().min(1) }).strict(),
  features: z.string().min(1).nullable(), accepted: z.unknown(),
}).strict();
const featuresSchema = z.object({ repo: z.string(), commit: z.string(), confirmation: z.unknown(),
  features: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).passthrough()).min(1) }).passthrough();
const resultsSchema = z.array(checkResultSchema);

export type { CheckResult, QualityReview };
/** One QA pass over a frozen copy of the outline, in its own session. */
export interface ReviewRecord { jobId?: string; executionStatus: string; outlineCopy: string; review?: QualityReview; error?: string }
export interface OutlineRound {
  round: number; jobId: string; executionStatus: string; passed: boolean; results: CheckResult[]; outlineSha256?: string; review?: ReviewRecord;
  /** Why the round went back unchecked: the executor finished without submitting the ticket. */
  ticketErrors?: string[];
}
export type Phase = 'dev' | 'test';
export type StopReason = 'passed' | 'max_bounces' | 'max_revisions' | 'stalled' | 'needs_human' | 'not_completed' | 'review_failed';
/** The role version is the last commit that touched the role directory; uncommitted changes make a run unattributable. */
export interface RoleVersion { commit?: string; dirty: boolean }
export interface OutlineRunReport {
  roleId: string; caseId: string; phase: Phase; role: RoleVersion; repo: string; commit: string; workDirectory: string; outlinePath: string; ticketPath: string;
  featuresConfirmed: boolean; rounds: OutlineRound[]; passed: boolean; stopReason: StopReason; startedAt: string; finishedAt: string;
}
/** One line of `<workspace>/<role>/ledger.jsonl`. */
export interface LedgerEntry {
  startedAt: string; phase: Phase; caseId: string; caseKind: 'original' | 'variant'; role: RoleVersion; passed: boolean; stopReason: StopReason;
  /** The executor's first outline passed every program check without a bounce. */
  firstDraftPassed: boolean; bounces: number; revisions: number; scores: Record<string, number>[];
  mustIssues: number; proposals: NonNullable<QualityReview['proposals']>; workDirectory: string; ticketPath: string;
}
export interface OutlineRunOptions {
  roleDirectory: string; caseId: string; projectPath: string; workspace: string;
  /** A test run needs a committed role directory and QA; development runs take whatever is on disk. */
  phase?: Phase;
  targetId: string; agentPreset: string; originSessionId: string;
  /** Times a failed check goes back to the executor. The design default is one. */
  maxBounces?: number; pollMs?: number; timeoutMs?: number; python?: string;
  /** A QA agent reviews each outline that passes the program checks and may send it back for revision, by default up to three times. */
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
  return `${role}\n\n## 本次任务\n\n- 工作目录：${work}\n- 仓库：${kase.input.repo}\n- 提交：${kase.input.commit}\n- 受众：${kase.input.audience}\n- 自查用的 Python：\`${python}\`（已装好 jsonschema）\n\n读 \`project/\`，按 \`features.json\` 和 \`checks/outline.schema.json\` 写出 \`${path.join(work, 'outline.json')}\`。自查：\`${python} -I checks/check_outline.py outline.json features.json project\`。通过后结束，最终答复给出文件路径。\n\n这次任务的任务单记在系统里，宿主维护。被打回时，意见都在任务单上，按打回消息里的步骤用 \`ticket_show\`、\`ticket_mark\`、\`ticket_submit\` 工具处理；工作目录里的 \`ticket.json\` 只是只读导出。`;
}

/** The checks need jsonschema, so the interpreter is resolved once and handed to the executor by absolute path. */
async function checkInterpreter(name: string): Promise<string> {
  const found = await run(name, ['-I', '-c', 'import sys; from jsonschema import Draft202012Validator; print(sys.executable)']);
  if (found.code !== 0) throw new Error(`${name} cannot run the role checks (needs jsonschema with Draft 2020-12); pass another interpreter`);
  return found.stdout.trim();
}

function ticketSteps(ticket: Ticket): string {
  const pending = pendingItems(ticket);
  return `任务单上有 ${pending.length} 条待处理（${pending.filter(item => item.severity === 'must').length} 条必须改）：\n\n1. 调用 \`ticket_show\` 工具查看待处理的意见和证据。\n2. 在同一个 outline.json 上逐条修改。改完一条就调用 \`ticket_mark\`：\`id\` 填编号，\`state\` 填 \`done\`，\`note\` 写怎么改的；不同意的 \`state\` 填 \`disputed\`，\`note\` 写理由。\n3. 全部处理完，调用 \`ticket_submit\`。\n4. 用任务里给的 Python 再运行自查，全部检查通过后结束，最终答复给出文件路径。\n\n任务单只能用这三个工具处理；工作目录里的 ticket.json 是只读导出，改它没有用。`;
}

function bouncePrompt(ticket: Ticket, round: number): string {
  return `宿主程序检查没有通过（第 ${round} 轮），未通过的检查项和证据已写进任务单。${ticketSteps(ticket)}`;
}

function ticketBouncePrompt(ticket: Ticket, problems: string[]): string {
  return `任务单没有按规定处理：\n\n${problems.map(problem => `- ${problem}`).join('\n')}\n\n${ticketSteps(ticket)}`;
}

export async function roleVersion(roleDirectory: string): Promise<RoleVersion> {
  const last = await run('git', ['-C', roleDirectory, 'log', '-1', '--format=%H', '--', '.']);
  const status = await run('git', ['-C', roleDirectory, 'status', '--porcelain', '--untracked-files=all', '--', '.']);
  const commit = last.code === 0 && last.stdout.trim() ? last.stdout.trim() : undefined;
  return { ...(commit ? { commit } : {}), dirty: !commit || status.code !== 0 || status.stdout.trim() !== '' };
}

export const ledgerPath = (workspace: string, roleId: string) => path.join(path.resolve(workspace), roleId, 'ledger.jsonl');

/** More revisions stop helping when the same issue survives two re-reviews in a row, or the total score has not risen twice running. */
function stalled(reviews: QualityReview[]): boolean {
  const open = (review?: QualityReview) => new Set((review?.previous ?? []).filter(p => p.status === 'not_fixed' || p.status === 'partly').map(p => p.id));
  const before = open(reviews.at(-2));
  if ([...open(reviews.at(-1))].some(where => before.has(where))) return true;
  const totals = reviews.map(review => Object.values(review.scores).reduce((sum, score) => sum + score, 0));
  return totals.length >= 3 && totals.at(-1)! <= totals.at(-2)! && totals.at(-2)! <= totals.at(-3)!;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function reviewPrompt(qaRole: string, kase: z.infer<typeof caseSchema>, work: string, copy: string, output: string): string {
  return `${qaRole}\n\n## 本次质检\n\n- 工作目录：${work}\n- 要审的大纲：\`${copy}\`\n- 项目副本（只读）：\`${path.join(work, 'project')}\`\n- 功能清单：\`${path.join(work, 'features.json')}\`\n- 任务单（系统里的任务单的只读导出）：\`${path.join(work, 'ticket.json')}\`\n- 仓库：${kase.input.repo}\n- 受众：${kase.input.audience}\n\n把质检结果写到 \`${output}\`，写完立即结束。不要修改其他任何文件。`;
}

/** A re-review continues the same QA session, so it remembers its own issues and checks them first. */
function reReviewPrompt(copy: string, output: string, ticketPath: string, round: number): string {
  return `执行者按任务单改了大纲（第 ${round} 轮）。新版本：\`${copy}\`。任务单记在系统里，只读导出在 \`${ticketPath}\`；执行者在上面把你的每条意见标了 done（已改）或 disputed（不同意），并写了说明。\n\n按 QA.md 的复审要求：先在 previous 里用任务单编号逐条核对执行者处理过的质检意见，再用同样的标准打分，issues 只写新问题。把结果写到 \`${output}\`，写完立即结束。不要修改其他任何文件。`;
}

function revisePrompt(ticket: Ticket, review: QualityReview, round: number): string {
  return `质检审了你第 ${round} 轮的大纲，结论是需要修改：${review.summary}\n\n质检的意见已写进任务单，没改到位的旧意见已重新打开。${ticketSteps(ticket)}`;
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
  const phase = options.phase ?? 'dev', role = await roleVersion(roleDirectory);
  if (phase === 'test' && role.dirty) throw new Error('A test run needs the role directory committed with no local changes');
  if (phase === 'test' && !options.qa) throw new Error('A test run needs the QA review');

  const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const work = path.join(path.resolve(options.workspace), roleId, `${kase.id}-${stamp}`);
  await mkdir(work, { recursive: true });
  await exportProject(path.resolve(options.projectPath), kase.input.commit, path.join(work, 'project'), kase.input.exclude);
  await cp(path.join(roleDirectory, 'checklist.json'), path.join(work, 'checklist.json'));
  await cp(path.join(roleDirectory, 'checks'), path.join(work, 'checks'), { recursive: true });
  await cp(path.join(caseDirectory, kase.features), path.join(work, 'features.json'));
  log(`工作目录：${work}`);
  log(`阶段：${phase === 'dev' ? '开发' : '测试'}，角色版本：${role.commit?.slice(0, 8) ?? '未提交'}${role.commit && role.dirty ? '（有未提交的改动）' : ''}`);
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

  const roleText = await readFile(path.join(roleDirectory, 'ROLE.md'), 'utf8');
  const qaRole = options.qa ? await readFile(path.join(roleDirectory, 'QA.md'), 'utf8') : '';
  const outlinePath = path.join(work, 'outline.json'), ticketPath = path.join(work, 'ticket.json');
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
      await options.invoke('execution_continue', { originSessionId: options.originSessionId, jobId: qaJobId, clientRequestId, input: { prompt: reReviewPrompt(copy, output, ticketPath, round) } });
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
    try { record.review = qualityReviewSchema.parse(JSON.parse(await readFile(output, 'utf8'))); }
    catch (error) { record.error = [record.error, `质检结果读不出来：${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('；'); }
    return record;
  };
  const submitted = await options.invoke('execution_submit', { originSessionId: options.originSessionId, targetId: options.targetId,
    title: `产品介绍大纲：${kase.input.repo}`, clientRequestId: `${roleId}:${kase.id}:${stamp}:round-1`,
    input: { cwd: work, agentPreset: options.agentPreset, prompt: taskPrompt(roleText, kase, work, python) } });
  const jobId = String(submitted.jobId);
  /** Each change goes through the gateway, which records it on the job; the work directory gets a read-only copy. */
  const ticketCall = async (method: string, params: Record<string, unknown> = {}): Promise<Ticket> => {
    const scope = { originSessionId: options.originSessionId, jobId };
    if (method !== 'ticket_get') await options.invoke(method, { ...scope, ...params });
    const current = await options.invoke('ticket_get', scope) as Ticket;
    await rm(ticketPath, { force: true });
    await writeFile(ticketPath, JSON.stringify(current, null, 2) + '\n', { mode: 0o444 });
    return current;
  };
  let ticket = await ticketCall('ticket_open', { roleId, caseId: kase.id });
  const rounds: OutlineRound[] = [];
  const reviews: QualityReview[] = [];
  let bounces = 0, revisions = 0, stopReason: StopReason = 'passed';
  const sendBack = async (round: number, feedback: (ticket: Ticket) => string, note: string) => {
    ticket = await ticketCall('ticket_revise', { note });
    await options.invoke('execution_continue', { originSessionId: options.originSessionId, jobId,
      clientRequestId: `${roleId}:${kase.id}:${stamp}:round-${round + 1}`, input: { prompt: feedback(ticket) } });
    log(`已打回执行者（第 ${round + 1} 轮）`);
  };
  for (let round = 1; ; round++) {
    const executionStatus = await wait(jobId);
    if (round > 1 && executionStatus === 'completed') {
      ticket = await ticketCall('ticket_get');
      if (ticket.status !== 'ready_for_review') {
        const problems = [`还没有提交任务单（待处理 ${pendingItems(ticket).map(item => item.id).join('、') || '0 条'}）`];
        rounds.push({ round, jobId, executionStatus, passed: false, results: [], ticketErrors: problems });
        log(`第 ${round} 轮：任务单没有按规定处理（${problems.join('；')}）`);
        if (bounces >= maxBounces) { stopReason = 'max_bounces'; break; }
        bounces++;
        await sendBack(round, current => ticketBouncePrompt(current, problems), '执行者没有提交任务单');
        continue;
      }
    }
    const checked = executionStatus === 'completed' ? await check(work, python, jobId) : { results: [] };
    const results = checked.results, programPassed = executionStatus === 'completed' && results.every(result => result.pass);
    const record: OutlineRound = { round, jobId, executionStatus, passed: programPassed, results, ...(checked.outlineSha256 ? { outlineSha256: checked.outlineSha256 } : {}) };
    rounds.push(record);
    log(`第 ${round} 轮：${programPassed ? '程序检查通过' : executionStatus === 'completed' ? `未通过 ${results.filter(r => !r.pass).map(r => r.itemId).join('、')}` : `执行未完成（${executionStatus}）`}`);
    if (executionStatus !== 'completed') { stopReason = 'not_completed'; break; }
    ticket = await ticketCall('ticket_checks', { results });
    let feedback: (ticket: Ticket) => string, note: string;
    if (!programPassed) {
      if (bounces >= maxBounces) { stopReason = 'max_bounces'; break; }
      bounces++; feedback = current => bouncePrompt(current, round); note = '程序检查没有通过';
    } else if (options.qa) {
      record.review = await review(round);
      const verdict = record.review.review?.verdict;
      record.passed = verdict === 'pass';
      log(`第 ${round} 轮质检：${verdict ? `${verdict === 'pass' ? '通过' : '需要修改'}，${JSON.stringify(record.review.review!.scores)}` : record.review.error}`);
      if (!verdict) { stopReason = 'review_failed'; break; }
      const accepted = record.review.review!;
      ticket = await ticketCall('ticket_review', { review: accepted, ...(record.review.jobId ? { qaJobId: record.review.jobId } : {}) });
      if (verdict === 'pass') break;
      reviews.push(accepted);
      if (stalled(reviews)) { stopReason = 'stalled'; log('质检意见连续两轮没有改到位，或分数连续两轮没有提高，停止修改'); break; }
      if (revisions >= (options.qa.maxRevisions ?? 3)) { stopReason = 'max_revisions'; break; }
      revisions++; feedback = current => revisePrompt(current, accepted, round); note = '质检要求修改';
    } else break;
    await sendBack(round, feedback, note);
  }
  const last = rounds.at(-1)!;
  // Revising further cannot help when QA says a locked item is in the way; only a person can change it.
  if ((stopReason === 'stalled' || stopReason === 'max_revisions') && ticket.proposals.some(p => p.kind === 'locked')) stopReason = 'needs_human';
  ticket = await ticketCall('ticket_close', { status: last.passed ? 'closed' : 'stopped', stopReason });
  const report: OutlineRunReport = { roleId, caseId: kase.id, phase, role, repo: kase.input.repo, commit: kase.input.commit, workDirectory: work,
    outlinePath, ticketPath, featuresConfirmed: Boolean(features.confirmation), rounds,
    passed: last.passed, stopReason, startedAt, finishedAt: now().toISOString() };
  await writeFile(path.join(work, 'run.json'), JSON.stringify(report, null, 2) + '\n');
  const first = rounds[0]!;
  const entry: LedgerEntry = { startedAt, phase, caseId: kase.id, caseKind: kase.kind, role, passed: report.passed, stopReason,
    firstDraftPassed: first.executionStatus === 'completed' && first.results.every(result => result.pass), bounces, revisions,
    scores: rounds.flatMap(r => r.review?.review ? [r.review.review.scores] : []),
    mustIssues: unsettledMust(ticket).length, proposals: ticket.proposals.map(({ kind, text }) => ({ kind, text })), workDirectory: work, ticketPath };
  await appendFile(ledgerPath(options.workspace, roleId), JSON.stringify(entry) + '\n');
  log(`停止原因：${stopReason}`);
  return report;
}
