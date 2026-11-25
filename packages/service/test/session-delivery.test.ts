import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
