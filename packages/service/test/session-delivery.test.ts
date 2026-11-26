import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serveA2AGateway } from '../src/a2a/gateway.js';
import { SessionDelivery } from '../src/a2a/session-delivery.js';
import { sessionHostSchema } from '../src/a2a/session-hosts.js';

test('restart requires reconciliation of dispatching admission, blocks FIFO, and preserves explicit acceptance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); calls.push(request.rpcId);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const hosts = { dsh: sessionHostSchema.parse({ kind: 'dsh', url: `http://127.0.0.1:${address.port}`, headers: { Authorization: 'Bearer private-test-credential' } }) };
  const initial = new SessionDelivery(root, hosts);
  initial.bind({ originSessionId: 'parent', host: 'dsh', sessionId: 'existing-session' });
  initial.enqueue({ originSessionId: 'parent', messageId: 'first', text: 'first work' });
  initial.enqueue({ originSessionId: 'parent', messageId: 'second', text: 'second work' });
  await initial.close();
  const file = join(root, 'session-delivery.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.deliveries[0].status = 'dispatching'; stored.deliveries[0].attempts = 1;
  await writeFile(file, JSON.stringify(stored));
  const restored = new SessionDelivery(root, hosts); t.after(() => restored.close());
  assert.equal(restored.get({ originSessionId: 'parent', messageId: 'first' }).status, 'unknown');
  await restored.reconcile(); assert.deepEqual(calls, []);
  restored.resolve({ originSessionId: 'parent', messageId: 'first', accepted: true, note: 'Verified first message is in host history', hostReceiptId: 'host-receipt' });
  await restored.reconcile(); assert.equal(calls.length, 1);
  assert.equal(restored.get({ originSessionId: 'parent', messageId: 'second' }).hostReceiptId, calls[0]);
  const receipt = restored.get({ originSessionId: 'parent', messageId: 'first' });
  assert.equal(receipt.hostReceiptId, 'host-receipt'); assert.equal(receipt.status, 'accepted');
  assert.equal(JSON.stringify(receipt).includes('first work'), false);
  assert.equal((await readFile(file, 'utf8')).includes('private-test-credential'), false);
});

test('saved bindings cannot silently redirect queued messages when an alias changes destination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstHost = sessionHostSchema.parse({ kind: 'dsh', url: 'http://127.0.0.1:1', headers: { Cookie: 'old-secret' } });
  const initial = new SessionDelivery(root, { host: firstHost });
  initial.bind({ originSessionId: 'parent', host: 'host', sessionId: 'original-session' });
  initial.enqueue({ originSessionId: 'parent', messageId: 'work', text: 'original work' }); await initial.close();
  const changed = new SessionDelivery(root, { host: sessionHostSchema.parse({ kind: 'dsh', url: 'http://127.0.0.1:2' }) });
  t.after(() => changed.close());
  assert.throws(() => changed.bind({ originSessionId: 'parent', host: 'host', sessionId: 'original-session' }), /already bound/);
  await changed.reconcile();
  const receipt = changed.get({ originSessionId: 'parent', messageId: 'work' });
  assert.equal(receipt.status, 'unknown'); assert.equal(receipt.attempts, 0);
  await changed.close();
  // Credential rotation leaves the destination identity intact.
  const rotated = new SessionDelivery(root, { host: sessionHostSchema.parse({ kind: 'dsh', url: 'http://127.0.0.1:1', headers: { Cookie: 'new-secret' } }) });
  t.after(() => rotated.close());
  assert.equal(rotated.bind({ originSessionId: 'parent', host: 'host', sessionId: 'original-session' }).sessionId, 'original-session');
});

test('acknowledging a pending task notice suppresses its automatic delivery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-ack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new SessionDelivery(root, { host: sessionHostSchema.parse({ kind: 'dsh', url: 'http://127.0.0.1:1' }) });
  t.after(() => sessions.close());
  sessions.bind({ originSessionId: 'parent', host: 'host', sessionId: 'session' });
  sessions.enqueue({ originSessionId: 'parent', messageId: 'a2a-notice:handled', text: 'already processed task' });
  sessions.acknowledgeNotice('parent', 'handled');
  await sessions.reconcile();
  const receipt = sessions.get({ originSessionId: 'parent', messageId: 'a2a-notice:handled' });
  assert.ok(receipt.processedAt); assert.equal(receipt.attempts, 0);
});

test('a failed durable write cannot be reported as accepted by repeating the same request', async t => {
  for (const operation of ['bind', 'send'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'session-write-failure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sessions = new SessionDelivery(root, { host: sessionHostSchema.parse({ kind: 'dsh', url: 'http://127.0.0.1:1' }) });
    t.after(() => sessions.close());
    const binding = { originSessionId: 'parent', host: 'host', sessionId: 'session' };
    if (operation === 'send') sessions.bind(binding);
    const file = join(root, 'session-delivery.json');
    await rm(file, { force: true }); await mkdir(file);
    const submit = () => operation === 'bind' ? sessions.bind(binding) : sessions.enqueue({ originSessionId: 'parent', messageId: 'work', text: 'must be durable' });
    assert.throws(submit, /storage is unavailable/);
    assert.equal(sessions.healthy, false);
    assert.throws(submit, /storage is unavailable/);
    assert.throws(() => sessions.get({ originSessionId: 'parent', messageId: 'work' }), /storage is unavailable/);
    assert.throws(() => sessions.getBindingStatus('parent'), /storage is unavailable/);
    assert.equal(typeof sessions.summary().bindings, 'number');
    await sessions.reconcile();
  }
});

test('steer mode persists, detects idempotency conflicts, repumps concurrent enqueue, and suppresses acknowledged process requests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-steer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const delivered: Array<{ rpcId: string; mode: string; text: string }> = [];
  let releaseFirst: (() => void) | undefined;
  const firstArrived = new Promise<void>(resolve => {
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      const item = request.payload.args.request;
      delivered.push({ rpcId: request.rpcId, mode: item.mode, text: item.content[0].text });
      if (delivered.length === 1) {
        resolve();
        await new Promise<void>(done => { releaseFirst = done; });
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      t.after(() => new Promise<void>(done => server.close(() => done())));
      const hosts = { dsh: sessionHostSchema.parse({ kind: 'dsh', url: `http://127.0.0.1:${address.port}` }) };
      const sessions = new SessionDelivery(root, hosts);
      t.after(() => sessions.close());
      sessions.bind({ originSessionId: 'parent-a', host: 'dsh', sessionId: 'sess-a' });
      sessions.bind({ originSessionId: 'parent-b', host: 'dsh', sessionId: 'sess-b' });
      sessions.enqueue({ originSessionId: 'parent-a', messageId: 'msg-1', text: 'first' });
      sessions.enqueue({ originSessionId: 'parent-b', messageId: 'process-request:prc-suppressed', mode: 'steer', text: 'already answered' });
      sessions.acknowledgeProcessRequest('parent-b', 'prc-suppressed');
      assert.throws(() => sessions.enqueue({ originSessionId: 'parent-a', messageId: 'msg-1', mode: 'steer', text: 'first' }), /different content/);
      const pump = sessions.reconcile();
      void firstArrived.then(async () => {
        sessions.enqueue({ originSessionId: 'parent-b', messageId: 'process-request:prc-live', mode: 'steer', text: 'approve bash' });
        const secondPump = sessions.reconcile();
        releaseFirst?.();
        await Promise.all([pump, secondPump]);
      });
    });
  });
  await firstArrived;
  for (let i = 0; i < 40 && delivered.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(delivered.map(item => [item.mode, item.text]), [['queue', 'first'], ['steer', 'approve bash']]);
});

const zeroDeliveries = { total: 0, pending: 0, dispatching: 0, retrying: 0, accepted: 0, unknown: 0, rejected: 0, unprocessed: 0 };

test('binding status hides host fingerprints and blocks only unknown or rejected admissions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-binding-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hosts = { 'dsh-local': sessionHostSchema.parse({ kind: 'dsh', url: 'http://127.0.0.1:9', headers: { Authorization: 'Bearer status-secret-credential' } }) };
  const initial = new SessionDelivery(root, hosts);
  initial.bind({ originSessionId: 'parent-a', host: 'dsh-local', sessionId: 'sess-a' });
  initial.bind({ originSessionId: 'parent-b', host: 'dsh-local', sessionId: 'sess-b' });
  initial.bind({ originSessionId: 'parent-c', host: 'dsh-local', sessionId: 'sess-c' });
  for (const [originSessionId, messageId, text] of [
    ['parent-a', 'm-unknown', 'body-unknown-secret-text'],
    ['parent-a', 'm-pending', 'body-pending-secret-text'],
    ['parent-a', 'm-accepted', 'body-accepted-secret-text'],
    ['parent-b', 'm-rejected', 'body-rejected-secret-text'],
    ['parent-b', 'm-retrying', 'body-retrying-secret-text'],
  ] as const) initial.enqueue({ originSessionId, messageId, text });
  await initial.close();
  const file = join(root, 'session-delivery.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const fingerprint = stored.bindings[0].hostFingerprint as string;
  assert.equal(typeof fingerprint, 'string'); assert.ok(fingerprint.length > 0);
  const byId = new Map<string, any>(stored.deliveries.map((delivery: { messageId: string }) => [delivery.messageId, delivery]));
  byId.get('m-unknown').status = 'unknown';
  byId.get('m-pending').status = 'pending';
  byId.get('m-accepted').status = 'accepted';
  byId.get('m-accepted').processedAt = byId.get('m-accepted').updatedAt;
  byId.get('m-rejected').status = 'rejected';
  byId.get('m-retrying').status = 'retrying';
  await writeFile(file, JSON.stringify(stored));
  const sessions = new SessionDelivery(root, hosts);
  t.after(() => sessions.close());
  const missing = sessions.getBindingStatus('missing-origin');
  assert.equal(missing.originSessionId, 'missing-origin');
  assert.equal(missing.bound, false);
  assert.equal(missing.binding, undefined);
  assert.equal(missing.blocked, false);
  assert.deepEqual(missing.deliveries, zeroDeliveries);
  const parentA = sessions.getBindingStatus('parent-a');
  assert.equal(parentA.bound, true);
  assert.equal(parentA.blocked, true);
  assert.deepEqual(parentA.binding, { originSessionId: 'parent-a', host: 'dsh-local', sessionId: 'sess-a', createdAt: parentA.binding!.createdAt });
  assert.equal(Object.hasOwn(parentA.binding!, 'hostFingerprint'), false);
  assert.deepEqual(parentA.deliveries, { total: 3, pending: 1, dispatching: 0, retrying: 0, accepted: 1, unknown: 1, rejected: 0, unprocessed: 2 });
  const parentB = sessions.getBindingStatus('parent-b');
  assert.equal(parentB.bound, true);
  assert.equal(parentB.blocked, true);
  assert.deepEqual(parentB.deliveries, { total: 2, pending: 0, dispatching: 0, retrying: 1, accepted: 0, unknown: 0, rejected: 1, unprocessed: 2 });
  const parentC = sessions.getBindingStatus('parent-c');
  assert.equal(parentC.bound, true);
  assert.equal(parentC.blocked, false);
  assert.deepEqual(parentC.deliveries, zeroDeliveries);
  const summary = sessions.summary();
  assert.deepEqual(summary, {
    bindings: 3,
    blockedOrigins: 2,
    deliveries: { total: 5, pending: 1, dispatching: 0, retrying: 1, accepted: 1, unknown: 1, rejected: 1 },
  });
  const leaked = JSON.stringify({ missing, parentA, parentB, parentC, summary });
  assert.equal(leaked.includes('hostFingerprint'), false);
  assert.equal(leaked.includes(fingerprint), false);
  assert.equal(leaked.includes('status-secret-credential'), false);
  assert.equal(leaked.includes('secret-text'), false);
});

test('in-flight host admission counts as dispatching and is not blocked', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-binding-dispatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    await held;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const sessions = new SessionDelivery(root, { dsh: sessionHostSchema.parse({ kind: 'dsh', url: `http://127.0.0.1:${address.port}` }) });
  t.after(() => sessions.close());
  sessions.bind({ originSessionId: 'parent', host: 'dsh', sessionId: 'sess' });
  sessions.enqueue({ originSessionId: 'parent', messageId: 'live', text: 'dispatch-body-not-in-status' });
  const pump = sessions.reconcile();
  const deadline = Date.now() + 2000;
  let inflight = sessions.getBindingStatus('parent');
  while (inflight.deliveries.dispatching !== 1) {
    if (Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 10));
    inflight = sessions.getBindingStatus('parent');
  }
  assert.equal(inflight.deliveries.dispatching, 1);
  assert.equal(inflight.blocked, false);
  assert.equal(inflight.bound, true);
  assert.equal(JSON.stringify(inflight).includes('dispatch-body-not-in-status'), false);
  assert.equal(JSON.stringify(inflight).includes('hostFingerprint'), false);
  release();
  await pump;
  const done = sessions.getBindingStatus('parent');
  assert.equal(done.deliveries.accepted, 1);
  assert.equal(done.deliveries.dispatching, 0);
  assert.equal(done.deliveries.unprocessed, 1);
  assert.equal(done.blocked, false);
});

test('gateway session_binding_get and health expose binding stats without credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-binding-gateway-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await serveA2AGateway({
    stateDirectory: root, port: 0, remotes: {}, pollIntervalMs: 60_000,
    sessionHosts: { 'dsh-local': { kind: 'dsh', url: 'http://127.0.0.1:9', headers: { Authorization: 'Bearer gateway-status-secret' } } },
  }, { report: false });
  t.after(() => host.close());
  await assert.rejects(host.gateway.invoke('session_binding_get', {}));
  const missing = await host.gateway.invoke('session_binding_get', { originSessionId: 'missing-origin' }) as any;
  assert.equal(missing.bound, false);
  assert.equal(missing.blocked, false);
  assert.deepEqual(missing.deliveries, zeroDeliveries);
  await host.gateway.invoke('session_bind', { originSessionId: 'coach-1', host: 'dsh-local', sessionId: 'existing-session' });
  const bound = await host.gateway.invoke('session_binding_get', { originSessionId: 'coach-1' }) as any;
  assert.equal(bound.bound, true);
  assert.equal(bound.blocked, false);
  assert.equal(bound.binding.host, 'dsh-local');
  assert.equal(bound.binding.sessionId, 'existing-session');
  assert.equal(bound.binding.hostFingerprint, undefined);
  const health = await (await fetch(`http://127.0.0.1:${host.port}/health`)).json() as any;
  assert.equal(health.status, 'ok');
  assert.equal(health.sessionDelivery, 'ok');
  assert.deepEqual(health.sessionDeliveryStats, {
    bindings: 1,
    blockedOrigins: 0,
    deliveries: { total: 0, pending: 0, dispatching: 0, retrying: 0, accepted: 0, unknown: 0, rejected: 0 },
  });
  const leaked = JSON.stringify({ missing, bound, health });
  assert.equal(leaked.includes('hostFingerprint'), false);
  assert.equal(leaked.includes('gateway-status-secret'), false);
  const file = join(root, 'session-delivery.json');
  await rm(file, { force: true }); await mkdir(file);
  await assert.rejects(host.gateway.invoke('session_bind', { originSessionId: 'coach-2', host: 'dsh-local', sessionId: 'other-session' }), /storage is unavailable/);
  await assert.rejects(host.gateway.invoke('session_binding_get', { originSessionId: 'coach-1' }), /storage is unavailable/);
  const degradedResponse = await fetch(`http://127.0.0.1:${host.port}/health`);
  assert.equal(degradedResponse.status, 503);
  const degraded = await degradedResponse.json() as any;
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.sessionDelivery, 'storage-unavailable');
  assert.equal(degraded.sessionDeliveryStats.bindings, 1);
  assert.equal(degraded.sessionDeliveryStats.blockedOrigins, 0);
  assert.equal(JSON.stringify(degraded).includes('gateway-status-secret'), false);
  assert.equal(JSON.stringify(degraded).includes('hostFingerprint'), false);
});

test('subscriber target queues stay isolated when one target is rejected or unknown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-target-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    const sessionId = request.payload?.args?.request?.sessionId as string | undefined;
    if (sessionId === 'bad-unknown') { req.socket.destroy(); return; }
    if (sessionId === 'bad-rejected') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: false } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const hosts = {
    dsh: sessionHostSchema.parse({ kind: 'dsh', url: `http://127.0.0.1:${address.port}`, headers: { Authorization: 'Bearer target-queue-secret' } }),
    codex: sessionHostSchema.parse({ kind: 'codex', executable: 'codex' }),
  };
  const legacy = { version: 1, bindings: [], deliveries: [] };
  await writeFile(join(root, 'session-delivery.json'), JSON.stringify(legacy));
  const sessions = new SessionDelivery(root, hosts);
  t.after(() => sessions.close());
  const codexId = '11111111-1111-4111-8111-111111111111';
  sessions.bind({ originSessionId: 'owner', host: 'dsh', sessionId: 'owner-session' });
  assert.deepEqual(sessions.resolveTarget({ originSessionId: 'owner' }), { host: 'dsh', sessionId: 'owner-session' });
  assert.throws(() => sessions.resolveTarget({ originSessionId: 'missing' }), /not bound/);
  assert.throws(() => sessions.resolveTarget({ host: 'missing', sessionId: 'x' }), /Unknown session host/);
  assert.throws(() => sessions.resolveTarget({ host: 'codex', sessionId: 'not-a-uuid' }), /UUID/);
  assert.deepEqual(sessions.resolveTarget({ host: 'codex', sessionId: codexId }), { host: 'codex', sessionId: codexId });
  sessions.enqueue({ originSessionId: 'owner', messageId: 'owner-1', text: 'owner body secret' });
  const ownerKey = 'owner';
  const rejectedKey = 'sub:dsh:bad-rejected';
  const unknownKey = 'sub:dsh:bad-unknown';
  const healthyKey = 'sub:dsh:healthy-session';
  for (const [targetKey, sessionId, messageId] of [
    [rejectedKey, 'bad-rejected', 'sub-1'],
    [unknownKey, 'bad-unknown', 'sub-1'],
    [healthyKey, 'healthy-session', 'sub-1'],
  ] as const) {
    sessions.enqueueTarget({ targetKey, host: 'dsh', sessionId, messageId, text: `body ${sessionId} secret`, mode: 'queue', notice: { form: 'notice', summary: '订阅' } });
  }
  await sessions.reconcile();
  assert.equal(sessions.get({ originSessionId: ownerKey, messageId: 'owner-1' }).status, 'accepted');
  assert.equal(sessions.getTarget({ targetKey: healthyKey, messageId: 'sub-1' }).status, 'accepted');
  assert.equal(sessions.getTarget({ targetKey: rejectedKey, messageId: 'sub-1' }).status, 'rejected');
  assert.equal(sessions.getTarget({ targetKey: unknownKey, messageId: 'sub-1' }).status, 'unknown');
  sessions.enqueue({ originSessionId: 'owner', messageId: 'owner-2', text: 'owner second secret' });
  sessions.enqueueTarget({ targetKey: healthyKey, host: 'dsh', sessionId: 'healthy-session', messageId: 'sub-2', text: 'healthy second secret' });
  sessions.enqueueTarget({ targetKey: rejectedKey, host: 'dsh', sessionId: 'bad-rejected', messageId: 'sub-2', text: 'rejected second secret' });
  sessions.enqueueTarget({ targetKey: unknownKey, host: 'dsh', sessionId: 'bad-unknown', messageId: 'sub-2', text: 'unknown second secret' });
  await sessions.reconcile();
  assert.equal(sessions.get({ originSessionId: 'owner', messageId: 'owner-2' }).status, 'accepted');
  assert.equal(sessions.getTarget({ targetKey: healthyKey, messageId: 'sub-2' }).status, 'accepted');
  assert.equal(sessions.getTarget({ targetKey: rejectedKey, messageId: 'sub-2' }).status, 'pending');
  assert.equal(sessions.getTarget({ targetKey: rejectedKey, messageId: 'sub-2' }).attempts, 0);
  assert.equal(sessions.getTarget({ targetKey: unknownKey, messageId: 'sub-2' }).status, 'pending');
  const status = sessions.getBindingStatus('owner');
  assert.equal(status.blocked, false);
  assert.equal(status.deliveries.rejected, 0);
  assert.equal(status.deliveries.unknown, 0);
  const summary = sessions.summary();
  assert.equal(summary.blockedOrigins, 0);
  assert.equal(summary.deliveries.rejected, 0);
  const leaked = JSON.stringify({ status, summary, owner: sessions.get({ originSessionId: 'owner', messageId: 'owner-1' }), healthy: sessions.getTarget({ targetKey: healthyKey, messageId: 'sub-1' }) });
  assert.equal(leaked.includes('secret'), false);
  assert.equal(leaked.includes('hostFingerprint'), false);
  assert.equal(leaked.includes('target-queue-secret'), false);
});
