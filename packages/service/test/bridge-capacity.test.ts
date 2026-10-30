import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAgentRegistry, createRuntimeStore } from '@1agents/acp-service/runtime';
import { CapacityGovernor } from '../src/capacity.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Pending bridge initialization did not cancel')), 5000);
  })]); } finally { clearTimeout(timer); }
}

test('bridge cancels pending session launches, including profile keys and late successful handles', { timeout: 40_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-capacity-'));
  const capacityDirectory = join(directory, 'capacity');
  const settings = { ACP_STATE_DIR: directory, ACP_CAPACITY_DIRECTORY: capacityDirectory,
    ACP_CAPACITY_SOFT_LIMIT: '1', ACP_CAPACITY_HARD_LIMIT: '2', ACP_CAPACITY_MEMORY_RESERVE_MB: '0',
    ACP_CAPACITY_INSTANCE_MEMORY_MB: '0.0009765625' };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const bridge = await import('../src/bridge.js');
  const options = Reflect.get(bridge.runtime, 'options');
  options.sessionStore = createRuntimeStore({ stateDir: directory });
  options.agentRegistry = createAgentRegistry({ overrides: { codex: [process.execPath,
    fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))] } });
  const governor = new CapacityGovernor({ directory: capacityDirectory, softLimit: 1, hardLimit: 2,
    memoryReserveBytes: 0, estimatedInstanceBytes: 1024,
    memoryProvider: () => ({ totalBytes: 1024 ** 3, availableBytes: 1024 ** 3 }) });
  t.after(async () => {
    await bridge.killAllManagedAgents();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const queueEntries = () => existsSync(join(capacityDirectory, 'queue'))
    ? readdirSync(join(capacityDirectory, 'queue')).filter(name => name.startsWith('entry-')) : [];
  const waitForPending = async () => {
    await deadline((async () => { while (!queueEntries().length) await delay(10); })());
  };
  const peer = () => {
    const events: Array<Record<string, unknown>> = [];
    return { events, readyState: 1, send(raw: string) { events.push(JSON.parse(raw)); } };
  };

  for (const action of ['close_session', 'cancel_turn', 'close_all_sessions']) {
    await t.test(`${action} aborts the actual process FIFO and prevents a later launch`, async () => {
      const occupied = await governor.acquire({ kind: 'process', source: 'automatic', id: `occupied-${action}` });
      const ws = peer();
      const sessionId = `pending-${action}`;
      const ensure = bridge.dispatchCommand(ws, { action: 'ensure_session', sessionId, workspacePath: directory,
        agentType: 'codex', responsePolicy: 'summary', launch: { profileId: 'separate-profile', profileRevision: 2 } });
      try {
        await waitForPending();
        await deadline(bridge.dispatchCommand(ws, { action, sessionId }));
        await deadline(ensure);
        assert.equal(queueEntries().length, 0);
        assert.equal(bridge.activeSessions.has(sessionId), false);
        assert.equal(ws.events.some(event => event.code === 'SESSION_NOT_FOUND'), false);
        await occupied.release();
        await delay(800);
        assert.equal((await governor.snapshot('process')).used, 0);
        assert.equal(ws.events.some(event => event.event === 'session_ready'), false);
      } finally { await occupied.release(); }
    });
  }

  await t.test('a late ensure result is closed before cancellation returns', async () => {
    const originalEnsure = bridge.runtime.ensureSession;
    const originalClose = bridge.runtime.close;
    const late = deferred<object>();
    const started = deferred<void>();
    const closed: object[] = [];
    let ensures = 0;
    Reflect.set(bridge.runtime, 'ensureSession', async () => { ensures++; started.resolve(); return late.promise; });
    Reflect.set(bridge.runtime, 'close', async ({ handle }: { handle: object }) => { closed.push(handle); });
    const ws = peer();
    const sessionId = 'late-profile-result';
    const handle = { sessionKey: `${sessionId}@updated-r2`, agent: 'codex', mode: 'persistent', cwd: directory };
    try {
      const ensure = bridge.dispatchCommand(ws, { action: 'ensure_session', sessionId, workspacePath: directory,
        agentType: 'codex', responsePolicy: 'summary', resumeSessionId: 'old-agent',
        launch: { profileId: 'updated', profileRevision: 2, previousProfileId: 'old', previousProfileRevision: 1 } });
      await started.promise;
      const canceled = bridge.dispatchCommand(ws, { action: 'close_session', sessionId });
      late.resolve(handle);
      await deadline(Promise.all([ensure, canceled]));
      assert.deepEqual(closed, [handle]);
      assert.equal(ensures, 1);
      assert.equal(bridge.activeSessions.has(sessionId), false);
      assert.equal(ws.events.some(event => event.event === 'session_ready'), false);
    } finally {
      Reflect.set(bridge.runtime, 'ensureSession', originalEnsure);
      Reflect.set(bridge.runtime, 'close', originalClose);
    }
  });

  await t.test('cancellation of a failed profile resume cannot launch its fallback', async () => {
    const originalEnsure = bridge.runtime.ensureSession;
    const late = deferred<never>();
    const started = deferred<void>();
    let ensures = 0;
    Reflect.set(bridge.runtime, 'ensureSession', async () => { ensures++; started.resolve(); return late.promise; });
    const ws = peer();
    const sessionId = 'failed-profile-resume';
    try {
      const ensure = bridge.dispatchCommand(ws, { action: 'ensure_session', sessionId, workspacePath: directory,
        agentType: 'codex', responsePolicy: 'summary', resumeSessionId: 'old-agent',
        launch: { profileId: 'updated', profileRevision: 2, previousProfileId: 'old', previousProfileRevision: 1 } });
      await started.promise;
      const canceled = bridge.dispatchCommand(ws, { action: 'cancel_turn', sessionId });
      late.reject(new Error('profile resume failed'));
      await deadline(Promise.all([ensure, canceled]));
      assert.equal(ensures, 1);
      assert.equal(ws.events.some(event => event.event === 'session_ready'), false);
      assert.equal(ws.events.some(event => event.code === 'SESSION_NOT_FOUND'), false);
    } finally { Reflect.set(bridge.runtime, 'ensureSession', originalEnsure); }
  });

  await t.test('a full process slot returns CAPACITY_PENDING before the handshake budget', async () => {
    const occupied = await governor.acquire({ kind: 'process', source: 'automatic', id: 'occupied-probe' });
    const ws = peer();
    const started = Date.now();
    try {
      await deadline(bridge.dispatchCommand(ws, { action: 'ensure_session', sessionId: 'pending-capacity-id', workspacePath: directory,
        agentType: 'codex', responsePolicy: 'summary', capacityId: 'a2a-probe-1' }));
      assert.ok(Date.now() - started < 5000);
      const pending = ws.events.find(event => event.code === 'CAPACITY_PENDING');
      assert.ok(pending);
      const data = pending.data as { position?: unknown; waitedMs?: unknown };
      assert.equal(typeof data.position, 'number');
      assert.ok((data.position as number) >= 1);
      assert.equal(typeof data.waitedMs, 'number');
      assert.equal(ws.events.some(event => event.event === 'session_ready'), false);
      assert.equal(bridge.activeSessions.has('pending-capacity-id'), false);
      const names = queueEntries();
      assert.equal(names.length, 1);
      const file = join(capacityDirectory, 'queue', names[0]!);
      const record = JSON.parse(readFileSync(file, 'utf8'));
      record.enqueuedAt = Date.now() - 61_000;
      writeFileSync(file, JSON.stringify(record));
      const again = peer();
      await deadline(bridge.dispatchCommand(again, { action: 'ensure_session', sessionId: 'pending-capacity-id-2', workspacePath: directory,
        agentType: 'codex', responsePolicy: 'summary', capacityId: 'a2a-probe-1' }));
      const waited = again.events.find(event => event.code === 'CAPACITY_PENDING');
      assert.ok(waited);
      assert.ok((waited.data as { waitedMs: number }).waitedMs >= 60_000);
      assert.equal(queueEntries().length, 1);
      await deadline(bridge.dispatchCommand(again, { action: 'capacity_cancel', sessionId: 'pending-capacity-id-2', capacityId: 'a2a-probe-1' }));
      assert.equal(queueEntries().length, 0);
      assert.equal((await governor.snapshot('process')).used, 1);
      assert.equal(bridge.activeSessions.has('pending-capacity-id'), false);
      assert.equal(bridge.activeSessions.has('pending-capacity-id-2'), false);
    } finally { await occupied.release(); }
  });
});
