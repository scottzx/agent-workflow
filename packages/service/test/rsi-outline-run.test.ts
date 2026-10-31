import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { checkGate } from '../src/rsi/gate.js';
import { JobLedger } from '../src/execution/ledger.js';
import { invokeTicket, pendingItems, type Ticket } from '../src/execution/ticket.js';
import { type LedgerEntry, runOutlineCase, type OutlineRunOptions } from '../src/rsi/outline-run.js';

const ROLE = resolve(import.meta.dirname, '../../../.1agents/roles/product-intro-outline');
const checksAvailable = spawnSync('python3', ['-I', '-c', 'import jsonschema']).status === 0;

function outline(repo: string, commit: string, font = '微软雅黑') {
  const slide = (title: string, featureIds?: string[]) => ({ title, layout: 'title-bullets',
    points: [{ text: `${title}要点`, ...(featureIds ? { featureIds } : {}), sources: [{ path: 'README.md', lines: '1-2' }] }] });
  return { schemaVersion: 1, project: { repo, commit, name: '示例', oneLiner: '示例项目' }, audience: '开发者',
    style: { slideSize: '16:9', font: { family: font, sizes: { title: 32, subtitle: 24, body: 18, caption: 12 } },
      colors: { primary: '#285B4D', background: '#F7F4EB', accent: '#CBB078', text: '#202D29', source: { path: 'README.md' } },
      layouts: ['title-bullets', 'closing'] },
    sections: [
      { id: 'positioning', title: '定位', status: 'present', slides: [slide('定位')] },
      { id: 'features', title: '功能', status: 'present', slides: [slide('功能', ['F1'])] },
      { id: 'architecture', title: '架构', status: 'present', slides: [slide('架构')] },
      { id: 'getting_started', title: '上手', status: 'present', slides: [slide('上手'), { ...slide('下一步'), layout: 'closing' }] },
      { id: 'screenshots', status: 'not_applicable', reason: '命令行工具，没有界面' },
    ] };
}

/**
 * The gateway's ticket methods on a real ledger. The fake execution methods hand out short job IDs; each is aliased
 * onto a ledger job, and each executor round is a new attempt there, as execution_continue records it.
 */
function ticketGateway() {
  const ledger = new JobLedger(undefined, () => {}), jobs = new Map<string, string>();
  const job = (id: string) => jobs.get(id) ?? jobs.set(id, ledger.prepare({ originSessionId: 'rsi-test', targetSnapshot: { targetId: 'dsh-host' }, input: {} }).job.jobId).get(id)!;
  return {
    ledger, job,
    /** The run's invoke: ticket methods go to the ledger, everything else to the test's fake. */
    invoke: (fake: OutlineRunOptions['invoke']): OutlineRunOptions['invoke'] => async (method, params: any) =>
      method.startsWith('ticket_') ? invokeTicket(ledger, method, { ...params, jobId: job(params.jobId) }) : fake(method, params),
    /** A new executor round on the job; returns that round's ticket tools, as the DSH plugin calls them. */
    round(id: string) {
      const attemptId = ledger.prepare({ originSessionId: 'rsi-test', jobId: job(id), targetSnapshot: { targetId: 'dsh-host' }, input: {} }).attempt.attemptId;
      return (method: string, params: Record<string, unknown> = {}) => invokeTicket(ledger, method, { jobId: job(id), attemptId, sessionId: 'executor-session', ...params });
    },
  };
}
type Executor = ReturnType<ReturnType<typeof ticketGateway>['round']>;

/** What a well-behaved executor does with its ticket tools: mark every pending item done, then submit. */
function handleTicket(executor: Executor, note = '已按意见修改') {
  for (const item of pendingItems(executor('ticket_show'))) executor('ticket_mark', { itemId: item.id, state: 'done', note });
  executor('ticket_submit');
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
  const f = await fixture(t), gw = ticketGateway();
  let work = '';
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1,
    invoke: gw.invoke(async (method, params: any) => {
      f.calls.push({ method, params });
      if (method === 'execution_submit') {
        work = params.input.cwd;
        await writeFile(join(work, 'outline.json'), JSON.stringify(outline('example/demo', f.commit, 'Arial')));
        return { jobId: 'job-1' };
      }
      if (method === 'execution_continue') {
        await writeFile(join(work, 'outline.json'), JSON.stringify(outline('example/demo', f.commit)));
        handleTicket(gw.round('job-1'), '字体改成微软雅黑');
        return { jobId: 'job-1' };
      }
      return { executionStatus: 'completed' };
    }) });
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
  assert.match(bounce.input.prompt, /`ticket_show`.*`ticket_mark`.*`ticket_submit`/s, 'the executor is pointed at its ticket tools, not given the evidence as text');
  assert.doesNotMatch(bounce.input.prompt, /Arial|ticket\.py/);
  assert.match(submit.input.prompt, /ticket_show/); assert.doesNotMatch(submit.input.prompt, /ticket\.py/);
  const ticket = await readTicket(work);
  assert.deepEqual(ticket, invokeTicket(gw.ledger, 'ticket_get', { originSessionId: 'rsi-test', jobId: gw.job('job-1') }), 'ticket.json is the gateway ticket');
  assert.equal((await stat(join(work, 'ticket.json'))).mode & 0o222, 0, 'and a read-only export');
  assert.equal(ticket.status, 'closed');
  const item = ticket.items.find(i => i.id === 'P1-P2')!;
  assert.match(JSON.stringify(item.evidence), /Arial/);
  assert.deepEqual([item.state, item.log.map(e => `${e.round}:${e.by}:${e.action}`)], ['verified', ['1:host:raised', '2:executor:done', '2:host:verified']]);
  assert.equal(item.log[1]!.note, '字体改成微软雅黑');
  const events = gw.ledger.events('rsi-test', gw.job('job-1')).filter(e => e.type.startsWith('ticket.')).map(e => e.data as Record<string, unknown>);
  assert.deepEqual(gw.ledger.events('rsi-test', gw.job('job-1')).filter(e => e.type.startsWith('ticket.')).map(e => `${e.type}:${(e.data as any).actor}:${(e.data as any).round}`),
    ['ticket.opened:host:1', 'ticket.item_raised:host:1', 'ticket.checked:host:1', 'ticket.revision_started:host:2', 'ticket.item_marked:executor:2',
      'ticket.submitted:executor:2', 'ticket.item_settled:host:2', 'ticket.checked:host:2', 'ticket.closed:host:2'], 'every step is a ledger event');
  assert.deepEqual([events[4]!.itemId, events[4]!.note, events[4]!.sessionId, typeof events[4]!.attemptId], ['P1-P2', '字体改成微软雅黑', 'executor-session', 'string']);
  assert.ok(await stat(join(work, 'project', 'README.md')));
  await assert.rejects(stat(join(work, 'project', 'internal')), 'excluded paths are not in the copy');
  assert.equal(JSON.parse(await readFile(join(work, 'run.json'), 'utf8')).passed, true);
  assert.equal(report.rounds[1]!.outlineSha256, createHash('sha256').update(await readFile(join(work, 'outline.json'))).digest('hex'));
  assert.ok(!report.rounds[1]!.results.some(r => r.itemId === 'D1'), 'no delivered copy, nothing to compare');
});

test('an ACP executor runs a role that trains only its first message, is told the ticket commands for its job, and a role that trains tools or names its presets refuses it', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t), gw = ticketGateway();
  let work = '';
  const options = { roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'oneagents-acp-grok', originSessionId: 'rsi-test', pollMs: 1,
    cli: { command: '/bin/node /x/acp-service.js', url: 'http://127.0.0.1:36814' } };
  // The executor's self-check waits on a tool approval for two polls before it finishes.
  let polls = 0;
  const lines: string[] = [];
  const pending = { requestId: 'prc-check', status: 'pending', kind: 'permission', toolTitle: 'Run python3 -I checks/check_outline.py' };
  const report = await runOutlineCase({ ...options, log: line => lines.push(line), invoke: gw.invoke(async (method, params: any) => {
    f.calls.push({ method, params });
    if (method === 'execution_get' && params.jobId === 'job-1' && polls < 2) { polls++; return { executionStatus: 'working' }; }
    if (method === 'execution_process_requests') return { requests: polls < 2 ? [pending] : [{ ...pending, status: 'answered' }] };
    if (method === 'execution_submit') {
      work = params.input.cwd;
      await writeFile(join(work, 'outline.json'), JSON.stringify(outline('example/demo', f.commit, 'Arial')));
      return { jobId: 'job-1' };
    }
    if (method === 'execution_continue') {
      await writeFile(join(work, 'outline.json'), JSON.stringify(outline('example/demo', f.commit)));
      handleTicket(gw.round('job-1'));
      return { jobId: 'job-1' };
    }
    return { executionStatus: 'completed' };
  }) });
  assert.equal(report.passed, true);
  assert.equal(f.calls.find(call => call.method === 'execution_submit')!.params.input.agentPreset, 'oneagents-acp-grok');
  const bounce = f.calls.find(call => call.method === 'execution_continue')!.params.input.prompt as string;
  assert.match(bounce, /`1agents-review` MCP 服务/);
  assert.ok(bounce.includes('`/bin/node /x/acp-service.js ticket mark --job job-1 --url http://127.0.0.1:36814 --id 编号 --state done'), 'the commands name the executor’s own job');
  assert.match(bounce, /只能用这三个工具或这三条命令处理/);
  assert.deepEqual(lines.filter(line => line.includes('prc-check')), ['任务 job-1 的过程请求 prc-check：工具「Run python3 -I checks/check_outline.py」待批准。教练处理：/bin/node /x/acp-service.js process answer --job job-1 --id prc-check approve|reject --note 理由 --url http://127.0.0.1:36814'],
    'a pending request is reported once, with the coach’s command');

  const profile = JSON.parse(await readFile(join(f.role, 'profile.json'), 'utf8'));
  const refuse = async (training: unknown, pattern: RegExp) => {
    await writeFile(join(f.role, 'profile.json'), JSON.stringify({ ...profile, training }));
    await assert.rejects(runOutlineCase({ ...options, invoke: async () => assert.fail('nothing is dispatched') }), pattern);
  };
  await refuse({ layers: ['prompt', 'tools'] }, /trains tools, which only DSH's own presets control/);
  await refuse({ layers: ['prompt'], presets: ['standard'] }, /runs only on standard, not oneagents-acp-grok/);
  await refuse({ layers: ['skills'] }, /layers must include prompt/);
});

test('a delivered copy that differs from the checked outline fails and goes back; matching bytes pass',{ skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t), gw = ticketGateway();
  let work = '', prompt = '';
  const good = JSON.stringify(outline('example/demo', f.commit));
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1,
    invoke: gw.invoke(async (method, params: any) => {
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
        handleTicket(gw.round('job-5'));
        return { jobId: 'job-5' };
      }
      return { executionStatus: 'completed' };
    }) });
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
    invoke: ticketGateway().invoke(async (method, params: any) => {
      f.calls.push({ method, params });
      if (method === 'execution_submit') return { jobId: 'job-2' };
      return { executionStatus: 'completed' };
    }) });
  assert.equal(bad.passed, false);
  assert.deepEqual(bad.rounds.map(r => r.results.map(x => x.itemId)), [['P0']], 'no outline.json at all');
  assert.ok(!f.calls.some(call => call.method === 'execution_continue'));

  const failed = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs-2'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1,
    invoke: ticketGateway().invoke(async method => method === 'execution_submit' ? { jobId: 'job-3' } : { executionStatus: 'failed' }) });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.rounds, [{ round: 1, jobId: 'job-3', executionStatus: 'failed', passed: false, results: [] }]);

  const stuck = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs-3'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, timeoutMs: 5,
    invoke: ticketGateway().invoke(async method => method === 'execution_submit' ? { jobId: 'job-4' } : { executionStatus: 'working' }) });
  assert.equal(stuck.passed, false);
  assert.equal(stuck.rounds[0]!.executionStatus, 'timed_out', 'a task that never finishes is recorded, not thrown');
});

test('with QA on, a QA agent in its own session reviews a frozen copy, its issues go back to the executor, and the same QA session re-reviews the revision', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t), gw = ticketGateway();
  let work = '', reviews = 0;
  const first = outline('example/demo', f.commit), revised = { ...first, project: { ...first.project, oneLiner: '一行命令生成产品介绍' } };
  const review = (verdict: string, issues: unknown[]) => ({ verdict, summary: verdict === 'pass' ? '可以了' : '开头太空泛', issues,
    scores: { 吸引力: verdict === 'pass' ? 4 : 2, 具体: 4, 受众: 4, 结构: 4, 可信: 5, 行动: 4 } });
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, qa: { agentPreset: 'qa-preset' },
    invoke: gw.invoke(async (method, params: any) => {
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
      if (method === 'execution_continue') { await writeFile(join(work, 'outline.json'), JSON.stringify(revised)); handleTicket(gw.round('job-1'), '改成一行命令生成产品介绍'); return { jobId: 'job-1' }; }
      return { executionStatus: 'completed' };
    }) });
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
  assert.deepEqual(gw.ledger.events('rsi-test', gw.job('job-1')).filter(e => e.type === 'ticket.reviewed').map(e => (e.data as any).qaJobId), ['qa-1', 'qa-1'], 'the QA job is on record');
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

test('a QA agent that edits the outline itself is undone, its edit of the exported ticket changes nothing, and a run without a readable review stops without sending anything back', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t);
  let work = '';
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, qa: {},
    invoke: ticketGateway().invoke(async (method, params: any) => {
      f.calls.push({ method, params });
      if (method === 'execution_submit' && params.title.startsWith('质检')) {
        await writeFile(join(work, 'outline.json'), '{"tampered":true}');
        await rm(join(work, 'ticket.json')); await writeFile(join(work, 'ticket.json'), '{"status":"closed"}'); return { jobId: 'qa-1' };
      }
      if (method === 'execution_submit') { work = params.input.cwd; await writeFile(join(work, 'outline.json'), JSON.stringify(outline('example/demo', f.commit))); return { jobId: 'job-1' }; }
      return { executionStatus: 'completed' };
    }) });
  assert.equal(report.passed, false);
  assert.match(report.rounds[0]!.review!.error!, /改动了 outline\.json，已恢复.*读不出来/);
  assert.equal((await readTicket(work)).status, 'stopped', 'the export is rewritten from the gateway ticket, which records how the run ended');
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
  const gw = ticketGateway();
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace,
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, qa: {}, ...extra,
    invoke: gw.invoke(async (method, params: any) => {
      const qa = async () => { reviews++; await writeFile(join(work, 'reviews', `review-r${reviews}.json`), JSON.stringify(script(reviews))); return { jobId: 'qa-1' }; };
      if (method === 'execution_submit' && params.title.startsWith('质检')) return qa();
      if (method === 'execution_continue' && params.jobId === 'qa-1') return qa();
      if (method === 'execution_submit' || method === 'execution_continue') {
        if (method === 'execution_submit') work = params.input.cwd;
        const doc = outline('example/demo', f.commit); doc.project.oneLiner = `第 ${++edits} 版`;
        await writeFile(join(work, 'outline.json'), JSON.stringify(doc));
        if (method === 'execution_continue') handleTicket(gw.round('job-1'));
        return { jobId: 'job-1' };
      }
      return { executionStatus: 'completed' };
    }) });
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
  assert.match(blocked.reasons.join('\n'), /初稿没有一次通过/); assert.match(blocked.reasons.join('\n'), /1 条提议还没人处理（#1 locked）/);
  await write([entry({ passed: false, stopReason: 'stalled' }), entry(), entry({ proposals: [{ kind: 'role', text: '开头' }] }),
    entry({ role: { commit: 'f'.repeat(40), dirty: false } }), entry({ phase: 'test', caseId: 'demo' })]);
  const open = await gate();
  assert.equal(open.ready, true, 'the two newest dev runs on this version are clean; an older failure and another version do not count');
  assert.deepEqual(open.testCases.find(c => c.caseId === 'demo'), { caseId: 'demo', kind: 'original', result: 'passed' });
  assert.equal(open.testCases.find(c => c.caseId === 'dreammate-network')!.result, 'not_run');

  await write([entry(), entry({ passed: false, stopReason: 'review_failed', startedAt: '2026-10-31T01:00:00.000Z' }), entry()]);
  const quota = await gate();
  assert.equal(quota.ready, true, 'a run whose QA task never finished says nothing about the role');
  assert.deepEqual(quota.unfinished.map(run => run.stopReason), ['review_failed']);

  // Proposals are read live from the ticket: open ones block, settled ones do not.
  let state = 'open';
  const proposals = [{ kind: 'check' as const, text: '收尾页要有完整地址' }];
  const live = (jobId: string) => entry({ jobId, originSessionId: 'rsi-test', proposals });
  const invoke = async (method: string, params: any) => {
    assert.equal(method, 'ticket_get'); assert.equal(params.originSessionId, 'rsi-test');
    return { proposals: [{ id: 'R1-1', ...proposals[0], raisedInRound: 1, state }] };
  };
  await write([live('job-a'), live('job-b')]);
  const waiting = await checkGate({ roleDirectory: f.role, workspace, invoke });
  assert.equal(waiting.ready, false);
  assert.match(waiting.reasons.join('\n'), /1 条提议还没人处理（R1-1 check），用 acp-service ticket proposal --job job-b --id <编号>/);
  state = 'rejected';
  assert.equal((await checkGate({ roleDirectory: f.role, workspace, invoke })).ready, true, 'a person settled the proposal on the ticket');

  await writeFile(join(f.role, 'ROLE.md'), '# 改了一句\n', { flag: 'a' });
  const dirty = await gate();
  assert.equal(dirty.ready, false); assert.match(dirty.reasons.join('\n'), /未提交的改动/);
  await assert.rejects(runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace, phase: 'test', qa: {},
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, invoke: async () => ({}) }), /committed with no local changes/);
});

test('an executor that ends its round without submitting the ticket is sent back once with the reason', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t), gw = ticketGateway();
  let work = '', continues = 0;
  const first = outline('example/demo', f.commit);
  const review = (verdict: string) => ({ verdict, summary: '…', scores: { 吸引力: 4, 具体: 4, 受众: 4, 结构: 4, 可信: 4, 行动: 4 },
    issues: verdict === 'pass' ? [] : [{ where: 'project/oneLiner', problem: '太空泛', suggestion: '写场景', severity: 'must' }],
    ...(verdict === 'pass' ? { previous: [{ id: 'Q1-1', status: 'fixed' }] } : {}) });
  const report = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, qa: {},
    invoke: gw.invoke(async (method, params: any) => {
      f.calls.push({ method, params });
      const qa = (verdict: string) => writeFile(join(work, 'reviews', `review-r${verdict === 'pass' ? 3 : 1}.json`), JSON.stringify(review(verdict))).then(() => ({ jobId: 'qa-1' }));
      if (method === 'execution_submit' && params.title.startsWith('质检')) return qa('revise');
      if (method === 'execution_continue' && params.jobId === 'qa-1') return qa('pass');
      if (method === 'execution_submit') { work = params.input.cwd; await writeFile(join(work, 'outline.json'), JSON.stringify(first)); return { jobId: 'job-1' }; }
      if (method === 'execution_continue' && ++continues === 1) {
        // Editing the export instead of using the tools leaves the gateway ticket as it was.
        await rm(join(work, 'ticket.json')); await writeFile(join(work, 'ticket.json'), '{"status":"ready_for_review"}');
        return { jobId: 'job-1' };
      }
      if (method === 'execution_continue') { handleTicket(gw.round('job-1'), '开头改成场景加结果'); return { jobId: 'job-1' }; }
      return { executionStatus: 'completed' };
    }) });
  assert.equal(report.passed, true);
  assert.deepEqual(report.rounds[1]!.ticketErrors, ['还没有提交任务单（待处理 Q1-1）']);
  assert.equal(report.rounds[1]!.results.length, 0, 'the round goes back unchecked');
  const bounce = f.calls.filter(call => call.method === 'execution_continue' && call.params.jobId === 'job-1')[1]!.params.input.prompt;
  assert.match(bounce, /任务单没有按规定处理/); assert.match(bounce, /还没有提交任务单/); assert.match(bounce, /`ticket_submit`/);
  const ticket = await readTicket(work);
  assert.deepEqual(ticket.items[0]!.log.map(e => `${e.round}:${e.by}:${e.action}`), ['1:qa:raised', '3:executor:done', '3:qa:fixed']);
  assert.equal(ticket.status, 'closed');
  assert.equal(gw.ledger.events('rsi-test', gw.job('job-1')).filter(e => e.type === 'ticket.revision_started').length, 2);

  const once = await runOutlineCase({ roleDirectory: f.role, caseId: 'demo', projectPath: f.project, workspace: join(f.root, 'runs-2'),
    targetId: 'dsh-host', agentPreset: 'standard', originSessionId: 'rsi-test', pollMs: 1, qa: {},
    invoke: ticketGateway().invoke(async (method, params: any) => {
      if (method === 'execution_submit' && params.title.startsWith('质检')) return qa1();
      if (method === 'execution_submit') { work = params.input.cwd; await writeFile(join(work, 'outline.json'), JSON.stringify(first)); return { jobId: 'job-1' }; }
      return method === 'execution_continue' ? { jobId: 'job-1' } : { executionStatus: 'completed' };
    }) });
  async function qa1() { await writeFile(join(work, 'reviews', 'review-r1.json'), JSON.stringify(review('revise'))); return { jobId: 'qa-1' }; }
  assert.equal(once.stopReason, 'max_bounces', 'the bounce counts against maxBounces');
  assert.equal((await readTicket(work)).stopReason, 'max_bounces');
});

test('P12-P14: the closing slide comes last, a title that counts its points is right, and the same sources are not paraphrased twice', { skip: !checksAvailable && 'python3 jsonschema is unavailable' }, async t => {
  const f = await fixture(t), dir = join(f.root, 'checks-case'), project = join(dir, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# 示例\n\n一个命令行工具。\n');
  await writeFile(join(project, 'GUIDE.md'), '# 指南\n');
  await writeFile(join(dir, 'features.json'), await readFile(join(f.role, 'cases', 'demo', 'features.json')));
  const run = async (doc: unknown) => {
    await writeFile(join(dir, 'outline.json'), JSON.stringify(doc));
    const out = spawnSync('python3', ['-I', join(f.role, 'checks', 'check_outline.py'), join(dir, 'outline.json'), join(dir, 'features.json'), project], { encoding: 'utf8' });
    return Object.fromEntries((JSON.parse(out.stdout) as { itemId: string; pass: boolean; evidence: any[] }[]).map(r => [r.itemId, r]));
  };
  const point = (text: string, path = 'README.md') => ({ text, sources: [{ path }] });
  const ok = outline('example/demo', f.commit) as any;
  ok.sections[3].slides[0].title = '第一步：装好就能用';
  ok.sections[2].slides[0].title = '六个演示场景';
  ok.sections[1].slides[0].points.push(point('运行 npm run dev 打开 TypeScript 项目'), point('客户打开链接就能看到演示'));
  ok.sections[3].slides[0].points.push(point('运行 npm run dev 再看 TypeScript 报错'), point('打开链接就能看到演示', 'GUIDE.md'), point('客户打开链接就能看到演示'));
  ok.sections[3].slides[0].points.pop();
  ok.sections[3].slides[1].title = '下一步：三步开始';
  ok.sections[3].slides[1].points = [point('一'), point('二'), point('三')].map((p, i) => ({ ...p, text: `第${p.text}步` + '子'.repeat(i) }));
  const good = await run(ok);
  assert.deepEqual(['P12', 'P13', 'P14'].map(id => [id, good[id]!.pass, good[id]!.evidence]), [['P12', true, []], ['P13', true, []], ['P14', true, []]],
    'ordinals, counts of things, shared English words and the same text from other sources are fine');

  const bad = structuredClone(ok);
  bad.sections[3].slides[1].title = '下一步：四个动作';
  bad.sections[1].slides[0].points.push(point('演示站可以放到公司自己的服务器或内网'));
  bad.sections[3].slides[0].points.push(point('交给 IT 放到公司自己的服务器或内网即可'));
  const r = await run(bad);
  assert.match(JSON.stringify(r.P13!.evidence), /slides\/1\/title.*四个动作.*3 points/);
  assert.match(JSON.stringify(r.P14!.evidence), /getting_started\/slides\/0\/points\/\d.*features\/slides\/0\/points\/\d.*放到公司自己的服务器或内网/);

  const moved = structuredClone(ok);
  moved.sections[1].slides.push(moved.sections[3].slides.pop());
  const p12 = (await run(moved)).P12!;
  assert.match(JSON.stringify(p12.evidence), /features\/slides\/1.*not the last slide.*getting_started\/slides\/0.*must use the closing layout/);
});
