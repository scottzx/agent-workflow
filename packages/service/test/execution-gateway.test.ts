import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Task } from '@a2a-js/sdk';
import { RemoteAgentGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import { createA2AServer } from '../src/a2a/server.js';
import type { A2APreflightInput, A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';

class Backend implements A2ABackend {
  beforePrepare?: () => Promise<void>;
  async preflight(input: A2APreflightInput) { return { ok: true, cwd: input.cwd, checkedAt: new Date().toISOString(), checks: [{ id: 'fixture-host', ok: true }] }; }
  readonly runs: Array<{ target: A2ATarget; prompt: string; signal: AbortSignal; finish: (result: A2ARunResult) => void }> = [];
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    await this.beforePrepare?.();
    return { sessionId: input.sessionId ?? `session-${Math.random()}`, cwd: input.cwd!, agentPreset: input.agentPreset };
  }
  async run(target: A2ATarget, prompt: string, options: { signal: AbortSignal }): Promise<A2ARunResult> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      options.signal.addEventListener('abort', abort, { once: true });
      this.runs.push({ target, prompt, signal: options.signal, finish: result => { options.signal.removeEventListener('abort', abort); resolve(result); } });
      if (options.signal.aborted) abort();
    });
  }
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function stop(server: Server): Promise<void> {
  const done = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await done;
}
async function until<T>(operation: () => Promise<T>, predicate: (result: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await operation(); if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error('Execution gateway test condition deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'execution-gateway-')), backend = new Backend();
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') host.cardHandler(req, res);
    else void host.handler(req, res);
  });
  const url = await listen(server);
  host = await createA2AServer({ backend, capacity: testCapacity(root), publicUrl: url, stateDirectory: join(root, 'host'), token: 'test-token' });
  const stateDirectory = join(root, 'client');
  const config: A2AGatewayConfig = { stateDirectory, port: 0, remotes: { local: { url, token: 'test-token' } }, pollIntervalMs: 60_000 };
  const gateways = new Set<RemoteAgentGateway>();
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    await host.close(); await stop(server); await rm(root, { recursive: true, force: true });
  });
  return { root, stateDirectory, backend, config, gateway: () => {
    const gateway = new RemoteAgentGateway(config); gateways.add(gateway); return gateway;
  } };
}
const submit = { originSessionId: 'root', targetId: 'legacy:local', input: { cwd: '/project', prompt: 'summarize project', agentPreset: 'standard' } };
const rawSpawn = { originSessionId: 'root', remote: 'local', cwd: '/project', prompt: 'summarize project', agentPreset: 'standard' };

test('explicit PPT checkpoint continuation persists a new parent attempt and idempotently replays without an A2A dispatch', async t => {
  const f = await fixture(t);
  f.config.pptDelivery = { workspaceRoot: join(f.root, 'roles'), publicDirectory: join(f.root, 'public'),
    publicBaseUrl: 'http://127.0.0.1:1/artifacts', allowedProjectRoots: [f.root], summaryTargetId: 'summary', makerTargetId: 'maker', reviewTargetId: 'review',
    runtimeDocument: join(f.root, 'RUNTIME.md'), designSkill: join(f.root, 'SKILL.md'), pythonExecutable: '/usr/bin/python3' };
  const gateway = f.gateway();
  // Let the constructor's first empty reconcile finish; this test exercises durable API admission, not PPT validation.
  await new Promise(resolve => setTimeout(resolve, 30));
  await gateway.invoke('execution_target_create', { targetId: 'delivery', kind: 'resident_agent', name: 'Delivery', connectionId: 'remote:local', enabled: true,
    capabilities: { query: true, cancel: false, continue: true, reconcile: true }, binding: { cwd: f.root, agentPreset: 'standard', roleId: 'delivery', driver: 'ppt_delivery' } });
  const first = await gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'delivery', input: { projectDirectory: f.root, projectName: 'Project' } }) as any;
  const internals = gateway as any, prior = internals.state.pptDeliveries.runs[first.attemptId];
  // Model a persisted terminal checkpoint produced by the previous policy. Production revalidates exact files before dispatch.
  prior.executionStatus = 'failed'; prior.stage = 'review'; prior.phase = 'failed';
  prior.review = { verdict: 'passed', artifactDigest: 'a'.repeat(64), factsChecked: true, allSlidesViewed: true, issues: [], limitations: [], evidence: ['fixture'] };
  prior.validation = { artifactDigest: 'a'.repeat(64) };
  prior.currentChild = { jobId: 'review-fixture', attemptId: 'review-attempt', executionStatus: 'completed', submissionStatus: 'accepted' };
  internals.ledger.observe(first.attemptId, { executionStatus: 'failed', phase: 'failed' });
  const request = { originSessionId: 'root', jobId: first.jobId, input: {}, clientRequestId: 'recover-parent' };
  const next = await gateway.invoke('execution_continue', request) as any;
  assert.equal(next.jobId, first.jobId); assert.notEqual(next.attemptId, first.attemptId);
  assert.equal(next.attempts[0].executionStatus, 'failed'); assert.equal(next.executionStatus, 'working');
  assert.equal(next.backendRunRef.provider, 'resident_role'); assert.equal(next.backendRunRef.runId, next.attemptId);
  assert.equal(internals.state.pptDeliveries.runs[first.attemptId].executionStatus, 'failed');
  assert.equal(internals.state.pptDeliveries.runs[next.attemptId].recovery.fromAttemptId, first.attemptId);
  const replay = await gateway.invoke('execution_continue', request) as any;
  assert.equal(replay.attemptId, next.attemptId); assert.equal(replay.attempts.length, 2); assert.equal(f.backend.runs.length, 0);
  await assert.rejects(gateway.invoke('execution_continue', { ...request, input: { projectName: 'changed' }, clientRequestId: 'changed-recovery' }), /frozen input/);
});

test('review-only admission freezes the recovery request, survives restart and cannot reopen a closed parent', async t => {
  const f = await fixture(t);
  f.config.pptDelivery = { workspaceRoot: join(f.root, 'roles'), publicDirectory: join(f.root, 'public'),
    publicBaseUrl: 'http://127.0.0.1:1/artifacts', allowedProjectRoots: [f.root], summaryTargetId: 'summary', makerTargetId: 'maker', reviewTargetId: 'review',
    runtimeDocument: join(f.root, 'RUNTIME.md'), designSkill: join(f.root, 'SKILL.md'), pythonExecutable: '/usr/bin/python3' };
  let gateway = f.gateway(); await new Promise(resolve => setTimeout(resolve, 30));
  await gateway.invoke('execution_target_create', { targetId: 'delivery', kind: 'resident_agent', name: 'Delivery', connectionId: 'remote:local', enabled: true,
    capabilities: { query: true, cancel: true, continue: true, reconcile: true }, binding: { cwd: f.root, agentPreset: 'standard', roleId: 'delivery', driver: 'ppt_delivery' } });
  await gateway.invoke('execution_target_create', { targetId: 'codex-review', kind: 'resident_agent', name: 'Codex review', connectionId: 'remote:local', enabled: true,
    binding: { cwd: f.root, agentPreset: 'codex', roleId: 'review' } });
  const first = await gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'delivery', input: { projectDirectory: f.root, projectName: 'Project' } }) as any;
  const internals = gateway as any, prior = internals.state.pptDeliveries.runs[first.attemptId];
  prior.executionStatus = 'failed'; prior.stage = 'review'; prior.phase = 'failed'; prior.scriptDigest = 'b'.repeat(64); prior.sourceManifestDigest = 'c'.repeat(64);
  prior.validation = { status: 'passed', artifactDigest: 'a'.repeat(64) };
  prior.currentChild = { jobId: 'old-review', attemptId: 'old-review-attempt', executionStatus: 'failed', submissionStatus: 'accepted' };
  internals.ledger.observe(first.attemptId, { executionStatus: 'failed', phase: 'failed' });
  const frozen = structuredClone(prior), request = { originSessionId: 'root', jobId: first.jobId,
    input: { recoveryMode: 'review_only', reviewTargetId: 'codex-review', sourceSnapshotDirectory: join(f.root, 'snapshot') }, clientRequestId: 'review-retry' };
  await assert.rejects(gateway.invoke('execution_continue', { ...request, input: { ...request.input, projectName: 'changed' } }), /frozen input/);
  await assert.rejects(gateway.invoke('execution_continue', { ...request, input: { ...request.input, reviewTargetId: 'missing' } }), /not found/);
  const next = await gateway.invoke('execution_continue', request) as any;
  assert.equal(next.jobId, first.jobId); assert.equal(next.attempts.length, 2); assert.equal(next.attempts[0].executionStatus, 'failed');
  assert.notEqual(next.attemptId, first.attemptId); assert.deepEqual(internals.state.pptDeliveries.runs[first.attemptId], frozen);
  const recovered = internals.state.pptDeliveries.runs[next.attemptId];
  assert.equal(recovered.recovery.mode, 'review_only'); assert.equal(recovered.policy.reviewTargetId, 'codex-review');
  assert.equal(recovered.recovery.artifactDigest, frozen.validation.artifactDigest);
  assert.equal(recovered.currentChild, undefined); assert.equal(f.backend.runs.length, 0);
  await assert.rejects(gateway.invoke('execution_continue', { ...request, input: { ...request.input, reviewTargetId: 'review' } }), /conflicts/);
  await gateway.close(); gateway = f.gateway();
  const replay = await gateway.invoke('execution_continue', request) as any;
  assert.equal(replay.attemptId, next.attemptId); assert.equal(replay.attempts.length, 2);
  await gateway.invoke('execution_cancel', { originSessionId: 'root', jobId: first.jobId });
  await assert.rejects(gateway.invoke('execution_continue', { ...request, clientRequestId: 'after-close' }), /closing or closed/);
  const closed = await gateway.invoke('execution_get', { originSessionId: 'root', jobId: first.jobId }) as any;
  assert.equal(closed.attempts.length, 2); assert.equal(closed.cancellation.status, 'completed');
});

test('unified submit/get/list/events persist scope and IDs; replay does not create another backend run', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const first = await gateway.invoke('execution_submit', { ...submit, clientRequestId: 'stable-submit' }) as any;
  assert.ok(first.jobId); assert.ok(first.attemptId); assert.ok(first.taskId); assert.ok(first.sessionId);
  assert.equal(first.submissionStatus, 'accepted');
  assert.equal(first.attempts[0].targetSnapshot.targetKind, 'agent_host');
  assert.equal(first.attempts[0].targetSnapshot.targetName, 'Legacy A2A local');
  await until(async () => f.backend.runs.length, count => count === 1);
  const repeated = await gateway.invoke('execution_submit', { ...submit, clientRequestId: 'stable-submit' }) as any;
  assert.equal(repeated.jobId, first.jobId); assert.equal(repeated.attemptId, first.attemptId);
  assert.equal(f.backend.runs.length, 1);
  await assert.rejects(gateway.invoke('execution_submit', { ...submit, input: { ...submit.input, prompt: 'changed' }, clientRequestId: 'stable-submit' }), /conflicts/);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'project result' });
  const completed = await until(() => gateway.invoke('execution_get', { originSessionId: 'root', jobId: first.jobId }) as Promise<any>, item => item.executionStatus === 'completed');
  assert.equal(completed.resultSummary, 'project result'); assert.equal(completed.attempts.length, 1);
  const list = await gateway.invoke('execution_list', { originSessionId: 'root' }) as any;
  assert.equal(list.jobs.length, 1); assert.equal(list.jobs[0].jobId, first.jobId);
  assert.deepEqual((await gateway.invoke('execution_list', { originSessionId: 'outsider' }) as any).jobs, []);
  await assert.rejects(gateway.invoke('execution_get', { originSessionId: 'outsider', jobId: first.jobId }), /not found/);
  const events = await gateway.invoke('execution_events', { originSessionId: 'root', jobId: first.jobId }) as any;
  assert.ok(events.events.some((item: any) => item.type === 'job.created'));
  assert.ok(events.events.some((item: any) => item.type === 'attempt.accepted'));
  assert.ok(events.events.some((item: any) => item.type === 'attempt.state_changed'));
  assert.equal(new Set(events.events.map((item: any) => item.eventId)).size, events.events.length);
  const after = await gateway.invoke('execution_events', { originSessionId: 'root', afterSequence: events.events.at(-1).sequence }) as any;
  assert.deepEqual(after.events, []);
  const persisted = JSON.parse(await readFile(join(f.stateDirectory, 'gateway.json'), 'utf8'));
  assert.equal(persisted.version, 2); assert.equal(persisted.ledger.sourceId, events.sourceId);
  assert.equal(persisted.jobs[0].ledgerJobId, first.jobId); assert.equal(persisted.jobs[0].attemptId, first.attemptId);
});

test('generic resident results support version-bound review, stable reads and restart, and reject review of a superseded attempt', async t => {
  const f = await fixture(t); let gateway = f.gateway();
  await gateway.invoke('execution_target_create', { targetId: 'editor', kind: 'resident_agent', name: 'Editor', connectionId: 'remote:local',
    binding: { cwd: '/project', agentPreset: 'standard', roleId: 'editor' } });
  const first = await gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'editor', input: { prompt: 'create package' } }) as any;
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'package v1' });
  const query = { originSessionId: 'root', jobId: first.jobId };
  const completed = await until(() => gateway.invoke('execution_get', query) as Promise<any>, item => item.executionStatus === 'completed');
  assert.equal(completed.resultRevision, 'result-1'); assert.match(completed.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal(completed.resultHistory.length, 1);
  const review = { ...query, attemptId: first.attemptId, resultRevision: completed.resultRevision, resultDigest: completed.resultDigest, reviewStatus: 'accepted' };
  await gateway.invoke('execution_review', review);
  const repeated = await gateway.invoke('execution_get', query) as any;
  assert.equal(repeated.resultDigest, completed.resultDigest); assert.equal(repeated.resultRevision, completed.resultRevision);
  assert.equal(repeated.resultHistory.length, 1); assert.equal(repeated.businessAcceptance.reviewStatus, 'accepted');
  const raw = await gateway.invoke('remote_agent_get', { originSessionId: 'root', remote: 'local', taskId: first.taskId }) as any;
  assert.equal(raw.resultDigest, completed.resultDigest); assert.equal(raw.resultRevision, completed.resultRevision);
  const inbox = await gateway.invoke('remote_agent_inbox', { originSessionId: 'root' }) as any;
  assert.equal(inbox.notices.length, 1);
  await gateway.invoke('remote_agent_ack', { originSessionId: 'root', noticeId: inbox.notices[0].noticeId });
  assert.equal((await gateway.invoke('execution_get', query) as any).businessAcceptance.reviewStatus, 'accepted');
  await gateway.close(); gateway = f.gateway();
  const restored = await gateway.invoke('execution_get', query) as any;
  assert.deepEqual(restored.resultHistory, completed.resultHistory); assert.equal(restored.businessAcceptance.reviewStatus, 'accepted');
  assert.deepEqual(await gateway.invoke('remote_agent_inbox', { originSessionId: 'root' }), { notices: [] });
  const next = await gateway.invoke('execution_continue', { ...query, input: { prompt: 'create v2' } }) as any;
  assert.notEqual(next.attemptId, first.attemptId); assert.equal(next.businessAcceptance, undefined); assert.deepEqual(next.resultHistory, []);
  await assert.rejects(gateway.invoke('execution_review', review), /current completed attempt/);
  await until(async () => f.backend.runs.length, count => count === 2);
  f.backend.runs[1]!.finish({ outcome: 'completed', text: 'package v2' });
  const revised = await until(() => gateway.invoke('execution_get', query) as Promise<any>, item => item.executionStatus === 'completed');
  assert.notEqual(revised.resultDigest, completed.resultDigest); assert.equal(revised.businessAcceptance, undefined);
  assert.deepEqual(revised.attempts[0].resultHistory, completed.resultHistory); assert.equal(revised.acceptanceHistory.length, 1);
});

test('cached completed results missing versions are upgraded offline without new tasks, notices or automatic acceptance', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const first = await gateway.invoke('execution_submit', submit) as any;
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'saved result' });
  const query = { originSessionId: 'root', jobId: first.jobId };
  const completed = await until(() => gateway.invoke('execution_get', query) as Promise<any>, item => item.executionStatus === 'completed');
  const inbox = await gateway.invoke('remote_agent_inbox', { originSessionId: 'root' }) as any;
  await gateway.invoke('remote_agent_ack', { originSessionId: 'root', noticeId: inbox.notices[0].noticeId });
  await gateway.close();
  const filename = join(f.stateDirectory, 'gateway.json'), state = JSON.parse(await readFile(filename, 'utf8'));
  const attempt = state.ledger.attempts[first.attemptId];
  delete attempt.result.resultRevision; delete attempt.result.resultDigest; delete attempt.result.resultArtifacts; delete attempt.resultHistory;
  await writeFile(filename, JSON.stringify(state));
  f.config.remotes.local!.url = 'http://127.0.0.1:1';
  const restored = f.gateway();
  const list = await restored.invoke('execution_list', { originSessionId: 'root' }) as any;
  const upgraded = list.jobs[0];
  assert.equal(upgraded.sourceId, completed.sourceId); assert.equal(upgraded.jobId, first.jobId);
  assert.equal(upgraded.currentAttemptId, first.attemptId); assert.equal(upgraded.result.resultRevision, completed.resultRevision);
  assert.equal(upgraded.result.resultDigest, completed.resultDigest); assert.equal(upgraded.resultHistory.length, 1);
  assert.equal(upgraded.businessAcceptance, undefined); assert.equal(f.backend.runs.length, 1);
  assert.deepEqual(await restored.invoke('remote_agent_inbox', { originSessionId: 'root' }), { notices: [] });
  await restored.close();
  const again = f.gateway();
  assert.deepEqual(await again.invoke('execution_list', { originSessionId: 'root' }), list);
});

test('legacy spawn fields remain compatible and message creates a new attempt in the same job and session', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const first = await gateway.invoke('remote_agent_spawn', { ...rawSpawn, clientRequestId: 'raw-submit' }) as any;
  for (const key of ['remote', 'taskId', 'contextId', 'originSessionId', 'cwd', 'sessionId', 'state', 'checkedAt', 'jobId', 'attemptId', 'sourceId']) assert.ok(first[key]);
  assert.equal(first.remote, 'local'); assert.equal(first.cwd, '/project'); assert.equal(first.stale, false);
  await until(async () => f.backend.runs.length, count => count === 1);
  const repeated = await gateway.invoke('remote_agent_spawn', { ...rawSpawn, clientRequestId: 'raw-submit' }) as any;
  assert.equal(repeated.taskId, first.taskId); assert.equal(f.backend.runs.length, 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'v1' });
  await until(() => gateway.invoke('remote_agent_get', { originSessionId: 'root', remote: 'local', taskId: first.taskId }) as Promise<any>, item => item.state === 'TASK_STATE_COMPLETED');
  const next = await gateway.invoke('remote_agent_message', { originSessionId: 'root', remote: 'local', taskId: first.taskId, prompt: 'revise only', clientRequestId: 'raw-continue' }) as any;
  assert.equal(next.jobId, first.jobId); assert.notEqual(next.attemptId, first.attemptId); assert.notEqual(next.taskId, first.taskId);
  assert.equal(next.contextId, first.contextId); assert.equal(next.sessionId, first.sessionId);
  await until(async () => f.backend.runs.length, count => count === 2);
  const view = await gateway.invoke('execution_get', { originSessionId: 'root', jobId: first.jobId }) as any;
  assert.equal(view.attempts.length, 2); assert.equal(view.attempts[0].executionStatus, 'completed');
  assert.equal(view.currentAttemptId, next.attemptId);
});

test('unified explicit continuation uses the same job and session without reopening the old attempt', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const first = await gateway.invoke('execution_submit', submit) as any;
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'v1' });
  await until(() => gateway.invoke('execution_get', { originSessionId: 'root', jobId: first.jobId }) as Promise<any>, item => item.executionStatus === 'completed');
  const next = await gateway.invoke('execution_continue', { originSessionId: 'root', jobId: first.jobId, input: { prompt: 'v2 request' }, clientRequestId: 'continue-v2' }) as any;
  assert.equal(next.jobId, first.jobId); assert.notEqual(next.attemptId, first.attemptId);
  assert.equal(next.sessionId, first.sessionId); assert.equal(next.contextId, first.contextId);
  assert.equal(next.attempts[0].executionStatus, 'completed');
  const repeated = await gateway.invoke('execution_continue', { originSessionId: 'root', jobId: first.jobId, input: { prompt: 'v2 request' }, clientRequestId: 'continue-v2' }) as any;
  assert.equal(repeated.attemptId, next.attemptId);
  await until(async () => f.backend.runs.length, count => count === 2);
  assert.equal(f.backend.runs.length, 2);
});

test('replaying an accepted request after target disable returns its original attempt without dispatch', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const first = await gateway.invoke('execution_submit', { ...submit, clientRequestId: 'stable-before-disable' }) as any;
  await until(async () => f.backend.runs.length, count => count === 1);
  await gateway.invoke('execution_target_update', { targetId: submit.targetId, patch: { enabled: false } });
  const replay = await gateway.invoke('execution_submit', { ...submit, clientRequestId: 'stable-before-disable' }) as any;
  assert.equal(replay.jobId, first.jobId); assert.equal(replay.attemptId, first.attemptId);
  assert.equal(replay.attempts[0].targetSnapshot.configVersion, first.attempts[0].targetSnapshot.configVersion);
  assert.equal(f.backend.runs.length, 1);
  await assert.rejects(gateway.invoke('execution_submit', { ...submit, clientRequestId: 'new-disabled-request' }), /disabled/);
});

test('an old continuation request replays after later rounds change inherited fields and while acceptance is unknown', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const first = await gateway.invoke('execution_submit', submit) as any;
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'v1' });
  await until(() => gateway.invoke('execution_get', { originSessionId: 'root', jobId: first.jobId }) as Promise<any>, item => item.executionStatus === 'completed');
  const originalRequest = { originSessionId: 'root', jobId: first.jobId, input: { prompt: 'v2' }, clientRequestId: 'continue-v2-stable' };
  const second = await gateway.invoke('execution_continue', originalRequest) as any;
  await until(async () => f.backend.runs.length, count => count === 2);
  f.backend.runs[1]!.finish({ outcome: 'completed', text: 'v2' });
  await until(() => gateway.invoke('execution_get', { originSessionId: 'root', jobId: first.jobId }) as Promise<any>, item => item.executionStatus === 'completed');
  const third = await gateway.invoke('execution_continue', { originSessionId: 'root', jobId: first.jobId,
    input: { prompt: 'v3', laterField: 'new inherited value' }, clientRequestId: 'continue-v3' }) as any;
  await until(async () => f.backend.runs.length, count => count === 3);
  const replayAfterLater = await gateway.invoke('execution_continue', originalRequest) as any;
  assert.equal(replayAfterLater.attemptId, second.attemptId); assert.equal(replayAfterLater.requestedAttempt.attemptId, second.attemptId);
  assert.equal(replayAfterLater.currentAttemptId, third.attemptId); assert.equal(f.backend.runs.length, 3);
  const originalClient = (gateway as any).client.bind(gateway);
  (gateway as any).client = async (remote: string) => {
    const client = await originalClient(remote);
    return { sendMessage: async (...args: unknown[]) => { await client.sendMessage(...args); throw new Error('lost continuation response'); } };
  };
  const unknown = await gateway.invoke('execution_continue', { originSessionId: 'root', jobId: first.jobId,
    input: { prompt: 'v4', laterField: 'another inherited value' }, clientRequestId: 'continue-v4-lost' }) as any;
  assert.equal(unknown.submissionStatus, 'submission_unknown');
  const replayDuringUnknown = await gateway.invoke('execution_continue', originalRequest) as any;
  assert.equal(replayDuringUnknown.attemptId, second.attemptId); assert.equal(replayDuringUnknown.requestedAttempt.attemptId, second.attemptId);
  assert.equal(replayDuringUnknown.currentAttemptId, unknown.attemptId); assert.equal(replayDuringUnknown.executionStatus, 'unknown');
  assert.equal(replayDuringUnknown.attempts.length, 4);
  await assert.rejects(gateway.invoke('execution_continue', { ...originalRequest, clientRequestId: 'new-during-unknown' }), /submission_unknown/);
  await assert.rejects(gateway.invoke('execution_continue', { ...originalRequest, input: { prompt: 'conflicting request' } }), /conflicts/);
  // v4 was received by the real host but remains queued behind v3; replay must not add any fifth round.
  const list = await gateway.invoke('execution_list', { originSessionId: 'root' }) as any;
  assert.equal(list.jobs[0].attempts.length, 4);
});

test('child dispatch pins the parent attempt and does not complete or cancel its parent', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const parent = await gateway.invoke('execution_submit', submit) as any;
  const child = await gateway.invoke('execution_submit', { ...submit, input: { ...submit.input, prompt: 'child task' },
    parentJobRef: { sourceId: parent.sourceId, jobId: parent.jobId }, parentAttemptId: parent.attemptId, purpose: 'production' }) as any;
  assert.equal(child.parentJobRef.jobId, parent.jobId); assert.equal(child.parentAttemptId, parent.attemptId);
  await until(async () => f.backend.runs.length, count => count === 2);
  f.backend.runs[1]!.finish({ outcome: 'completed', text: 'child result' });
  await until(() => gateway.invoke('execution_get', { originSessionId: 'root', jobId: child.jobId }) as Promise<any>, item => item.executionStatus === 'completed');
  const view = await gateway.invoke('execution_get', { originSessionId: 'root', jobId: parent.jobId }) as any;
  assert.equal(view.executionStatus, 'working'); assert.equal(view.children.length, 1); assert.equal(view.children[0].jobId, child.jobId);
  await assert.rejects(gateway.invoke('execution_submit', { ...submit, originSessionId: 'outsider', parentJobRef: { sourceId: parent.sourceId, jobId: parent.jobId }, parentAttemptId: parent.attemptId }), /not found/);
  await assert.rejects(gateway.invoke('execution_submit', { ...submit, parentJobRef: { sourceId: parent.sourceId, jobId: parent.jobId }, parentAttemptId: child.attemptId }), /does not belong/);
});

test('unified cancel stops an actually running child, records intent and leaves its parent running', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const parent = await gateway.invoke('execution_submit', submit) as any;
  const child = await gateway.invoke('execution_submit', { ...submit, input: { ...submit.input, prompt: 'child remains running until canceled' },
    parentJobRef: { sourceId: parent.sourceId, jobId: parent.jobId }, parentAttemptId: parent.attemptId, purpose: 'production' }) as any;
  await until(async () => f.backend.runs.length, count => count === 2);
  assert.equal(f.backend.runs[0]!.signal.aborted, false); assert.equal(f.backend.runs[1]!.signal.aborted, false);
  await assert.rejects(gateway.invoke('execution_cancel', { originSessionId: 'outsider', jobId: child.jobId }), /not found/);
  assert.equal(f.backend.runs[1]!.signal.aborted, false);
  const canceled = await gateway.invoke('execution_cancel', { originSessionId: 'root', jobId: child.jobId }) as any;
  assert.equal(canceled.executionStatus, 'canceled'); assert.equal(canceled.attemptId, child.attemptId);
  assert.ok(canceled.attempts.find((item: any) => item.attemptId === child.attemptId).cancellationRequestedAt);
  assert.equal(f.backend.runs[1]!.signal.aborted, true); assert.equal(f.backend.runs[0]!.signal.aborted, false);
  const parentAfter = await gateway.invoke('execution_get', { originSessionId: 'root', jobId: parent.jobId }) as any;
  assert.equal(parentAfter.executionStatus, 'working'); assert.equal(parentAfter.attemptId, parent.attemptId);
  assert.equal(parentAfter.children[0].executionStatus, 'canceled'); assert.equal(parentAfter.children[0].parentAttemptId, parent.attemptId);
  const events = await gateway.invoke('execution_events', { originSessionId: 'root', jobId: child.jobId }) as any;
  assert.ok(events.events.some((item: any) => item.type === 'attempt.cancellation_requested'));
  assert.ok(events.events.some((item: any) => item.type === 'attempt.state_changed'));
});

test('fixed resident targets cannot be overridden and resolve their configured execution binding', async t => {
  const f = await fixture(t), gateway = f.gateway();
  await gateway.invoke('execution_target_create', { targetId: 'fixed-ppt', kind: 'resident_agent', name: 'PPT role', connectionId: 'remote:local',
    binding: { cwd: '/fixed-role', agentPreset: 'ppt-beautifier', roleId: 'ppt' } });
  for (const override of [{ cwd: '/other' }, { agentPreset: 'standard' }, { roleId: 'other' }]) {
    await assert.rejects(gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'fixed-ppt', input: { prompt: 'design', ...override } }), /cannot override/);
  }
  assert.equal(f.backend.runs.length, 0);
  const accepted = await gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'fixed-ppt', input: { prompt: 'design' } }) as any;
  await until(async () => f.backend.runs.length, count => count === 1);
  assert.equal(f.backend.runs[0]!.target.cwd, '/fixed-role'); assert.equal(f.backend.runs[0]!.target.agentPreset, 'ppt-beautifier');
  assert.equal(accepted.attempts[0].targetSnapshot.binding.cwd, '/fixed-role');
  assert.equal(accepted.attempts[0].targetSnapshot.targetKind, 'resident_agent');
  assert.equal(accepted.attempts[0].targetSnapshot.targetName, 'PPT role');
});

test('a lost acceptance response is persisted as unknown and cannot cause another execution round', async t => {
  const f = await fixture(t), gateway = f.gateway();
  // Execute the real host request, then lose its reply at the adapter boundary.
  const originalClient = (gateway as any).client.bind(gateway);
  (gateway as any).client = async (remote: string) => {
    const client = await originalClient(remote);
    return { sendMessage: async (...args: unknown[]) => { await client.sendMessage(...args); throw new Error('simulated lost acceptance response'); } };
  };
  const first = await gateway.invoke('execution_submit', { ...submit, clientRequestId: 'lost-response' }) as any;
  assert.equal(first.submissionStatus, 'submission_unknown'); assert.equal(first.executionStatus, 'unknown');
  assert.deepEqual(first.unresolvedAttemptIds, [first.attemptId]);
  await until(async () => f.backend.runs.length, count => count === 1);
  const replay = await gateway.invoke('execution_submit', { ...submit, clientRequestId: 'lost-response' }) as any;
  assert.equal(replay.attemptId, first.attemptId); assert.equal(replay.submissionStatus, 'submission_unknown');
  await assert.rejects(gateway.invoke('execution_continue', { originSessionId: 'root', jobId: first.jobId, input: { prompt: 'retry' }, clientRequestId: 'unsafe-retry' }), /submission_unknown/);
  assert.equal(f.backend.runs.length, 1);
  const persisted = JSON.parse(await readFile(join(f.stateDirectory, 'gateway.json'), 'utf8'));
  assert.equal(persisted.ledger.attempts[first.attemptId].submissionStatus, 'submission_unknown');
  assert.equal(persisted.ledger.attempts[first.attemptId].backendRunRef, undefined);
});

test('version 1 migration creates one legacy job per task and stays idempotent across repeated restarts', async t => {
  const f = await fixture(t);
  await mkdir(f.stateDirectory, { recursive: true });
  const jobs = ['legacy-1', 'legacy-2'].map(taskId => ({ originSessionId: 'root', remote: 'local', taskId, contextId: 'shared-context', cwd: '/project',
    checkedAt: '2026-10-20T00:00:00.000Z', task: Task.toJSON(Task.fromJSON({ id: taskId, contextId: 'shared-context', status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [], history: [], metadata: { '1agents': { sessionId: 'shared-session', cwd: '/project' } } })) }));
  await writeFile(join(f.stateDirectory, 'gateway.json'), JSON.stringify({ version: 1, jobs, notices: [] }));
  const first = f.gateway(), list = await first.invoke('execution_list', { originSessionId: 'root' }) as any;
  assert.equal(list.jobs.length, 2); assert.notEqual(list.jobs[0].jobId, list.jobs[1].jobId);
  for (const job of list.jobs) { assert.equal(job.provenance, 'legacy'); assert.equal(job.createdAt, null); assert.equal(job.attempts.length, 1); assert.equal(job.attempts[0].createdAt, null); }
  const firstState = JSON.parse(await readFile(join(f.stateDirectory, 'gateway.json'), 'utf8'));
  assert.equal(firstState.version, 2); assert.ok(firstState.jobs.every((item: any) => item.ledgerJobId && item.attemptId));
  await first.close();
  const second = f.gateway(), again = await second.invoke('execution_list', { originSessionId: 'root' }) as any;
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(list)));
  const secondState = JSON.parse(await readFile(join(f.stateDirectory, 'gateway.json'), 'utf8'));
  assert.equal(secondState.ledger.sourceId, firstState.ledger.sourceId); assert.deepEqual(secondState.ledger.events, firstState.ledger.events);
  await second.close();
  const third = f.gateway(), final = await third.invoke('execution_list', { originSessionId: 'root' }) as any;
  assert.deepEqual(JSON.parse(JSON.stringify(final)), JSON.parse(JSON.stringify(list)));
});

test('explicit cascade closes parent and descendants, preserves completed results, and blocks further dispatch', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const parent = await gateway.invoke('execution_submit', submit) as any;
  const child = await gateway.invoke('execution_submit', { ...submit, parentJobRef: { sourceId: parent.sourceId, jobId: parent.jobId }, parentAttemptId: parent.attemptId }) as any;
  const grandchild = await gateway.invoke('execution_submit', { ...submit, parentJobRef: { sourceId: child.sourceId, jobId: child.jobId }, parentAttemptId: child.attemptId }) as any;
  const done = await gateway.invoke('execution_submit', { ...submit, parentJobRef: { sourceId: parent.sourceId, jobId: parent.jobId }, parentAttemptId: parent.attemptId }) as any;
  const unrelated = await gateway.invoke('execution_submit', submit) as any;
  await until(async () => f.backend.runs.length, n => n === 5);
  f.backend.runs[3]!.finish({ outcome: 'completed', text: 'keep this result' });
  await until(() => gateway.invoke('execution_get', { originSessionId: 'root', jobId: done.jobId }) as Promise<any>, v => v.executionStatus === 'completed');
  await assert.rejects(gateway.invoke('execution_cancel', { originSessionId: 'outsider', jobId: parent.jobId, cascade: true }), /not found/);
  const canceled = await gateway.invoke('execution_cancel', { originSessionId: 'root', jobId: parent.jobId, cascade: true }) as any;
  assert.equal(canceled.cancellation.status, 'completed');
  for (const item of [parent, child, grandchild]) assert.equal((await gateway.invoke('execution_get', { originSessionId: 'root', jobId: item.jobId }) as any).executionStatus, 'canceled');
  assert.equal((await gateway.invoke('execution_get', { originSessionId: 'root', jobId: done.jobId }) as any).resultSummary, 'keep this result');
  assert.equal((await gateway.invoke('execution_get', { originSessionId: 'root', jobId: unrelated.jobId }) as any).executionStatus, 'working');
  await assert.rejects(gateway.invoke('execution_submit', { ...submit, parentJobRef: { sourceId: parent.sourceId, jobId: parent.jobId }, parentAttemptId: parent.attemptId }), /closing or closed/);
  await assert.rejects(gateway.invoke('execution_continue', { originSessionId: 'root', jobId: child.jobId, input: { prompt: 'do not restart' } }), /closing or closed/);
  const repeated = await gateway.invoke('execution_cancel', { originSessionId: 'root', jobId: parent.jobId, cascade: true }) as any;
  assert.equal(repeated.cancellation.completedAt, canceled.cancellation.completedAt);
  assert.equal(f.backend.runs.length, 5);
});

async function pptParent(f: Awaited<ReturnType<typeof fixture>>) {
  f.config.pptDelivery = { workspaceRoot: join(f.root, 'roles'), publicDirectory: join(f.root, 'public'),
    publicBaseUrl: 'http://127.0.0.1:1/artifacts', allowedProjectRoots: [f.root], summaryTargetId: 'legacy:local', makerTargetId: 'legacy:local', reviewTargetId: 'legacy:local',
    runtimeDocument: join(f.root, 'RUNTIME.md'), designSkill: join(f.root, 'SKILL.md'), pythonExecutable: '/usr/bin/python3' };
  const gateway = f.gateway(); await gateway.reconcile();
  await gateway.invoke('execution_target_create', { targetId: 'delivery', kind: 'resident_agent', name: 'Delivery', connectionId: 'remote:local', enabled: true,
    binding: { cwd: f.root, agentPreset: 'standard', roleId: 'delivery', driver: 'ppt_delivery' } });
  const parent = await gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'delivery', input: { projectDirectory: f.root, projectName: 'No PPT generation fixture' } }) as any;
  return { gateway, parent, run: (gateway as any).state.pptDeliveries.runs[parent.attemptId] };
}

test('PPT parent cancellation defaults to cascading and survives restart without another model dispatch', async t => {
  const f = await fixture(t), { gateway, parent, run } = await pptParent(f);
  const child = await gateway.invoke('execution_submit', { ...submit, parentJobRef: { sourceId: parent.sourceId, jobId: parent.jobId }, parentAttemptId: parent.attemptId, purpose: 'project_script' }) as any;
  run.currentChild = child; run.children.push({ purpose: 'project_script', revision: 1, targetId: 'legacy:local', child });
  await until(async () => f.backend.runs.length, n => n === 1);
  await assert.rejects(gateway.invoke('execution_cancel', { originSessionId: 'root', jobId: parent.jobId, cascade: false }), /must include/);
  const canceled = await gateway.invoke('execution_cancel', { originSessionId: 'root', jobId: parent.jobId }) as any;
  assert.equal(canceled.executionStatus, 'canceled'); assert.equal(canceled.cancellation.status, 'completed');
  assert.equal(canceled.deliveryProgress.cancellationRequestedAt, canceled.cancellation.requestedAt);
  assert.equal(f.backend.runs[0]!.signal.aborted, true);
  await gateway.close(); const restored = f.gateway(); await restored.reconcile();
  const view = await restored.invoke('execution_get', { originSessionId: 'root', jobId: parent.jobId }) as any;
  assert.equal(view.executionStatus, 'canceled'); assert.equal(view.children.length, 1); assert.equal(f.backend.runs.length, 1);
  const inbox = await restored.invoke('execution_inbox', { originSessionId: 'root' }) as any;
  assert.equal(inbox.notices.length, 1); assert.match(inbox.notices[0].resultSummary, /子任务已确认停止/);
});

test('unknown child admission blocks parent cancellation across restart instead of claiming it stopped', async t => {
  const f = await fixture(t), { gateway, parent } = await pptParent(f);
  const child = gateway.ledger.prepare({ originSessionId: 'root', targetSnapshot: { targetId: 'legacy:local', provider: 'a2a' }, input: {},
    parentJobRef: { sourceId: parent.sourceId, jobId: parent.jobId }, parentAttemptId: parent.attemptId });
  gateway.ledger.markDispatching(child.attempt.attemptId); gateway.ledger.markUnknown(child.attempt.attemptId);
  const blocked = await gateway.invoke('execution_cancel', { originSessionId: 'root', jobId: parent.jobId }) as any;
  assert.equal(blocked.cancellation.status, 'blocked'); assert.notEqual(blocked.executionStatus, 'canceled');
  assert.ok(blocked.cancellation.targets.some((a: any) => a.submissionStatus === 'submission_unknown'));
  await gateway.close(); const restored = f.gateway(); await restored.reconcile();
  assert.equal((await restored.invoke('execution_get', { originSessionId: 'root', jobId: parent.jobId }) as any).cancellation.status, 'blocked');
  assert.equal(f.backend.runs.length, 0);
  restored.ledger.knownNotSubmitted(child.attempt.attemptId, { executionStatus: 'canceled', diagnostic: 'Fixture has confirmed no remote submission' });
  await restored.reconcile();
  assert.equal((await restored.invoke('execution_get', { originSessionId: 'root', jobId: parent.jobId }) as any).executionStatus, 'canceled');
  assert.equal(f.backend.runs.length, 0);
});

test('cancel waits for an on-wire child admission, then cancels that child before completing the parent', async t => {
  const f = await fixture(t), { gateway, parent, run } = await pptParent(f);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.backend.beforePrepare = async () => { entered(); await gate; };
  run.publicationCheckedAt = new Date().toISOString();
  const advancing = (gateway as any).advanceDelivery(run) as Promise<void>;
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture send did not reach host prepare')), 3000))]);
  t.after(() => release());
  const canceling = gateway.invoke('execution_cancel', { originSessionId: 'root', jobId: parent.jobId });
  await until(async () => run.cancellationRequestedAt, Boolean);
  const interim = await gateway.invoke('execution_get', { originSessionId: 'root', jobId: parent.jobId }) as any;
  assert.notEqual(interim.executionStatus, 'canceled');
  assert.equal(interim.cancellation.status, 'pending');
  release(); await advancing;
  const canceled = await canceling as any;
  assert.equal(canceled.executionStatus, 'canceled'); assert.equal(canceled.cancellation.status, 'completed');
  assert.equal(canceled.children.length, 1); assert.equal(canceled.children[0].executionStatus, 'canceled');
  await gateway.reconcile();
  assert.equal(f.backend.runs.length, 1); assert.equal(f.backend.runs[0]!.signal.aborted, true);
});

test('stage progress is queryable without a root wakeup; failure notice contains existing draft links and acceptance boundaries', async t => {
  const f = await fixture(t), { gateway, parent, run } = await pptParent(f);
  run.stage = 'review'; run.phase = 'waiting_children'; run.scriptDigest = 'c'.repeat(64);
  run.children = [{ purpose: 'project_script', revision: 1, targetId: 'summary', child: { jobId: 'summary', attemptId: 's', executionStatus: 'completed' } },
    { purpose: 'ppt_production', revision: 1, targetId: 'maker', child: { jobId: 'maker', attemptId: 'm', executionStatus: 'completed' } }];
  run.validation = { status: 'passed', artifactDigest: 'd'.repeat(64), artifacts: [
    { path: '/retained/project.pptx', url: 'http://example.invalid/retained.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 100, sha256: 'a'.repeat(64) },
    { path: '/retained/preview.png', url: 'http://example.invalid/preview.png', mediaType: 'image/png', size: 20, sha256: 'b'.repeat(64) }] };
  (gateway as any).save();
  const progress = (await gateway.invoke('execution_get', { originSessionId: 'root', jobId: parent.jobId }) as any).deliveryProgress;
  assert.deepEqual(progress.completedStages, ['项目总结与脚本', 'PPT制作', '机器校验']);
  assert.equal(progress.stageCompletionWakeups, false);
  assert.equal((await gateway.invoke('execution_inbox', { originSessionId: 'root' }) as any).notices.length, 0);
  run.executionStatus = 'failed'; run.phase = 'failed';
  (gateway as any).executionNotice(run, 'Independent review failed', []);
  const inbox = await gateway.invoke('execution_inbox', { originSessionId: 'root' }) as any;
  assert.equal(inbox.notices.length, 1); assert.equal(inbox.notices[0].artifactLinks.length, 2);
  assert.match(inbox.notices[0].resultSummary, /已完成：项目总结与脚本、PPT制作、机器校验/);
  const text = (gateway as any).state.executionNotices[0].text;
  assert.match(text, /已有 PPT（未完成最终验收）/); assert.match(text, /http:\/\/example.invalid\/retained.pptx/);
  assert.doesNotMatch(text, /\[最终 PPT\]/);
});

test('every task is told where to put artifacts, per job and per attempt, unless the caller declared its own', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const first = await gateway.invoke('remote_agent_spawn', { ...rawSpawn, clientRequestId: 'artifact-default' }) as any;
  await until(async () => f.backend.runs.length, count => count === 1);
  const prompt = f.backend.runs[0]!.prompt;
  assert.ok(prompt.startsWith(String(rawSpawn.prompt)), 'the original prompt is untouched');
  assert.ok(prompt.includes(`/project/.1agents/jobs/${first.jobId}/`));
  assert.ok(prompt.includes(`/project/.1agents/jobs/${first.jobId}/manifest-${first.attemptId}.json`));
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'done' });
  const got = await until(() => gateway.invoke('remote_agent_get', { originSessionId: 'root', remote: 'local', taskId: first.taskId }) as Promise<any>, item => item.state === 'TASK_STATE_COMPLETED');
  assert.deepEqual(got.resultMetadata.artifacts, [], 'no manifest means no artifacts, and the task still completes');
});

test('the task ticket lives on the job: the gateway enforces each actor at the call and execution_events shows every step', async t => {
  const f = await fixture(t), gateway = f.gateway();
  const job = await gateway.invoke('execution_submit', submit) as any, scope = { originSessionId: 'root', jobId: job.jobId };
  await until(async () => f.backend.runs.length, count => count === 1);
  await gateway.invoke('ticket_open', { ...scope, roleId: 'role', caseId: 'demo' });
  await gateway.invoke('ticket_checks', { ...scope, results: [{ itemId: 'P2', pass: false, evidence: [] }] });
  await gateway.invoke('ticket_revise', scope);
  const executor = { jobId: job.jobId, attemptId: job.attemptId, sessionId: job.sessionId };
  await assert.rejects(gateway.invoke('ticket_mark', { ...executor, sessionId: 'another-session', itemId: 'P1-P2', state: 'done', note: '改了' }), /不是执行这一轮的会话/,
    'the session the host reported for the attempt is the only one that may act as its executor');
  await assert.rejects(gateway.invoke('ticket_submit', executor), /还有 1 条没处理/);
  await gateway.invoke('ticket_mark', { ...executor, itemId: 'P1-P2', state: 'done', note: '改了' });
  assert.equal((await gateway.invoke('ticket_submit', executor) as any).status, 'ready_for_review');
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'done' });
  await until(() => gateway.invoke('execution_get', scope) as Promise<any>, item => item.executionStatus === 'completed');
  await assert.rejects(gateway.invoke('ticket_show', executor), /已经结束/, 'a finished round no longer acts on the ticket');
  await assert.rejects(gateway.invoke('ticket_get', { originSessionId: 'outsider', jobId: job.jobId }), /not found/);
  const events = (await gateway.invoke('execution_events', scope) as any).events.filter((event: any) => event.type.startsWith('ticket.'));
  assert.deepEqual(events.map((event: any) => event.type), ['ticket.opened', 'ticket.item_raised', 'ticket.checked', 'ticket.revision_started', 'ticket.item_marked', 'ticket.submitted']);
  assert.deepEqual([events[4].data.actor, events[4].data.sessionId, events[4].attemptId], ['executor', job.sessionId, job.attemptId]);
  await gateway.close();
  const restarted = f.gateway();
  assert.equal((await restarted.invoke('ticket_get', scope) as any).status, 'ready_for_review', 'the ticket is persisted with the ledger');
  assert.equal((await restarted.invoke('ticket_close', { ...scope, status: 'closed', stopReason: 'passed' }) as any).status, 'closed');
});
