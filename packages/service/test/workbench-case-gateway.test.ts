import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { testCapacity } from './capacity-fixture.js';
import { serveA2AGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import { createA2AServer } from '../src/a2a/server.js';
import type { A2APreflightInput, A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';

const token = 'case-workbench-test-credential';
const relaySecret = 'page-relay-secret-for-case-tests-000001';

/** A host that accepts any task and never finishes on its own. */
class Backend implements A2ABackend {
  async preflight(input: A2APreflightInput) { return { ok: true, cwd: input.cwd, checkedAt: new Date().toISOString(), checks: [{ id: 'fixture-host', ok: true }] }; }
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    return { sessionId: input.sessionId ?? `session-${Math.random()}`, cwd: input.cwd!, agentPreset: input.agentPreset };
  }
  async run(target: A2ATarget, prompt: string, options: { signal: AbortSignal }): Promise<A2ARunResult> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      options.signal.addEventListener('abort', abort, { once: true });
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

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'case-gateway-')), backend = new Backend();
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') host.cardHandler(req, res);
    else void host.handler(req, res);
  });
  const url = await listen(server);
  host = await createA2AServer({ backend, capacity: testCapacity(root), publicUrl: url, stateDirectory: join(root, 'host'), token: 'test-token' });
  const config: A2AGatewayConfig = { stateDirectory: join(root, 'client'), port: 0, remotes: { local: { url, token: 'test-token' } }, pollIntervalMs: 60_000,
    workbench: { token, reviewerId: 'local-owner', reviewerName: '本机用户', pageRelaySecret: relaySecret } };
  let gateway = await serveA2AGateway(config, { report: false });
  t.after(async () => { await gateway.close(); await host.close(); await stop(server); await rm(root, { recursive: true, force: true }); });
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${gateway.port}` + path, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const post = (body: unknown, relay = true): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(relay ? { 'X-Workbench-Page-Relay': relaySecret } : {}) }, body: JSON.stringify(body) });
  return { root, config, request, post,
    get gateway() { return gateway.gateway; },
    get port() { return gateway.port; },
    restart: async () => { await gateway.close(); gateway = await serveA2AGateway(config, { report: false }); } };
}

const digestOf = (content: string) => createHash('sha256').update(content).digest('hex');

test('a thing is opened on the page, and it keeps its tasks, edges and decisions across a restart', async t => {
  const f = await fixture(t);
  const opened = await f.request('/workbench/cases', f.post({ originSessionId: 'root', goal: '本周选题与发布' }));
  assert.equal(opened.status, 200);
  const record = await opened.json() as any;
  assert.equal(record.goal, '本周选题与发布');
  assert.equal(record.createdBy.kind, 'person');
  assert.equal(record.createdBy.id, 'local-owner');

  const list = await f.request('/workbench/cases');
  assert.equal(list.status, 200);
  const cases = await list.json() as any;
  assert.equal(cases.items.length, 1);
  assert.equal(cases.items[0].caseId, record.caseId);

  await f.restart();
  const after = await f.request('/workbench/cases');
  const restored = await after.json() as any;
  assert.equal(restored.items.length, 1, 'the case survives a restart');
  assert.equal(restored.items[0].caseId, record.caseId);
});

test('an agent may not write that a person agreed, and the page decision carries the reviewer', async t => {
  const f = await fixture(t);
  const opened = await f.request('/workbench/cases', f.post({ originSessionId: 'root', goal: '选题' }));
  const record = await opened.json() as any;
  const digest = digestOf('draft');
  const prepared = f.gateway.ledger.prepare({ originSessionId: 'root', caseId: record.caseId, title: '稿子', targetSnapshot: { targetId: 'author' }, input: {} });
  f.gateway.ledger.markDispatching(prepared.attempt.attemptId);
  f.gateway.ledger.accept(prepared.attempt.attemptId, { taskId: 'task-1' }, { executionStatus: 'completed', resultRevision: 'r1', resultDigest: digest, artifactLinks: [] });
  const proposal = await f.gateway.invoke('handoff_propose', { originSessionId: 'root', jobId: prepared.job.jobId, attemptId: prepared.attempt.attemptId,
    caseId: record.caseId, toTargetId: 'legacy:local', purpose: 'make', artifactRevision: 'r1', artifactDigest: digest, reason: '稿子可以制作' }) as any;
  assert.equal(proposal.status, 'proposed');

  const refused = await f.request(`/workbench/cases/${record.caseId}/handoffs/${proposal.handoffId}/decisions`, f.post({ decision: 'accept' }, false));
  assert.equal(refused.status, 403, 'a bearer call without the page relay may not decide');
  assert.equal((await refused.json() as any).error, 'page_action_required');

  const decided = await f.request(`/workbench/cases/${record.caseId}/handoffs/${proposal.handoffId}/decisions`, f.post({ decision: 'accept' }));
  assert.equal(decided.status, 200);
  const result = await decided.json() as any;
  assert.equal(result.handoff.status, 'accepted');
  assert.equal(result.handoff.decidedBy.kind, 'person');
  assert.equal(result.handoff.decidedBy.id, 'local-owner');

  const agentDecision = await f.gateway.invoke('handoff_decide', { originSessionId: 'root', handoffId: proposal.handoffId, decision: 'accept', decidedBy: { kind: 'person' } })
    .then(() => undefined, (error: Error) => error);
  assert.match(String((agentDecision as Error)?.message), /A person decides on the workbench page/);
});

test('an accepted handoff freezes its bytes: a later round of the source job does not change them', async t => {
  const f = await fixture(t);
  const opened = await f.request('/workbench/cases', f.post({ originSessionId: 'root', goal: '选题' }));
  const record = await opened.json() as any;
  const first = join(f.root, 'draft-v1.txt'), second = join(f.root, 'draft-v2.txt');
  await writeFile(first, 'draft one');
  await writeFile(second, 'draft two');
  const digest = digestOf('draft one');
  const prepared = f.gateway.ledger.prepare({ originSessionId: 'root', caseId: record.caseId, title: '稿子', targetSnapshot: { targetId: 'author' }, input: {} });
  f.gateway.ledger.markDispatching(prepared.attempt.attemptId);
  f.gateway.ledger.accept(prepared.attempt.attemptId, { taskId: 'task-1' }, { executionStatus: 'completed', resultRevision: 'r1', resultDigest: digest,
    artifactLinks: [], resultArtifacts: [{ path: first, size: 9, sha256: digest, mediaType: 'text/plain' }] });
  const proposal = await f.gateway.invoke('handoff_propose', { originSessionId: 'root', jobId: prepared.job.jobId, attemptId: prepared.attempt.attemptId,
    caseId: record.caseId, toTargetId: 'legacy:local', purpose: 'make', artifactRevision: 'r1', artifactDigest: digest, reason: '稿子可以制作' }) as any;
  const decided = await f.request(`/workbench/cases/${record.caseId}/handoffs/${proposal.handoffId}/decisions`, f.post({ decision: 'accept' }));
  assert.equal(decided.status, 200);
  const accepted = await decided.json() as any;
  assert.equal(accepted.handoff.snapshots.length, 1);
  assert.equal(accepted.handoff.snapshots[0].digest, digest);

  // The frozen bytes are served by digest and checked again on every read.
  const frozen = await f.request(`/workbench/cases/${record.caseId}/handoffs/${proposal.handoffId}/artifacts/${digest}`);
  assert.equal(frozen.status, 200);
  assert.equal(await frozen.text(), 'draft one');

  // The source job runs another round with different bytes.
  const round = f.gateway.ledger.prepare({ originSessionId: 'root', jobId: prepared.job.jobId, targetSnapshot: { targetId: 'author' }, input: {} });
  f.gateway.ledger.markDispatching(round.attempt.attemptId);
  const next = f.gateway.ledger.accept(round.attempt.attemptId, { taskId: 'task-2' }, { executionStatus: 'completed', resultRevision: 'r2', resultDigest: digestOf('draft two'),
    artifactLinks: [], resultArtifacts: [{ path: second, size: 9, sha256: digestOf('draft two'), mediaType: 'text/plain' }] });
  assert.equal(next.result?.resultRevision, 'r2');

  const stale = await f.gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'legacy:local', handoffId: proposal.handoffId,
    resultRevision: 'r2', input: { cwd: f.root, prompt: '制作成片', agentPreset: 'standard' } }).then(() => undefined, (error: Error) => error);
  assert.match(String((stale as Error)?.message), /Handoff version does not match/);

  const child = await f.gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'legacy:local', handoffId: proposal.handoffId,
    input: { cwd: f.root, prompt: '制作成片', agentPreset: 'standard' } }) as any;
  assert.equal(child.resultRevision, 'r1', 'the next task opens on the accepted version');
  const again = await f.gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'legacy:local', handoffId: proposal.handoffId,
    input: { cwd: f.root, prompt: '制作成片', agentPreset: 'standard' } }) as any;
  assert.equal(again.jobId, child.jobId, 'the same handoff opens the same task');

  const frozenAgain = await f.request(`/workbench/cases/${record.caseId}/handoffs/${proposal.handoffId}/artifacts/${digest}`);
  assert.equal(await frozenAgain.text(), 'draft one', 'the source job ran again, the accepted bytes did not change');
});

test('a receipt names its channel and id, and the same id never holds another digest', async t => {
  const f = await fixture(t);
  const opened = await f.request('/workbench/cases', f.post({ originSessionId: 'root', goal: '发布' }));
  const record = await opened.json() as any;
  const digest = digestOf('film');
  const first = await f.request(`/workbench/cases/${record.caseId}/receipts`, f.post({ channel: 'wechat', remoteId: 'post-1', artifactDigest: digest }, false));
  assert.equal(first.status, 200);
  const receipt = await first.json() as any;
  assert.equal(receipt.artifactDigest, digest);
  const conflict = await f.request(`/workbench/cases/${record.caseId}/receipts`, f.post({ channel: 'wechat', remoteId: 'post-1', artifactDigest: digestOf('other') }, false));
  assert.equal(conflict.status, 409);
  const detail = await f.request(`/workbench/cases/${record.caseId}`);
  const view = await detail.json() as any;
  assert.equal(view.receipts.length, 1);
});

test('a fact below the threshold proposes nothing, and a fact above it proposes only', async t => {
  const f = await fixture(t);
  const opened = await f.request('/workbench/cases', f.post({ originSessionId: 'root', goal: '数据' }));
  const record = await opened.json() as any;
  const digest = digestOf('film');
  const prepared = f.gateway.ledger.prepare({ originSessionId: 'root', caseId: record.caseId, title: '成片', targetSnapshot: { targetId: 'author' }, input: {} });
  f.gateway.ledger.markDispatching(prepared.attempt.attemptId);
  f.gateway.ledger.accept(prepared.attempt.attemptId, { taskId: 'task-1' }, { executionStatus: 'completed', resultRevision: 'r1', resultDigest: digest, artifactLinks: [] });
  const convention = await f.request(`/workbench/cases/${record.caseId}/conventions`, f.post({ toTargetId: 'legacy:local', toPurpose: 'retitle',
    when: 'fact_reached', condition: { metric: 'reads', operator: 'gte', value: 1000 } }, false));
  assert.equal(convention.status, 200);
  const low = await f.request(`/workbench/cases/${record.caseId}/facts`, f.post({ metric: 'reads', value: 10, source: 'wechat' }, false));
  assert.equal(low.status, 200);
  assert.equal((await low.json() as any).proposals.length, 0);
  const high = await f.request(`/workbench/cases/${record.caseId}/facts`, f.post({ metric: 'reads', value: 5000, source: 'wechat' }, false));
  const result = await high.json() as any;
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].status, 'proposed');
  assert.equal(f.gateway.ledger.list('root').length, 1, 'a fact never opens a new task');
});

test('a gate belongs to the person it names, and nobody else may press it', async t => {
  const f = await fixture(t);
  (f.config.workbench as any).gateReviewers = { handoff: 'editor', publish: 'publisher' };
  await f.restart();
  const opened = await f.request('/workbench/cases', f.post({ originSessionId: 'root', goal: '选题' }));
  const record = await opened.json() as any;
  const digest = digestOf('draft');
  const prepared = f.gateway.ledger.prepare({ originSessionId: 'root', caseId: record.caseId, title: '稿子', targetSnapshot: { targetId: 'author' }, input: {} });
  f.gateway.ledger.markDispatching(prepared.attempt.attemptId);
  f.gateway.ledger.accept(prepared.attempt.attemptId, { taskId: 'task-1' }, { executionStatus: 'completed', resultRevision: 'r1', resultDigest: digest, artifactLinks: [] });
  const proposal = await f.gateway.invoke('handoff_propose', { originSessionId: 'root', jobId: prepared.job.jobId, attemptId: prepared.attempt.attemptId,
    caseId: record.caseId, toTargetId: 'legacy:local', purpose: 'make', artifactRevision: 'r1', artifactDigest: digest, reason: '稿子可以制作' }) as any;
  const refused = await f.request(`/workbench/cases/${record.caseId}/handoffs/${proposal.handoffId}/decisions`, f.post({ decision: 'accept' }));
  assert.equal(refused.status, 404, 'the page owner may not decide another person\'s gate');

  const reviewers = await f.request('/workbench/cases');
  assert.equal((await reviewers.json() as any).reviewers.handoff, 'editor');
});

test('an executor may propose a handoff from its own session, and it still does not open the next task', async t => {
  const f = await fixture(t);
  const opened = await f.request('/workbench/cases', f.post({ originSessionId: 'root', goal: '选题' }));
  const record = await opened.json() as any;
  const digest = digestOf('draft');
  const prepared = f.gateway.ledger.prepare({ originSessionId: 'root', caseId: record.caseId, title: '稿子', targetSnapshot: { targetId: 'author' }, input: {} });
  f.gateway.ledger.markDispatching(prepared.attempt.attemptId);
  f.gateway.ledger.accept(prepared.attempt.attemptId, { taskId: 'task-1', sessionId: 'executor-session' }, { executionStatus: 'completed', resultRevision: 'r1', resultDigest: digest, artifactLinks: [] });
  const proposal = await f.gateway.invoke('handoff_propose', { jobId: prepared.job.jobId, attemptId: prepared.attempt.attemptId, sessionId: 'executor-session',
    via: 'dsh', caseId: record.caseId, toTargetId: 'legacy:local', purpose: 'make', artifactRevision: 'r1', artifactDigest: digest, reason: '稿子可以制作' }) as any;
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.caseId, record.caseId);
  assert.equal(f.gateway.ledger.list('root').length, 1, 'proposing never opens the next task');

  const wrongSession = await f.gateway.invoke('handoff_propose', { jobId: prepared.job.jobId, attemptId: prepared.attempt.attemptId, sessionId: 'another-session',
    via: 'dsh', caseId: record.caseId, toTargetId: 'legacy:local', purpose: 'make', artifactRevision: 'r1', artifactDigest: digest, reason: '稿子可以制作' })
    .then(() => undefined, (error: Error) => error);
  assert.match(String((wrongSession as Error)?.message), /不是执行这一轮的会话/);
});

test('a receipt is written by the application that holds the credential, not by an agent that says so', async t => {
  const f = await fixture(t);
  const opened = await f.request('/workbench/cases', f.post({ originSessionId: 'root', goal: '发布' }));
  const record = await opened.json() as any;
  const digest = digestOf('film');
  const written = await f.request(`/workbench/cases/${record.caseId}/receipts`, f.post({ channel: 'wechat', remoteId: 'post-1', artifactDigest: digest }, false));
  assert.equal(written.status, 200);
  const receipt = await written.json() as any;
  assert.equal(receipt.recordedBy.kind, 'application', 'the bearer call is the application, not a person');
  const agentWrite = await f.gateway.invoke('receipt_record', { originSessionId: 'root', caseId: record.caseId, channel: 'wechat', remoteId: 'post-2', artifactDigest: digest })
    .then(() => undefined, (error: Error) => error);
  assert.match(String((agentWrite as Error)?.message), /Unknown method/, 'the agent channel has no way to register a receipt');
});
