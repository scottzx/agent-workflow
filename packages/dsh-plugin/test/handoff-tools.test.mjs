import test from 'node:test';
import assert from 'node:assert/strict';
import { bindA2AExecution, unbindA2AExecution } from '@1agents/acp-service/a2a';
import { runHandoffTool } from '../dist/handoff-executor.js';

const execution = { jobId: 'job-exec', attemptId: 'attempt-2' };
const current = { caseId: 'case-1', artifactRevision: 'r1', artifactDigest: 'a'.repeat(64) };

function fakeGateway(reply = async (method) => (method === 'handoff_get' ? current : { handoffId: 'h1', toTargetId: 'legacy:local', purpose: 'make', artifactRevision: 'r1' })) {
  const calls = [];
  return { calls, invoke: async (method, params) => { calls.push({ method, params }); return reply(method, params); } };
}

test('a session that is not running an A2A task cannot propose a handoff', async () => {
  const gateway = fakeGateway();
  await assert.rejects(runHandoffTool(gateway, 'plain-session', 'handoff_propose', { toTargetId: 'legacy:local', purpose: 'make', reason: '可以做了' }),
    /不是正在执行的 A2A 任务会话/);
  assert.deepEqual(gateway.calls, [], 'nothing reaches the gateway');
});

test('the proposal names the version and digest the gateway recorded, and never dispatches the next task', async t => {
  bindA2AExecution('exec-session', execution);
  t.after(() => unbindA2AExecution('exec-session'));
  const gateway = fakeGateway();
  const message = await runHandoffTool(gateway, 'exec-session', 'handoff_propose', { toTargetId: 'legacy:local', purpose: 'make', reason: '稿子可以制作' });
  assert.deepEqual(gateway.calls[0], { method: 'handoff_get', params: { jobId: 'job-exec', attemptId: 'attempt-2', sessionId: 'exec-session' } });
  assert.deepEqual(gateway.calls[1], { method: 'handoff_propose', params: { jobId: 'job-exec', attemptId: 'attempt-2', sessionId: 'exec-session',
    via: 'dsh', caseId: 'case-1', artifactRevision: 'r1', artifactDigest: 'a'.repeat(64), toTargetId: 'legacy:local', purpose: 'make', reason: '稿子可以制作' } });
  assert.match(message, /已提议交接：交给 legacy:local \/ make，版本 r1/);
  assert.match(message, /没有派下一单/);
  assert.equal(gateway.calls.filter(call => call.method === 'execution_submit').length, 0);
});

test('a round without a recorded version cannot be handed over', async t => {
  bindA2AExecution('exec-session', execution);
  t.after(() => unbindA2AExecution('exec-session'));
  const gateway = fakeGateway(async (method) => (method === 'handoff_get' ? { caseId: 'case-1' } : {}));
  await assert.rejects(runHandoffTool(gateway, 'exec-session', 'handoff_propose', { toTargetId: 'legacy:local', purpose: 'make', reason: '稿子可以制作' }),
    /还没有可交接的版本/);
});

test('the operation refuses arguments that do not name a target, a purpose and a reason', async t => {
  bindA2AExecution('exec-session', execution);
  t.after(() => unbindA2AExecution('exec-session'));
  const gateway = fakeGateway();
  await assert.rejects(runHandoffTool(gateway, 'exec-session', 'handoff_propose', { purpose: 'make' }), /toTargetId、purpose 和 reason/);
});
