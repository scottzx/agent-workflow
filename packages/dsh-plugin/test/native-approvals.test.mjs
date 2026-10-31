import assert from 'node:assert/strict';
import test from 'node:test';
import { bindA2AExecution, unbindA2AExecution } from '@1agents/acp-service/a2a';
import { registerNativeApprovals } from '../dist/native-approvals.js';

const execution = { jobId: 'job-native', attemptId: 'attempt-native' };

/** The registered listener, plus a process-request client whose answer each test sets. */
function harness(answer = async () => ({ status: 'answered', answer: { outcome: 'approved' } })) {
  const calls = { open: [], wait: [], report: [] };
  let registered;
  const ctx = { on(name, listener, options) { registered = { name, listener, options }; return () => {}; } };
  const client = {
    async open(input) { calls.open.push(input); if (harness.failOpen) throw new Error('gateway unreachable'); return { requestId: input.requestId, deadlineAt: '2099-01-01T00:00:00.000Z', status: 'pending' }; },
    async wait(input) { calls.wait.push(input); return answer(input); },
    async report(input) { calls.report.push(input); },
  };
  registerNativeApprovals(ctx, client);
  const ask = (req, next = async () => 'unavailable') => registered.listener({ toolName: 'bash', reason: 'pip install jsonschema', signal: new AbortController().signal,
    ...req, agent: { id: 'dsh-native', session: { header: { agentPreset: 'standard' } }, ...req.agent } }, next);
  return { registered, calls, ask };
}

test('the listener runs ahead of the host UI on approval/request', () => {
  const { registered } = harness();
  assert.equal(registered.name, 'approval/request');
  assert.deepEqual(registered.options, { prepend: true });
});

test('with real Cordis, the listener answers before a host UI answerer that registered first', async t => {
  const { Context } = await import('@deepseek-ai/cordis');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  let uiAsked = 0;
  ctx.on('approval/request', async () => { uiAsked++; return 'rejected'; });
  registerNativeApprovals(ctx, { open: async input => ({ requestId: input.requestId, deadlineAt: '2099-01-01T00:00:00.000Z', status: 'pending' }),
    wait: async () => ({ status: 'answered', answer: { outcome: 'approved' } }), report: async () => {} });
  const req = { agent: { id: 'dsh-native', session: { header: { agentPreset: 'standard' } } }, toolName: 'bash', callId: 'real-1', reason: 'x', signal: new AbortController().signal };
  bindA2AExecution('dsh-native', execution);
  t.after(() => unbindA2AExecution('dsh-native'));
  assert.equal(await ctx.waterfall('approval/request', req, async () => 'unavailable'), 'allowed-once');
  assert.equal(uiAsked, 0);
  unbindA2AExecution('dsh-native');
  assert.equal(await ctx.waterfall('approval/request', { ...req, callId: 'real-2' }, async () => 'unavailable'), 'rejected', 'outside A2A the UI answers');
  assert.equal(uiAsked, 1);
});

test('outside an A2A task, and for ACP presets, the host UI answers alone', async t => {
  const { calls, ask } = harness();
  let delegated = 0;
  assert.equal(await ask({ callId: 'c1' }, async () => { delegated++; return 'rejected'; }), 'rejected');
  bindA2AExecution('dsh-acp', execution);
  t.after(() => unbindA2AExecution('dsh-acp'));
  // The ACP adapter already opened a workbench request; its host-UI answer must not open a second one.
  assert.equal(await ask({ callId: 'c2', agent: { id: 'dsh-acp', session: { header: { agentPreset: 'oneagents-acp-grok-build' } } } },
    async () => { delegated++; return 'allowed-once'; }), 'allowed-once');
  assert.equal(delegated, 2);
  assert.equal(calls.open.length, 0);
});

test('in an A2A task the workbench answers: approve, reject, expiry and a closed request', async t => {
  bindA2AExecution('dsh-native', execution);
  t.after(() => unbindA2AExecution('dsh-native'));
  const answers = [
    [{ status: 'answered', answer: { outcome: 'approved' } }, 'allowed-once'],
    [{ status: 'answered', answer: { outcome: 'rejected' } }, 'rejected'],
    [{ status: 'expired' }, 'cancelled'],
    [{ status: 'answered', answer: { outcome: 'cancelled' } }, 'cancelled'],
  ];
  for (const [view, expected] of answers) {
    const { calls, ask } = harness(async () => view);
    let delegated = false;
    assert.equal(await ask({ callId: 'call-1' }, async () => { delegated = true; return 'allowed-once'; }), expected);
    assert.equal(delegated, false, 'the host UI is not asked while the workbench owns the request');
    assert.deepEqual({ ...calls.open[0], requestId: undefined }, { requestId: undefined, jobId: 'job-native', attemptId: 'attempt-native', sessionId: 'dsh-native',
      kind: 'permission', toolTitle: 'bash', toolDetail: 'pip install jsonschema' });
  }
});

test('an unreachable workbench falls back to the host UI', async t => {
  bindA2AExecution('dsh-native', execution);
  t.after(() => { unbindA2AExecution('dsh-native'); harness.failOpen = false; });
  harness.failOpen = true;
  const { calls, ask } = harness();
  assert.equal(await ask({ callId: 'call-1' }, async () => 'rejected'), 'rejected');
  assert.equal(calls.open.length, 1); assert.equal(calls.wait.length, 0);
});

test('an aborted request is cancelled and the workbench is told', async t => {
  bindA2AExecution('dsh-native', execution);
  t.after(() => unbindA2AExecution('dsh-native'));
  const abort = new AbortController();
  const { calls, ask } = harness(input => new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })));
  const pending = ask({ callId: 'call-1', signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  assert.equal(await pending, 'cancelled');
  assert.equal(calls.report.length, 1);
  assert.equal(calls.report[0].outcome, 'cancelled');
  assert.match(calls.report[0].clientRequestId, /^dsh-cancel:prc-/);
});

test('each call is its own request; identical commands without a call id never share an answer', async t => {
  bindA2AExecution('dsh-native', execution);
  t.after(() => unbindA2AExecution('dsh-native'));
  const { calls, ask } = harness();
  await ask({ callId: 'same' }); await ask({ callId: 'same' });
  await ask({}); await ask({});
  const ids = calls.open.map(input => input.requestId);
  assert.equal(ids[0], ids[1], 'the same tool call keeps one record');
  assert.notEqual(ids[2], ids[3]);
  assert.equal(new Set(ids).size, 3);
});
