import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runOutlineCase } from '../src/rsi/outline-run.js';

const ROLE = resolve(import.meta.dirname, '../../../.1agents/roles/product-intro-outline');
// The role checks validate with Draft 2020-12; an older system jsonschema cannot run them.
const checksAvailable = spawnSync('python3', ['-I', '-c', 'from jsonschema import Draft202012Validator']).status === 0;

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
  assert.match(bounce.input.prompt, /P2/); assert.match(bounce.input.prompt, /Arial/);
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
        return { jobId: 'job-5' };
      }
      return { executionStatus: 'completed' };
    } });
  const first = report.rounds[0]!;
  assert.equal(first.passed, false);
  assert.deepEqual(first.results.filter(r => !r.pass).map(r => r.itemId), ['D1'], 'P1–P7 pass; only the copy differs');
  assert.match(JSON.stringify(first.results.find(r => r.itemId === 'D1')!.evidence), /\.1agents\/jobs\/job-5\/outline\.json/);
  assert.match(prompt, /D1/);
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
          : { ...review('pass', []), previous: [{ where: 'project/oneLiner', status: 'fixed', note: '已改' }] }));
        return { jobId: 'qa-1' };
      };
      if (method === 'execution_submit' && params.title.startsWith('质检')) return qaReview();
      if (method === 'execution_continue' && params.jobId === 'qa-1') return qaReview();
      if (method === 'execution_submit') { work = params.input.cwd; await writeFile(join(work, 'outline.json'), JSON.stringify(first)); return { jobId: 'job-1' }; }
      if (method === 'execution_continue') { await writeFile(join(work, 'outline.json'), JSON.stringify(revised)); return { jobId: 'job-1' }; }
      return { executionStatus: 'completed' };
    } });
  assert.equal(report.passed, true);
  assert.deepEqual(report.rounds.map(r => [r.round, r.review?.review?.verdict]), [[1, 'revise'], [2, 'pass']]);
  assert.equal(f.calls.filter(call => call.method === 'execution_submit' && call.params.title.startsWith('质检')).length, 1, 'one QA session per task');
  const reReview = f.calls.find(call => call.method === 'execution_continue' && call.params.jobId === 'qa-1')!.params;
  assert.match(reReview.input.prompt, /reviews\/outline-r2\.json/); assert.match(reReview.input.prompt, /previous/);
  assert.deepEqual(report.rounds[1]!.review!.review!.previous, [{ where: 'project/oneLiner', status: 'fixed', note: '已改' }]);
  assert.equal(report.rounds[1]!.review!.jobId, 'qa-1');
  const qaSubmit = f.calls.find(call => call.method === 'execution_submit' && call.params.title.startsWith('质检'))!.params;
  assert.equal(qaSubmit.input.agentPreset, 'qa-preset');
  assert.match(qaSubmit.input.prompt, /# 产品介绍大纲 · 质检/, 'the QA role leads the review prompt');
  assert.match(qaSubmit.input.prompt, /reviews\/outline-r1\.json/, 'QA reviews a frozen copy');
  const back = f.calls.find(call => call.method === 'execution_continue' && call.params.jobId === 'job-1')!.params;
  assert.equal(back.jobId, 'job-1', 'the issues go back to the executor session');
  assert.match(back.input.prompt, /\[必须改\] project\/oneLiner/); assert.match(back.input.prompt, /一行命令生成产品介绍/);
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
      if (method === 'execution_submit' && params.title.startsWith('质检')) { await writeFile(join(work, 'outline.json'), '{"tampered":true}'); return { jobId: 'qa-1' }; }
      if (method === 'execution_submit') { work = params.input.cwd; await writeFile(join(work, 'outline.json'), JSON.stringify(outline('example/demo', f.commit))); return { jobId: 'job-1' }; }
      return { executionStatus: 'completed' };
    } });
  assert.equal(report.passed, false);
  assert.match(report.rounds[0]!.review!.error!, /改动了 outline\.json，已恢复.*读不出来/);
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
