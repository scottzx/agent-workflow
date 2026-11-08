import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createA2AServer } from '../src/a2a/server.js';
import { RemoteAgentGateway } from '../src/a2a/gateway.js';
import { runA2APreflight } from '../src/a2a/preflight.js';
import type { A2ABackend, A2APrepareInput, A2ATarget } from '../src/a2a/types.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-preflight-'));
  let creates = 0, runs = 0;
  const backend: A2ABackend = {
    preflight: runA2APreflight,
    prepare: async (input: A2APrepareInput): Promise<A2ATarget> => {
      creates++;
      return { sessionId: input.sessionId ?? 'host-session', cwd: input.cwd!, preflight: await runA2APreflight({ cwd: input.cwd!, ...input.preflight }) };
    },
    run: async () => { runs++; return { outcome: 'completed', text: 'Result complete' }; },
  };
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') host.cardHandler(req, res);
    else void host.handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  host = await createA2AServer({ backend, capacity: testCapacity(root), publicUrl: url, token: 'test-only-token', stateDirectory: join(root, 'host') });
  const gateway = new RemoteAgentGateway({ remotes: { local: { url, token: 'test-only-token' } }, stateDirectory: join(root, 'gateway'), pollIntervalMs: 50 });
  t.after(async () => { await gateway.close(); await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { root, gateway, counts: () => ({ creates, runs }) };
}
const originSessionId = 'caller-session', remote = 'local';

test('gateway preflight probes the remote host without admission and rejects a bad dispatch before creating a task', async t => {
  const f = await fixture(t);
  const report: any = await f.gateway.invoke('remote_agent_preflight', { originSessionId, remote, cwd: f.root, jobDirectory: f.root });
  assert.equal(report.ok, true);
  assert.deepEqual(f.counts(), { creates: 0, runs: 0 });
  const bad: any = await f.gateway.invoke('remote_agent_preflight', { originSessionId, remote, cwd: join(f.root, 'missing') });
  assert.equal(bad.ok, false);
  await assert.rejects(f.gateway.invoke('remote_agent_spawn', { originSessionId, remote, cwd: f.root, prompt: 'never run', preflight: { jobDirectory: join(f.root, 'missing') } }), /preflight rejected/);
  assert.deepEqual(f.counts(), { creates: 0, runs: 0 });
  assert.deepEqual(await f.gateway.invoke('remote_agent_list', { originSessionId }), { tasks: [] });
});

test('gateway forwards result contracts, exposes authoritative metadata and emits verified artifact links', async t => {
  const f = await fixture(t);
  const artifact = join(f.root, 'result.pptx'), manifest = join(f.root, 'artifacts.json');
  await writeFile(artifact, 'synthetic-ppt');
  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: artifact, url: 'https://example.test/result.pptx' }] }));
  const task: any = await f.gateway.invoke('remote_agent_spawn', { originSessionId, remote, cwd: f.root, prompt: 'run', preflight: { jobDirectory: f.root }, resultContract: { jobId: 'job-1', originSessionId, artifactManifestPath: manifest } });
  let final: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    final = await f.gateway.invoke('remote_agent_get', { originSessionId, remote, taskId: task.taskId });
    if (final.state === 'TASK_STATE_COMPLETED') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(final.state, 'TASK_STATE_COMPLETED');
  assert.equal(final.preflight.ok, true);
  assert.equal(final.resultMetadata.taskId, task.taskId);
  assert.equal(final.resultMetadata.contextId, task.contextId);
  assert.equal(final.resultMetadata.sessionId, 'host-session');
  assert.equal(final.resultMetadata.artifacts[0].size, 13);
  assert.equal(final.resultMetadata.validation.status, 'passed');
  assert.ok(final.artifactLinks.some((link: any) => link.url === 'https://example.test/result.pptx'));
  const completed = await f.gateway.invoke('execution_get', { originSessionId, jobId: task.jobId }) as any;
  assert.equal(completed.resultRevision, 'result-1'); assert.match(completed.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal(completed.resultDigest, final.resultDigest);
  assert.deepEqual(completed.result.resultArtifacts, final.resultMetadata.artifacts);
  assert.deepEqual(completed.resultHistory[0].resultArtifacts, final.resultMetadata.artifacts);
  const review = await f.gateway.invoke('execution_review', { originSessionId, jobId: task.jobId, attemptId: task.attemptId,
    resultRevision: completed.resultRevision, resultDigest: completed.resultDigest, reviewStatus: 'accepted', decidedBy: { kind: 'person' } }) as any;
  assert.equal(review.reviewStatus, 'accepted');
  await assert.rejects(f.gateway.invoke('remote_agent_spawn', { originSessionId, remote, cwd: f.root, prompt: 'run', resultContract: { jobId: 'fake', taskId: 'spoof' } }));
});
