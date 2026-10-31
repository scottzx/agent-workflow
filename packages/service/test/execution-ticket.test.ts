import assert from 'node:assert/strict';
import test from 'node:test';
import { JobLedger, type LedgerState } from '../src/execution/ledger.js';
import { invokeTicket, TICKET_METHODS, type Ticket } from '../src/execution/ticket.js';

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
  assert.deepEqual(settled.proposals[0], { id: 'R2-1', kind: 'check', text: '加一条检查', raisedInRound: 2, state: 'accepted', note: '写进 P15' }, 'a person settles proposals after the run');
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
