import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { settler } from '../bin/ticket.js';
import { JobLedger, type LedgerState } from '../src/execution/ledger.js';
import { invokeTicket, TICKET_METHODS, type Ticket } from '../src/execution/ticket.js';
import { runExecutorTicket } from '../src/execution/ticket-executor.js';

const origin = 'root', target = { targetId: 'dsh-host' };
const review = (over: Record<string, unknown> = {}) => ({ verdict: 'revise', summary: '还要改', scores: { 吸引力: 3 },
  issues: [{ where: 'project/oneLiner', problem: '太空泛', suggestion: '写场景', severity: 'must' }], ...over });

/** A ledger with one executor job whose current attempt is running in `session`. */
function fixture() {
  let saved: LedgerState | undefined;
  const ledger = new JobLedger(undefined, next => { saved = structuredClone(next); });
  const prepared = ledger.prepare({ originSessionId: origin, targetSnapshot: target, input: {} }), jobId = prepared.job.jobId;
  const running = (attemptId: string) => {
    ledger.markDispatching(attemptId);
    ledger.accept(attemptId, { provider: 'a2a', taskId: attemptId, sessionId: 'session' }, { executionStatus: 'working' });
    return attemptId;
  };
  let attemptId = running(prepared.attempt.attemptId);
  const call = (method: string, params: Record<string, unknown> = {}) => invokeTicket(ledger, method, { originSessionId: origin, jobId, ...params });
  const executor = (method: string, params: Record<string, unknown> = {}) => invokeTicket(ledger, method, { jobId, attemptId, sessionId: 'session', ...params });
  /** The host sends the ticket back and continues the job: a new attempt in the same session. */
  const revise = () => {
    call('ticket_revise', { note: '打回' });
    ledger.observe(attemptId, { executionStatus: 'completed' });
    attemptId = running(ledger.prepare({ originSessionId: origin, jobId, targetSnapshot: target, input: {} }).attempt.attemptId);
  };
  const events = () => ledger.events(origin, jobId).filter(event => event.type.startsWith('ticket.'));
  return { ledger, jobId, call, executor, revise, events, attempt: () => attemptId, saved: () => saved };
}

test('every actor operation is one ticket event on the job, and a full round trip lands in the ledger', () => {
  const f = fixture();
  f.call('ticket_open', { roleId: 'role', caseId: 'demo' });
  f.call('ticket_checks', { results: [{ itemId: 'P2', pass: false, evidence: [{ path: 'style/font' }] }, { itemId: 'P3', pass: true, evidence: [] }] });
  f.revise();
  assert.equal((f.executor('ticket_show') as Ticket).items[0]!.id, 'P1-P2');
  f.executor('ticket_mark', { itemId: 'P1-P2', state: 'done', note: '字体改了' });
  f.executor('ticket_submit');
  f.call('ticket_checks', { results: [{ itemId: 'P2', pass: true, evidence: [] }] });
  f.call('ticket_review', { qaJobId: 'qa-job', review: review({ proposals: [{ kind: 'check', text: '加一条检查' }] }) });
  f.revise();
  f.executor('ticket_mark', { itemId: 'Q2-1', state: 'disputed', note: '仓库里就是这么写的' });
  f.executor('ticket_submit');
  f.call('ticket_checks', { results: [{ itemId: 'P2', pass: true, evidence: [] }] });
  f.call('ticket_review', { qaJobId: 'qa-job', review: review({ verdict: 'pass', issues: [], previous: [{ id: 'Q2-1', status: 'withdrawn', note: '有道理' }],
    proposals: [{ kind: 'check', text: '加一条检查' }, { kind: 'role', text: '开头先写场景' }] }) });
  const closed = f.call('ticket_close', { status: 'closed', stopReason: 'passed' });
  assert.deepEqual(closed.items.map(item => [item.id, item.state]), [['P1-P2', 'verified'], ['Q2-1', 'withdrawn']]);
  assert.deepEqual(closed.proposals.map(p => p.id), ['R2-1', 'R3-2'], 'a proposal repeated word for word is not added again');
  assert.equal(closed.status, 'closed');
  assert.deepEqual(f.events().map(event => `${event.type}:${(event.data as any).actor}`), [
    'ticket.opened:host', 'ticket.item_raised:host', 'ticket.checked:host', 'ticket.revision_started:host',
    'ticket.item_marked:executor', 'ticket.submitted:executor', 'ticket.item_settled:host', 'ticket.checked:host',
    'ticket.item_raised:qa', 'ticket.proposal_raised:qa', 'ticket.reviewed:qa', 'ticket.revision_started:host',
    'ticket.item_marked:executor', 'ticket.submitted:executor', 'ticket.checked:host',
    'ticket.item_settled:qa', 'ticket.proposal_raised:qa', 'ticket.reviewed:qa', 'ticket.closed:host']);
  const marked = f.events().find(event => event.type === 'ticket.item_marked')!;
  assert.deepEqual(marked.data, { actor: 'executor', round: 2, itemId: 'P1-P2', state: 'done', note: '字体改了', attemptId: marked.attemptId, sessionId: 'session' });
  assert.ok(marked.attemptId);
  assert.equal((f.events().find(event => event.type === 'ticket.reviewed')!.data as any).qaJobId, 'qa-job');
  assert.deepEqual(f.saved()!.tickets![f.jobId], closed, 'the ticket is persisted with the ledger');
  assert.deepEqual(new JobLedger(f.saved(), () => {}).ticket(origin, f.jobId), closed, 'and survives a restart');

  const settled = f.call('ticket_proposal', { proposalId: 'R2-1', state: 'accepted', note: '写进 P15' });
  assert.deepEqual(settled.proposals[0], { id: 'R2-1', kind: 'check', text: '加一条检查', raisedInRound: 2, state: 'accepted', note: '写进 P15', by: { kind: 'person' } }, 'a person settles proposals after the run');
  assert.deepEqual(f.events().at(-1)!.data, { actor: 'person', round: 3, proposalId: 'R2-1', state: 'accepted', note: '写进 P15' });
});

test('the executor may only mark its pending items with a note and submit when nothing is pending, in a revision round of its current attempt', () => {
  const f = fixture();
  f.call('ticket_open', { roleId: 'role', caseId: 'demo' });
  f.call('ticket_checks', { results: [{ itemId: 'P2', pass: false, evidence: [] }, { itemId: 'P5', pass: false, evidence: [] }] });
  assert.throws(() => f.executor('ticket_mark', { itemId: 'P1-P2', state: 'done', note: '改了' }), /状态是 drafting，现在不能修改/, 'not before the ticket is sent back');
  f.revise();
  const before = f.events().length;
  assert.throws(() => f.executor('ticket_mark', { itemId: 'P1-P2', state: 'done', note: '  ' }), /说明不能为空/);
  assert.throws(() => f.executor('ticket_mark', { itemId: 'P1-P2', state: 'verified', note: '好了' }), /Invalid option/, 'verifying is not the executor’s call');
  assert.throws(() => f.executor('ticket_mark', { itemId: 'Q9-9', state: 'done', note: 'x' }), /没有 Q9-9/);
  assert.throws(() => f.executor('ticket_submit'), /还有 2 条没处理：P1-P2、P1-P5/);
  f.executor('ticket_mark', { itemId: 'P1-P2', state: 'done', note: '改了' });
  assert.throws(() => f.executor('ticket_mark', { itemId: 'P1-P2', state: 'disputed', note: '改主意' }), /已经是 done/);
  assert.throws(() => f.executor('ticket_show', { sessionId: 'other-session' }), /不是执行这一轮的会话/);
  const stale = f.attempt();
  f.revise();
  assert.throws(() => invokeTicket(f.ledger, 'ticket_mark', { jobId: f.jobId, attemptId: stale, sessionId: 'session', itemId: 'P1-P5', state: 'done', note: 'x' }), /不是该任务的当前轮次/);
  f.ledger.observe(f.attempt(), { executionStatus: 'completed' });
  assert.throws(() => f.executor('ticket_submit'), /已经结束/);
  assert.throws(() => invokeTicket(f.ledger, 'ticket_checks', { jobId: f.jobId, attemptId: f.attempt(), sessionId: 'session', results: [] }), /originSessionId|Unrecognized/,
    'the executor’s identity reaches no host method');
  assert.equal(f.events().length, before + 2, 'a rejected call records nothing; the mark and the revision did');
});

test('the CLI names only the job and acts for its current round, and every executor event records the channel it came through', async () => {
  const f = fixture();
  f.call('ticket_open', { roleId: 'role', caseId: 'demo' });
  f.call('ticket_checks', { results: [{ itemId: 'P2', pass: false, evidence: [] }, { itemId: 'P5', pass: false, evidence: [] }] });
  f.revise();
  const before = f.events().length;
  assert.throws(() => invokeTicket(f.ledger, 'ticket_show', { jobId: f.jobId }), /attemptId and sessionId are required/, 'the tools still name their attempt and session');
  assert.throws(() => invokeTicket(f.ledger, 'ticket_show', { jobId: f.jobId, attemptId: f.attempt(), sessionId: 'session', via: 'cli' }), /except from the CLI/);
  const invoke = async (method: string, params: Record<string, unknown>) => invokeTicket(f.ledger, method, params);
  const cli = (tool: 'ticket_show' | 'ticket_mark' | 'ticket_submit', args = {}) => runExecutorTicket(invoke, { jobId: f.jobId }, 'cli', tool, args);
  assert.match((await cli('ticket_show')).text, /P1-P2 \[必须改\][\s\S]*待处理 2 条，任务单状态 in_revision，第 2 轮/);
  assert.deepEqual(await cli('ticket_mark', { id: 'P1-P2', state: 'done', note: '字体改了' }), { text: 'P1-P2 已标为 done，还剩 1 条待处理。' });
  assert.deepEqual(await cli('ticket_submit'), { text: '任务单操作被拒绝：还有 1 条没处理：P1-P5', refused: true });
  await runExecutorTicket(invoke, { jobId: f.jobId, attemptId: f.attempt(), sessionId: 'session' }, 'mcp', 'ticket_mark', { id: 'P1-P5', state: 'disputed', note: '仓库里就是这么写的' });
  assert.deepEqual((await cli('ticket_submit')).text, '任务单已提交（第 2 轮），等待宿主检查。');
  const marks = f.events().slice(before).filter(event => event.type !== 'ticket.revision_started');
  assert.deepEqual(marks.map(event => [event.type, (event.data as any).via, (event.data as any).attemptId, (event.data as any).sessionId]), [
    ['ticket.item_marked', 'cli', f.attempt(), 'session'], ['ticket.item_marked', 'mcp', f.attempt(), 'session'], ['ticket.submitted', 'cli', f.attempt(), 'session']],
  'the CLI is recorded against the round it acted for and the session that runs it');
  f.revise();
  f.ledger.observe(f.attempt(), { executionStatus: 'completed' });
  assert.match((await cli('ticket_show')).text, /任务单操作被拒绝：这一轮执行已经结束/, 'nor once the executor’s round is over');
});

test('the host merges checks only after a submission, reviews only in review, and nothing changes a closed ticket but proposals', () => {
  const f = fixture();
  assert.throws(() => f.call('ticket_get'), /还没有任务单/);
  assert.throws(() => f.call('ticket_checks', { results: [] }), /还没有任务单/);
  f.call('ticket_open', { roleId: 'role', caseId: 'demo' });
  assert.throws(() => f.call('ticket_open', { roleId: 'role', caseId: 'demo' }), /已经有任务单/);
  assert.throws(() => invokeTicket(f.ledger, 'ticket_get', { originSessionId: 'outsider', jobId: f.jobId }), /not found/);
  assert.throws(() => f.call('ticket_review', { review: review() }), /只有程序检查通过后/);
  f.call('ticket_checks', { results: [{ itemId: 'P2', pass: false, evidence: [] }] });
  f.revise();
  assert.throws(() => f.call('ticket_checks', { results: [] }), /只有执行者交稿后/);
  assert.throws(() => f.call('ticket_review', { review: { verdict: 'revise', summary: 'x', scores: {}, issues: [] } }), /at least one issue/);
  const stopped = f.call('ticket_close', { status: 'stopped', stopReason: 'max_bounces' });
  assert.deepEqual([stopped.status, stopped.stopReason, stopped.history.at(-1)], ['stopped', 'max_bounces', { round: 2, by: 'host', action: 'stopped', note: 'max_bounces' }]);
  assert.equal(f.events().at(-1)!.type, 'ticket.stopped');
  assert.throws(() => f.call('ticket_revise'), /已经 stopped/);
  assert.throws(() => f.call('ticket_close', { status: 'closed' }), /已经 stopped/);
  assert.throws(() => f.call('ticket_proposal', { proposalId: 'R1-1', state: 'done' }), /没有提议 R1-1/);
});

test('ledger state written before tickets existed loads and takes tickets', () => {
  const f = fixture(), { tickets: _tickets, ...old } = f.ledger.snapshot();
  const ledger = new JobLedger(old as LedgerState, () => {});
  assert.equal(invokeTicket(ledger, 'ticket_open', { originSessionId: origin, jobId: f.jobId, roleId: 'role', caseId: 'demo' }).status, 'drafting');
});

test('every ticket method is described for discovery', () => {
  assert.deepEqual(Object.keys(TICKET_METHODS), ['ticket_get', 'ticket_open', 'ticket_checks', 'ticket_review', 'ticket_revise', 'ticket_show', 'ticket_mark', 'ticket_submit', 'ticket_proposal', 'ticket_close']);
  for (const method of Object.values(TICKET_METHODS)) assert.equal((method.parameters as { type?: string }).type, 'object');
});

test('a coach settling a proposal is recorded as the coach and its session, a person as a person, and the export follows every change', async t => {
  const f = fixture(), dir = await mkdtemp(join(tmpdir(), 'ticket-export-')), exportPath = join(dir, 'ticket.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(() => f.call('ticket_open', { roleId: 'role', caseId: 'demo', exportPath: 'ticket.json' }), /absolute \.json path/);
  f.call('ticket_open', { roleId: 'role', caseId: 'demo', exportPath });
  const exported = async () => JSON.parse(await readFile(exportPath, 'utf8')) as Ticket;
  assert.equal((await exported()).status, 'drafting');
  assert.equal((await stat(exportPath)).mode & 0o777, 0o444, 'the copy is read-only');
  f.call('ticket_checks', { results: [{ itemId: 'P2', pass: true, evidence: [] }] });
  f.call('ticket_review', { review: review({ proposals: [{ kind: 'check', text: '收尾页要有直链' }, { kind: 'role', text: '开头写场景' }] }) });
  f.call('ticket_close', { status: 'stopped', stopReason: 'max_revisions' });

  f.call('ticket_proposal', { proposalId: 'R1-1', state: 'accepted', note: '下一版写成检查', by: { kind: 'coach', agent: 'claude-code', sessionId: 'cc-1' } });
  f.call('ticket_proposal', { proposalId: 'R1-2', state: 'rejected' });
  assert.throws(() => f.call('ticket_proposal', { proposalId: 'R1-2', state: 'done', by: { kind: 'person', sessionId: 'x' } }), /Only a coach/);
  const marked = f.events().filter(event => event.type === 'ticket.proposal_marked').map(event => event.data);
  assert.deepEqual(marked, [{ actor: 'coach', round: 1, proposalId: 'R1-1', state: 'accepted', note: '下一版写成检查', agent: 'claude-code', sessionId: 'cc-1' },
    { actor: 'person', round: 1, proposalId: 'R1-2', state: 'rejected' }]);
  const copy = await exported();
  assert.equal(copy.status, 'stopped');
  assert.deepEqual(copy.proposals.map(p => [p.id, p.state, p.by?.kind]), [['R1-1', 'accepted', 'coach'], ['R1-2', 'rejected', 'person']], 'settling after the run rewrites the copy too');

  assert.deepEqual(settler({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-9' }), { kind: 'coach', agent: 'claude-code', sessionId: 'cc-9' });
  assert.deepEqual(settler({}), { kind: 'person' }, 'outside an agent harness the CLI speaks for a person');
});
