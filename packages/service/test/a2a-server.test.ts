import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CancelTaskRequest, DeleteTaskPushNotificationConfigRequest, GetTaskPushNotificationConfigRequest,
  GetTaskRequest, ListTaskPushNotificationConfigsRequest, ListTasksRequest,
  SendMessageRequest, SubscribeToTaskRequest, Task, TaskPushNotificationConfig, TaskState,
  type StreamResponse,
} from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions, type Client, type RequestOptions } from '@a2a-js/sdk/client';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { toSafeError, type SafeError } from '@1agents/acp-service/runtime';
import { createA2AServer, FileA2AStore, runA2APreflight, type A2AServerOptions } from '../src/a2a/index.js';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';

const token = 'a2a-test-bearer';
const authenticated: RequestOptions = { serviceParameters: { Authorization: `Bearer ${token}` } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Fake execution has no timers, provider credentials or external agent process. */
class DeferredBackend implements A2ABackend {
  readonly preparations: A2APrepareInput[] = [];
  readonly runs: Array<{
    target: A2ATarget; prompt: string; requestId: string; signal: AbortSignal;
    execution?: { jobId: string; attemptId: string };
    result: ReturnType<typeof deferred<A2ARunResult>>;
  }> = [];

  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    this.preparations.push(structuredClone(input));
    return {
      sessionId: input.sessionId ?? `session-${this.preparations.length}`,
      cwd: input.cwd ?? '/tmp/a2a-project',
      ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}),
    };
  }

  async run(target: A2ATarget, prompt: string, options: { requestId: string; signal: AbortSignal; execution?: { jobId: string; attemptId: string } }): Promise<A2ARunResult> {
    const result = deferred<A2ARunResult>();
    const call = { target: structuredClone(target), prompt, requestId: options.requestId, signal: options.signal,
      ...(options.execution ? { execution: { ...options.execution } } : {}), result };
    this.runs.push(call);
    const abort = (): void => result.reject(options.signal.reason);
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    try { return await result.promise; }
    finally { options.signal.removeEventListener('abort', abort); }
  }
}

async function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 2500); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function stopHttp(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

async function fixture(t: TestContext, options: Partial<Omit<A2AServerOptions, 'backend' | 'publicUrl' | 'token'>> = {}, backend = new DeferredBackend()) {
  const stateDirectory = options.stateDirectory ?? await mkdtemp(join(tmpdir(), 'a2a-http-'));
  let host: Awaited<ReturnType<typeof createA2AServer>> | undefined;
  const server = createServer((req, res) => {
    if (!host) { res.writeHead(503); res.end(); return; }
    const handler = req.url === '/.well-known/agent-card.json' ? host.cardHandler : (req.url === host.path || req.url === `${host.path}/preflight`) ? host.handler : undefined;
    if (!handler) { res.writeHead(404); res.end(); return; }
    void handler(req, res).catch(error => { res.destroy(error); });
  });
  const origin = await listen(server);
  try {
    host = await createA2AServer({ backend, stateDirectory, publicUrl: origin, token, capacity: testCapacity(stateDirectory),
      defaultCwd: '/tmp/a2a-default', defaultAgentPreset: 'coding', ...options });
  } catch (error) { await stopHttp(server); throw error; }
  const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    clientConfig: { polling: true },
  }));
  const client = await factory.createFromUrl(origin);
  let stopped = false;
  const close = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await host!.close();
    await stopHttp(server);
  };
  t.after(async () => {
    await close();
    if (!options.stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
  });
  return { backend, client, origin, stateDirectory, host, close };
}

function message(prompt: string, options: { contextId?: string; taskId?: string; metadata?: Record<string, unknown>; blocking?: boolean; callback?: string } = {}): SendMessageRequest {
  return SendMessageRequest.fromJSON({
    message: { messageId: randomUUID(), role: 'ROLE_USER', contextId: options.contextId,
      taskId: options.taskId, parts: [{ text: prompt, mediaType: 'text/plain' }] },
    metadata: options.metadata ? { '1agents': options.metadata } : undefined,
    configuration: { returnImmediately: !options.blocking,
      taskPushNotificationConfig: options.callback ? { url: options.callback, authentication: { scheme: 'Bearer', credentials: 'callback-secret' } } : undefined },
  });
}

async function submit(client: Client, request = message('work')): Promise<Task> {
  const result = await deadline(client.sendMessage(request, authenticated), 'SendMessage waited for unfinished backend execution');
  assert.ok('id' in result, 'DSH should return a tracked Task');
  return result;
}

async function waitForTask(client: Client, id: string, state: TaskState): Promise<Task> {
  return deadline((async () => {
    for (;;) {
      const task = await client.getTask(GetTaskRequest.fromJSON({ id }), authenticated);
      if (task.status?.state === state) return task;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  })(), `Task ${id} did not reach ${state}`);
}

async function collect(stream: AsyncGenerator<StreamResponse>): Promise<StreamResponse[]> {
  const events: StreamResponse[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

type RpcEnvelope = { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code: number; message: string } };
async function rpc(origin: string, method: string, params: unknown, headers: Record<string, string> = {}): Promise<{ response: Response; body: RpcEnvelope }> {
  const response = await fetch(`${origin}/a2a`, { method: 'POST', headers: {
    'Content-Type': 'application/a2a+json', Authorization: `Bearer ${token}`, 'A2A-Version': '1.0', ...headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 'test-request', method, params }) });
  return { response, body: await response.json() as RpcEnvelope };
}

test('memory-bound tasks return pending Task IDs, start FIFO after release and can be canceled without preparation', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-capacity-fifo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let availableBytes = 0;
  const f = await fixture(t, { capacity: { ...testCapacity(root), softLimit: 1, hardLimit: 2,
    memoryReserveBytes: 10, estimatedInstanceBytes: 20,
    memoryProvider: () => ({ totalBytes: 100, availableBytes }) } });
  const first = await submit(f.client, message('first'));
  const canceled = await submit(f.client, message('canceled'));
  const third = await submit(f.client, message('third'));
  assert.equal(first.status?.state, TaskState.TASK_STATE_SUBMITTED);
  assert.match(first.status?.message?.parts[0]?.content?.value as string ?? '', /Pending/);
  assert.equal(f.backend.preparations.length, 0);
  await f.client.cancelTask(CancelTaskRequest.fromJSON({ id: canceled.id }), authenticated);
  await waitForTask(f.client, canceled.id, TaskState.TASK_STATE_CANCELED);
  availableBytes = 100;
  await waitForTask(f.client, first.id, TaskState.TASK_STATE_WORKING);
  assert.deepEqual(f.backend.runs.map(run => run.prompt), ['first']);
  f.backend.runs[0].result.resolve({ text: 'done', outcome: 'completed' });
  await waitForTask(f.client, third.id, TaskState.TASK_STATE_WORKING);
  assert.deepEqual(f.backend.runs.map(run => run.prompt), ['first', 'third']);
  f.backend.runs[1].result.resolve({ text: 'done', outcome: 'completed' });
  await waitForTask(f.client, third.id, TaskState.TASK_STATE_COMPLETED);
});

test('a memory drop during preparation queues the prepared task and never repeats session creation', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-capacity-recheck-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let availableBytes = 100;
  const backend = new DeferredBackend();
  const prepare = backend.prepare.bind(backend);
  backend.prepare = async input => { const target = await prepare(input); availableBytes = 0; return target; };
  const f = await fixture(t, { capacity: { ...testCapacity(root), memoryReserveBytes: 10, estimatedInstanceBytes: 20,
    memoryProvider: () => ({ totalBytes: 100, availableBytes }) } }, backend);
  const task = await submit(f.client);
  assert.equal(task.status?.state, TaskState.TASK_STATE_SUBMITTED);
  assert.equal(backend.preparations.length, 1);
  assert.equal(backend.runs.length, 0);
  availableBytes = 100;
  await waitForTask(f.client, task.id, TaskState.TASK_STATE_WORKING);
  assert.equal(backend.preparations.length, 1);
  assert.equal(backend.runs.length, 1);
  backend.runs[0].result.resolve({ text: 'done', outcome: 'completed' });
  await waitForTask(f.client, task.id, TaskState.TASK_STATE_COMPLETED);
});

test('canceling a same-context waiter needs no memory recovery and preserves the preceding preparation lock', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-capacity-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let availableBytes = 0;
  const f = await fixture(t, { capacity: { ...testCapacity(root), softLimit: 1, hardLimit: 2,
    memoryReserveBytes: 10, estimatedInstanceBytes: 20,
    memoryProvider: () => ({ totalBytes: 100, availableBytes }) } });
  const first = await submit(f.client, message('first'));
  const second = await submit(f.client, message('cancel', { contextId: first.contextId }));
  await deadline(f.client.cancelTask(CancelTaskRequest.fromJSON({ id: second.id }), authenticated), 'cancel waited for memory');
  await waitForTask(f.client, second.id, TaskState.TASK_STATE_CANCELED);
  const third = await submit(f.client, message('third', { contextId: first.contextId }));
  assert.equal(f.backend.preparations.length, 0);
  availableBytes = 100;
  await waitForTask(f.client, first.id, TaskState.TASK_STATE_WORKING);
  assert.deepEqual(f.backend.runs.map(run => run.prompt), ['first']);
  f.backend.runs[0].result.resolve({ text: 'done', outcome: 'completed' });
  await waitForTask(f.client, third.id, TaskState.TASK_STATE_WORKING);
  assert.deepEqual(f.backend.runs.map(run => run.prompt), ['first', 'third']);
  assert.equal(f.backend.preparations[1].sessionId, f.backend.runs[0].target.sessionId);
  f.backend.runs[1].result.resolve({ text: 'done', outcome: 'completed' });
  await waitForTask(f.client, third.id, TaskState.TASK_STATE_COMPLETED);
});

test('canceling during backend preparation aborts admission and waits for its cleanup before releasing the task', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-capacity-prepare-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entered = deferred<void>(), cleaned = deferred<void>();
  let stopped = false;
  class PreparingBackend extends DeferredBackend {
    override async prepare(input: A2APrepareInput, options?: { signal: AbortSignal }): Promise<A2ATarget> {
      assert.ok(options?.signal);
      entered.resolve();
      try {
        await new Promise<void>((_, reject) => {
          const abort = () => reject(options.signal.reason);
          options.signal.addEventListener('abort', abort, { once: true });
          if (options.signal.aborted) abort();
        });
      } finally { await cleaned.promise; stopped = true; }
      return super.prepare(input);
    }
  }
  const backend = new PreparingBackend();
  const f = await fixture(t, { capacity: testCapacity(root), defaultAgentPreset: 'oneagents-acp-codex' }, backend);
  const task = await submit(f.client);
  await entered.promise;
  let canceled = false;
  const cancellation = f.client.cancelTask(CancelTaskRequest.fromJSON({ id: task.id }), authenticated).then(() => { canceled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(canceled, false, 'cancellation must drain the owned initialization');
  cleaned.resolve();
  await deadline(cancellation, 'preparation cancellation did not drain');
  await waitForTask(f.client, task.id, TaskState.TASK_STATE_CANCELED);
  assert.equal(stopped, true);
  assert.equal(backend.preparations.length, 0);
  assert.equal(backend.runs.length, 0);
});

test('official A2A client discovers the card and returns a Task before execution; query and SSE deliver completion', { timeout: 10000 }, async t => {
  const f = await fixture(t, { workspaces: { app: '/tmp/a2a-app' } });
  const card = await f.client.getAgentCard();
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(card.supportedInterfaces[0].url, `${f.origin}/a2a`);
  assert.equal(card.capabilities?.streaming, true);
  assert.equal(card.capabilities?.pushNotifications, false);
  assert.equal(card.securitySchemes.bearerAuth.scheme?.$case, 'httpAuthSecurityScheme');

  const task = await submit(f.client, message('implement this', { metadata: { workspace: 'app', agentPreset: 'developer' } }));
  assert.ok(task.id);
  assert.ok(task.contextId);
  assert.equal(f.backend.runs.length, 1);
  assert.deepEqual(f.backend.preparations[0], { sessionId: undefined, cwd: '/tmp/a2a-app', agentPreset: 'developer' });
  assert.match(f.backend.runs[0].requestId, /^a2a-[a-f0-9]{64}$/);
  assert.equal(f.backend.runs[0].signal.aborted, false);
  await waitForTask(f.client, task.id, TaskState.TASK_STATE_WORKING);

  const stream = f.client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: task.id }), authenticated);
  const first = await deadline(stream.next(), 'SubscribeToTask omitted its current snapshot');
  assert.equal(first.value?.payload?.$case, 'task');
  if (first.value?.payload?.$case === 'task') assert.equal(first.value.payload.value.id, task.id);
  const subsequent = collect(stream);
  f.backend.runs[0].result.resolve({ text: 'finished result', outcome: 'completed' });
  const events = await deadline(subsequent, 'SSE failed to close after completion');
  assert.ok(events.some(event => event.payload?.$case === 'artifactUpdate' && event.payload.value.artifact?.parts[0].content?.value === 'finished result'));
  assert.ok(events.some(event => event.payload?.$case === 'statusUpdate' && event.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED));
  const completed = await waitForTask(f.client, task.id, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.artifacts[0].parts[0].content?.value, 'finished result');
  assert.equal(completed.history[0].parts[0].content?.value, 'implement this');
  assert.equal((await f.client.getTask(GetTaskRequest.fromJSON({ id: task.id, historyLength: 0 }), authenticated)).history.length, 0);
  const listed = await f.client.listTasks(ListTasksRequest.fromJSON({ contextId: task.contextId, includeArtifacts: true }), authenticated);
  assert.deepEqual(listed.tasks.map(item => item.id), [task.id]);
  await assert.rejects(f.client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: task.id }), authenticated).next(), /terminal|subscribed|Unsupported/i);
  await assert.rejects(f.client.sendMessage(message('reopen', { taskId: task.id }), authenticated), /terminal|modified|Unsupported/i);
});

test('authenticated host preflight checks requirements without allocating a task or session', async t => {
  class PreflightBackend extends DeferredBackend {
    checks = 0;
    async preflight(input: Parameters<typeof runA2APreflight>[0]) { this.checks++; return runA2APreflight(input); }
  }
  const backend = new PreflightBackend(), f = await fixture(t, {}, backend);
  const request = (value: unknown, authorized = true) => fetch(`${f.origin}/a2a/preflight`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value),
  });
  assert.equal((await request({ cwd: tmpdir() }, false)).status, 401);
  assert.equal(backend.checks, 0);
  assert.equal((await request({ cwd: 'relative' })).status, 400);
  const good = await request({ cwd: tmpdir() });
  assert.equal(good.status, 200);
  assert.equal((await good.json() as { ok: boolean }).ok, true);
  const bad = await request({ cwd: '/__a2a_missing_preflight_cwd__' });
  assert.equal(bad.status, 200, 'a valid probe returns a failed report, rather than a transport error');
  assert.equal((await bad.json() as { ok: boolean }).ok, false);
  assert.equal(backend.preparations.length, 0);
  assert.equal(backend.runs.length, 0);
  const tasks = await f.client.listTasks(ListTasksRequest.fromJSON({}), authenticated);
  assert.equal(tasks.tasks.length, 0);
});

test('a disconnected SendStreamingMessage continues execution and saves its final result', { timeout: 10000 }, async t => {
  const notification = deferred<void>();
  const callback = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { statusUpdate?: { status?: { state?: string } } };
      if (body.statusUpdate?.status?.state === 'TASK_STATE_COMPLETED') notification.resolve();
      res.writeHead(204); res.end();
    })().catch(error => res.destroy(error));
  });
  const callbackOrigin = await listen(callback);
  const f = await fixture(t, { pushNotificationOrigins: [callbackOrigin] });
  t.after(() => stopHttp(callback));
  const disconnect = new AbortController();
  const stream = f.client.sendMessageStream(message('keep working', { callback: `${callbackOrigin}/completed` }), { ...authenticated, signal: disconnect.signal });
  const first = await deadline(stream.next(), 'Streaming SendMessage did not begin');
  assert.equal(first.value?.payload?.$case, 'task');
  assert.ok(first.value?.payload?.$case === 'task');
  const task = first.value.payload.value;
  disconnect.abort();
  await stream.return(undefined).catch(() => {});
  assert.equal(f.backend.runs[0].signal.aborted, false, 'HTTP disconnect canceled independent work');
  f.backend.runs[0].result.resolve({ text: 'completed after disconnect', outcome: 'completed' });
  const completed = await waitForTask(f.client, task.id, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.artifacts[0].parts[0].content?.value, 'completed after disconnect');
  await deadline(notification.promise, 'HTTP disconnect prevented completion webhook');
});

test('same context starts a new Task with the saved DSH session, while CancelTask precisely aborts a running turn', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const first = await submit(f.client, message('first turn', { metadata: { cwd: '/tmp/shared-project', agentPreset: 'reviewer' } }));
  f.backend.runs[0].result.resolve({ text: 'first output', outcome: 'completed' });
  await waitForTask(f.client, first.id, TaskState.TASK_STATE_COMPLETED);
  const second = await submit(f.client, message('follow up', { contextId: first.contextId }));
  assert.notEqual(first.id, second.id);
  assert.equal(second.contextId, first.contextId);
  assert.deepEqual(f.backend.preparations[1], { sessionId: 'session-1', cwd: '/tmp/shared-project', agentPreset: 'reviewer' });
  const canceled = await deadline(f.client.cancelTask(CancelTaskRequest.fromJSON({ id: second.id }), authenticated), 'CancelTask waited forever');
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  assert.equal((canceled.metadata?.['1agents'] as { error: SafeError }).error.category, 'cancelled');
  assert.equal(f.backend.runs[1].signal.aborted, true);
  assert.equal((await f.client.getTask(GetTaskRequest.fromJSON({ id: first.id }), authenticated)).status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal((await f.client.cancelTask(CancelTaskRequest.fromJSON({ id: second.id }), authenticated)).status?.state, TaskState.TASK_STATE_CANCELED);
  await assert.rejects(f.client.cancelTask(CancelTaskRequest.fromJSON({ id: first.id }), authenticated), /cancel|terminal/i);
});

test('backend failures produce a queryable failed Task and close live subscribers', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const task = await submit(f.client, message('fail this turn'));
  const stream = f.client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: task.id }), authenticated);
  await deadline(stream.next(), 'Failure subscriber could not attach');
  const subsequent = collect(stream);
  f.backend.runs[0].result.reject(new Error('backend crashed'));
  const events = await deadline(subsequent, 'Failed Task kept SSE open');
  assert.ok(events.some(event => event.payload?.$case === 'statusUpdate' && event.payload.value.status?.state === TaskState.TASK_STATE_FAILED));
  const failed = await waitForTask(f.client, task.id, TaskState.TASK_STATE_FAILED);
  assert.equal((failed.metadata?.['1agents'] as { error: SafeError }).error.category, 'unknown');
  assert.ok(!JSON.stringify(failed).includes('backend crashed'));
  assert.equal(failed.artifacts.length, 0);

  const backend = new DeferredBackend();
  backend.prepare = async () => { throw new Error('session could not be resumed'); };
  const preparationFailure = await fixture(t, {}, backend);
  const refused = await submit(preparationFailure.client, message('session preparation fails'));
  const refusedTask = await waitForTask(preparationFailure.client, refused.id, TaskState.TASK_STATE_FAILED);
  assert.equal((refusedTask.metadata?.['1agents'] as { error: SafeError }).error.category, 'unknown');
  assert.ok(!JSON.stringify(refusedTask).includes('session could not be resumed'));
  assert.equal(backend.runs.length, 0);
});

test('A05 A2A errors retain safe categories and uncertain delivery without leaking provider detail', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const secret = 'SYNTHETIC_SECRET_CANARY_NOT_REAL';
  const authLink = 'https://example.invalid/authorize?token=SYNTHETIC_AUTH_CANARY_NOT_REAL';
  const cases = [
    { code: -32603, message: 'Internal error', data: { codexErrorInfo: 'usageLimitExceeded', message: secret, additionalDetails: authLink } },
    { code: -32603, message: `quota budget retry ${secret}`, data: { message: authLink } },
    { code: -32603, message: 'Internal error', data: { codexErrorInfo: 'unauthorized', token: secret, authUrl: authLink } },
  ];
  for (const [index, category] of ['quota', 'unknown', 'auth'].entries()) {
    const task = await submit(f.client, message(`synthetic failure ${index}`));
    f.backend.runs[index].result.reject(cases[index]);
    const failed = await waitForTask(f.client, task.id, TaskState.TASK_STATE_FAILED);
    const error = (failed.metadata?.['1agents'] as { error: SafeError }).error;
    assert.equal(error.category, category);
    assert.equal(error.retryable, false);
    assert.equal(error.outcomeUnknown, false);
    const serialized = JSON.stringify(failed);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes(authLink));
    assert.ok(!serialized.includes('codexErrorInfo'));
  }
  const task = await submit(f.client, message('synthetic uncertain delivery'));
  f.backend.runs[3].result.resolve({ outcome: 'failed', text: '', detail: `${secret} ${authLink}`,
    error: toSafeError(undefined, { origin: 'transport', operationId: 'synthetic-delivery', outcomeUnknown: true }) });
  const uncertain = await waitForTask(f.client, task.id, TaskState.TASK_STATE_FAILED);
  const metadata = uncertain.metadata?.['1agents'] as { sessionId: string; error: SafeError };
  assert.equal(metadata.sessionId, 'session-4');
  assert.equal(metadata.error.origin, 'transport');
  assert.equal(metadata.error.operationId, f.backend.runs[3].requestId);
  assert.equal(metadata.error.outcomeUnknown, true);
  assert.equal(metadata.error.category, 'unknown');
  assert.ok(!JSON.stringify(uncertain).includes(secret));
  assert.ok(!JSON.stringify(uncertain).includes(authLink));
  assert.equal(f.backend.runs.length, 4, 'Failed executions must not be retried automatically');
});

test('known host failure reasons remain queryable while raw failure detail stays private', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const secret = 'SYNTHETIC_HOST_DETAIL_CANARY_NOT_REAL';
  const authLink = 'https://example.invalid/authorize?token=SYNTHETIC_HOST_AUTH_CANARY_NOT_REAL';
  for (const [reason, explanation] of [['max-tokens', /model output token limit/], ['forked', /closed by a session fork/], ['missing-final-answer', /without a final answer/]] as const) {
    const task = await submit(f.client, message(`synthetic host ending ${reason}`));
    f.backend.runs.at(-1)!.result.resolve({ outcome: 'failed', text: '', failureReason: reason, detail: `${secret} ${authLink}` });
    const failed = await waitForTask(f.client, task.id, TaskState.TASK_STATE_FAILED);
    assert.match(String(failed.status?.message?.parts[0].content?.value), explanation);
    assert.equal((failed.metadata?.['1agents'] as { error: SafeError }).error.category, 'unknown');
    assert.ok(!JSON.stringify(failed).includes(secret));
    assert.ok(!JSON.stringify(failed).includes(authLink));
  }
  // A malformed backend's arbitrary reason strings never become explanations.
  for (const reason of [undefined, 'synthetic-unrecognized-reason', 'toString']) {
    const task = await submit(f.client, message('synthetic unknown host ending'));
    f.backend.runs.at(-1)!.result.resolve({ outcome: 'failed', text: '',
      failureReason: reason as A2ARunResult['failureReason'], detail: `${secret} ${authLink}` });
    const failed = await waitForTask(f.client, task.id, TaskState.TASK_STATE_FAILED);
    assert.equal(failed.status?.message?.parts[0].content?.value, 'ACP execution failed.');
    assert.ok(!JSON.stringify(failed).includes(secret));
    assert.ok(!JSON.stringify(failed).includes(authLink));
    assert.ok(!JSON.stringify(failed).includes('synthetic-unrecognized-reason'));
  }
});

test('raw backend error records cannot self-assert trusted policy fields or operation IDs', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const secret = 'SYNTHETIC_BACKEND_ERROR_CANARY_NOT_REAL';
  const operationCanary = 'SYNTHETIC_BACKEND_OPERATION_SECRET_NOT_REAL';
  const authLink = 'https://example.invalid/authorize?token=SYNTHETIC_BACKEND_AUTH_CANARY_NOT_REAL';
  const task = await submit(f.client, message('synthetic backend policy spoof'));
  f.backend.runs[0].result.resolve({ outcome: 'failed', text: '', detail: secret, error: {
    message: `${secret} ${authLink}`, category: 'quota', origin: 'dsh', retryable: true,
    outcomeUnknown: true, operationId: operationCanary,
  } });
  const failed = await waitForTask(f.client, task.id, TaskState.TASK_STATE_FAILED);
  const error = (failed.metadata?.['1agents'] as { error: SafeError }).error;
  assert.equal(error.category, 'unknown');
  assert.equal(error.origin, 'a2a');
  assert.equal(error.retryable, false);
  assert.equal(error.outcomeUnknown, false);
  assert.equal(error.operationId, f.backend.runs[0].requestId);
  assert.equal(failed.status?.message?.parts[0].content?.value, 'ACP execution failed.');
  assert.ok(!JSON.stringify(failed).includes(secret));
  assert.ok(!JSON.stringify(failed).includes(operationCanary));
  assert.ok(!JSON.stringify(failed).includes(authLink));
});

test('owned backend error projections keep safe fields while operation identity belongs to the A2A caller', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const operationCanary = 'SYNTHETIC_OWNED_BACKEND_OPERATION_NOT_REAL';
  for (const [index, outcome] of ['resolve', 'reject'].entries()) {
    const task = await submit(f.client, message(`synthetic owned backend ${outcome}`));
    const error = toSafeError({ code: -32603, data: { codexErrorInfo: 'usageLimitExceeded' } }, {
      origin: 'acp', operationId: operationCanary, outcomeUnknown: true,
    });
    if (outcome === 'resolve') f.backend.runs[index].result.resolve({ outcome: 'failed', text: '', error });
    else f.backend.runs[index].result.reject(error);
    const failed = await waitForTask(f.client, task.id, TaskState.TASK_STATE_FAILED);
    const safe = (failed.metadata?.['1agents'] as { error: SafeError }).error;
    assert.equal(safe.category, 'quota');
    assert.equal(safe.providerCode, 'usageLimitExceeded');
    assert.equal(safe.retryable, false);
    assert.equal(safe.outcomeUnknown, true);
    assert.equal(safe.origin, 'acp');
    assert.equal(safe.operationId, f.backend.runs[index].requestId);
    assert.ok(!JSON.stringify(failed).includes(operationCanary));
  }
  assert.equal(f.backend.runs.length, 2, 'Rebinding an error must not retry the backend');
});

test('A2A cancellation preserves a backend uncertainty flag while remaining canceled', { timeout: 10000 }, async t => {
  const backend = new DeferredBackend();
  const started = deferred<void>();
  let callerRequestId: string | undefined;
  backend.run = async (_target, _prompt, options) => {
    callerRequestId = options.requestId;
    started.resolve();
    return new Promise<A2ARunResult>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(toSafeError(undefined, {
        origin: 'transport', operationId: 'synthetic-cancel-delivery', outcomeUnknown: true,
      })), { once: true });
    });
  };
  const f = await fixture(t, {}, backend);
  const task = await submit(f.client, message('synthetic uncertain cancellation'));
  await started.promise;
  const canceled = await f.client.cancelTask(CancelTaskRequest.fromJSON({ id: task.id }), authenticated);
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  const error = (canceled.metadata?.['1agents'] as { error: SafeError }).error;
  assert.equal(error.category, 'unknown');
  assert.equal(error.origin, 'transport');
  assert.equal(error.operationId, callerRequestId);
  assert.equal(error.outcomeUnknown, true);
});

test('queued backend discard without an error keeps the local cancellation category', { timeout: 10000 }, async t => {
  const backend = new DeferredBackend();
  const started = deferred<void>();
  let callerRequestId: string | undefined;
  backend.run = async (_target, _prompt, options) => new Promise<A2ARunResult>(resolve => {
    callerRequestId = options.requestId;
    options.signal.addEventListener('abort', () => resolve({
      outcome: 'failed', text: '', failureReason: 'discarded',
    }), { once: true });
    started.resolve();
  });
  const f = await fixture(t, {}, backend);
  const task = await submit(f.client, message('synthetic queued backend discard'));
  await started.promise;
  const canceled = await f.client.cancelTask(CancelTaskRequest.fromJSON({ id: task.id }), authenticated);
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  const error = (canceled.metadata?.['1agents'] as { error: SafeError }).error;
  assert.equal(error.category, 'cancelled');
  assert.equal(error.retryable, false);
  assert.equal(error.outcomeUnknown, false);
  assert.equal(error.origin, 'a2a');
  assert.equal(error.operationId, callerRequestId);
});

test('A2A cancellation racing a returned failure preserves all safe error fields', { timeout: 10000 }, async t => {
  const backend = new DeferredBackend();
  const started = deferred<void>();
  let callerRequestId: string | undefined;
  backend.run = async (_target, _prompt, options) => new Promise<A2ARunResult>(resolve => {
    callerRequestId = options.requestId;
    options.signal.addEventListener('abort', () => {
      assert.equal(options.signal.aborted, true);
      // Return rather than throw: executor cancellation is observed after run resolves.
      const error = toSafeError({ code: -32603, message: 'Internal error', data: { codexErrorInfo: 'usageLimitExceeded' } }, {
        origin: 'acp', operationId: 'synthetic-returned-delivery', outcomeUnknown: true,
      });
      error.retryable = true;
      resolve({ outcome: 'failed', text: '', error });
    }, { once: true });
    started.resolve();
  });
  const f = await fixture(t, {}, backend);
  const task = await submit(f.client, message('synthetic returned failure cancellation race'));
  await started.promise;
  const canceled = await f.client.cancelTask(CancelTaskRequest.fromJSON({ id: task.id }), authenticated);
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  const error = (canceled.metadata?.['1agents'] as { error: SafeError }).error;
  assert.equal(error.category, 'quota');
  assert.equal(error.providerCode, 'usageLimitExceeded');
  assert.equal(error.retryable, true);
  assert.equal(error.origin, 'acp');
  assert.equal(error.operationId, callerRequestId);
  assert.equal(error.outcomeUnknown, true);
});

test('blocking SendMessage waits for the result and input-required tasks accept a follow-up', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const pending = f.client.sendMessage(message('need an answer', { blocking: true }), authenticated);
  let settled = false;
  void pending.then(() => { settled = true; });
  await deadline((async () => { while (!f.backend.runs.length) await new Promise<void>(resolve => setImmediate(resolve)); })(), 'Backend did not start');
  assert.equal(settled, false);
  f.backend.runs[0].result.resolve({ text: 'Which branch?', detail: 'Choose a branch', outcome: 'input-required' });
  const result = await deadline(pending, 'Blocking SendMessage did not return interrupted Task');
  assert.ok('id' in result);
  assert.equal(result.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  const duplicate = message('repeat old admission', { taskId: result.id });
  duplicate.message!.messageId = result.history[0].messageId;
  await assert.rejects(f.client.sendMessage(duplicate, authenticated), /new messageId/);
  assert.equal(f.backend.runs.length, 1);
  const simultaneous = await Promise.allSettled([
    f.client.sendMessage(message('main branch', { taskId: result.id, contextId: result.contextId }), authenticated),
    f.client.sendMessage(message('other branch', { taskId: result.id, contextId: result.contextId }), authenticated),
  ]);
  const admitted = simultaneous.filter(item => item.status === 'fulfilled');
  assert.equal(admitted.length, 1, 'Only one follow-up can own a task execution');
  assert.equal(simultaneous.filter(item => item.status === 'rejected').length, 1);
  const resumed = admitted[0].value;
  assert.ok('id' in resumed);
  assert.equal(resumed.id, result.id);
  assert.equal(f.backend.preparations[1].sessionId, 'session-1');
  assert.notEqual(f.backend.runs[0].requestId, f.backend.runs[1].requestId, 'Follow-up turns require distinct DSH admission IDs');
  f.backend.runs[1].result.resolve({ text: 'main finished', outcome: 'completed' });
  const completed = await waitForTask(f.client, resumed.id, TaskState.TASK_STATE_COMPLETED);
  assert.ok(completed.history.some(item => item.parts[0].content?.value === f.backend.runs[1].prompt));

  const paused = await submit(f.client, message('pause until canceled'));
  f.backend.runs[2].result.resolve({ text: 'Waiting for input', outcome: 'input-required' });
  await waitForTask(f.client, paused.id, TaskState.TASK_STATE_INPUT_REQUIRED);
  const canceled = await deadline(f.client.cancelTask(CancelTaskRequest.fromJSON({ id: paused.id }), authenticated), 'Paused task could not be canceled');
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
});

test('restart retains completed tasks and context-to-session mapping without replaying finished work', { timeout: 10000 }, async t => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'a2a-restart-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const first = await fixture(t, { stateDirectory });
  const task = await submit(first.client, message('persist this', { metadata: { cwd: '/tmp/persisted', agentPreset: 'manager' } }));
  first.backend.runs[0].result.resolve({ text: 'durable output', outcome: 'completed' });
  await waitForTask(first.client, task.id, TaskState.TASK_STATE_COMPLETED);
  await first.close();
  const restarted = await fixture(t, { stateDirectory });
  const restored = await restarted.client.getTask(GetTaskRequest.fromJSON({ id: task.id }), authenticated);
  assert.equal(restored.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(restored.artifacts[0].parts[0].content?.value, 'durable output');
  assert.equal(restarted.backend.runs.length, 0);
  const followup = await submit(restarted.client, message('continue', { contextId: task.contextId }));
  assert.deepEqual(restarted.backend.preparations[0], { sessionId: 'session-1', cwd: '/tmp/persisted', agentPreset: 'manager' });
  restarted.backend.runs[0].result.resolve({ text: 'restored session output', outcome: 'completed' });
  await waitForTask(restarted.client, followup.id, TaskState.TASK_STATE_COMPLETED);
});

test('restart marks an interrupted persisted task failed and retains its session for a new Task', { timeout: 10000 }, async t => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'a2a-interrupted-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const context = new ServerCallContext({ requestedVersion: '1.0', user: { isAuthenticated: true, userName: 'dsh-a2a' } });
  const store = new FileA2AStore(stateDirectory);
  try {
    await store.taskStore.save(Task.fromJSON({ id: 'interrupted-task', contextId: 'persisted-context',
      status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() } }), context);
    store.saveTarget('persisted-context', { sessionId: 'old-session', cwd: '/tmp/interrupted', agentPreset: 'coder' }, context);
  } finally { store.close(); }
  const f = await fixture(t, { stateDirectory });
  const failed = await f.client.getTask(GetTaskRequest.fromJSON({ id: 'interrupted-task' }), authenticated);
  assert.equal(failed.status?.state, TaskState.TASK_STATE_FAILED);
  assert.match(String(failed.status?.message?.parts[0].content?.value), /restart|interrupted/i);
  assert.equal(f.backend.runs.length, 0);
  const continued = await submit(f.client, message('continue carefully', { contextId: 'persisted-context' }));
  assert.deepEqual(f.backend.preparations[0], { sessionId: 'old-session', cwd: '/tmp/interrupted', agentPreset: 'coder' });
  f.backend.runs[0].result.resolve({ text: 'recovered', outcome: 'completed' });
  await waitForTask(f.client, continued.id, TaskState.TASK_STATE_COMPLETED);
});

test('HTTP authentication, version negotiation and invalid input fail before backend execution', { timeout: 10000 }, async t => {
  const f = await fixture(t, { workspaces: { allowed: '/tmp/allowed' } });
  const params = SendMessageRequest.toJSON(message('valid'));
  for (const authorization of ['', 'Bearer incorrect']) {
    const denied = await rpc(f.origin, 'SendMessage', params, { Authorization: authorization });
    assert.equal(denied.response.status, 401);
    assert.equal(denied.response.headers.get('www-authenticate'), 'Bearer');
  }
  for (const version of ['', '0.3', '2.0']) {
    const unsupported = await rpc(f.origin, 'SendMessage', params, { 'A2A-Version': version });
    assert.match(unsupported.body.error?.message ?? '', /version/i);
    assert.equal(unsupported.body.jsonrpc, '2.0');
  }
  const inputs = [
    { message: { messageId: 'wrong-role', role: 'ROLE_AGENT', parts: [{ text: 'hello' }] } },
    { message: { messageId: 'data-input', role: 'ROLE_USER', parts: [{ data: { prompt: 'hello' } }] } },
    { message: { messageId: 'empty-text', role: 'ROLE_USER', parts: [{ text: ' ' }] } },
    { ...params as object, metadata: { '1agents': { cwd: '/tmp/a', workspace: 'allowed' } } },
    { ...params as object, metadata: { '1agents': { workspace: 'missing' } } },
    { ...params as object, metadata: { '1agents': { sessionId: 'injected-session' } } },
    { ...params as object, configuration: { returnImmediately: 'true' } },
  ];
  for (const input of inputs) {
    const invalid = await rpc(f.origin, 'SendMessage', input);
    assert.ok(invalid.body.error, `Invalid input was admitted: ${JSON.stringify(input)}`);
    assert.equal(invalid.body.id, 'test-request');
  }
  const missing = await rpc(f.origin, 'GetTask', { id: 'unknown-task' });
  assert.match(missing.body.error?.message ?? '', /not found/i);
  const legacy = await rpc(f.origin, 'message/send', params);
  assert.ok(legacy.body.error, 'Unadvertised v0.3 method should fail');
  assert.equal(f.backend.preparations.length, 0);
  assert.equal(f.backend.runs.length, 0);
});

test('gateway execution metadata is forwarded to the run and kept out of session preparation', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const task = await submit(f.client, message('work', { metadata: { cwd: '/tmp/a2a-project', execution: { jobId: 'job-1', attemptId: 'attempt-1' } } }));
  assert.deepEqual(f.backend.preparations[0], { sessionId: undefined, cwd: '/tmp/a2a-project', agentPreset: 'coding' });
  assert.deepEqual(f.backend.runs[0]?.execution, { jobId: 'job-1', attemptId: 'attempt-1' });
  f.backend.runs[0]!.result.resolve({ text: 'done', outcome: 'completed' });
  await waitForTask(f.client, task.id, TaskState.TASK_STATE_COMPLETED);
});

test('slow allowed webhooks do not delay SendMessage or completion, and push configs support standard CRUD', { timeout: 10000 }, async t => {
  const release = deferred<void>();
  const entered = deferred<void>();
  const completedNotification = deferred<Record<string, unknown>>();
  const notifications: Array<{ body: Record<string, unknown>; authorization?: string; contentType?: string }> = [];
  const callback = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      notifications.push({ body, authorization: req.headers.authorization, contentType: req.headers['content-type'] });
      entered.resolve();
      if ((body.statusUpdate as { status?: { state?: string } } | undefined)?.status?.state === 'TASK_STATE_COMPLETED') completedNotification.resolve(body);
      await release.promise;
      res.writeHead(204); res.end();
    })().catch(error => res.destroy(error));
  });
  const callbackOrigin = await listen(callback);
  t.after(async () => { release.resolve(); await stopHttp(callback); });
  const f = await fixture(t, { pushNotificationOrigins: [callbackOrigin] });
  const task = await submit(f.client, message('notify later', { callback: `${callbackOrigin}/done` }));
  await deadline(entered.promise, 'No webhook was attempted');
  assert.equal(f.backend.runs[0].signal.aborted, false);
  const configs = await f.client.listTaskPushNotificationConfig(ListTaskPushNotificationConfigsRequest.fromJSON({ taskId: task.id }), authenticated);
  assert.equal(configs.configs.length, 1);
  assert.equal(configs.configs[0].taskId, task.id);
  const fetched = await f.client.getTaskPushNotificationConfig(GetTaskPushNotificationConfigRequest.fromJSON({ taskId: task.id, id: configs.configs[0].id }), authenticated);
  assert.equal(fetched.url, `${callbackOrigin}/done`);
  const created = await f.client.createTaskPushNotificationConfig(TaskPushNotificationConfig.fromJSON({
    taskId: task.id, id: 'second-callback', url: `${callbackOrigin}/second`,
    authentication: { scheme: 'Bearer', credentials: 'callback-secret' },
  }), authenticated);
  assert.equal(created.id, 'second-callback');
  assert.equal(created.taskId, task.id);
  assert.equal((await f.client.listTaskPushNotificationConfig(ListTaskPushNotificationConfigsRequest.fromJSON({ taskId: task.id }), authenticated)).configs.length, 2);
  await f.client.deleteTaskPushNotificationConfig(DeleteTaskPushNotificationConfigRequest.fromJSON({ taskId: task.id, id: created.id }), authenticated);
  f.backend.runs[0].result.resolve({ text: 'done', outcome: 'completed' });
  await waitForTask(f.client, task.id, TaskState.TASK_STATE_COMPLETED);
  release.resolve();
  await deadline(completedNotification.promise, 'Completion webhook missing');
  assert.ok(notifications.every(item => item.authorization === 'Bearer callback-secret'));
  assert.ok(notifications.every(item => item.contentType === 'application/a2a+json'));
  assert.ok(notifications.every(item => Object.keys(item.body).length === 1));
  await f.client.deleteTaskPushNotificationConfig(DeleteTaskPushNotificationConfigRequest.fromJSON({ taskId: task.id, id: configs.configs[0].id }), authenticated);
  assert.equal((await f.client.listTaskPushNotificationConfig(ListTaskPushNotificationConfigsRequest.fromJSON({ taskId: task.id }), authenticated)).configs.length, 0);
});

test('callback destinations require an allowed origin and redirects never reach an unapproved endpoint', { timeout: 10000 }, async t => {
  let forbiddenHits = 0;
  const forbidden = createServer((_req, res) => { forbiddenHits++; res.writeHead(204); res.end(); });
  const forbiddenOrigin = await listen(forbidden);
  t.after(() => stopHttp(forbidden));
  const redirected = deferred<void>();
  const callback = createServer((req, res) => {
    req.resume();
    res.writeHead(307, { Location: `${forbiddenOrigin}/secret` }); res.end(); redirected.resolve();
  });
  const callbackOrigin = await listen(callback);
  t.after(() => stopHttp(callback));
  const disabled = await fixture(t);
  await assert.rejects(disabled.client.sendMessage(message('webhook disabled', { callback: `${callbackOrigin}/done` }), authenticated), /push|webhook|Configure/i);
  assert.equal(disabled.backend.preparations.length, 0);

  const f = await fixture(t, { pushNotificationOrigins: [callbackOrigin] });
  for (const url of [`${forbiddenOrigin}/forbidden`, 'file:///tmp/callback', `http://user:password@${new URL(callbackOrigin).host}/done`]) {
    await assert.rejects(f.client.sendMessage(message('reject target', { callback: url }), authenticated), /origin|allowed|Webhook/i);
  }
  assert.equal(f.backend.preparations.length, 0);
  const task = await submit(f.client, message('safe callback', { callback: `${callbackOrigin}/redirect` }));
  await deadline(redirected.promise, 'Redirect webhook was not attempted');
  await assert.rejects(f.client.createTaskPushNotificationConfig(TaskPushNotificationConfig.fromJSON({ taskId: task.id, id: 'bad', url: `${forbiddenOrigin}/forbidden` }), authenticated), /origin|allowed/i);
  f.backend.runs[0].result.resolve({ text: 'safe result', outcome: 'completed' });
  await waitForTask(f.client, task.id, TaskState.TASK_STATE_COMPLETED);
  await f.close();
  assert.equal(forbiddenHits, 0, 'Webhook redirect leaked a request outside the allowlist');
});

test('a host-default ACP preset rejects provider and model before preparing a session', async t => {
  const f = await fixture(t, { defaultAgentPreset: 'oneagents-acp-grok' });
  await assert.rejects(f.client.sendMessage(message('half', { metadata: { provider: 'deepseek' } }), authenticated), /passed together/);
  const task = await submit(f.client, message('work', { metadata: { provider: 'deepseek', model: 'deepseek-v4' } }));
  const failed = await waitForTask(f.client, task.id, TaskState.TASK_STATE_FAILED);
  assert.equal((failed.metadata?.['1agents'] as { result: { validation: { code: string } } }).result.validation.code, 'MODEL_SELECTION_UNSUPPORTED');
  assert.equal(f.backend.preparations.length, 0);
  assert.equal(f.backend.runs.length, 0);
});
