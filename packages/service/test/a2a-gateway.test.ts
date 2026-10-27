import { testCapacity } from './capacity-fixture.js';
import { CapacityGovernor, type CapacityOptions } from '../src/capacity.js';
import { CapacityQueue } from '../src/capacity-queue.js';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createA2AServer } from '../src/a2a/server.js';
import { RemoteAgentError, RemoteAgentGateway, retryCallbackBind, serveA2AGateway } from '../src/a2a/gateway.js';
import { classifyColdAttach, normalizeLifecycle, oneShotShouldClose } from '../src/a2a/session-lifecycle.js';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';

class Backend implements A2ABackend {
  readonly runs: Array<{ target: A2ATarget; prompt: string; signal: AbortSignal; finish: (result: A2ARunResult) => void }> = [];
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
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
class ReattachBackend implements A2ABackend {
  readonly prepares: A2APrepareInput[] = [];
  readonly runs: string[] = [];
  activeTurn = false;
  fail: 'deleted' | 'conflict' | undefined;
  hangCapacity = false;
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    this.prepares.push(input);
    if (input.sessionId && this.fail === 'deleted') {
      const error = new Error('Session was deleted') as Error & { code: string };
      error.code = 'SESSION_DELETED';
      throw error;
    }
    if (input.sessionId && this.fail === 'conflict') {
      const error = new Error('Existing session cwd conflicts') as Error & { code: string };
      error.code = 'SESSION_CONFLICT';
      throw error;
    }
    return {
      sessionId: input.sessionId ?? 'dsh-kept', cwd: input.cwd!, agentPreset: input.agentPreset,
      ...(input.sessionId ? { resumed: true, restoreMethod: 'session/load' as const } : {}),
    };
  }
  async run(_target: A2ATarget, prompt: string, options: { signal: AbortSignal; onCapacity?: (pending: { code: 'CAPACITY_PENDING'; position: number; waitedMs: number } | undefined) => void }): Promise<A2ARunResult> {
    this.runs.push(prompt);
    if (this.hangCapacity) {
      options.onCapacity?.({ code: 'CAPACITY_PENDING', position: 1, waitedMs: 70_000 });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    this.activeTurn = true;
    return { outcome: 'completed', text: prompt };
  }
  async close() { this.activeTurn = false; return { processReleased: 'pending' as const, acp: true }; }
  async status() {
    return { attached: true, activeTurn: this.activeTurn, lastUsedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() };
  }
}
class PendingCapacityBackend implements A2ABackend {
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    return { sessionId: input.sessionId ?? 'pending-session', cwd: input.cwd!, agentPreset: input.agentPreset };
  }
  async run(_target: A2ATarget, _prompt: string, options: { signal: AbortSignal; onCapacity?: (pending: { code: 'CAPACITY_PENDING'; position: number; waitedMs: number } | undefined) => void }): Promise<A2ARunResult> {
    options.onCapacity?.({ code: 'CAPACITY_PENDING', position: 2, waitedMs: 70_000 });
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  }
}
class ClosingBackend implements A2ABackend {
  readonly runs: Array<{ target: A2ATarget; prompt: string; signal: AbortSignal; finish: (result: A2ARunResult) => void }> = [];
  readonly closes: A2ATarget[] = [];
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
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
  async close(target: A2ATarget) {
    this.closes.push(target);
    if (!target.agentPreset?.startsWith('oneagents-acp-')) return { processReleased: true as const, acp: false };
    return { processReleased: 'pending' as const, acp: true };
  }
  async status(): Promise<{ attached: boolean; activeTurn: boolean }> {
    return { attached: true, activeTurn: false };
  }
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function stop(server: Server): Promise<void> {
  const done = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections(); await done;
}
async function until<T>(operation: () => Promise<T>, predicate: (result: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await operation(); if (predicate(result)) return result;
    if (Date.now() > deadline) throw new Error('Test condition deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture<T extends A2ABackend = Backend>(t: TestContext, backend: T = new Backend() as unknown as T, capacityOptions: Partial<CapacityOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'a2a-gateway-'));
  const capacity = { ...testCapacity(root), ...capacityOptions };
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') host.cardHandler(req, res);
    else void host.handler(req, res);
  });
  const url = await listen(server);
  host = await createA2AServer({ backend, capacity, publicUrl: url, stateDirectory: join(root, 'host'), token: 'remote-test-token', defaultAgentPreset: 'coding' });
  const config = { stateDirectory: join(root, 'client'), port: 0, remotes: { wsl: { url, token: 'remote-test-token' } }, pollIntervalMs: 50, capacityDirectory: capacity.directory };
  const gateways = new Set<RemoteAgentGateway>();
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    await host.close(); await stop(server); await rm(root, { recursive: true, force: true });
  });
  return { root, backend, capacity, config, server, gateways, gateway: (input: ConstructorParameters<typeof RemoteAgentGateway>[0] = config) => {
    const gateway = new RemoteAgentGateway(input); gateways.add(gateway); return gateway;
  } };
}
const spawn = { remote: 'wsl', originSessionId: 'parent-a', cwd: '/home/scott/project', prompt: 'read pwd', agentPreset: 'coding' };

test('spawn returns before execution; detached completion reconciles after gateway restart and inbox is scoped and durable', async t => {
  const f = await fixture(t);
  const gateway = f.gateway();
  t.after(() => gateway.close());
  const first = await gateway.invoke('remote_agent_spawn', spawn) as any;
  assert.ok(first.taskId); assert.equal(first.cwd, spawn.cwd); assert.ok(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(first.state));
  const second = await gateway.invoke('remote_agent_spawn', spawn) as any;
  assert.notEqual(first.contextId, second.contextId); assert.notEqual(first.sessionId, second.sessionId);
  assert.throws(() => new RemoteAgentGateway(f.config), /already in use/);
  await until(async () => f.backend.runs.length, value => value === 2);
  await gateway.close();
  assert.equal(f.backend.runs[0]!.signal.aborted, false);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: '/home/scott/project' });
  const restored = f.gateway(); t.after(() => restored.close());
  const final = await until(() => restored.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-a', taskId: first.taskId }) as Promise<any>, value => value.state === 'TASK_STATE_COMPLETED');
  assert.equal(final.result, '/home/scott/project');
  await assert.rejects(restored.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-b', taskId: first.taskId }), /not found/);
  assert.deepEqual(await restored.invoke('remote_agent_inbox', { originSessionId: 'parent-b' }), { notices: [] });
  const inbox = await restored.invoke('remote_agent_inbox', { originSessionId: 'parent-a' }) as any;
  assert.equal(inbox.notices.length, 1); assert.equal(inbox.notices[0].taskId, first.taskId);
  await restored.receivePush({ statusUpdate: { taskId: first.taskId, status: { state: 'TASK_STATE_FAILED' } } });
  assert.deepEqual(await restored.invoke('remote_agent_inbox', { originSessionId: 'parent-a' }), inbox);
  await restored.invoke('remote_agent_ack', { originSessionId: 'parent-a', noticeId: inbox.notices[0].noticeId });
  await restored.close();
  const again = f.gateway(); t.after(() => again.close());
  assert.deepEqual(await again.invoke('remote_agent_inbox', { originSessionId: 'parent-a' }), { notices: [] });
});

test('follow-up reuses remote session, cancellation only aborts the requested task, and offline is stale', async t => {
  const f = await fixture(t), gateway = f.gateway(); t.after(() => gateway.close());
  await assert.rejects(gateway.invoke('remote_agent_spawn', { ...spawn, cwd: 'relative' }));
  const first = await gateway.invoke('remote_agent_spawn', spawn) as any;
  await until(async () => f.backend.runs.length, value => value === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'first result' });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-a', taskId: first.taskId }) as Promise<any>, value => value.state === 'TASK_STATE_COMPLETED');
  const follow = await gateway.invoke('remote_agent_message', { remote: 'wsl', originSessionId: 'parent-a', taskId: first.taskId, prompt: 'continue' }) as any;
  assert.equal(follow.contextId, first.contextId); assert.equal(follow.sessionId, first.sessionId); assert.notEqual(follow.taskId, first.taskId);
  const other = await gateway.invoke('remote_agent_spawn', spawn) as any;
  await until(async () => f.backend.runs.length, value => value === 3);
  const canceled = await gateway.invoke('remote_agent_cancel', { remote: 'wsl', originSessionId: 'parent-a', taskId: follow.taskId }) as any;
  assert.equal(canceled.state, 'TASK_STATE_CANCELED'); assert.equal(f.backend.runs[1]!.signal.aborted, true); assert.equal(f.backend.runs[2]!.signal.aborted, false);
  await gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-a', taskId: other.taskId });
  await stop(f.server);
  const offline = await gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-a', taskId: other.taskId }) as any;
  assert.equal(offline.stale, true); assert.equal(offline.state, 'TASK_STATE_WORKING');
});

test('completion delivery retries across restarts with a stable notice ID and origin routing', async t => {
  const f = await fixture(t); let ready = false;
  const received: any[] = [];
  const sink = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sink-token');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const notice = JSON.parse(raw); assert.equal(req.headers['idempotency-key'], notice.noticeId); received.push(notice);
    res.writeHead(ready ? 204 : 503); res.end();
  });
  const sinkUrl = await listen(sink); t.after(() => stop(sink));
  const config = { ...f.config, notificationTargets: { phone: { url: sinkUrl, token: 'sink-token' } } };
  let gateway = f.gateway(config); t.after(() => gateway.close());
  await assert.rejects(gateway.invoke('remote_agent_spawn', { ...spawn, notificationTarget: 'unknown' }), /Unknown notificationTarget/);
  const task = await gateway.invoke('remote_agent_spawn', { ...spawn, notificationTarget: 'phone' }) as any;
  await until(async () => f.backend.runs.length, value => value === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'delivery result' });
  await until(async () => { await gateway.reconcile(); return received.length; }, value => value > 0);
  await gateway.close(); ready = true; gateway = f.gateway(config);
  await until(async () => { await gateway.reconcile(); return received.length; }, value => value > 1);
  assert.equal(received[0].noticeId, received.at(-1).noticeId); assert.equal(received.at(-1).originSessionId, spawn.originSessionId);
  assert.equal(received.at(-1).taskId, task.taskId); assert.equal(received.at(-1).result, 'delivery result');
  const deliveredCount = received.length; await gateway.reconcile(); assert.equal(received.length, deliveredCount);
});

test('local HTTP tools reject browser calls; authenticated callback listener exposes no invocation route', async t => {
  const f = await fixture(t);
  const host = await serveA2AGateway({ ...f.config, callback: { host: '127.0.0.1', port: 0, url: 'http://127.0.0.1:1/events', token: 'callback-test-token' } }, { report: false });
  f.gateways.add(host.gateway);
  t.after(() => host.close());
  const url = `http://127.0.0.1:${host.port}`;
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal((await fetch(url + '/invoke', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const response = await fetch(url + '/invoke', { method: 'POST', body: JSON.stringify({ method: 'remote_agent_inbox', params: { originSessionId: 'parent-a' } }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { notices: [] });
  assert.equal((await fetch(url + '/events', { method: 'POST', body: '{}' })).status, 404);
  const callback = `http://127.0.0.1:${host.callbackPort}`;
  assert.equal((await fetch(callback + '/events', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(callback + '/invoke', { method: 'POST', headers: { Authorization: 'Bearer callback-test-token' }, body: '{}' })).status, 404);
  assert.equal((await fetch(callback + '/events', { method: 'POST', headers: { Authorization: 'Bearer callback-test-token' }, body: JSON.stringify({ statusUpdate: { taskId: 'unknown-task' } }) })).status, 202);
});

test('callback bind retries a missing address and does not retry a busy port', async () => {
  let calls = 0;
  const pending: string[] = [];
  const signal = new AbortController();
  await retryCallbackBind({
    bind: async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error('bind') as NodeJS.ErrnoException;
        error.code = 'EADDRNOTAVAIL';
        throw error;
      }
    },
    signal: signal.signal,
    onPending: (_error, at) => pending.push(at),
    sleep: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(pending.length, 2);
  assert.ok(pending.every(at => Number.isFinite(Date.parse(at))));
  const busy = new Error('busy') as NodeJS.ErrnoException;
  busy.code = 'EADDRINUSE';
  await assert.rejects(retryCallbackBind({
    bind: async () => { throw busy; },
    signal: signal.signal,
    onPending: () => { throw new Error('EADDRINUSE entered retry'); },
    sleep: async () => { throw new Error('EADDRINUSE entered retry'); },
  }), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
});

test('an unavailable callback address leaves local health and invoke up', async t => {
  const f = await fixture(t);
  const host = await serveA2AGateway({ ...f.config, callback: {
    host: '192.0.2.1', port: 36815, url: 'http://192.0.2.1:36815/events', token: 'callback-test-token',
  } }, { report: false });
  f.gateways.add(host.gateway);
  t.after(() => host.close());
  const health = await (await fetch(`http://127.0.0.1:${host.port}/health`)).json() as { status: string; callback?: string; taskSlot?: { used: number }; processSlot?: { used: number; headWaitMs: number } };
  assert.equal(health.status, 'ok');
  assert.equal(health.callback, 'pending');
  assert.equal(health.taskSlot?.used, 0);
  assert.equal(health.processSlot?.used, 0);
  assert.equal(health.processSlot?.headWaitMs, 0);
  assert.equal(host.callbackPort, undefined);
  const invoke = await fetch(`http://127.0.0.1:${host.port}/invoke`, { method: 'POST',
    body: JSON.stringify({ method: 'remote_agent_inbox', params: { originSessionId: 'parent-a' } }) });
  assert.equal(invoke.status, 200);
  const taken = createServer((_req, res) => { res.end(); });
  await new Promise<void>(resolve => taken.listen(0, '127.0.0.1', resolve));
  const address = taken.address();
  assert.ok(address && typeof address !== 'string');
  t.after(() => stop(taken));
  await assert.rejects(() => serveA2AGateway({
    ...f.config, port: 0, stateDirectory: join(f.root, 'busy-callback'),
    callback: { host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}/events`, token: 'callback-test-token' },
  }, { report: false }), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('one-shot closes after complete, failure, or cancel and leaves other work open', { timeout: 40_000 }, async t => {
  assert.equal(oneShotShouldClose(normalizeLifecycle({ mode: 'one-shot' }), 'TASK_STATE_REJECTED', true), false);
  assert.equal(oneShotShouldClose(normalizeLifecycle({ mode: 'one-shot' }), 'TASK_STATE_INPUT_REQUIRED', true), false);
  assert.equal(oneShotShouldClose(normalizeLifecycle({ mode: 'one-shot', closeAfter: 'ack' }), 'TASK_STATE_COMPLETED', false), false);
  const backend = new ClosingBackend();
  const f = await fixture(t, backend);
  const gateway = f.gateway();
  t.after(() => gateway.close());
  const locate = { remote: 'wsl', originSessionId: 'parent-close' };
  const read = (taskId: string) => gateway.invoke('remote_agent_get', { ...locate, taskId }) as Promise<Record<string, unknown>>;

  const acp = await gateway.invoke('remote_agent_spawn', { ...spawn, ...locate, agentPreset: 'oneagents-acp-codex', lifecycle: { mode: 'one-shot' } }) as Record<string, unknown>;
  await until(async () => backend.runs.length, value => value === 1);
  backend.runs[0]!.finish({ outcome: 'completed', text: 'acp done' });
  const closed = await until(() => read(String(acp.taskId)), value => value.state === 'TASK_STATE_COMPLETED' && value.sessionState === 'closing');
  assert.equal(closed.processReleased, 'pending');
  assert.equal(closed.lifecycle && (closed.lifecycle as { mode: string }).mode, 'one-shot');
  assert.equal(backend.closes.length, 1);
  assert.equal(backend.closes[0]!.agentPreset, 'oneagents-acp-codex');
  const repeat = await gateway.invoke('remote_agent_close', { ...locate, taskId: acp.taskId }) as Record<string, unknown>;
  assert.equal(repeat.alreadyClosed, true);
  assert.equal(repeat.acp, true);
  assert.equal(repeat.processReleased, 'pending');
  assert.equal(backend.closes.length, 1);

  const asking = await gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId: 'parent-close-input', agentPreset: 'oneagents-acp-codex', lifecycle: { mode: 'one-shot' } }) as Record<string, unknown>;
  await until(async () => backend.runs.length, value => value === 2);
  backend.runs[1]!.finish({ outcome: 'input-required', text: 'need a path' });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-close-input', taskId: asking.taskId }) as Promise<Record<string, unknown>>, value => value.state === 'TASK_STATE_INPUT_REQUIRED');
  await pause(200);
  assert.equal(backend.closes.length, 1);

  const kept = await gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId: 'parent-close-keep', agentPreset: 'oneagents-acp-codex' }) as Record<string, unknown>;
  await until(async () => backend.runs.length, value => value === 3);
  backend.runs[2]!.finish({ outcome: 'completed', text: 'stay open' });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-close-keep', taskId: kept.taskId }) as Promise<Record<string, unknown>>, value => value.state === 'TASK_STATE_COMPLETED');
  await pause(200);
  assert.equal(backend.closes.length, 1);
  const keptView = await gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-close-keep', taskId: kept.taskId }) as Record<string, unknown>;
  assert.equal(keptView.sessionState, undefined);

  const standard = await gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId: 'parent-close-standard', agentPreset: 'standard', lifecycle: { mode: 'one-shot' } }) as Record<string, unknown>;
  await until(async () => backend.runs.length, value => value === 4);
  backend.runs[3]!.finish({ outcome: 'failed', text: 'standard failed' });
  const standardView = await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-close-standard', taskId: standard.taskId }) as Promise<Record<string, unknown>>, value => value.state === 'TASK_STATE_FAILED' && value.sessionState === 'closed');
  assert.equal(standardView.processReleased, true);
  const standardClose = await gateway.invoke('remote_agent_close', { remote: 'wsl', originSessionId: 'parent-close-standard', contextId: standard.contextId }) as Record<string, unknown>;
  assert.equal(standardClose.alreadyClosed, true);
  assert.equal(standardClose.acp, false);
  assert.equal(backend.closes.length, 2);

  const acknowledged = await gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId: 'parent-close-ack', agentPreset: 'standard', lifecycle: { mode: 'one-shot', closeAfter: 'ack' } }) as Record<string, unknown>;
  await until(async () => backend.runs.length, value => value === 5);
  backend.runs[4]!.finish({ outcome: 'completed', text: 'wait for ack' });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-close-ack', taskId: acknowledged.taskId }) as Promise<Record<string, unknown>>, value => value.state === 'TASK_STATE_COMPLETED');
  await pause(200);
  assert.equal(backend.closes.length, 2);
  const inbox = await gateway.invoke('remote_agent_inbox', { originSessionId: 'parent-close-ack' }) as { notices: Array<{ noticeId: string; taskId: string }> };
  const notice = inbox.notices.find(item => item.taskId === acknowledged.taskId);
  assert.ok(notice);
  await gateway.invoke('remote_agent_ack', { originSessionId: 'parent-close-ack', noticeId: notice.noticeId });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-close-ack', taskId: acknowledged.taskId }) as Promise<Record<string, unknown>>, value => value.sessionState === 'closed');
  assert.equal(backend.closes.length, 3);

  const canceled = await gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId: 'parent-close-cancel', agentPreset: 'standard', lifecycle: { mode: 'one-shot' } }) as Record<string, unknown>;
  await until(async () => backend.runs.length, value => value === 6);
  await gateway.invoke('remote_agent_cancel', { remote: 'wsl', originSessionId: 'parent-close-cancel', taskId: canceled.taskId });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-close-cancel', taskId: canceled.taskId }) as Promise<Record<string, unknown>>, value => value.state === 'TASK_STATE_CANCELED' && value.sessionState === 'closed');
  assert.equal(backend.runs[5]!.signal.aborted, true);
  assert.equal(backend.closes.length, 4);

  const busy = await gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId: 'parent-close-busy', agentPreset: 'standard' }) as Record<string, unknown>;
  await until(async () => backend.runs.length, value => value === 7);
  const busyView = await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-close-busy', taskId: busy.taskId }) as Promise<Record<string, unknown>>, value => value.state === 'TASK_STATE_WORKING' && typeof value.sessionId === 'string');
  await assert.rejects(() => gateway.invoke('remote_agent_close', { remote: 'wsl', originSessionId: 'parent-close-busy', sessionId: busyView.sessionId }), (error: unknown) => error instanceof RemoteAgentError && error.code === 'SESSION_BUSY');
  assert.equal(backend.closes.length, 4);
  const forced = await gateway.invoke('remote_agent_close', { remote: 'wsl', originSessionId: 'parent-close-busy', taskId: busy.taskId, force: true }) as Record<string, unknown>;
  assert.equal(forced.acp, false);
  assert.equal(forced.processReleased, true);
  assert.deepEqual(forced.canceledTaskIds, [busy.taskId]);
  assert.equal(backend.runs[6]!.signal.aborted, true);
  assert.ok(backend.closes.length >= 5);
  const forcedView = await gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-close-busy', taskId: busy.taskId }) as Record<string, unknown>;
  assert.equal(forcedView.sessionState, 'closed');

  await assert.rejects(() => gateway.invoke('remote_agent_close', { remote: 'wsl', originSessionId: 'parent-other', taskId: acp.taskId }), (error: unknown) => {
    assert.ok(error instanceof RemoteAgentError);
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    assert.match(error.message, /not found/);
    return true;
  });
  await assert.rejects(() => gateway.invoke('remote_agent_close', { ...locate, taskId: acp.taskId, contextId: acp.contextId }), (error: unknown) => error instanceof RemoteAgentError && error.code === 'SESSION_CONFLICT');
});

test('a host without close stays open and reports UNSUPPORTED', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const gateway = f.gateway();
  t.after(() => gateway.close());
  const task = await gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId: 'parent-unsupported', lifecycle: { mode: 'one-shot' } }) as Record<string, unknown>;
  await until(async () => f.backend.runs.length, value => value === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'no close' });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-unsupported', taskId: task.taskId }) as Promise<Record<string, unknown>>, value => value.state === 'TASK_STATE_COMPLETED');
  await pause(300);
  const view = await gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-unsupported', taskId: task.taskId }) as Record<string, unknown>;
  assert.equal(view.sessionState, undefined);
  await assert.rejects(() => gateway.invoke('remote_agent_close', { remote: 'wsl', originSessionId: 'parent-unsupported', taskId: task.taskId }), (error: unknown) => error instanceof RemoteAgentError && error.code === 'UNSUPPORTED');
  const after = await gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-unsupported', taskId: task.taskId }) as Record<string, unknown>;
  assert.equal(after.sessionState, undefined);
  assert.equal(after.processReleased, undefined);
});

test('a full process ledger stays pending while the task ledger still has room', async t => {
  const backend = new PendingCapacityBackend();
  const f = await fixture(t, backend, { softLimit: 3, hardLimit: 4 });
  const governor = new CapacityGovernor(f.capacity);
  const queue = new CapacityQueue(f.capacity);
  await governor.acquire({ kind: 'process', source: 'automatic', id: 'job-1', origin: 'job' });
  await governor.acquire({ kind: 'process', source: 'automatic', id: 'warm-1', origin: 'prewarm' });
  await governor.acquire({ kind: 'process', source: 'automatic', id: 'old-1' });
  const waiting = await queue.tryAdmit({ kind: 'process', source: 'automatic', id: 'waiting' });
  assert.equal('pending' in waiting && waiting.pending, true);
  const directory = f.capacity.directory;
  if (!directory) throw new Error('capacity directory missing');
  const names = readdirSync(join(directory, 'queue')).filter(name => name.startsWith('entry-'));
  if (names.length !== 1 || !names[0]) throw new Error('process queue entry missing');
  const path = join(directory, 'queue', names[0]);
  const record = JSON.parse(readFileSync(path, 'utf8')) as { enqueuedAt: number };
  record.enqueuedAt = Date.now() - 61_000;
  writeFileSync(path, JSON.stringify(record));
  const host = await serveA2AGateway(f.config, { report: false });
  f.gateways.add(host.gateway);
  t.after(() => host.close());
  const task = await host.gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId: 'parent-slots', agentPreset: 'oneagents-acp-codex' }) as Record<string, unknown>;
  const view = await until(() => host.gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-slots', taskId: task.taskId }) as Promise<Record<string, any>>, value => {
    const taskSlot = value.taskSlot as { used?: number; limit?: number } | undefined;
    const processSlot = value.processSlot as { used?: number; limit?: number; headWaitMs?: number } | undefined;
    return value.state === 'TASK_STATE_SUBMITTED' && value.capacity?.code === 'CAPACITY_PENDING'
      && typeof taskSlot?.used === 'number' && typeof taskSlot.limit === 'number' && taskSlot.used < taskSlot.limit
      && typeof processSlot?.used === 'number' && typeof processSlot.limit === 'number' && processSlot.used >= processSlot.limit;
  });
  assert.equal(view.capacity.position, 2);
  assert.equal(view.capacity.waitedMs, 70_000);
  assert.equal(view.taskSlot.used, 1);
  assert.equal(view.processSlot.used, 3);
  assert.ok(view.processSlot.headWaitMs >= 60_000);
  const sessions = await host.gateway.invoke('remote_agent_sessions', {}) as { sessions: Record<string, Array<{ id: string }>>; processSlot: { used: number } };
  const ids = (origin: string) => sessions.sessions[origin]!.map(item => item.id).sort();
  assert.deepEqual(ids('job'), ['job-1']);
  assert.deepEqual(ids('prewarm'), ['warm-1']);
  assert.deepEqual(ids('user-opened'), []);
  assert.deepEqual(ids('unlabeled'), ['old-1']);
  const again = await host.gateway.invoke('remote_agent_sessions', {}) as { sessions: Record<string, Array<{ id: string }>>; processSlot: { used: number } };
  assert.deepEqual(again.sessions.unlabeled!.map(item => item.id), ['old-1']);
  assert.equal(again.processSlot.used, 3);
  const health = await (await fetch(`http://127.0.0.1:${host.port}/health`)).json() as { status: string; taskSlot: { used: number; limit: number }; processSlot: { used: number; limit: number; headWaitMs: number } };
  assert.equal(health.status, 'ok');
  assert.equal(health.taskSlot.used, 1);
  assert.ok(health.taskSlot.used < health.taskSlot.limit);
  assert.equal(health.processSlot.used, 3);
  assert.ok(health.processSlot.used >= health.processSlot.limit);
  assert.ok(health.processSlot.headWaitMs >= 60_000);
});

test('health omits slot counts when no capacity directory is configured', async t => {
  const f = await fixture(t);
  const { capacityDirectory: _omit, ...config } = f.config;
  const host = await serveA2AGateway(config, { report: false });
  f.gateways.add(host.gateway);
  t.after(() => host.close());
  const health = await (await fetch(`http://127.0.0.1:${host.port}/health`)).json() as { status: string; taskSlot?: unknown; processSlot?: unknown };
  assert.equal(health.status, 'ok');
  assert.equal(health.taskSlot, undefined);
  assert.equal(health.processSlot, undefined);
  await assert.rejects(() => host.gateway.invoke('remote_agent_sessions', {}), /ACP capacity directory is not configured/);
});

async function finishedTask(gateway: RemoteAgentGateway, backend: ReattachBackend, originSessionId: string) {
  const task = await gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId, agentPreset: 'oneagents-acp-codex' }) as Record<string, unknown>;
  const view = await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId, taskId: task.taskId }) as Promise<Record<string, any>>, value => value.state === 'TASK_STATE_COMPLETED');
  assert.equal(view.sessionId, 'dsh-kept');
  assert.equal(backend.runs.length, 1);
  return task;
}

test('a closed session message reattaches the same session and a jumped idle clock still reaches the turn', async t => {
  const backend = new ReattachBackend();
  const f = await fixture(t, backend);
  const gateway = f.gateway();
  t.after(() => gateway.close());
  const originSessionId = 'parent-reattach';
  const first = await finishedTask(gateway, backend, originSessionId);
  await gateway.invoke('remote_agent_close', { remote: 'wsl', originSessionId, taskId: first.taskId });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId, taskId: first.taskId }) as Promise<Record<string, unknown>>, value => value.sessionState === 'closing' || value.sessionState === 'closed');
  const idle = await backend.status();
  assert.ok(Date.now() - Date.parse(idle.lastUsedAt!) >= 5 * 60 * 60 * 1000);
  const follow = await gateway.invoke('remote_agent_message', { remote: 'wsl', originSessionId, taskId: first.taskId, prompt: 'continue after idle' }) as Record<string, unknown>;
  const view = await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId, taskId: follow.taskId }) as Promise<Record<string, any>>, value => value.state === 'TASK_STATE_COMPLETED' && value.resumed === true);
  assert.equal(view.sessionId, 'dsh-kept');
  assert.equal(view.restoreMethod, 'session/load');
  assert.equal(backend.prepares[1]?.sessionId, 'dsh-kept');
  assert.equal(backend.runs.length, 2);
  assert.equal(classifyColdAttach({ enqueued: true, attach: 'done', turnStarted: true, activeTurn: false }), 'activeTurn');
});

test('autoResume false does not send a message to a closed session', async t => {
  const backend = new ReattachBackend();
  const f = await fixture(t, backend);
  const gateway = f.gateway();
  t.after(() => gateway.close());
  const originSessionId = 'parent-no-resume';
  const first = await finishedTask(gateway, backend, originSessionId);
  await gateway.invoke('remote_agent_close', { remote: 'wsl', originSessionId, taskId: first.taskId });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId, taskId: first.taskId }) as Promise<Record<string, unknown>>, value => value.sessionState === 'closing' || value.sessionState === 'closed');
  await assert.rejects(() => gateway.invoke('remote_agent_message', { remote: 'wsl', originSessionId, taskId: first.taskId, prompt: 'do not send', autoResume: false }), (error: unknown) => error instanceof RemoteAgentError && error.code === 'SESSION_CLOSED');
  assert.equal(backend.prepares.length, 1);
  assert.equal(backend.runs.length, 1);
});

test('a deleted or conflicting session is not replaced', async t => {
  for (const fail of ['deleted', 'conflict'] as const) {
    const backend = new ReattachBackend();
    const f = await fixture(t, backend);
    const gateway = f.gateway();
    t.after(() => gateway.close());
    const originSessionId = `parent-${fail}`;
    const first = await finishedTask(gateway, backend, originSessionId);
    backend.fail = fail;
    const follow = await gateway.invoke('remote_agent_message', { remote: 'wsl', originSessionId, taskId: first.taskId, prompt: 'again' }) as Record<string, unknown>;
    const view = await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId, taskId: follow.taskId }) as Promise<Record<string, any>>, value => value.state === 'TASK_STATE_FAILED');
    assert.equal(view.resultMetadata.validation.code, fail === 'deleted' ? 'SESSION_DELETED' : 'SESSION_CONFLICT');
    assert.equal(backend.runs.length, 1);
    assert.equal(classifyColdAttach({ enqueued: true, attach: 'failed', turnStarted: false, activeTurn: false }), 'attach-failed');
  }
});

test('a follow-up with a full process slot stays pending instead of failing the turn', async t => {
  const backend = new ReattachBackend();
  const f = await fixture(t, backend);
  const gateway = f.gateway();
  t.after(() => gateway.close());
  const originSessionId = 'parent-pending-message';
  const first = await finishedTask(gateway, backend, originSessionId);
  backend.hangCapacity = true;
  const follow = await gateway.invoke('remote_agent_message', { remote: 'wsl', originSessionId, taskId: first.taskId, prompt: 'wait for a process slot' }) as Record<string, unknown>;
  const view = await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId, taskId: follow.taskId }) as Promise<Record<string, any>>, value => value.state === 'TASK_STATE_SUBMITTED' && value.capacity?.code === 'CAPACITY_PENDING');
  assert.equal(view.capacity.position, 1);
  assert.equal(view.capacity.waitedMs, 70_000);
  assert.notEqual(view.state, 'TASK_STATE_FAILED');
  assert.equal(classifyColdAttach({ enqueued: true, attach: 'pending', turnStarted: false, activeTurn: false }), 'attach-hung');
});

class IdleBackend extends ClosingBackend {
  report: { attached: boolean; activeTurn: boolean } | 'unknown' = { attached: true, activeTurn: false };
  override async status(): Promise<{ attached: boolean; activeTurn: boolean }> {
    if (this.report === 'unknown') throw new Error('status unavailable');
    return this.report;
  }
}

test('persistent ACP sessions close after a confirmed idle TTL and stay open otherwise', { timeout: 40_000 }, async t => {
  const backend = new IdleBackend();
  const f = await fixture(t, backend);
  let offsetMs = 0;
  const gateway = new RemoteAgentGateway({ ...f.config, sessionLifecycle: { idleScanIntervalMs: 50 } }, { now: () => Date.now() + offsetMs });
  f.gateways.add(gateway);
  const finish = async (originSessionId: string, extra: Record<string, unknown> = {}, outcome: A2ARunResult = { outcome: 'completed', text: 'done' }) => {
    const count = backend.runs.length;
    const task = await gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId, agentPreset: 'oneagents-acp-codex', ...extra }) as Record<string, unknown>;
    await until(async () => backend.runs.length, value => value === count + 1);
    backend.runs[count]!.finish(outcome);
    await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId, taskId: task.taskId }) as Promise<Record<string, unknown>>,
      value => value.state === (outcome.outcome === 'input-required' ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_COMPLETED'));
    return task;
  };
  const view = (originSessionId: string, taskId: unknown) => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId, taskId }) as Promise<Record<string, unknown>>;

  const kept = await finish('parent-idle-default');
  const zero = await finish('parent-idle-zero', { lifecycle: { mode: 'persistent', idleTtlSeconds: 0 } });
  const long = await finish('parent-idle-long', { lifecycle: { mode: 'persistent', idleTtlSeconds: 1800 } });
  const asking = await finish('parent-idle-input', {}, { outcome: 'input-required', text: 'need a path' });
  offsetMs = 599_000;
  await pause(300);
  assert.equal(backend.closes.length, 0);

  // A follow-up inside the window restarts the clock from its own turn.
  await gateway.invoke('remote_agent_message', { remote: 'wsl', originSessionId: 'parent-idle-default', taskId: kept.taskId, prompt: 'again' });
  await until(async () => backend.runs.length, value => value === 5);
  backend.runs[4]!.finish({ outcome: 'completed', text: 'again done' });
  offsetMs = 0;
  await until(async () => (await gateway.invoke('remote_agent_inbox', { originSessionId: 'parent-idle-default' }) as { notices: unknown[] }).notices.length, value => value === 2);
  offsetMs = 599_000;
  await pause(300);
  assert.equal(backend.closes.length, 0);

  backend.report = { attached: true, activeTurn: true };
  offsetMs = 700_000;
  await pause(300);
  assert.equal(backend.closes.length, 0);
  backend.report = 'unknown';
  await pause(300);
  assert.equal(backend.closes.length, 0);

  backend.report = { attached: true, activeTurn: false };
  const closed = await until(() => view('parent-idle-default', kept.taskId), value => value.sessionState === 'closing');
  assert.equal(closed.processReleased, 'pending');
  assert.equal(backend.closes.length, 1);
  assert.equal(backend.closes[0]!.agentPreset, 'oneagents-acp-codex');
  assert.equal((await view('parent-idle-long', long.taskId)).sessionState, undefined);

  offsetMs = 1_801_000;
  await until(() => view('parent-idle-long', long.taskId), value => value.sessionState === 'closing');
  offsetMs = 24 * 60 * 60 * 1000;
  await pause(300);
  assert.equal((await view('parent-idle-zero', zero.taskId)).sessionState, undefined);
  assert.equal((await view('parent-idle-input', asking.taskId)).sessionState, undefined);
  assert.equal(backend.closes.length, 2);

  const report = gateway.lifecycleReport();
  assert.equal(report.closeReasons['idle-ttl'], 2);
  assert.equal(report.busy, 1);
  assert.equal(report.inputRequiredAlerts.length, 1);
  assert.equal(report.inputRequiredAlerts[0]!.contextId, asking.contextId);
  assert.equal(report.processReleasePending, 2);
});

test('INPUT_REQUIRED warns only after the alert window', async t => {
  const backend = new IdleBackend();
  const f = await fixture(t, backend);
  let offsetMs = 0;
  const gateway = new RemoteAgentGateway({ ...f.config, sessionLifecycle: { idleScanIntervalMs: 50 } }, { now: () => Date.now() + offsetMs });
  f.gateways.add(gateway);
  const task = await gateway.invoke('remote_agent_spawn', { ...spawn, originSessionId: 'parent-alert', agentPreset: 'oneagents-acp-codex' }) as Record<string, unknown>;
  await until(async () => backend.runs.length, value => value === 1);
  backend.runs[0]!.finish({ outcome: 'input-required', text: 'which file' });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-alert', taskId: task.taskId }) as Promise<Record<string, unknown>>, value => value.state === 'TASK_STATE_INPUT_REQUIRED');
  offsetMs = 2 * 60 * 60 * 1000 - 60_000;
  await pause(300);
  assert.equal(gateway.lifecycleReport().inputRequiredAlerts.length, 0);
  offsetMs = 2 * 60 * 60 * 1000 + 1000;
  await until(async () => gateway.lifecycleReport().inputRequiredAlerts.length, value => value === 1);
  assert.equal(backend.closes.length, 0);
});
