import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { checkGate } from '../src/rsi/gate.js';
import { type LedgerEntry, runOutlineCase } from '../src/rsi/outline-run.js';
import { executorChanges, type Ticket } from '../src/rsi/ticket.js';

const ROLE = resolve(import.meta.dirname, '../../../.1agents/roles/product-intro-outline');
const checksAvailable = spawnSync('python3', ['-I', '-c', 'import jsonschema']).status === 0;

function outline(repo: string, commit: string, font = '微软雅黑') {
  const slide = (title: string, featureIds?: string[]) => ({ title, layout: 'title-bullets',
    points: [{ text: `${title}要点`, ...(featureIds ? { featureIds } : {}), sources: [{ path: 'README.md', lines: '1-2' }] }] });
  return { schemaVersion: 1, project: { repo, commit, name: '示例', oneLiner: '示例项目' }, audience: '开发者',
    style: { slideSize: '16:9', font: { family: font, sizes: { title: 32, subtitle: 24, body: 18, caption: 12 } },
      colors: { primary: '#285B4D', background: '#F7F4EB', accent: '#CBB078', text: '#202D29', source: { path: 'README.md' } },
      layouts: ['title-bullets'] },
    sections: [
      { id: 'positioning', title: '定位', status: 'present', slides: [slide('定位')] },
      { id: 'features', title: '功能', status: 'present', slides: [slide('功能', ['F1'])] },
      { id: 'architecture', title: '架构', status: 'present', slides: [slide('架构')] },
      { id: 'getting_started', title: '上手', status: 'present', slides: [slide('上手')] },
      { id: 'screenshots', status: 'not_applicable', reason: '命令行工具，没有界面' },
    ] };
}

/** What a well-behaved executor does with the ticket: mark every pending item done through ticket.py, then submit. */
function handleTicket(work: string, note = '已按意见修改') {
  const tool = (...args: string[]) => {
    const out = spawnSync('python3', ['-I', join(work, 'checks', 'ticket.py'), join(work, 'ticket.json'), ...args], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr); return out.stdout;
  };
  for (const line of tool('show').split('\n')) { const id = /^([PQ]\d+-\S+) \[/.exec(line)?.[1]; if (id) tool('mark', id, 'done', '--note', note); }
  tool('submit');
}
const readTicket = async (work: string) => JSON.parse(await readFile(join(work, 'ticket.json'), 'utf8')) as Ticket;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-outline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, 'internal'), { recursive: true });
  await writeFile(join(project, 'README.md'), '# 示例\n\n一个命令行工具。\n');
  await writeFile(join(project, 'internal', 'brochure.md'), '现成的宣传稿\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const commit = git('rev-parse', 'HEAD');
  const role = join(root, 'role');
  await cp(ROLE, role, { recursive: true });
  await mkdir(join(role, 'cases', 'demo'), { recursive: true });
  await writeFile(join(role, 'cases', 'demo', 'case.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', kind: 'original', locked: true,
    input: { repo: 'example/demo', commit, exclude: ['internal'], audience: '开发者' }, features: 'features.json', accepted: null }));
  await writeFile(join(role, 'cases', 'demo', 'features.json'), JSON.stringify({ repo: 'example/demo', commit, confirmation: null,
    features: [{ id: 'F1', name: '命令行入口', sources: [{ path: 'README.md' }] }] }));
  const calls: { method: string; params: any }[] = [];
  return { root, project, role, commit, calls };
}

test('a failed program check goes back to the same task with its evidence, and the next round passes', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t);
  let work = '';
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1,
    invoke: async (method, params: any) => {
      f.calls.push({ method, params });
      if (method === 'execution_submit') {
        work = params.input.cwd;
        await writeFile(join(work, 'outline.json'), JSON.stringify(outline('example/demo', f.commit, 'Arial')));
        return { jobId: 'job-1' };
      }
      if (method === 'execution_continue') {
        await writeFile(join(work, 'outline.json'), JSON.stringify(outline('example/demo', f.commit)));
        handleTicket(work, '字体改成微软雅黑');
        return { jobId: 'job-1' };
      }
      return { executionStatus: 'completed' };
    } });
  assert.equal(report.passed, true);
  assert.equal(report.rounds.length, 2);
  assert.deepEqual(report.rounds[0]!.results.filter(r => !r.pass).map(r => r.itemId), ['P2']);
  const submit = f.calls.find(call => call.method === 'execution_submit')!.params;
  assert.equal(submit.targetId, 'dsh-host'); assert.equal(submit.input.agentPreset, 'standard');
  assert.match(submit.input.prompt, /# 产品介绍大纲/, 'the role instructions lead the prompt');
  assert.ok(submit.input.prompt.includes(f.commit));
  assert.match(submit.input.prompt, /自查用的 Python：`\/[^`]+`/, 'the executor gets the checker interpreter by absolute path');
  const bounce = f.calls.find(call => call.method === 'execution_continue')!.params;
  assert.equal(bounce.jobId, 'job-1');
  assert.match(bounce.input.prompt, /ticket\.py ticket\.json show/, 'the executor is pointed at the ticket, not given the evidence as text');
  assert.doesNotMatch(bounce.input.prompt, /Arial/);
  const ticket = await readTicket(work);
  assert.equal(ticket.status, 'closed');
  const item = ticket.items.find(i => i.id === 'P1-P2')!;
  assert.match(JSON.stringify(item.evidence), /Arial/);
  assert.deepEqual([item.state, item.log.map(e => `${e.round}:${e.by}:${e.action}`)], ['verified', ['1:host:raised', '2:executor:done', '2:host:verified']]);
  assert.equal(item.log[1]!.note, '字体改成微软雅黑');
  assert.ok(await stat(join(work, 'project', 'README.md')));
  await assert.rejects(stat(join(work, 'project', 'internal')), 'excluded paths are not in the copy');
  assert.equal(JSON.parse(await readFile(join(work, 'run.json'), 'utf8')).passed, true);
  assert.equal(report.rounds[1]!.outlineSha256, createHash('sha256').update(await readFile(join(work, 'outline.json'))).digest('hex'));
  assert.ok(!report.rounds[1]!.results.some(r => r.itemId === 'D1'), 'no delivered copy, nothing to compare');
});

test('a delivered copy that differs from the checked outline fails and goes back; matching bytes pass', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t);
  let work = '', prompt = '';
  const good = JSON.stringify(outline('example/demo', f.commit));
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1,
    invoke: async (method, params: any) => {
      const delivered = join(work, '.1agents', 'jobs', 'job-5');
      if (method === 'execution_submit') {
        work = params.input.cwd;
        await mkdir(join(work, '.1agents', 'jobs', 'job-5'), { recursive: true });
        await writeFile(join(work, 'outline.json'), good);
        // Same content as JSON, other bytes: what a stale copy from an earlier round looks like.
        await writeFile(join(work, '.1agents', 'jobs', 'job-5', 'outline.json'), JSON.stringify(JSON.parse(good), null, 2));
        return { jobId: 'job-5' };
      }
      if (method === 'execution_continue') {
        prompt = params.input.prompt;
        await cp(join(work, 'outline.json'), join(delivered, 'outline.json'));
        handleTicket(work);
        return { jobId: 'job-5' };
      }
      return { executionStatus: 'completed' };
    } });
  const first = report.rounds[0]!;
  assert.equal(first.passed, false);
  assert.deepEqual(first.results.filter(r => !r.pass).map(r => r.itemId), ['D1'], 'P1–P7 pass; only the copy differs');
  assert.match(JSON.stringify(first.results.find(r => r.itemId === 'D1')!.evidence), /\.1agents\/jobs\/job-5\/outline\.json/);
  assert.match(prompt, /1 条待处理/);
  assert.equal((await readTicket(work)).items.find(i => i.checkId === 'D1')!.state, 'verified');
  const second = report.rounds[1]!;
  assert.equal(report.passed, true);
  assert.equal(second.results.find(r => r.itemId === 'D1')!.pass, true);
  assert.equal(second.outlineSha256, createHash('sha256').update(good).digest('hex'));
});

test('without bounces left a failed check ends the run, and a failed task is not checked', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t);
  const bad = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, maxBounces: 0,
    invoke: async (method, params: any) => {
      f.calls.push({ method, params });
      if (method === 'execution_submit') return { jobId: 'job-2' };
      return { executionStatus: 'completed' };
    } });
  assert.equal(bad.passed, false);
  assert.deepEqual(bad.rounds.map(r => r.results.map(x => x.itemId)), [['P0']], 'no outline.json at all');
  assert.ok(!f.calls.some(call => call.method === 'execution_continue'));

  const failed = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs-2'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1,
    invoke: async method => method === 'execution_submit' ? { jobId: 'job-3' } : { executionStatus: 'failed' } });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.rounds, [{ round: 1, jobId: 'job-3', executionStatus: 'failed', passed: false, results: [] }]);

  const stuck = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs-3'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, timeoutMs: 5,
    invoke: async method => method === 'execution_submit' ? { jobId: 'job-4' } : { executionStatus: 'working' } });
  assert.equal(stuck.passed, false);
  assert.equal(stuck.rounds[0]!.executionStatus, 'timed_out', 'a task that never finishes is recorded, not thrown');
});

test('with QA on, a QA agent in its own session reviews a frozen copy, its issues go back to the executor, and the same QA session re-reviews the revision', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t);
  let work = '', reviews = 0;
  const first = outline('example/demo', f.commit), revised = { ...first, project: { ...first.project, oneLiner: '一行命令生成产品介绍' } };
  const review = (verdict: string, issues: unknown[]) => ({ verdict, summary: verdict === 'pass' ? '可以了' : '开头太空泛', issues,
    scores: { 吸引力: verdict === 'pass' ? 4 : 2, 具体: 4, 受众: 4, 结构: 4, 可信: 5, 行动: 4 } });
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, qa: { agentPreset: 'qa-preset' },
    invoke: async (method, params: any) => {
      f.calls.push({ method, params });
      const qaReview = async () => {
        reviews++;
        await writeFile(join(work, 'reviews', `review-r${reviews}.json`), JSON.stringify(reviews === 1
          ? review('revise', [{ where: 'project/oneLiner', problem: '示例项目四个字说明不了任何事', suggestion: '改成“一行命令生成产品介绍”', severity: 'must' }])
          : { ...review('pass', []), previous: [{ id: 'Q1-1', status: 'fixed', note: '已改' }] }));
        return { jobId: 'qa-1' };
      };
      if (method === 'execution_submit' && params.title.startsWith('质检')) return qaReview();
      if (method === 'execution_continue' && params.jobId === 'qa-1') return qaReview();
      if (method === 'execution_submit') { work = params.input.cwd; await writeFile(join(work, 'outline.json'), JSON.stringify(first)); return { jobId: 'job-1' }; }
      if (method === 'execution_continue') { await writeFile(join(work, 'outline.json'), JSON.stringify(revised)); handleTicket(work, '改成一行命令生成产品介绍'); return { jobId: 'job-1' }; }
      return { executionStatus: 'completed' };
    } });
  assert.equal(report.passed, true);
  assert.deepEqual(report.rounds.map(r => [r.round, r.review?.review?.verdict]), [[1, 'revise'], [2, 'pass']]);
  assert.equal(f.calls.filter(call => call.method === 'execution_submit' && call.params.title.startsWith('质检')).length, 1, 'one QA session per task');
  const reReview = f.calls.find(call => call.method === 'execution_continue' && call.params.jobId === 'qa-1')!.params;
  assert.match(reReview.input.prompt, /reviews\/outline-r2\.json/); assert.match(reReview.input.prompt, /previous/);
  assert.deepEqual(report.rounds[1]!.review!.review!.previous, [{ id: 'Q1-1', status: 'fixed', note: '已改' }]);
  assert.match(reReview.input.prompt, /ticket\.json/);
  const ticket = await readTicket(work);
  assert.equal(ticket.status, 'closed');
  assert.deepEqual(ticket.items.map(i => [i.id, i.state, i.log.map(e => `${e.by}:${e.action}`).join(',')]), [['Q1-1', 'verified', 'qa:raised,executor:done,qa:fixed']]);
  assert.deepEqual(ticket.history.filter(h => h.by === 'qa').map(h => h.verdict), ['revise', 'pass']);
  assert.equal(report.rounds[1]!.review!.jobId, 'qa-1');
  const qaSubmit = f.calls.find(call => call.method === 'execution_submit' && call.params.title.startsWith('质检'))!.params;
  assert.equal(qaSubmit.input.agentPreset, 'qa-preset');
  assert.match(qaSubmit.input.prompt, /# 产品介绍大纲 · 质检/, 'the QA role leads the review prompt');
  assert.match(qaSubmit.input.prompt, /reviews\/outline-r1\.json/, 'QA reviews a frozen copy');
  const back = f.calls.find(call => call.method === 'execution_continue' && call.params.jobId === 'job-1')!.params;
  assert.equal(back.jobId, 'job-1', 'the issues go back to the executor session');
  assert.match(back.input.prompt, /1 条待处理（1 条必须改）/); assert.doesNotMatch(back.input.prompt, /一行命令生成产品介绍/, 'the issue itself lives on the ticket');
  assert.equal(JSON.parse(await readFile(join(work, 'reviews', 'outline-r1.json'), 'utf8')).project.oneLiner, '示例项目', 'the pre-QA version is kept');
  assert.equal(JSON.parse(await readFile(join(work, 'reviews', 'outline-r2.json'), 'utf8')).project.oneLiner, '一行命令生成产品介绍');
});

test('a QA agent that edits the outline itself is undone, and a run without a readable review stops without sending anything back', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t);
  let work = '';
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, qa: {},
    invoke: async (method, params: any) => {
      f.calls.push({ method, params });
      if (method === 'execution_submit' && params.title.startsWith('质检')) {
        await writeFile(join(work, 'outline.json'), '{"tampered":true}'); await writeFile(join(work, 'ticket.json'), '{}'); return { jobId: 'qa-1' };
      }
      if (method === 'execution_submit') { work = params.input.cwd; await writeFile(join(work, 'outline.json'), JSON.stringify(outline('example/demo', f.commit))); return { jobId: 'job-1' }; }
      return { executionStatus: 'completed' };
    } });
  assert.equal(report.passed, false);
  assert.match(report.rounds[0]!.review!.error!, /改动了 outline\.json，已恢复.*改动了 ticket\.json，已恢复.*读不出来/);
  assert.equal((await readTicket(work)).status, 'stopped', 'the restored ticket records how the run ended');
  assert.equal(JSON.parse(await readFile(join(work, 'outline.json'), 'utf8')).schemaVersion, 1, "the executor's outline is restored");
  assert.ok(!f.calls.some(call => call.method === 'execution_continue'));
});

test('P8-P11 catch the deterministic problems QA used to find, and leave legitimate text alone', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t), dir = join(f.root, 'checks-case'), project = join(dir, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# 示例\n\n一个命令行工具。\n');
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  await writeFile(join(project, 'RELEASE_NOTES.md'), '# Demo v0.9.0\n\n首个版本。\n');
  await writeFile(join(dir, 'features.json'), await readFile(join(f.role, 'cases', 'demo', 'features.json')));
  const run = async (doc: unknown) => {
    await writeFile(join(dir, 'outline.json'), JSON.stringify(doc));
    const out = spawnSync('python3', ['-I', join(f.role, 'checks', 'check_outline.py'), join(dir, 'outline.json'), join(dir, 'features.json'), project], { encoding: 'utf8' });
    return Object.fromEntries((JSON.parse(out.stdout) as { itemId: string; pass: boolean; evidence: any[] }[]).map(r => [r.itemId, r]));
  };
  const point = (text: string) => ({ text, sources: [{ path: 'README.md' }] });
  const clean = outline('example/demo', f.commit) as any;
  clean.sections[0].slides[0].points.push(point('需要 Node.js 22.18.0 以上'), point('部分尺寸仍标注待确认，以现场为准'));
  const ok = await run(clean);
  assert.deepEqual(['P8', 'P9', 'P10', 'P11'].map(id => ok[id]!.pass), [true, true, true, true], 'a runtime version and a stated limitation are not flagged');

  const bad = outline('example/demo', f.commit) as any;
  bad.sections[0].slides[0].points = [1, 2, 3, 4, 5, 6].map(n => point(`第 ${n} 条要点`));
  bad.sections[2].slides[0].points.push(point('联系人与邮箱（待补）'));
  bad.sections[1].slides[0].points.push(point('推送到 main 后自动构建并发布到静态站点'));
  bad.sections[3].slides[0].points.push(point('推送到 main 后，自动构建并发布到静态站点。'));
  bad.sections[3].slides[0].points.push(point('下载 demo-v1.0.0-web.zip 解压即用'));
  const r = await run(bad);
  assert.deepEqual(r.P8!.evidence.map((e: any) => e.path), ['sections/positioning/slides/0']);
  assert.match(JSON.stringify(r.P9!.evidence), /architecture\/slides\/0\/points\/1.*待补/);
  assert.match(JSON.stringify(r.P10!.evidence), /getting_started\/slides\/0\/points\/1.*same text as sections\/features\/slides\/0\/points\/1/, 'punctuation does not hide a repeat');
  assert.match(JSON.stringify(r.P11!.evidence), /demo-v1\.0\.0-web\.zip.*records disagree/, 'release notes say 0.9.0, package.json says 1.0.0');

  await writeFile(join(project, 'RELEASE_NOTES.md'), '# Demo v1.0.0\n');
  assert.equal((await run(bad)).P11!.pass, true, 'a hard-coded version is fine when every record agrees');
  bad.sections[3].slides[0].points.at(-1).text = '下载 demo-v2.0.0-web.zip';
  assert.match(JSON.stringify((await run(bad)).P11!.evidence), /says 2\.0\.0/);
});

/** A run whose QA agent answers each review with the next scripted one; the executor just touches the outline. */
async function scriptedQaRun(f: Awaited<ReturnType<typeof fixture>>, workspace: string, script: (n: number) => unknown, extra: Record<string, unknown> = {}) {
  let work = '', reviews = 0, edits = 0;
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace,
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, qa: {}, ...extra,
    invoke: async (method, params: any) => {
      const qa = async () => { reviews++; await writeFile(join(work, 'reviews', `review-r${reviews}.json`), JSON.stringify(script(reviews))); return { jobId: 'qa-1' }; };
      if (method === 'execution_submit' && params.title.startsWith('质检')) return qa();
      if (method === 'execution_continue' && params.jobId === 'qa-1') return qa();
      if (method === 'execution_submit' || method === 'execution_continue') {
        if (method === 'execution_submit') work = params.input.cwd;
        const doc = outline('example/demo', f.commit); doc.project.oneLiner = `第 ${++edits} 版`;
        await writeFile(join(work, 'outline.json'), JSON.stringify(doc));
        if (method === 'execution_continue') handleTicket(work);
        return { jobId: 'job-1' };
      }
      return { executionStatus: 'completed' };
    } });
  return { report, reviews };
}

const qaReview = (total: number, previous?: unknown[], proposals?: unknown[]) => ({ verdict: 'revise', summary: '还要改',
  scores: { 吸引力: total - 15, 具体: 3, 受众: 3, 结构: 3, 可信: 3, 行动: 3 },
  issues: [{ where: 'project/oneLiner', problem: '太空泛', suggestion: '写场景加结果', severity: 'must' }],
  ...(previous ? { previous } : {}), ...(proposals ? { proposals } : {}) });

test('revisions continue up to three by default, stop early when the same issue survives two re-reviews, and every run lands in the ledger', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t), workspace = join(f.root, 'runs');
  const fixedLast = (n: number) => n > 1 ? [{ id: `Q${n - 1}-1`, status: 'fixed' }] : undefined;
  const rising = await scriptedQaRun(f, workspace, n => qaReview(16 + n, fixedLast(n)));
  assert.equal(rising.report.stopReason, 'max_revisions');
  assert.equal(rising.reviews, 4, 'one review plus three re-reviews');

  const partly = [{ id: 'Q1-1', status: 'partly', note: '只改了一半' }];
  const stuck = await scriptedQaRun(f, workspace, n => qaReview(16 + n, n > 1 ? partly : undefined, [{ kind: 'check', text: '同组出处跨页提示重复' }]));
  assert.equal(stuck.report.stopReason, 'stalled');
  assert.equal(stuck.reviews, 3, 'partly in two re-reviews in a row stops before the third revision');

  const flat = await scriptedQaRun(f, workspace, n => qaReview(18, fixedLast(n),
    [{ kind: 'locked', text: '模板锁定的技术架构章挡住了受众分' }]));
  assert.equal(flat.reviews, 3, 'no score gain twice running stops too');
  assert.equal(flat.report.stopReason, 'needs_human', 'QA says a locked item is in the way');
  assert.deepEqual(flat.report.role, { dirty: true }, 'a role directory outside git has no version');

  const ledger = (await readFile(join(workspace, 'product-intro-outline', 'ledger.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as LedgerEntry);
  assert.deepEqual(ledger.map(e => e.stopReason), ['max_revisions', 'stalled', 'needs_human']);
  assert.deepEqual(ledger.map(e => e.revisions), [3, 2, 2]);
  assert.deepEqual(ledger[0]!.scores.map(s => Object.values(s).reduce((a, b) => a + b, 0)), [17, 18, 19, 20]);
  assert.equal(ledger[1]!.firstDraftPassed, true); assert.equal(ledger[1]!.mustIssues, 3, 'Q1-1 reopened, Q2-1 done but unconfirmed, Q3-1 open');
  assert.deepEqual(ledger[1]!.proposals, [{ kind: 'check', text: '同组出处跨页提示重复' }]);
  assert.equal(ledger[2]!.phase, 'dev'); assert.equal(ledger[2]!.caseKind, 'original');
});

test('the gate opens only after consecutive clean passes on the committed role version, and a test run needs a committed role', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t), workspace = join(f.root, 'runs');
  const git = (...args: string[]) => execFileSync('git', ['-C', f.role, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'role v1');
  const commit = git('rev-parse', 'HEAD');
  const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({ startedAt: '2026-10-31T00:00:00.000Z', phase: 'dev', caseId: 'demo', caseKind: 'original',
    role: { commit, dirty: false }, passed: true, stopReason: 'passed', firstDraftPassed: true, bounces: 0, revisions: 1,
    scores: [{ 吸引力: 3 }, { 吸引力: 4 }], mustIssues: 0, proposals: [], workDirectory: '/w', ticketPath: '/w/ticket.json', ...over });
  const ledger = join(workspace, 'product-intro-outline', 'ledger.jsonl');
  const write = (entries: LedgerEntry[]) => mkdir(join(workspace, 'product-intro-outline'), { recursive: true })
    .then(() => writeFile(ledger, entries.map(e => JSON.stringify(e)).join('\n') + '\n'));
  const gate = () => checkGate({ roleDirectory: f.role, workspace });

  await write([entry()]);
  assert.match((await gate()).reasons.join('\n'), /1 次运行，需要连续 2 次通过/);
  await write([entry(), entry({ firstDraftPassed: false, proposals: [{ kind: 'locked', text: '模板' }, { kind: 'role', text: '开头' }] })]);
  const blocked = await gate();
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join('\n'), /初稿没有一次通过/); assert.match(blocked.reasons.join('\n'), /1 条提议要处理（locked）/);
  await write([entry({ passed: false, stopReason: 'stalled' }), entry(), entry({ proposals: [{ kind: 'role', text: '开头' }] }),
    entry({ role: { commit: 'f'.repeat(40), dirty: false } }), entry({ phase: 'test', caseId: 'demo' })]);
  const open = await gate();
  assert.equal(open.ready, true, 'the two newest dev runs on this version are clean; an older failure and another version do not count');
  assert.deepEqual(open.testCases.find(c => c.caseId === 'demo'), { caseId: 'demo', kind: 'original', result: 'passed' });
  assert.equal(open.testCases.find(c => c.caseId === 'dreammate-network')!.result, 'not_run');

  await writeFile(join(f.role, 'ROLE.md'), '# 改了一句\n', { flag: 'a' });
  const dirty = await gate();
  assert.equal(dirty.ready, false); assert.match(dirty.reasons.join('\n'), /未提交的改动/);
  await assert.rejects(runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace, phase: 'test', qa: {},
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, invoke: async () => ({}) }), /committed with no local changes/);
});

test('the executor can only mark pending items done or disputed with a note and submit; anything else is undone and sent back', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const before: Ticket = { schemaVersion: 1, roleId: 'r', caseId: 'c', outline: 'outline.json', status: 'in_revision', round: 2, proposals: [], history: [],
    items: [{ id: 'Q1-1', source: 'qa', raisedInRound: 1, severity: 'must', where: 'project/oneLiner', problem: '太空泛', state: 'open', log: [{ round: 1, by: 'qa', action: 'raised' }] },
      { id: 'Q1-2', source: 'qa', raisedInRound: 1, severity: 'should', where: 'x', problem: 'y', state: 'verified', log: [] }] };
  const edit = (change: (ticket: any) => void) => { const copy = structuredClone(before) as any; change(copy); return executorChanges(before, JSON.stringify(copy)); };
  const done = (ticket: any, note = '改了') => { ticket.items[0].state = 'done'; ticket.items[0].log.push({ round: 2, by: 'executor', action: 'done', note }); };
  const submit = (ticket: any) => { ticket.status = 'ready_for_review'; ticket.history.push({ round: 2, by: 'executor', action: 'submitted' }); };
  assert.deepEqual(edit(ticket => { done(ticket); submit(ticket); }).illegal, []);
  assert.deepEqual(edit(ticket => { done(ticket); submit(ticket); }).incomplete, []);
  assert.match(edit(done).incomplete.join(), /还没有提交/);
  assert.match(edit(ticket => { ticket.items[0].state = 'verified'; ticket.items[0].log.push({ round: 2, by: 'executor', action: 'verified', note: '好了' }); }).illegal.join(), /Q1-1/);
  assert.match(edit(ticket => done(ticket, ' ')).illegal.join(), /说明/);
  assert.match(edit(ticket => { ticket.items[0].severity = 'should'; }).illegal.join(), /不能改意见本身/);
  assert.match(edit(ticket => { ticket.items.pop(); }).illegal.join(), /增删/);
  assert.match(edit(ticket => { ticket.items[1].state = 'done'; ticket.items[1].log.push({ round: 2, by: 'executor', action: 'done', note: 'x' }); }).illegal.join(), /Q1-2/);
  assert.match(edit(ticket => { ticket.status = 'closed'; }).illegal.join(), /不能改成 closed/);
  assert.match(edit(ticket => { ticket.proposals.push({ id: 'R1-1' }); }).illegal.join(), /提议/);
  assert.match(executorChanges(before, '{').illegal.join(), /不是可读的 JSON/);

  const f = await fixture(t);
  let work = '', continues = 0;
  const first = outline('example/demo', f.commit);
  const review = (verdict: string) => ({ verdict, summary: '…', scores: { 吸引力: 4, 具体: 4, 受众: 4, 结构: 4, 可信: 4, 行动: 4 },
    issues: verdict === 'pass' ? [] : [{ where: 'project/oneLiner', problem: '太空泛', suggestion: '写场景', severity: 'must' }],
    ...(verdict === 'pass' ? { previous: [{ id: 'Q1-1', status: 'fixed' }] } : {}) });
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, qa: {},
    invoke: async (method, params: any) => {
      f.calls.push({ method, params });
      const qa = (verdict: string) => writeFile(join(work, 'reviews', `review-r${verdict === 'pass' ? 3 : 1}.json`), JSON.stringify(review(verdict))).then(() => ({ jobId: 'qa-1' }));
      if (method === 'execution_submit' && params.title.startsWith('质检')) return qa('revise');
      if (method === 'execution_continue' && params.jobId === 'qa-1') return qa('pass');
      if (method === 'execution_submit') { work = params.input.cwd; await writeFile(join(work, 'outline.json'), JSON.stringify(first)); return { jobId: 'job-1' }; }
      if (method === 'execution_continue' && ++continues === 1) {
        // Straight to verified, by editing the file: not the executor's call.
        const ticket = await readTicket(work); ticket.items[0]!.state = 'verified'; ticket.status = 'ready_for_review';
        await writeFile(join(work, 'ticket.json'), JSON.stringify(ticket)); return { jobId: 'job-1' };
      }
      if (method === 'execution_continue') { handleTicket(work, '开头改成场景加结果'); return { jobId: 'job-1' }; }
      return { executionStatus: 'completed' };
    } });
  assert.equal(report.passed, true);
  assert.match(report.rounds[1]!.ticketErrors!.join(), /Q1-1：执行者只能/);
  const bounce = f.calls.filter(call => call.method === 'execution_continue' && call.params.jobId === 'job-1')[1]!.params.input.prompt;
  assert.match(bounce, /任务单没有按规定处理/); assert.match(bounce, /越权的改动已经恢复/);
  const ticket = await readTicket(work);
  assert.deepEqual(ticket.items[0]!.log.map(e => `${e.round}:${e.by}:${e.action}`), ['1:qa:raised', '3:executor:done', '3:qa:fixed']);
  assert.ok(ticket.history.some(h => h.by === 'host' && h.action === 'reverted'), 'the undone change stays on record');
  assert.equal(ticket.status, 'closed');
});
