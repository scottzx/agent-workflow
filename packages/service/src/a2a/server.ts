/** Node HTTP A2A transport reusable by DSH and standalone hosts. */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentCard, SSE_HEADERS, TaskState, formatSSEEvent, type CancelTaskRequest, type Message, type SendMessageRequest, type StreamResponse, type Task, type TaskPushNotificationConfig } from '@a2a-js/sdk';
import { PushNotificationNotSupportedError, RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { DefaultExecutionEventBusManager, DefaultRequestHandler, JsonRpcTransportHandler, ServerCallContext, V1PushNotificationSerializer, resolveUserScope, validateVersion, type PushNotificationSender } from '@a2a-js/sdk/server';
import { A2ASessionExecutor, parseA2AInput, validateA2AExecutionOptions, type A2AExecutionOptions } from './executor.js';
import { Role } from '@a2a-js/sdk';
import { toSafeError } from '@1agents/acp-service/runtime';
import { a2aRequestId } from './request-id.js';
import { FileA2AStore } from './store.js';
import type { A2ABackend } from './types.js';
import { a2aPreflightInputSchema } from './preflight.js';
import { ArtifactContentError, readVerifiedArtifact } from './artifact-content.js';
import type { A2AVerifiedArtifact } from './result-metadata.js';

async function readBoundedJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sessionRouteError(error: unknown): { status: number; code: string } {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  switch (code) {
    case 'SESSION_NOT_FOUND': return { status: 404, code };
    case 'SESSION_DELETED': return { status: 404, code };
    case 'SESSION_CLOSED': return { status: 409, code };
    case 'SESSION_BUSY': return { status: 409, code };
    case 'SESSION_CONFLICT': return { status: 400, code };
    case 'SESSION_ATTACH_IN_PROGRESS': return { status: 409, code };
    case 'UNSUPPORTED': return { status: 501, code };
    case 'REMOTE_UNAVAILABLE': return { status: 503, code };
    default: return { status: 503, code: 'REMOTE_UNAVAILABLE' };
  }
}

/** Remote execution is explicitly enabled with a host-owned bearer credential. */
export interface A2AServerOptions extends A2AExecutionOptions {
  backend: A2ABackend;
  stateDirectory: string;
  publicUrl: string;
  token: string;
  path?: string;
  /** Webhook destinations must belong to one of these exact HTTP(S) origins. */
  pushNotificationOrigins?: string[];
}

function allowedCallback(config: TaskPushNotificationConfig, origins: Set<string>): void {
  if (!origins.size) throw new PushNotificationNotSupportedError('Configure pushNotificationOrigins to enable webhooks');
  let url: URL;
  try { url = new URL(config.url); } catch { throw new RequestMalformedError('Webhook URL must be absolute'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !origins.has(url.origin)) throw new RequestMalformedError('Webhook origin is not allowed');
}

/** Callback I/O is ordered per scoped task, never awaited by SendMessage. */
class HttpPushSender implements PushNotificationSender {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;
  constructor(private readonly store: FileA2AStore, private readonly origins: Set<string>) {}
  send(event: StreamResponse, context: ServerCallContext, task?: Task): Promise<void> {
    const payload = event.payload;
    if (!payload || this.stopped) return Promise.resolve();
    const taskId = payload.$case === 'task' ? payload.value.id : payload.value.taskId;
    if (!taskId) return Promise.resolve();
    const key = JSON.stringify([context.tenant ?? '', resolveUserScope(context), taskId]);
    const snapshot = structuredClone(event);
    const prior = this.chains.get(key) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(async () => {
      if (this.stopped) return;
      const configs = await this.store.pushStore.load(taskId, context);
      const body = new V1PushNotificationSerializer().serialize(snapshot, task);
      await Promise.all(configs.map(async config => {
        allowedCallback(config, this.origins);
        const controller = new AbortController();
        this.controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const headers: Record<string, string> = { 'Content-Type': body.contentType };
          if (config.authentication?.scheme && config.authentication.credentials) headers.Authorization = `${config.authentication.scheme} ${config.authentication.credentials}`;
          else if (config.token) headers['X-A2A-Notification-Token'] = config.token;
          const response = await fetch(config.url, { method: 'POST', headers, body: body.body, signal: controller.signal, redirect: 'error' });
          await response.body?.cancel();
          if (!response.ok) throw new Error(`A2A webhook delivery failed (HTTP ${response.status})`);
        } finally { clearTimeout(timeout); this.controllers.delete(controller); }
      }));
    });
    this.chains.set(key, pending);
    const clean = (): void => { if (this.chains.get(key) === pending) this.chains.delete(key); };
    void pending.then(clean, clean);
    return pending;
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.chains.values());
  }
}

/** Reject unsupported input before creating a background task. */
class HostRequestHandler extends DefaultRequestHandler {
  private readonly buses: DefaultExecutionEventBusManager;
  private readonly admissions = new Map<string, Promise<void>>();
  constructor(card: AgentCard, private readonly store: FileA2AStore, private readonly executor: A2ASessionExecutor,
    sender: PushNotificationSender, private readonly options: A2AServerOptions, private readonly origins: Set<string>) {
    const buses = new DefaultExecutionEventBusManager();
    super(card, store.taskStore, executor, buses, store.pushStore, sender);
    this.buses = buses;
  }
  private async validate(request: SendMessageRequest, context: ServerCallContext): Promise<void> {
    parseA2AInput(request, this.options);
    if (request.message?.taskId && this.executor.isRunning(request.message.taskId)) throw new UnsupportedOperationError('Send a new task in the same context, or wait until this task requires input');
    if (request.message?.taskId) {
      const task = await this.store.taskStore.load(request.message.taskId, context);
      if (task?.history.some(message => message.messageId === request.message?.messageId)) {
        throw new RequestMalformedError('A continued task requires a new messageId');
      }
    }
    if (request.configuration?.taskPushNotificationConfig) allowedCallback(request.configuration.taskPushNotificationConfig, this.origins);
  }
  override async sendMessage(request: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    const taskId = request.message?.taskId;
    if (!taskId) {
      await this.validate(request, context);
      return super.sendMessage(request, context);
    }
    if (this.executor.isRunning(taskId)) throw new UnsupportedOperationError('This task already has an active execution');
    const key = JSON.stringify([context.tenant ?? '', resolveUserScope(context), taskId]);
    const previous = this.admissions.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const lock = new Promise<void>(resolve => { unlock = resolve; });
    this.admissions.set(key, lock);
    try {
      await previous;
      await this.validate(request, context);
      return await super.sendMessage(request, context);
    } finally {
      unlock();
      if (this.admissions.get(key) === lock) this.admissions.delete(key);
    }
  }
  override async *sendMessageStream(request: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    // The nonblocking SendMessage path keeps a persistence/notification drain
    // alive even after the streaming HTTP consumer disconnects.
    const result = await this.sendMessage({ ...request, configuration: {
      acceptedOutputModes: request.configuration?.acceptedOutputModes ?? [],
      taskPushNotificationConfig: request.configuration?.taskPushNotificationConfig,
      historyLength: request.configuration?.historyLength,
      returnImmediately: true,
    } }, context);
    if ('messageId' in result) { yield { payload: { $case: 'message', value: result } }; return; }
    try {
      yield* super.resubscribe({ tenant: request.tenant, id: result.id }, context);
    } catch (error) {
      const task = await this.store.taskStore.load(result.id, context);
      if (!(error instanceof UnsupportedOperationError) || !task || ![TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED].includes(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)) throw error;
      yield { payload: { $case: 'task', value: task } };
    }
  }
  override async createTaskPushNotificationConfig(config: TaskPushNotificationConfig, context: ServerCallContext): Promise<TaskPushNotificationConfig> {
    allowedCallback(config, this.origins);
    return super.createTaskPushNotificationConfig(config, context);
  }
  override async cancelTask(request: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    const task = await super.cancelTask(request, context);
    this.buses.cleanupByTaskId(request.id, context);
    return task;
  }
}

/** Create the A2A 1.0 host without opening a port or importing DSH. */
export async function createA2AServer(options: A2AServerOptions): Promise<{
  path: string;
  card: AgentCard;
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  cardHandler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
}> {
  if (!options.token?.trim()) throw new Error('A2A requires a bearer token');
  validateA2AExecutionOptions(options);
  const path = options.path ?? '/a2a';
  if (!/^\/[a-z0-9/_-]+$/i.test(path) || path.endsWith('/')) throw new Error('Invalid A2A route path');
  const publicUrl = new URL(options.publicUrl);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('publicUrl must be an HTTP(S) origin');
  const origins = new Set((options.pushNotificationOrigins ?? []).map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('pushNotificationOrigins must contain HTTP(S) origins');
    return url.origin;
  }));
  const card = AgentCard.fromJSON({ name: '1agents DSH', description: 'Delegate text tasks to persistent DSH sessions and selected agent presets.', version: '1.0.0',
    supportedInterfaces: [{ url: new URL(path, publicUrl).href, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: true, pushNotifications: origins.size > 0 },
    securitySchemes: { bearerAuth: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
    securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'dsh-session', name: 'DSH session task', description: 'Create or resume a session using metadata.1agents.cwd, workspace and agentPreset; retain contextId to continue collaboration.', tags: ['dsh', 'project', 'role', 'async'] }] });
  const store = new FileA2AStore(options.stateDirectory);
  try { await store.recoverInterrupted(async (task, context) => {
    const message = task.history.findLast(message => message.role === Role.ROLE_USER);
    const target = store.loadTarget(task.contextId, context);
    if (!message || !target) return;
    const requestId = a2aRequestId(task.id, message.messageId);
    const recovered = await options.backend.recover?.(target, { requestId });
    return toSafeError(recovered, { origin: 'a2a', operationId: requestId,
      outcomeUnknown: recovered === undefined });
  }); } catch (error) { store.close(); throw error; }
  const executor = new A2ASessionExecutor(options.backend, store, options);
  const sender = new HttpPushSender(store, origins);
  const requestHandler = new HostRequestHandler(card, store, executor, sender, options, origins);
  const transport = new JsonRpcTransportHandler(requestHandler);
  const tokenHash = createHash('sha256').update(options.token).digest();
  const responses = new Set<ServerResponse>();
  const requests = new Map<IncomingMessage, Promise<void>>();
  let stopped = false;
  const cardHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(AgentCard.toJSON(card)));
  };
  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (stopped) { res.writeHead(503); res.end(); return; }
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || !timingSafeEqual(tokenHash, createHash('sha256').update(authorization.slice(7)).digest())) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    // A host extension with the same credential boundary as execution. Probing
    // does not allocate a Task, context or session and never enters the model.
    if (req.url === `${path}/preflight`) {
      if (!options.backend.preflight) {
        res.writeHead(501, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Host preflight is not supported' })); return;
      }
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > 65536) throw new Error('Preflight body exceeds 64 KiB');
          chunks.push(buffer);
        }
        const input = a2aPreflightInputSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const report = await options.backend.preflight(input);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(report));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid preflight request' }));
      }
      return;
    }
    if (req.url === `${path}/sessions/close` || req.url === `${path}/sessions/status` || req.url === `${path}/sessions/delete`) {
      const action = req.url.endsWith('/status') ? 'status' : req.url.endsWith('/delete') ? 'delete' : 'close';
      if (!options.backend[action]) {
        res.writeHead(501, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'UNSUPPORTED' })); return;
      }
      try {
        const body = await readBoundedJson(req, 65536) as { sessionId?: unknown; contextId?: unknown };
        if (!body || typeof body !== 'object' || typeof body.sessionId !== 'string' || !body.sessionId.trim()
          || typeof body.contextId !== 'string' || !body.contextId.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'SESSION_CONFLICT' })); return;
        }
        const context = new ServerCallContext({ requestedVersion: '1.0', user: { isAuthenticated: true, userName: 'dsh-a2a' } });
        const target = store.loadTarget(body.contextId, context);
        if (!target || target.sessionId !== body.sessionId) {
          res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'SESSION_NOT_FOUND' })); return;
        }
        if (action === 'status') {
          const report = await options.backend.status!(target);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(report)); return;
        }
        if (action === 'delete') {
          if (target.state === 'deleted') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ processReleased: true, alreadyClosed: true, state: 'deleted', acp: target.agentPreset?.startsWith('oneagents-acp-') === true, sessionId: target.sessionId, contextId: body.contextId }));
            return;
          }
          const result = await options.backend.delete!(target);
          store.saveTarget(body.contextId, { ...target, state: 'deleted', lastUsedAt: new Date().toISOString() }, context);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ...result, alreadyClosed: false, state: 'deleted', sessionId: target.sessionId, contextId: body.contextId }));
          return;
        }
        if (target.state === 'closed' || target.state === 'closing' || target.state === 'deleted') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ processReleased: target.state === 'closed' ? true : 'pending', alreadyClosed: true,
            acp: target.agentPreset?.startsWith('oneagents-acp-') === true, sessionId: target.sessionId, contextId: body.contextId }));
          return;
        }
        const result = await options.backend.close!(target);
        store.saveTarget(body.contextId, { ...target, state: result.processReleased === true ? 'closed' : 'closing', lastUsedAt: new Date().toISOString() }, context);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ...result, alreadyClosed: false, sessionId: target.sessionId, contextId: body.contextId }));
      } catch (error) {
        if (error instanceof SyntaxError || (error instanceof Error && error.message === 'body too large')) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'SESSION_CONFLICT' })); return;
        }
        const mapped = sessionRouteError(error);
        res.writeHead(mapped.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: mapped.code }));
      }
      return;
    }
    // Same credential boundary as execution: the caller names a task and a receipt entry, never an arbitrary path.
    if (req.url === `${path}/artifacts/content`) {
      try {
        const body = await readBoundedJson(req, 65536) as { taskId?: unknown; path?: unknown; sha256?: unknown };
        if (!body || typeof body !== 'object' || typeof body.taskId !== 'string' || typeof body.path !== 'string'
          || typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256)) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid-artifact-request' })); return;
        }
        const context = new ServerCallContext({ requestedVersion: '1.0', user: { isAuthenticated: true, userName: 'dsh-a2a' } });
        const task = await store.taskStore.load(body.taskId, context);
        const result = (task?.metadata?.['1agents'] as { result?: { artifacts?: A2AVerifiedArtifact[] } } | undefined)?.result;
        const content = await readVerifiedArtifact(result?.artifacts ?? [], body.path, body.sha256);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-store' });
        res.end(content);
      } catch (error) {
        const status = error instanceof ArtifactContentError ? error.status : 400;
        const code = error instanceof ArtifactContentError ? error.code : 'invalid-artifact-request';
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: code }));
      }
      return;
    }
    res.setHeader('A2A-Version', '1.0');
    let id: string | number | null = null;
    try {
      const version = req.headers['a2a-version'];
      validateVersion(typeof version === 'string' ? version : '0.3', card, 'JSONRPC');
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 1024 * 1024) throw new RequestMalformedError('Request body exceeds 1 MiB');
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let decoded: Record<string, unknown>;
      try { decoded = JSON.parse(body); } catch { throw new RequestMalformedError('Invalid JSON request'); }
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        if (typeof decoded.id === 'string' || typeof decoded.id === 'number') id = decoded.id;
        const params = decoded.params as Record<string, unknown> | undefined;
        const config = params?.configuration as Record<string, unknown> | undefined;
        if (config?.returnImmediately !== undefined && typeof config.returnImmediately !== 'boolean') throw new RequestMalformedError('returnImmediately must be boolean');
        if (params?.historyLength !== undefined && (!Number.isSafeInteger(params.historyLength) || (params.historyLength as number) < 0)) throw new RequestMalformedError('historyLength must be a nonnegative integer');
        if (config?.historyLength !== undefined && (!Number.isSafeInteger(config.historyLength) || (config.historyLength as number) < 0)) throw new RequestMalformedError('historyLength must be a nonnegative integer');
      }
      const context = new ServerCallContext({ requestedVersion: '1.0', user: { isAuthenticated: true, userName: 'dsh-a2a' } });
      if (stopped) { res.writeHead(503); res.end(); return; }
      const result = await transport.handle(body, context);
      if (!(Symbol.asyncIterator in result)) {
        res.writeHead(200, { 'Content-Type': 'application/a2a+json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)); return;
      }
      const iterator = result[Symbol.asyncIterator]();
      const first = await iterator.next();
      res.writeHead(200, SSE_HEADERS);
      res.flushHeaders();
      responses.add(res);
      const closed = Symbol('closed');
      let onClose!: () => void;
      const disconnect = new Promise<typeof closed>(resolve => { onClose = () => resolve(closed); res.once('close', onClose); });
      try {
        if (!first.done) res.write(formatSSEEvent(first.value));
        while (!first.done && !res.destroyed) {
          const next = await Promise.race([iterator.next(), disconnect]);
          if (next === closed || next.done) break;
          res.write(formatSSEEvent(next.value));
        }
      } finally {
        res.off('close', onClose); responses.delete(res);
        void iterator.return().catch(() => {});
        if (!res.destroyed) res.end();
      }
    } catch (error) {
      const envelope = { jsonrpc: '2.0', id, error: JsonRpcTransportHandler.mapToJSONRPCError(error) };
      if (res.headersSent) { if (!res.destroyed) res.end(formatSSEEvent(envelope)); }
      else { res.writeHead(200, { 'Content-Type': 'application/a2a+json' }); res.end(JSON.stringify(envelope)); }
    }
  };
  const handler = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pending = serve(req, res);
    requests.set(req, pending);
    const clean = (): void => { requests.delete(req); };
    void pending.then(clean, clean);
    return pending;
  };
  return { path, card, handler, cardHandler, close: async () => {
    if (stopped) return;
    stopped = true;
    for (const res of responses) res.destroy();
    for (const req of requests.keys()) req.destroy();
    await executor.close();
    await Promise.allSettled(requests.values());
    await new Promise<void>(resolve => setImmediate(resolve));
    await sender.close();
    store.close();
  } };
}
