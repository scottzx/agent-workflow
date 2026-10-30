import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runOutlineCase } from '../src/rsi/outline-run.js';

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
