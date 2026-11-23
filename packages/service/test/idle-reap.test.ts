import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { client } from '@agentclientprotocol/sdk';
import { WebSocket, WebSocketServer } from 'ws';
import { createAgentRegistry, createRuntimeStore } from '@1agents/acp-service/runtime';
import { CapacityGovernor } from '../src/capacity.js';
import { AcpState } from '../src/acp-state.js';

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5000, message = 'Condition timed out'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function openAcpClient(port: number, webSocketStream: (ws: WebSocket) => ReturnType<typeof import('../src/acp-connection.js').webSocketStream>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agents/codex`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closedEvents: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const connection = client()
    .onNotification('session/update', ({ params }) => { updates.push(params as unknown as Record<string, unknown>); })
    .onNotification('_1agents/events/session_closed', (p: unknown) => p as Record<string, unknown>, ({ params }) => {
      closedEvents.push(params);
    })
    .onRequest('session/request_permission', async () => ({ outcome: { outcome: 'cancelled' } }))
    .connect(webSocketStream(ws));
  await connection.agent.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { _meta: { '1agents': { version: 1 } } },
  });
  return { ws, connection, rpc: connection.agent, closedEvents, updates };
}

test('acp-service idle reclamation, pressure eviction, and background-task protection', { timeout: 45_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'acp-idle-reap-'));
  const capacityDirectory = join(directory, 'capacity');
  const settings: Record<string, string> = {
    ACP_STATE_DIR: directory,
    ACP_CAPACITY_DIRECTORY: capacityDirectory,
    ACP_CAPACITY_SOFT_LIMIT: '1',
    ACP_CAPACITY_HARD_LIMIT: '2',
    ACP_CAPACITY_MEMORY_RESERVE_MB: '0',
    ACP_CAPACITY_INSTANCE_MEMORY_MB: '0.0009765625',
    ACP_IDLE_SESSION_TTL_MS: '250',
    ACP_PRESSURE_EVICT_GRACE_MS: '50',
  };
  const previous = Object.fromEntries(
    [...Object.keys(settings), 'ACP_IDLE_JOB_TTL_MS', 'ACP_PRESSURE_EVICT_ENABLED'].map(key => [key, process.env[key]]),
  );
  Object.assign(process.env, settings);

  const bridge = await import('../src/bridge.js');
  const { attachAcpConnection, webSocketStream } = await import('../src/acp-connection.js');
  const options = Reflect.get(bridge.runtime, 'options');
  options.sessionStore = createRuntimeStore({ stateDir: directory });
  options.agentRegistry = createAgentRegistry({
    overrides: {
      codex: [process.execPath, fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))],
    },
  });
  const governor = new CapacityGovernor({
    directory: capacityDirectory,
    softLimit: 1,
    hardLimit: 2,
    memoryReserveBytes: 0,
    estimatedInstanceBytes: 1024,
    memoryProvider: () => ({ totalBytes: 1024 ** 3, availableBytes: 1024 ** 3 }),
  });
  const state = new AcpState(join(directory, 'acp-state.json'));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => wss.once('listening', resolve));
  const address = wss.address();
  assert.ok(address && typeof address !== 'string');
  wss.on('connection', (ws, req) => attachAcpConnection(ws, req, undefined, state));

  t.after(async () => {
    await bridge.killAllManagedAgents();
    for (const sock of wss.clients) sock.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  await t.test('automatically reclaims idle session processes, releases capacity leases, and allows seamless session/load resume', async () => {
    process.env.ACP_IDLE_SESSION_TTL_MS = '250';
    delete process.env.ACP_IDLE_JOB_TTL_MS;

    const first = await openAcpClient(address.port, webSocketStream);
    const created = await first.rpc.request('session/new', { cwd: directory, mcpServers: [] }) as { sessionId: string };
    const sessionId = created.sessionId;
    assert.equal(bridge.activeSessions.has(sessionId), true);
    assert.equal((await governor.snapshot('process')).used, 1);

    const firstPrompt = await first.rpc.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hello before idle' }],
    });
    assert.equal(firstPrompt.stopReason, 'end_turn');

    await waitUntil(() => !bridge.activeSessions.has(sessionId), 5000, 'Idle session was not reclaimed');
    await waitUntil(async () => (await governor.snapshot('process')).used === 0, 5000, 'Process capacity lease was not released');
    await waitUntil(() => first.closedEvents.some(e => e.sessionId === sessionId && e.reason === 'idle_timeout'), 5000, 'Client did not receive idle_timeout session_closed event');
    await waitUntil(() => first.ws.readyState === WebSocket.CLOSED, 5000, 'Idle WebSocket was not closed after releasing last session');

    const second = await openAcpClient(address.port, webSocketStream);
    await second.rpc.request('session/load', { sessionId, cwd: directory, mcpServers: [] });
    assert.equal(bridge.activeSessions.has(sessionId), true);
    const resumedPrompt = await second.rpc.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hello after resume' }],
    });
    assert.equal(resumedPrompt.stopReason, 'end_turn');
    assert.equal((await governor.snapshot('process')).used, 1);
    second.ws.close();
    await bridge.killAllManagedAgents();
    await waitUntil(async () => (await governor.snapshot('process')).used === 0, 5000);
  });

  await t.test('evicts eligible idle session on demand when capacity is full so new user and A2A sessions do not block, and evicted session resumes via session/load', async () => {
    process.env.ACP_IDLE_SESSION_TTL_MS = '60000';
    process.env.ACP_IDLE_JOB_TTL_MS = '60000';
    process.env.ACP_PRESSURE_EVICT_GRACE_MS = '40';

    // 1. User session A occupies the only slot (softLimit=1) and completes a turn.
    const clientA = await openAcpClient(address.port, webSocketStream);
    const sessionA = (await clientA.rpc.request('session/new', {
      cwd: directory,
      mcpServers: [],
      _meta: { '1agents': { capacityId: 'user-session-a' } },
    }) as { sessionId: string }).sessionId;
    const turnA = await clientA.rpc.request('session/prompt', {
      sessionId: sessionA,
      prompt: [{ type: 'text', text: 'turn A' }],
    });
    assert.equal(turnA.stopReason, 'end_turn');
    await delay(70);

    // 2. User session B arrives while TTL (60s) has not expired; pressure eviction immediately reclaims A.
    const clientB = await openAcpClient(address.port, webSocketStream);
    const sessionB = (await clientB.rpc.request('session/new', {
      cwd: directory,
      mcpServers: [],
      _meta: { '1agents': { capacityId: 'user-session-b' } },
    }) as { sessionId: string }).sessionId;
    assert.equal(bridge.activeSessions.has(sessionB), true);
    assert.equal(bridge.activeSessions.has(sessionA), false);
    await waitUntil(() => clientA.closedEvents.some(e => e.sessionId === sessionA && e.reason === 'capacity_evicted'), 3000);
    await waitUntil(() => clientA.ws.readyState === WebSocket.CLOSED, 3000);

    // 3. After grace window, an A2A job session C arrives; pressure eviction reclaims B instead of returning CAPACITY_PENDING.
    await delay(70);
    const clientC = await openAcpClient(address.port, webSocketStream);
    const sessionC = (await clientC.rpc.request('session/new', {
      cwd: directory,
      mcpServers: [],
      _meta: { '1agents': { capacityId: 'a2a-job-c' } },
    }) as { sessionId: string }).sessionId;
    assert.equal(bridge.activeSessions.has(sessionC), true);
    assert.equal(bridge.activeSessions.has(sessionB), false);
    assert.equal(bridge.activeSessions.get(sessionC)?.origin, 'job');
    await waitUntil(() => clientB.closedEvents.some(e => e.sessionId === sessionB && e.reason === 'capacity_evicted'), 3000);

    // 4. Evicted session A seamlessly resumes via session/load (evicting now-idle C).
    await delay(70);
    const clientA2 = await openAcpClient(address.port, webSocketStream);
    await clientA2.rpc.request('session/load', {
      sessionId: sessionA,
      cwd: directory,
      mcpServers: [],
      _meta: { '1agents': { capacityId: 'user-session-a-resume' } },
    });
    assert.equal(bridge.activeSessions.has(sessionA), true);
    const turnA2 = await clientA2.rpc.request('session/prompt', {
      sessionId: sessionA,
      prompt: [{ type: 'text', text: 'turn A resumed' }],
    });
    assert.equal(turnA2.stopReason, 'end_turn');

    clientC.ws.close();
    clientA2.ws.close();
    await bridge.killAllManagedAgents();
    await waitUntil(async () => (await governor.snapshot('process')).used === 0, 5000);
  });

  await t.test('prioritizes disconnected -> job -> user-opened (LRU within tier) and protects running background tasks', async () => {
    process.env.ACP_IDLE_SESSION_TTL_MS = '60000';
    process.env.ACP_IDLE_JOB_TTL_MS = '50';
    process.env.ACP_PRESSURE_EVICT_GRACE_MS = '0';

    const originalClose = bridge.runtime.close;
    const evictedOrder: string[] = [];
    const lease = await governor.acquire({ kind: 'process', source: 'automatic', id: 'occupied-pressure-test' });
    Reflect.set(bridge.runtime, 'close', async ({ handle }: { handle: { sessionKey: string } }) => {
      evictedOrder.push(handle.sessionKey);
    });

    const events: Array<Record<string, unknown>> = [];
    const openWs = { readyState: 1, send(raw: string) { events.push(JSON.parse(raw)); } };
    const closedWs = { readyState: 3, send(raw: string) { events.push(JSON.parse(raw)); } };
    const now = Date.now();

    try {
      // 1. Tiered idle TTL: job expires at 50ms while user-opened stays warm (60s).
      bridge.activeSessions.set('job-ttl', {
        handle: { sessionKey: 'job-ttl' }, activeTurn: null, promptQueue: [], ws: openWs, origin: 'job', lastActivityAt: now - 200,
      });
      bridge.activeSessions.set('user-warm', {
        handle: { sessionKey: 'user-warm' }, activeTurn: null, promptQueue: [], ws: openWs, origin: 'user-opened', lastActivityAt: now - 5_000,
      });
      bridge.activeSessions.set('job-bg-running', {
        handle: { sessionKey: 'job-bg-running' }, activeTurn: null, promptQueue: [], ws: openWs, origin: 'job', lastActivityAt: now - 10_000,
      });
      bridge.sessionBackgroundTasks.set('job-bg-running', [{ id: 'bg-1', status: 'running' }]);

      const ttlReaped = await bridge.reapIdleSessions();
      assert.deepEqual(ttlReaped, ['job-ttl']);
      assert.equal(bridge.activeSessions.has('user-warm'), true);
      assert.equal(bridge.activeSessions.has('job-bg-running'), true);

      // 2. Pressure eviction order: disconnected WS -> job -> user-opened; running background task is NEVER evicted.
      evictedOrder.length = 0;
      events.length = 0;
      bridge.activeSessions.set('orphan-ws', {
        handle: { sessionKey: 'orphan-ws' }, activeTurn: null, promptQueue: [], ws: closedWs, origin: 'user-opened', lastActivityAt: now - 1_000,
      });
      bridge.activeSessions.set('job-newer', {
        handle: { sessionKey: 'job-newer' }, activeTurn: null, promptQueue: [], ws: openWs, origin: 'job', lastActivityAt: now - 2_000,
      });
      // user-warm is idle 5_000ms (older than both orphan-ws and job-newer), yet should be evicted LAST.

      const evicted = await bridge.evictIdleSessionsForCapacity();
      assert.deepEqual(evicted, ['orphan-ws', 'job-newer', 'user-warm']);
      assert.deepEqual(evictedOrder, ['orphan-ws', 'job-newer', 'user-warm']);
      assert.equal(bridge.activeSessions.has('job-bg-running'), true);
      assert.deepEqual(events, [
        { event: 'session_closed', sessionId: 'job-newer', reason: 'capacity_evicted' },
        { event: 'session_closed', sessionId: 'user-warm', reason: 'capacity_evicted' },
      ]);

      // 3. Once the background task completes, the session immediately becomes reclaimable.
      bridge.sessionBackgroundTasks.set('job-bg-running', [{ id: 'bg-1', status: 'completed' }]);
      const afterComplete = await bridge.reapIdleSessions();
      assert.deepEqual(afterComplete, ['job-bg-running']);
      assert.equal(bridge.activeSessions.has('job-bg-running'), false);
    } finally {
      Reflect.set(bridge.runtime, 'close', originalClose);
      for (const id of ['job-ttl', 'user-warm', 'job-bg-running', 'orphan-ws', 'job-newer']) {
        bridge.activeSessions.delete(id);
        bridge.sessionBackgroundTasks.delete(id);
      }
      await lease.release();
    }
  });

  await t.test('skips sessions with an active turn or pending interactive request', async () => {
    process.env.ACP_IDLE_SESSION_TTL_MS = '50';
    delete process.env.ACP_IDLE_JOB_TTL_MS;
    const originalClose = bridge.runtime.close;
    const closed: unknown[] = [];
    Reflect.set(bridge.runtime, 'close', async ({ handle }: { handle: unknown }) => { closed.push(handle); });
    const staleTime = Date.now() - 10_000;
    const events: Array<Record<string, unknown>> = [];
    const ws = { readyState: 1, send(raw: string) { events.push(JSON.parse(raw)); } };

    try {
      bridge.activeSessions.set('busy-turn', {
        handle: { sessionKey: 'busy-turn' }, activeTurn: { hostTurnId: 't1' }, promptQueue: [], ws, lastActivityAt: staleTime,
      });
      bridge.activeSessions.set('pending-perm', {
        handle: { sessionKey: 'pending-perm' }, activeTurn: null, promptQueue: [], ws, lastActivityAt: staleTime,
      });
      bridge.pendingPermissions.set('perm-guard', { sessionId: 'pending-perm' });
      bridge.activeSessions.set('truly-idle', {
        handle: { sessionKey: 'truly-idle' }, activeTurn: null, promptQueue: [], ws, lastActivityAt: staleTime,
      });

      const reaped = await bridge.reapIdleSessions();
      assert.deepEqual(reaped, ['truly-idle']);
      assert.equal(bridge.activeSessions.has('busy-turn'), true);
      assert.equal(bridge.activeSessions.has('pending-perm'), true);
      assert.equal(bridge.activeSessions.has('truly-idle'), false);
      assert.equal(closed.length, 1);
      assert.deepEqual(events, [{ event: 'session_closed', sessionId: 'truly-idle', reason: 'idle_timeout' }]);
    } finally {
      Reflect.set(bridge.runtime, 'close', originalClose);
      bridge.activeSessions.delete('busy-turn');
      bridge.activeSessions.delete('pending-perm');
      bridge.activeSessions.delete('truly-idle');
      bridge.pendingPermissions.delete('perm-guard');
    }
  });
});
