import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CancelTaskRequest, GetTaskRequest, SendMessageRequest, TaskState, type Task } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { createA2AServer } from '../src/a2a/server.js';
import { A2APreflightError, runA2APreflight } from '../src/a2a/preflight.js';
import { a2aResultContractSchema, createA2AResultMetadata, saveA2AResultMetadata, type A2AResultMetadata } from '../src/a2a/result-metadata.js';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';

async function directory(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'a2a-result-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const identity = { taskId: 'real-task', contextId: 'real-context', requestId: 'real-request', startedAt: '2026-10-20T00:00:00.000Z', outcome: 'completed' as const };

test('host verifies artifact bytes and atomically records authoritative identities and caller-declared lineage', async t => {
  const root = await directory(t);
  const artifact = join(root, 'slides.pptx');
  await writeFile(artifact, 'test PPT bytes');
  const manifest = join(root, 'artifacts.json');
  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: artifact, url: 'https://example.invalid/slides.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }] }));
  const preflight = await runA2APreflight({ cwd: root, jobDirectory: root });
  const target = { sessionId: 'real-session', cwd: root, agentPreset: 'ppt-beautifier', preflight };
  const metadata = await createA2AResultMetadata({ ...identity, target, contract: {
    jobId: 'job-123', parentTaskId: 'claimed-parent', parentSessionId: 'claimed-parent-session', originSessionId: 'claimed-origin', artifactManifestPath: manifest,
  } });
  await saveA2AResultMetadata(metadata, target);
  assert.equal(metadata.taskId, 'real-task');
  assert.equal(metadata.sessionId, 'real-session');
  assert.equal(metadata.lineage?.source, 'caller-declared');
  assert.equal(metadata.lineage?.parentTaskId, 'claimed-parent');
  assert.equal(metadata.validation.status, 'passed');
  assert.equal(metadata.artifacts[0].size, 14);
  assert.equal(metadata.artifacts[0].sha256, createHash('sha256').update('test PPT bytes').digest('hex'));
  assert.deepEqual(JSON.parse(await readFile(metadata.recordPath!, 'utf8')), metadata);
  assert.ok(Date.parse(metadata.finishedAt) >= Date.parse(metadata.startedAt));
  assert.equal(a2aResultContractSchema.safeParse({ jobId: 'x', taskId: 'spoofed', sessionId: 'spoofed' }).success, false);
});

test('artifact receipt rejects files outside the admitted job, symlinks, and model-supplied hash fields', async t => {
  const root = await directory(t), outside = await directory(t);
  const file = join(root, 'file.pptx'), outsideFile = join(outside, 'secret');
  await writeFile(file, 'PPT'); await writeFile(outsideFile, 'outside');
  const manifest = join(root, 'artifacts.json');
  const target = { sessionId: 'real-session', cwd: root, preflight: await runA2APreflight({ cwd: root, jobDirectory: root }) };
  const check = () => createA2AResultMetadata({ ...identity, target, contract: { jobId: 'x', artifactManifestPath: manifest } });
  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: outsideFile }] }));
  await assert.rejects(check(), /artifact-outside-job-directory/);
  const linked = join(root, 'link.pptx'); await symlink(file, linked);
  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: linked }] }));
  await assert.rejects(check(), /artifact-symlink/);
  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: file, sha256: 'invented' }] }));
  await assert.rejects(check(), /invalid-artifact-manifest/);
  await assert.rejects(createA2AResultMetadata({ ...identity, target: { sessionId: 's', cwd: root },
    contract: { jobId: 'x', artifactManifestPath: manifest } }), /artifact-job-directory-not-admitted/);
});

/** Real SDK transport checks that status metadata reaches the durable task rather than only an event. */
async function fixture(t: TestContext, outcome: A2ARunResult['outcome'] = 'completed') {
  const root = await directory(t);
  const state = await directory(t);
  const calls = { prepare: 0, run: 0 };
  const backend: A2ABackend = {
    async prepare(input: A2APrepareInput): Promise<A2ATarget> {
      const preflight = await runA2APreflight({ cwd: input.cwd!, ...input.preflight });
      if (!preflight.ok) throw new A2APreflightError(preflight);
      calls.prepare++;
      return { sessionId: input.sessionId ?? `session-${calls.prepare}`, cwd: preflight.cwd, preflight };
    },
    async run(): Promise<A2ARunResult> { calls.run++; return { text: 'MODEL SAYS taskId=spoofed sessionId=spoofed', outcome }; },
  };
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const server = createServer((req, res) => {
    const handler = req.url === '/.well-known/agent-card.json' ? host.cardHandler : host.handler;
    void handler(req, res).catch(error => res.destroy(error));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  host = await createA2AServer({ backend, capacity: testCapacity(root), stateDirectory: state, publicUrl: origin, token: 'test-token', defaultCwd: root });
  t.after(async () => { await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const client = await new ClientFactory().createFromUrl(origin);
  const auth = { serviceParameters: { Authorization: 'Bearer test-token' } };
  const send = async (metadata?: Record<string, unknown>, contextId?: string): Promise<Task> => {
    const result = await client.sendMessage(SendMessageRequest.fromJSON({
      message: { messageId: randomUUID(), role: 'ROLE_USER', contextId, parts: [{ text: 'make slides' }] },
      metadata: metadata ? { '1agents': metadata } : undefined,
      configuration: { returnImmediately: false },
    }), auth);
    assert.ok('id' in result);
    return client.getTask(GetTaskRequest.fromJSON({ id: result.id }), auth);
  };
  return { root, calls, send, client, auth, origin };
}

test('the host serves back only verified artifact bytes for a task, and refuses anything changed or unregistered', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const artifact = join(f.root, 'notes.md'), other = join(f.root, 'secret.txt'), manifest = join(f.root, 'artifacts.json');
  await writeFile(artifact, '# notes'); await writeFile(other, 'not registered');
  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: artifact, mediaType: 'text/markdown' }] }));
  const task = await f.send({ preflight: { jobDirectory: f.root }, resultContract: { jobId: 'read', artifactManifestPath: manifest } });
  const { sha256 } = (task.metadata?.['1agents'] as { result: A2AResultMetadata }).result.artifacts[0]!;
  const read = (body: Record<string, unknown>, token = 'test-token') => fetch(`${f.origin}/a2a/artifacts/content`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const served = await read({ taskId: task.id, path: artifact, sha256 });
  assert.equal(served.status, 200);
  assert.equal(await served.text(), '# notes');
  assert.equal((await read({ taskId: task.id, path: artifact, sha256 }, 'wrong')).status, 401);
  const otherHash = createHash('sha256').update('not registered').digest('hex');
  assert.equal((await read({ taskId: task.id, path: other, sha256: otherHash })).status, 404);
  assert.equal((await read({ taskId: 'missing', path: artifact, sha256 })).status, 404);
  assert.equal((await read({ taskId: task.id, path: artifact, sha256: 'not-a-hash' })).status, 400);
  await writeFile(artifact, '# edited');
  assert.equal((await read({ taskId: task.id, path: artifact, sha256 })).status, 409);
});

test('completed tasks and same-context continuations keep real IDs, verified URLs, and independent records', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const artifact = join(f.root, 'slides.pptx'), manifest = join(f.root, 'artifacts.json');
  await writeFile(artifact, 'editable deck');
  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: artifact, url: 'https://example.invalid/deck.pptx' }] }));
  const params = { preflight: { jobDirectory: f.root }, resultContract: { jobId: 'chain', artifactManifestPath: manifest } };
  const first = await f.send(params);
  const second = await f.send(params, first.contextId);
  assert.equal(first.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(second.status?.state, TaskState.TASK_STATE_COMPLETED);
  const a = (first.metadata?.['1agents'] as { result: A2AResultMetadata }).result;
  const b = (second.metadata?.['1agents'] as { result: A2AResultMetadata }).result;
  assert.notEqual(first.id, second.id);
  assert.equal(a.taskId, first.id); assert.equal(b.taskId, second.id);
  assert.equal(a.contextId, b.contextId); assert.equal(a.sessionId, b.sessionId);
  assert.notEqual(a.requestId, b.requestId); assert.notEqual(a.recordPath, b.recordPath);
  assert.equal(a.artifacts[0].sha256, b.artifacts[0].sha256);
  assert.ok(second.artifacts.some(artifact => artifact.parts.some(part => part.content?.$case === 'url' && part.content.value === 'https://example.invalid/deck.pptx')));
  assert.equal(JSON.parse(await readFile(b.recordPath!, 'utf8')).taskId, second.id);
});

test('legacy callers still complete; preflight and artifact failures retain system metadata without unadmitted execution', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const legacy = await f.send();
  assert.equal(legacy.status?.state, TaskState.TASK_STATE_COMPLETED);
  const legacyMetadata = (legacy.metadata?.['1agents'] as { result: A2AResultMetadata }).result;
  assert.equal(legacyMetadata.validation.status, 'not-requested');
  assert.equal(legacyMetadata.recordPath, undefined);
  const rejected = await f.send({ cwd: join(f.root, 'absent'), resultContract: { jobId: 'bad-cwd' } });
  const rejection = (rejected.metadata?.['1agents'] as { result: A2AResultMetadata }).result;
  assert.equal(rejected.status?.state, TaskState.TASK_STATE_FAILED);
  assert.equal(rejection.taskId, rejected.id); assert.equal(rejection.sessionId, undefined);
  assert.equal(rejection.preflight?.ok, false);
  assert.equal(f.calls.run, 1);
  const invalid = await f.send({ preflight: { jobDirectory: f.root }, resultContract: { jobId: 'missing-manifest', artifactManifestPath: join(f.root, 'missing.json') } });
  const invalidMetadata = (invalid.metadata?.['1agents'] as { result: A2AResultMetadata }).result;
  assert.equal(invalid.status?.state, TaskState.TASK_STATE_FAILED);
  assert.equal(invalidMetadata.outcome, 'failed');
  assert.equal(invalidMetadata.validation.status, 'failed');
  assert.ok(invalid.artifacts[0].parts[0].content?.value.includes('MODEL SAYS'));
});

test('canceling an input-required task updates its stored metadata outcome and sidecar', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'input-required');
  const task = await f.send({ preflight: { jobDirectory: f.root }, resultContract: { jobId: 'paused' } });
  assert.equal(task.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  const canceled = await f.client.cancelTask(CancelTaskRequest.fromJSON({ id: task.id }), f.auth);
  const result = (canceled.metadata?.['1agents'] as { result: A2AResultMetadata }).result;
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  assert.equal(result.taskId, task.id);
  assert.equal(result.outcome, 'canceled');
  assert.equal(JSON.parse(await readFile(result.recordPath!, 'utf8')).outcome, 'canceled');
});
