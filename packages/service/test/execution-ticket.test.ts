import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { settler, stampActor } from '../bin/ticket.js';
import { JobLedger, type LedgerState } from '../src/execution/ledger.js';
import { invokeTicket, reopenForContinue, TICKET_METHODS, type Ticket } from '../src/execution/ticket.js';
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
  assert.deepEqual(marks.map(event => [event.type, (event.data as any).via, (event.data as any).attemptId, (event.data as any).sessionId, (event.data as any).callerUnverified]), [
    ['ticket.item_marked', 'cli', f.attempt(), undefined, true], ['ticket.item_marked', 'mcp', f.attempt(), 'session', undefined],
    ['ticket.submitted', 'cli', f.attempt(), undefined, true]],
  'the CLI is recorded against the round it acted for, as an unverified caller, never under the executor’s session');
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
  assert.deepEqual(Object.keys(TICKET_METHODS), ['ticket_get', 'ticket_open', 'ticket_checks', 'ticket_review', 'ticket_revise', 'ticket_show', 'ticket_mark', 'ticket_self_check', 'ticket_submit', 'ticket_proposal', 'ticket_close', 'ticket_reopen']);
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
  const coach = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-9' }, named = { kind: 'coach', agent: 'claude-code', sessionId: 'cc-9' };
  assert.deepEqual(stampActor('execution_submit', { targetId: 't' }, coach), { targetId: 't', initiatedBy: named });
  assert.deepEqual(stampActor('execution_review', { jobId: 'j' }, {}), { jobId: 'j', decidedBy: { kind: 'person' } });
  assert.deepEqual(stampActor('execution_submit', { initiatedBy: { kind: 'person' } }, coach), { initiatedBy: { kind: 'person' } }, 'a caller that named itself keeps its name');
  assert.deepEqual(stampActor('execution_get', { jobId: 'j' }, coach), { jobId: 'j' });
});

test('a stopped ticket reopens where it stood, a continue sends it back to the executor, and a closed one stays closed', () => {
  const f = fixture();
  f.call('ticket_open', { roleId: 'role', caseId: 'demo' });
  assert.throws(() => f.call('ticket_reopen'), /只有 stopped/);
  f.call('ticket_close', { status: 'stopped', stopReason: 'not_completed' });
  assert.throws(() => f.executor('ticket_mark', { itemId: 'Q1-1', state: 'done', note: '改了' }), /stopped/);
  const drafting = f.call('ticket_reopen', { note: '接着跑' });
  assert.deepEqual([drafting.status, drafting.round, drafting.stopReason, drafting.stoppedFrom], ['drafting', 1, undefined, undefined]);
  assert.deepEqual(drafting.history.at(-1), { round: 1, by: 'host', action: 'reopened', note: '接着跑' });
  assert.deepEqual(f.events().at(-1)!.data, { actor: 'host', round: 1, status: 'drafting', note: '接着跑' });

  f.call('ticket_checks', { results: [] });
  f.call('ticket_close', { status: 'stopped', stopReason: 'review_failed' });
  assert.equal(f.call('ticket_reopen').status, 'in_review', 'QA goes on with the same review');
  f.call('ticket_close', { status: 'stopped', stopReason: 'review_failed' });
  reopenForContinue(f.ledger, origin, f.jobId);
  const again = f.call('ticket_get');
  assert.deepEqual([again.status, again.round], ['in_revision', 2], 'the executor cannot mark a ticket under review, so a continue starts a revision');
  f.call('ticket_close', { status: 'closed' });
  reopenForContinue(f.ledger, origin, f.jobId);
  assert.equal(f.call('ticket_get').status, 'closed');
  const bare = new JobLedger(undefined, () => {}), job = bare.prepare({ originSessionId: origin, targetSnapshot: target, input: {} }).job.jobId;
  reopenForContinue(bare, origin, job);
});

const selfCheck = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'self', severity: 'must', rule: `${id} 的规则`, ...over });

test('required self-checks block the first submit until each one is marked, from every executor channel', async () => {
  const f = fixture();
  assert.throws(() => f.call('ticket_open', { roleId: 'role', caseId: 'demo', selfChecks: [{ ...selfCheck('A1'), state: 'pass' }] }), /Unrecognized key/,
    'a caller cannot open a self-check already marked');
  const opened = f.call('ticket_open', { roleId: 'role', caseId: 'demo', artifacts: ['outline.json'], selfChecks: [
    selfCheck('A1', { evidenceHint: '引用标题' }), selfCheck('S1', { kind: 'self_and_qa' }), selfCheck('P5', { kind: 'program', severity: 'should', recheckOnRevision: false })] });
  assert.equal(opened.status, 'drafting');
  assert.equal(opened.outline, 'outline.json');
  assert.deepEqual(opened.artifacts, ['outline.json']);
  assert.deepEqual(opened.selfChecks?.map(check => [check.id, check.kind, check.state, check.recheckOnRevision, check.evidenceHint]), [
    ['A1', 'self', 'pending', true, '引用标题'], ['S1', 'self_and_qa', 'pending', true, undefined], ['P5', 'program', 'pending', false, undefined]]);
  assert.throws(() => f.executor('ticket_submit'), /还有 2 条必填自检未打卡：A1、S1/);
  assert.throws(() => f.executor('ticket_self_check', { checkId: 'S1', status: 'pass', note: '  ' }), /说明不能为空/);
  assert.throws(() => f.executor('ticket_self_check', { checkId: 'S1', status: 'done', note: 'x' }), /Invalid option/);
  assert.throws(() => f.executor('ticket_self_check', { checkId: 'Z9', status: 'pass', note: '没有这项' }), /没有自检项 Z9/);
  assert.throws(() => f.executor('ticket_self_check', { sessionId: 'other-session', checkId: 'A1', status: 'pass', note: '标题含受众' }), /不是执行这一轮的会话/);
  const invoke = async (method: string, params: Record<string, unknown>) => invokeTicket(f.ledger, method, params);
  const shown = await runExecutorTicket(invoke, { jobId: f.jobId }, 'cli', 'ticket_show');
  assert.match(shown.text, /预置自检清单（待打卡 3 条 \/ 已完成 0 条）[\s\S]*A1 \[必填\] pending：A1 的规则[\s\S]*待处理修改意见（共 0 条）[\s\S]*待处理 0 条，任务单状态 drafting，第 1 轮/);
  assert.deepEqual(await runExecutorTicket(invoke, { jobId: f.jobId }, 'cli', 'ticket_self_check', { id: 'A1', status: 'pass', note: '标题含受众' }),
    { text: 'A1 已自检为 pass，还剩 1 条必填自检待完成。' });
  await runExecutorTicket(invoke, { jobId: f.jobId, attemptId: f.attempt(), sessionId: 'session' }, 'mcp', 'ticket_self_check', { id: 'S1', status: 'na', note: '本题没有场景字段' });
  const checked = f.events().filter(event => event.type === 'ticket.self_checked');
  assert.deepEqual(checked.map(event => [event.type, (event.data as any).via, (event.data as any).checkId, (event.data as any).status, (event.data as any).note, (event.data as any).sessionId, (event.data as any).callerUnverified]), [
    ['ticket.self_checked', 'cli', 'A1', 'pass', '标题含受众', undefined, true],
    ['ticket.self_checked', 'mcp', 'S1', 'na', '本题没有场景字段', 'session', undefined]]);
  assert.equal((checked[0]!.data as any).actor, 'executor');
  assert.equal((checked[0]!.data as any).round, 1);
  assert.equal(checked[0]!.attemptId, f.attempt());
  const submitted = f.executor('ticket_submit') as Ticket;
  assert.equal(submitted.status, 'ready_for_review');
  assert.deepEqual(submitted.selfChecks?.map(check => [check.id, check.state, check.checkedInRound]), [['A1', 'pass', 1], ['S1', 'na', 1], ['P5', 'pending', undefined]]);
  assert.equal(f.events().at(-1)!.type, 'ticket.submitted');
  assert.throws(() => f.executor('ticket_self_check', { checkId: 'P5', status: 'pass', note: '交稿后不能再改' }), /ready_for_review/);
});

test('a self-check marked pass is cross-checked when the same program check fails, including when that item is reopened', () => {
  const f = fixture();
  f.call('ticket_open', { roleId: 'role', caseId: 'demo', selfChecks: [
    selfCheck('P5', { kind: 'program', rule: '字体符合规范', recheckOnRevision: false }),
    selfCheck('P9', { kind: 'program', rule: '另一项', recheckOnRevision: false })] });
  f.executor('ticket_self_check', { checkId: 'P5', status: 'pass', note: '已核对字体' });
  f.executor('ticket_self_check', { checkId: 'P9', status: 'na', note: '本题不涉及' });
  f.executor('ticket_submit');
  const checked = f.call('ticket_checks', { results: [
    { itemId: 'P5', pass: false, evidence: [{ path: 'style/font' }] }, { itemId: 'P9', pass: false, evidence: [] }, { itemId: 'P2', pass: true, evidence: [] }] });
  const failed = checked.items.find(item => item.id === 'P1-P5');
  assert.deepEqual(failed?.crossCheck, { kind: 'self_vs_program', checkId: 'P5', claimedState: 'pass', claimedNote: '已核对字体', actualVerdict: 'fail' });
  assert.equal(checked.items.find(item => item.id === 'P1-P9')?.crossCheck, undefined, 'na is not a claim that the program check passed');
  assert.deepEqual(f.events().filter(event => event.type === 'ticket.crosscheck_mismatch').map(event => event.data), [
    { actor: 'host', round: 1, itemId: 'P1-P5', kind: 'self_vs_program', checkId: 'P5', claimedState: 'pass', claimedNote: '已核对字体', actualVerdict: 'fail' }]);
  f.revise();
  f.executor('ticket_mark', { itemId: 'P1-P5', state: 'done', note: '字体改了' });
  f.executor('ticket_mark', { itemId: 'P1-P9', state: 'done', note: '不适用已说明' });
  f.executor('ticket_submit');
  const again = f.call('ticket_checks', { results: [{ itemId: 'P5', pass: false, evidence: [{ path: 'style/font' }] }, { itemId: 'P9', pass: true, evidence: [] }] });
  assert.equal(again.items.find(item => item.id === 'P1-P5')?.state, 'reopened');
  assert.equal(again.items.find(item => item.id === 'P1-P5')?.crossCheck?.kind, 'self_vs_program');
  assert.equal(again.items.find(item => item.id === 'P1-P9')?.state, 'verified');
  assert.equal(f.events().filter(event => event.type === 'ticket.crosscheck_mismatch').length, 2);
});

test('a revision resets self-checks that must be rechecked, and submit then requires both opinions and those checks', () => {
  const f = fixture();
  f.call('ticket_open', { roleId: 'role', caseId: 'demo', selfChecks: [selfCheck('A1'), selfCheck('B1', { recheckOnRevision: false, rule: '不必重核' })] });
  f.executor('ticket_self_check', { checkId: 'A1', status: 'pass', note: '第一轮核对过' });
  f.executor('ticket_self_check', { checkId: 'B1', status: 'pass', note: '这项保持有效' });
  f.executor('ticket_submit');
  f.call('ticket_checks', { results: [{ itemId: 'P2', pass: false, evidence: [] }] });
  f.revise();
  const revised = f.call('ticket_get');
  const a1 = revised.selfChecks?.find(check => check.id === 'A1'), b1 = revised.selfChecks?.find(check => check.id === 'B1');
  assert.equal(revised.status, 'in_revision');
  assert.equal(revised.round, 2);
  assert.deepEqual([a1?.state, a1?.note, a1?.checkedInRound, a1?.log.map(entry => entry.note)], ['pending', undefined, undefined, ['第一轮核对过']]);
  assert.deepEqual([b1?.state, b1?.note, b1?.checkedInRound], ['pass', '这项保持有效', 1]);
  assert.throws(() => f.executor('ticket_submit'), (error: Error) => {
    assert.match(error.message, /还有 1 条没处理：P1-P2/);
    assert.match(error.message, /还有 1 条必填自检未打卡：A1/);
    assert.doesNotMatch(error.message, /B1/);
    return true;
  });
  f.executor('ticket_mark', { itemId: 'P1-P2', state: 'done', note: '改了' });
  assert.throws(() => f.executor('ticket_submit'), /还有 1 条必填自检未打卡：A1/);
  f.executor('ticket_self_check', { checkId: 'A1', status: 'pass', note: '修改后再次核对' });
  const submitted = f.executor('ticket_submit') as Ticket;
  assert.equal(submitted.status, 'ready_for_review');
  assert.deepEqual(submitted.selfChecks?.find(check => check.id === 'A1')?.log.map(entry => [entry.round, entry.note]), [[1, '第一轮核对过'], [2, '修改后再次核对']]);
});

test('QA self-check audit records agreement and turns a disagreement into an X item', () => {
  const f = fixture();
  f.call('ticket_open', { roleId: 'role', caseId: 'demo', selfChecks: [selfCheck('A1', { kind: 'self_and_qa' }), selfCheck('S1', { kind: 'self_and_qa', rule: '场景要具体' })] });
  f.executor('ticket_self_check', { checkId: 'A1', status: 'pass', note: '标题含受众' });
  f.executor('ticket_self_check', { checkId: 'S1', status: 'pass', note: '写了会议室' });
  f.executor('ticket_submit');
  f.call('ticket_checks', { results: [{ itemId: 'P1', pass: true, evidence: [] }] });
  assert.throws(() => f.call('ticket_review', { review: review({ issues: [], selfCheckAudit: [{ id: 'A1', verdict: 'agree' }] }) }), /at least one issue/);
  const reviewed = f.call('ticket_review', { qaJobId: 'qa-job', review: review({ issues: [], summary: '自检对不上', selfCheckAudit: [
    { id: 'A1', verdict: 'agree', note: '依据成立' }, { id: 'S1', verdict: 'disagree', note: '场景仍是空话' }] }) });
  const a1 = reviewed.selfChecks?.find(check => check.id === 'A1'), s1 = reviewed.selfChecks?.find(check => check.id === 'S1');
  assert.deepEqual(a1?.log.at(-1), { round: 1, by: 'qa', action: 'agree', note: '依据成立' });
  assert.deepEqual(s1?.log.at(-1), { round: 1, by: 'qa', action: 'disagree', note: '场景仍是空话' });
  const item = reviewed.items.find(entry => entry.id === 'X1-S1');
  assert.equal(item?.source, 'qa');
  assert.equal(item?.severity, 'must');
  assert.deepEqual(item?.crossCheck, { kind: 'self_vs_qa', checkId: 'S1', claimedState: 'pass', claimedNote: '写了会议室', actualVerdict: 'disagree', actualNote: '场景仍是空话' });
  assert.match(item?.problem ?? '', /写了会议室/);
  assert.match(item?.problem ?? '', /场景仍是空话/);
  const auditEvents = f.events().filter(event => event.type === 'ticket.self_check_verified' || event.type === 'ticket.item_raised' || event.type === 'ticket.crosscheck_mismatch');
  assert.deepEqual(auditEvents.map(event => [event.type, (event.data as any).checkId ?? (event.data as any).itemId, (event.data as any).actor]), [
    ['ticket.self_check_verified', 'A1', 'qa'], ['ticket.item_raised', 'X1-S1', 'qa'], ['ticket.crosscheck_mismatch', 'S1', 'qa']]);
  assert.equal((auditEvents[0]!.data as any).qaJobId, 'qa-job');
  assert.equal((auditEvents[2]!.data as any).kind, 'self_vs_qa');
  assert.equal((auditEvents[2]!.data as any).actualVerdict, 'disagree');
});

test('a ticket opened without self-checks keeps the old check, revision and submit path', () => {
  const f = fixture();
  const opened = f.call('ticket_open', { roleId: 'role', caseId: 'demo' });
  assert.equal(opened.outline, 'outline.json');
  assert.equal(opened.selfChecks, undefined);
  assert.equal(opened.artifacts, undefined);
  assert.throws(() => f.executor('ticket_self_check', { checkId: 'A1', status: 'pass', note: '没有这项' }), /没有自检项 A1/);
  const checked = f.call('ticket_checks', { results: [{ itemId: 'P2', pass: false, evidence: [{ path: 'style/font' }] }] });
  assert.equal(checked.status, 'drafting', 'the first round can still enter checks without ticket_submit');
  assert.equal(checked.items[0]?.id, 'P1-P2');
  assert.equal(checked.items[0]?.crossCheck, undefined);
  f.revise();
  f.executor('ticket_mark', { itemId: 'P1-P2', state: 'done', note: '改了' });
  assert.equal((f.executor('ticket_submit') as Ticket).status, 'ready_for_review');
  assert.equal(f.events().some(event => event.type === 'ticket.self_checked' || event.type === 'ticket.crosscheck_mismatch'), false);
});

test('observe-only check failures do not raise must items or block transition to in_review, and qualityReviewSchema passes through rubric', () => {
  const f = fixture();
  f.call('ticket_open', { roleId: 'product-intro-outline', caseId: 'demo' });
  const checked = f.call('ticket_checks', {
    results: [
      { itemId: 'P1', pass: true, evidence: [] },
      { itemId: 'P16', pass: false, evidence: [{ path: 'rubric.json', message: 'broken rubric' }] },
    ],
    observeItemIds: ['P16'],
  });
  assert.equal(checked.status, 'in_review', 'observe-only failure must not block in_review');
  assert.deepEqual(checked.items, [], 'observe-only failure must not open a must ticket item');
  const checkedEvent = f.events().find(event => event.type === 'ticket.checked')!;
  assert.equal((checkedEvent.data as any).passed, true);
  assert.deepEqual((checkedEvent.data as any).failed, []);
  assert.deepEqual((checkedEvent.data as any).observeFailed, ['P16']);

  // QualityReview with extra rubric field passes through unchanged (zero qualityReviewSchema change).
  const reviewed = f.call('ticket_review', {
    review: {
      ...review({ verdict: 'pass', issues: [] }),
      rubric: { roleId: 'product-intro-outline', items: [{ id: 'R1', met: true, evidence: 'README.md:1' }] },
    },
  });
  assert.equal(reviewed.history.at(-1)?.verdict, 'pass');

  // Contrast: same P16 failure without observeItemIds (formal/block mode) raises a must item and blocks in_review.
  const formal = fixture();
  formal.call('ticket_open', { roleId: 'product-intro-outline', caseId: 'demo' });
  const blocked = formal.call('ticket_checks', {
    results: [
      { itemId: 'P1', pass: true, evidence: [] },
      { itemId: 'P16', pass: false, evidence: [{ path: 'rubric.json', message: 'broken rubric' }] },
    ],
  });
  assert.equal(blocked.status, 'drafting');
  assert.equal(blocked.items.length, 1);
  assert.equal(blocked.items[0]!.id, 'P1-P16');
  assert.equal(blocked.items[0]!.severity, 'must');
});
