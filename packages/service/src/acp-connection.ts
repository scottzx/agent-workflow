/** ACP v1 JSON-RPC over WebSocket. Runtime commands remain process-local. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { agent, RequestError, PROTOCOL_VERSION, type AgentContext, type Stream, type AnyMessage, type SessionUpdate, type PromptResponse, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { WebSocket } from 'ws';
import { toSafeError, type SafeError } from '@1agents/acp-service/runtime';
import { AcpState } from './acp-state.js';
import { dispatchCommand, activeSessions, runtime, loadSessionHistory, readRuntimeRecord } from './bridge.js';

// The existing JS runtime has heterogeneous command/event payloads. They are
// private to this adapter; ACP inputs are validated by the SDK before dispatch.
type RecordValue = Record<string, any>;
const calls = new AsyncLocalStorage<{ events: RecordValue[]; active: boolean }>();
const NS = '1agents';
const EXT = '_1agents/';

/** Error envelopes have a closed projection; provider data never becomes metadata. */
function safeFailureEvent(event: RecordValue, trustedRuntimeErrors: boolean): RecordValue {
  // Process-slot admission is not a turn failure. Keep the queue position for the caller.
  if (event.code === 'CAPACITY_PENDING' || event.message === 'CAPACITY_PENDING') {
    const data = event.data && typeof event.data === 'object' ? event.data as RecordValue : {};
    return { event: event.event ?? 'error', sessionId: event.sessionId, code: 'CAPACITY_PENDING',
      message: 'CAPACITY_PENDING', scope: 'control', terminal: false, data: { position: data.position, waitedMs: data.waitedMs } };
  }
  if (['tool_call', 'tool_call_update', 'tool_result'].includes(event.event)) {
    if (event.error === undefined && event.errorCode === undefined && event.errorText === undefined) return event;
    const error = toSafeError(event.error ?? (trustedRuntimeErrors ? { code: event.errorCode, message: event.errorText } : undefined), { origin: 'service' });
    return { ...event,
      ...(event.error !== undefined ? { error } : {}),
      ...(event.errorCode !== undefined ? { errorCode: error.providerCode ?? error.code } : {}),
      ...(event.errorText !== undefined ? { errorText: error.message } : {}),
    };
  }
  const failedTurn = event.status === 'failed' && ['turn_state', 'turn_terminal', 'turn_complete', 'done'].includes(event.event);
  if (!event.error && !failedTurn && event.event !== 'error' && event.event !== 'protocol_error' && event.type !== 'error') return event;
  const safe = toSafeError(event.error ?? (trustedRuntimeErrors ? { ...event, code: event.code ?? event.errorCode } : undefined), {
    origin: 'service', operationId: event.runtimeRequestId ?? event.requestId, trustedProjection: trustedRuntimeErrors,
  });
  const value: RecordValue = {};
  for (const key of ['event', 'type', 'sessionId', 'turnId', 'requestId', 'runtimeRequestId', 'promptMessageId',
    'sequence', 'journalSequence', 'scope', 'terminal', 'status', 'responsePolicy', 'stopReason', 'stopped',
    'completedAt', 'createdAt', 'updatedAt', 'finalAnswer', 'resultText', 'sessionRef', 'summary']) {
    if (event[key] !== undefined) value[key] = event[key];
  }
  if (event.error || event.status === 'failed') return { ...value, error: safe, errorCode: safe.providerCode ?? safe.code, errorText: safe.message };
  return { ...value, ...safe, error: safe };
}

function failure(error: unknown, options?: Parameters<typeof toSafeError>[1]): RequestError {
  const safe = toSafeError(error, { origin: 'service', ...options });
  return new RequestError(-32000, safe.message, safe);
}

export interface RuntimeBackend {
  dispatch(peer: RuntimePeer, command: RecordValue): Promise<void>;
  sessions: Map<string, RecordValue>;
  record(id: string): Promise<RecordValue | undefined>;
  status(id: string): Promise<RecordValue>;
  history(id: string): Promise<RecordValue[]>;
}
const production: RuntimeBackend = {
  dispatch: dispatchCommand,
  get sessions() { return activeSessions; },
  record: id => readRuntimeRecord(id),
  status: id => runtime.getStatus({ handle: activeSessions.get(id).handle }),
  history: loadSessionHistory,
};

/** Restore ACP select tags omitted by the runtime's display projection. */
function configOptions(status: RecordValue) {
  return status.details?.configOptions ?? (status.configOptions ?? []).map((option: RecordValue) => ({ type: 'select', ...option }));
}

/** Transport framing only; SDK owns method validation and RPC correlation. */
export function webSocketStream(ws: WebSocket): Stream {
  let readableClosed = false;
  return {
    readable: new ReadableStream<AnyMessage>({
      start(controller) {
        ws.on('message', data => {
          if (readableClosed) return;
          let value: unknown;
          try { value = JSON.parse(data.toString()); }
          catch {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
            return;
          }
          if (!value || typeof value !== 'object' || Array.isArray(value) || (value as RecordValue).jsonrpc !== '2.0') {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
            return;
          }
          controller.enqueue(value as AnyMessage);
        });
        ws.once('close', () => {
          if (readableClosed) return;
          readableClosed = true;
          controller.close();
        });
        ws.once('error', () => ws.close());
      },
      cancel() {
        readableClosed = true;
        ws.close();
      },
    }),
    writable: new WritableStream<AnyMessage>({
      write(value) {
        return new Promise<void>((resolve, reject) => {
          if (ws.readyState !== 1) { reject(new Error('WebSocket disconnected')); return; }
          ws.send(JSON.stringify(value), error => error ? reject(error) : resolve());
        });
      },
    }),
  };
}

/** A runtime subscriber owned by exactly one live ACP connection. */
export class RuntimePeer {
  readyState = 1;
  _acpxReqHost?: string;
  constructor(private readonly receive: (event: RecordValue) => void, private readonly trustedRuntimeErrors = false) {}
  send(raw: string): void {
    const event = safeFailureEvent(JSON.parse(raw) as RecordValue, this.trustedRuntimeErrors);
    const call = calls.getStore();
    if (call?.active) call.events.push(event);
    this.receive(event);
  }
  async command(backend: RuntimeBackend, payload: RecordValue): Promise<RecordValue[]> {
    const events: RecordValue[] = [];
    const call = { events, active: true };
    try { await calls.run(call, () => backend.dispatch(this, payload)); }
    catch (error) { throw failure(error, { operationId: payload.requestId }); }
    finally { call.active = false; }
    const failureEvent = events.find(e => (e.event === 'error' || e.type === 'error' || e.event === 'protocol_error') && e.scope !== 'turn');
    if (failureEvent) {
      if (failureEvent.code === 'CAPACITY_PENDING' || failureEvent.message === 'CAPACITY_PENDING') {
        throw new RequestError(-32010, 'CAPACITY_PENDING', failureEvent.data);
      }
      const safe: SafeError = toSafeError(failureEvent.error ?? failureEvent, { origin: 'service', operationId: payload.requestId });
      throw new RequestError(-32000, safe.message, safe);
    }
    return events;
  }
}

function metadata(value: RecordValue): RecordValue { return value._meta?.[NS] || {}; }
function envelope(value: RecordValue): RecordValue {
  const { event: _event, ...fields } = value;
  return { [NS]: fields };
}
function updateFor(event: RecordValue, toolUpdate = false): SessionUpdate | undefined {
  const common = { _meta: envelope(event) };
  switch (event.event) {
    case 'text_delta': return { ...common, ...(event.messageId ? { messageId: event.messageId } : {}), sessionUpdate: event.type === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text: event.text || '' } };
    case 'tool_call': {
      const fields = { ...common, toolCallId: event.toolCallId, title: event.title ?? event.toolName, status: event.status,
        kind: event.kind, rawInput: event.arguments, rawOutput: event.rawOutput, content: event.content, locations: event.locations };
      return toolUpdate ? { ...fields, sessionUpdate: 'tool_call_update' }
        : { ...fields, sessionUpdate: 'tool_call', title: fields.title ?? 'Tool', status: fields.status ?? 'pending' };
    }
    case 'tool_result': return { ...common, sessionUpdate: 'tool_call_update', toolCallId: event.toolCallId, status: event.isError ? 'failed' : 'completed',
      ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : event.text ? { rawOutput: event.text } : {}),
      ...(event.content !== undefined ? { content: event.content } : event.text ? { content: [{ type: 'content' as const, content: { type: 'text' as const, text: event.text } }] } : {}) };
    case 'mode_changed': return { ...common, sessionUpdate: 'current_mode_update', currentModeId: event.payload.currentModeId };
    case 'available_commands_update': return { ...common, sessionUpdate: 'available_commands_update', availableCommands: event.payload.availableCommands.map((c: RecordValue) => ({ name: c.name, description: c.description || '', ...(c.hasInput ? { input: { hint: c.inputHint || 'Arguments' } } : {}) })) };
    case 'plan': return { ...common, sessionUpdate: 'plan', entries: event.entries || event.payload?.entries || [] };
    default: return undefined;
  }
}
/** Each endpoint binds the connection to one Agent, including session reloads. */
export function attachAcpConnection(ws: WebSocket, req?: IncomingMessage, backend: RuntimeBackend = production, state = new AcpState()) {
  const endpoint = new URL(req?.url || '/', 'http://localhost');
  let agentName = 'codex';
  try {
    if (endpoint.pathname !== '/') {
      if (!endpoint.pathname.startsWith('/agents/')) throw new Error('Unknown ACP endpoint');
      agentName = decodeURIComponent(endpoint.pathname.slice(8));
      if (!/^[a-zA-Z0-9_-]+$/.test(agentName)) throw new Error('Invalid Agent name');
    }
  } catch { ws.close(1008, 'Use /agents/<agent>'); return; }
  let initialized = false;
  let connected = true;
  let extensions = false;
  let client: AgentContext;
  let output = Promise.resolve();
  const held = new Map<string, RecordValue[]>();
  const attached = new Set<string>();
  const prompts = new Map<string, { sessionId: string; requestId: string; turnId?: string; resolve: (v: PromptResponse) => void; reject: (e: Error) => void }>();
  const interactive = new Map<string, { abort: AbortController; sessionId: string }>();
  const answers = new Map<string, string>();
  const toolsSeen = new Set<string>();
  // The production bridge already projects runtime errors before serialization.
  // Injected backends do not inherit that provenance for self-asserted fields.
  const peer = new RuntimePeer(receive, backend === production);
  peer._acpxReqHost = req?.headers.host?.split(':')[0];

  function notify(method: string, params: RecordValue) {
    if (!connected) return;
    output = output.then(() => client.notify(method, params)).catch(error => {
      if (!connected) return;
      for (const pending of prompts.values()) pending.reject(failure(error, { origin: 'transport', operationId: pending.requestId, outcomeUnknown: true }));
      prompts.clear();
      ws.close(1011, 'ACP update delivery failed');
    });
  }
  function requireInitialized() { if (!initialized) throw new RequestError(-32002, 'Call initialize first'); }
  function requireSession(id: string) {
    requireInitialized();
    if (!attached.has(id) || backend.sessions.get(id)?.ws !== peer) throw new RequestError(-32001, 'Session is not attached to this connection');
  }
  async function interaction(event: RecordValue) {
    const { sessionId, requestId } = event;
    if (interactive.has(requestId)) return;
    const abort = new AbortController();
    interactive.set(requestId, { abort, sessionId });
    try {
      let response: RecordValue;
      let action: string;
      if (event.event === 'permission_request') {
        const options = event.options || [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ];
        const result = await client.request<RequestPermissionResponse>('session/request_permission', {
          sessionId, toolCall: event.toolCall || { toolCallId: event.toolCallId, title: event.toolName, rawInput: event.arguments }, options,
          _meta: envelope(event),
        }, { cancellationSignal: abort.signal });
        const selected = result.outcome.outcome === 'selected' ? options.find((o: RecordValue) => o.optionId === (result.outcome as RecordValue).optionId) : undefined;
        response = { behavior: selected?.kind || 'cancel' };
        action = 'respond_permission';
      } else {
        action = `respond_${event.event}`;
        if (!extensions) response = { outcome: event.event === 'exit_plan_mode' ? 'abandoned' : 'cancelled' };
        else response = await client.request<RecordValue>(`_x.ai/${event.event}`, { ...event, event: undefined }, { cancellationSignal: abort.signal });
      }
      if (!abort.signal.aborted && connected && backend.sessions.get(sessionId)?.ws === peer) {
        await peer.command(backend, { ...response, action, sessionId, requestId });
      }
    } catch {
      // Disconnection leaves the session-owned interaction pending for replay.
      // A connected client rejecting an unsupported method cancels that interaction.
      if (connected && !abort.signal.aborted && backend.sessions.get(sessionId)?.ws === peer) {
        await peer.command(backend, { action: `respond_${event.event === 'permission_request' ? 'permission' : event.event}`, sessionId, requestId, behavior: 'cancel', outcome: event.event === 'exit_plan_mode' ? 'abandoned' : 'cancelled' }).catch(() => {});
      }
    } finally { if (interactive.get(requestId)?.abort === abort) interactive.delete(requestId); }
  }
  function receive(event: RecordValue) {
    const sessionId = event.sessionId;
    const buffer = held.get(sessionId);
    if (buffer) { buffer.push(event); return; }
    if (event.event === 'session_taken_over' || event.event === 'session_closed') {
      attached.delete(sessionId);
      for (const item of interactive.values()) if (item.sessionId === sessionId) item.abort.abort();
      for (const [key, pending] of prompts) if (pending.sessionId === sessionId) {
        prompts.delete(key);
        if (event.event === 'session_closed') pending.resolve({ stopReason: 'cancelled' });
        else pending.reject(new RequestError(-32000, 'Session taken over by another connection'));
      }
    }
    if (['permission_request', 'ask_user_question', 'exit_plan_mode'].includes(event.event)) { if (connected) void interaction(event); return; }
    if (event.event?.endsWith('_timeout')) interactive.get(event.requestId)?.abort.abort();
    const summary = backend.sessions.get(sessionId)?.acpResponsePolicy === 'summary';
    if (event.event === 'text_delta' && event.type !== 'thought') answers.set(sessionId, (answers.get(sessionId) || '') + (event.text || ''));
    let update = updateFor(event, event.event === 'tool_call' && toolsSeen.has(`${sessionId}:${event.toolCallId}`));
    if (update?.sessionUpdate === 'tool_call') {
      const key = `${sessionId}:${update.toolCallId}`;
      toolsSeen.add(key);
    }
    if (update) {
      state.append(sessionId, update);
      if (!summary) notify('session/update', { sessionId, update });
    }
    else if (event.event === 'session_meta') {
      if (event.payload.configOptions) notify('session/update', { sessionId, update: { sessionUpdate: 'config_option_update', configOptions: configOptions(event.payload) } });
      if (extensions) notify(`${EXT}session/meta`, { ...event, event: undefined });
    } else if (extensions && event.type !== 'sessions_list' && !['session_ready', 'done'].includes(event.event) && (!summary || !['turn_state', 'turn_sync', 'background_task', 'usage'].includes(event.event))) {
      const { event: name, type, ...params } = event;
      notify(`${EXT}events/${name || type}`, { ...params, ...(name ? { type } : { _meta: { [NS]: { viewType: true } } }) });
    }
    const terminal = (event.event === 'turn_state' && ['completed', 'failed', 'cancelled'].includes(event.status)) || event.event === 'done' || event.event === 'turn_terminal' || (event.event === 'error' && event.terminal !== false && event.scope === 'turn');
    if (terminal) {
      if (summary && event.event !== 'turn_state') {
        const finalAnswer = event.finalAnswer ?? event.resultText ?? answers.get(sessionId) ?? event.summary ?? '';
        event = { ...event, responsePolicy: 'summary', resultText: finalAnswer, summary: finalAnswer, sessionRef: { sessionId, turnId: event.turnId } };
        if (extensions) notify(`${EXT}events/turn_complete`, { ...event, event: undefined });
      }
      answers.delete(sessionId);
      const entry = [...prompts.entries()].find(([, p]) => p.sessionId === sessionId && ((event.turnId && event.turnId === p.turnId) || ((event.runtimeRequestId || event.requestId) && (event.runtimeRequestId || event.requestId) === p.requestId) || (!event.turnId && !event.runtimeRequestId && !event.requestId)));
      if (!entry) return;
      const [key, pending] = entry;
      prompts.delete(key);
      void output.then(() => {
        if (event.status === 'failed' || event.event === 'error') pending.reject(failure(event.error ?? event, { operationId: pending.requestId }));
        else pending.resolve({ stopReason: event.stopped || event.status === 'cancelled' ? 'cancelled' : ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(event.stopReason) ? event.stopReason : 'end_turn', _meta: envelope(event) });
      });
    }
  }
  async function ensure(params: RecordValue, fresh: boolean, replay: boolean, signal?: AbortSignal) {
    requireInitialized();
    signal?.throwIfAborted();
    // Read-only status/replay work may be abandoned after cancellation; the
    // dispatch that owns process creation is always awaited and explicitly closed.
    async function readWhileActive<T>(operation: Promise<T>): Promise<T> {
      if (!signal) return operation;
      signal.throwIfAborted();
      let abort!: () => void;
      const canceled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      try { return await Promise.race([operation, canceled]); }
      finally { signal.removeEventListener('abort', abort); }
    }
    if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw RequestError.invalidParams('cwd must be absolute');
    try { params = { ...params, cwd: realpathSync(params.cwd) }; }
    catch { throw RequestError.invalidParams('cwd must name an existing directory'); }
    const id = fresh ? randomUUID() : params.sessionId;
    const custom = extensions ? metadata(params) : {};
    const stored = state.get(id);
    const record = fresh ? undefined : await readWhileActive(backend.record(stored?.runtimeRecordId || id));
    signal?.throwIfAborted();
    if (!fresh) {
      const live = backend.sessions.get(id);
      const binding = state.get(id);
      if (binding?.deleted) throw new RequestError(-32003, 'Session was deleted');
      if (!live && !record) throw new RequestError(-32001, 'Session not found');
      if ((live?.handle?.cwd || record?.cwd) !== params.cwd) throw RequestError.invalidParams('Session workspace cannot change');
      if (binding && binding.agentType !== agentName) throw RequestError.invalidParams('Session Agent cannot change');
      if (replay && !binding?.completeHistory) throw new RequestError(-32000, 'Imported session has no complete ACP replay log; use session/resume');
      if (live && live.agentType !== agentName) throw RequestError.invalidParams('Session Agent cannot change');
      if (record?._meta?.[NS]?.agentType && record._meta[NS].agentType !== agentName) throw RequestError.invalidParams('Session Agent cannot change');
    }
    if (held.has(id)) throw new RequestError(-32000, 'Session attachment is already in progress');
    const previousSession = backend.sessions.get(id);
    const previousPeer = previousSession?.ws;
    const previousResponsePolicy = previousSession?.acpResponsePolicy;
    const previouslyAttached = attached.has(id);
    held.set(id, []);
    let dispatchStarted = false;
    let abortCleanup: Promise<unknown> | undefined;
    let restoredExisting = false;
    const closeOwnedStartup = async () => {
      const current = backend.sessions.get(id);
      if (previousSession && current === previousSession) {
        // A canceled reattachment must preserve the user's original live turn.
        if (current.ws === peer) {
          current.ws = previousPeer;
          current.acpResponsePolicy = previousResponsePolicy;
          restoredExisting = true;
        }
        return;
      }
      // Ownership may have passed to another successful attachment while a
      // canceled request was awaiting status. Never close that connection.
      if (current && current.ws !== peer) return;
      await peer.command(backend, { action: 'close_session', sessionId: id, initializationSignal: signal });
    };
    const abort = () => {
      if (!dispatchStarted) return;
      // The client does not know a fresh session's ID yet. Cancel its private
      // initialization immediately, including while dispatch is awaiting capacity.
      abortCleanup ??= closeOwnedStartup().catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      dispatchStarted = true;
      const events = await peer.command(backend, { ...custom, action: 'ensure_session', sessionId: id, workspacePath: params.cwd, agentType: agentName, mcpServers: params.mcpServers, runtimeSessionKey: stored?.runtimeRecordId, resumeSessionId: fresh ? custom.resumeSessionId : record?.acpSessionId, responsePolicy: 'stream', initializationSignal: signal });
      signal?.throwIfAborted();
      state.create({ sessionId: id, agentType: agentName, cwd: params.cwd, completeHistory: fresh ? !custom.resumeSessionId : stored?.completeHistory === true, runtimeRecordId: backend.sessions.get(id)?.handle?.acpxRecordId });
      attached.add(id);
      const session = backend.sessions.get(id);
      if (session) session.acpResponsePolicy = custom.responsePolicy || session.acpResponsePolicy || 'stream';
      for (const update of state.history(id)) if (update.sessionUpdate === 'tool_call') toolsSeen.add(`${id}:${update.toolCallId}`);
      if (replay) {
        for (const update of state.history(id)) {
          notify('session/update', { sessionId: id, update });
        }
        await readWhileActive(output);
        signal?.throwIfAborted();
      }
      const status = await readWhileActive(backend.status(id));
      signal?.throwIfAborted();
      if (backend.sessions.get(id)?.ws !== peer) throw new RequestError(-32000, 'Session taken over during attachment');
      if (status.availableCommands) {
        notify('session/update', { sessionId: id, update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: status.availableCommands.map((c: RecordValue) => ({ name: c.name, description: c.description || '', ...(c.hasInput ? { input: { hint: c.inputHint || 'Arguments' } } : {}) })),
        } });
        await readWhileActive(output);
        signal?.throwIfAborted();
      }
      const ready = events.find(e => e.event === 'session_ready') || {};
      signal?.throwIfAborted();
      if (previousSession && backend.sessions.get(id) === previousSession && previousSession.ws === peer &&
          previousPeer && previousPeer !== peer && previousPeer.readyState === 1) {
        previousPeer.send(JSON.stringify({ event: 'session_taken_over', sessionId: id }));
      }
      return { ...(fresh ? { sessionId: id } : {}), ...(status.modes ? { modes: status.modes } : {}), configOptions: configOptions(status), _meta: { [NS]: { agentSessionId: ready.agentSessionId, turnProtocolVersion: 3, agentType: agentName } } };
    } catch (error) {
      if (signal?.aborted && dispatchStarted) {
        if (!previouslyAttached) attached.delete(id);
        abort();
        await abortCleanup;
        // A backend may finish attachment after the first close was sent.
        // Awaiting dispatch and then closing again retires that late handle too.
        await closeOwnedStartup();
        signal.throwIfAborted();
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      const buffered = held.get(id) || [];
      held.delete(id);
      if (signal?.aborted && restoredExisting && previousPeer && previousPeer !== peer && backend.sessions.get(id)?.ws === previousPeer) {
        for (const event of buffered) previousPeer.send(JSON.stringify(event));
      }
      for (const event of signal?.aborted && !previouslyAttached ? [] : buffered) {
        // The explicit load replay is the standard transcript; runtime history
        // snapshots are emitted only as negotiated application extensions.
        receive(event);
      }
    }
  }
  const app = agent({ name: '1agents-acp-service' })
    .onRequest('initialize', ({ params }) => {
      if (initialized) throw RequestError.invalidRequest('Already initialized');
      initialized = true;
      extensions = params.clientCapabilities?._meta?.[NS] !== undefined;
      return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: '1agents-acp-service', version: '0.2.0' }, authMethods: [], agentCapabilities: { promptCapabilities: { image: true, audio: true }, loadSession: true, sessionCapabilities: { resume: {}, close: {}, list: {}, delete: {} }, _meta: { [NS]: { version: 1, agentType: agentName, interactions: true, turnSync: true } } } };
    })
    .onRequest('authenticate', () => { requireInitialized(); throw RequestError.invalidParams('No connection authentication methods are configured'); })
    .onRequest('session/new', async ({ params, signal }) => await ensure(params, true, false, signal) as { sessionId: string })
    .onRequest('session/load', ({ params, signal }) => ensure(params, false, true, signal))
    .onRequest('session/resume', ({ params, signal }) => ensure(params, false, false, signal))
    .onRequest('session/prompt', async ({ params, signal }) => {
      requireSession(params.sessionId);
      const custom = extensions ? metadata(params) : {};
      if (!custom.turnManaged && ([...prompts.values()].some(p => p.sessionId === params.sessionId) || backend.sessions.get(params.sessionId)?.activeTurn)) throw new RequestError(-32000, 'Session is busy');
      const requestId = typeof custom.requestId === 'string' ? custom.requestId : randomUUID();
      const key = `${params.sessionId}:${requestId}`;
      if (prompts.has(key)) throw new RequestError(-32000, 'Prompt request is already in flight');
      if (params.prompt.some(block => !['text', 'image', 'audio'].includes(block.type))) throw RequestError.invalidParams('Unsupported prompt content');
      const attachments = params.prompt.filter(b => b.type === 'image' || b.type === 'audio').map(b => ({ mediaType: b.mimeType, data: b.data }));
      // The installed runtime accepts text followed by attachments; reject orders
      // it cannot preserve instead of silently rewriting model-visible content.
      let mediaSeen = false;
      for (const block of params.prompt) {
        if (block.type !== 'text') mediaSeen = true;
        else if (mediaSeen) throw RequestError.invalidParams('Text must precede attachments');
      }
      const result = new Promise<PromptResponse>((resolve, reject) => prompts.set(key, { sessionId: params.sessionId, requestId, turnId: custom.turnId, resolve, reject }));
      // Connection loss preserves the turn. Explicit request cancellation while
      // connected follows the same path as session/cancel.
      signal.addEventListener('abort', () => { if (connected) void peer.command(backend, { action: 'cancel_turn', sessionId: params.sessionId, turnId: custom.turnId }).catch(() => {}); }, { once: true });
      try {
        for (const content of params.prompt) state.append(params.sessionId, { sessionUpdate: 'user_message_chunk', content });
        const session = backend.sessions.get(params.sessionId);
        if (session && custom.responsePolicy) session.acpResponsePolicy = custom.responsePolicy;
        await peer.command(backend, { ...custom, responsePolicy: 'stream', requestId, attachments, action: 'prompt', sessionId: params.sessionId, text: params.prompt.map(b => b.type === 'text' ? b.text : '').join('') });
      } catch (error) { prompts.delete(key); throw error; }
      return result;
    })
    .onNotification('session/cancel', async ({ params }) => { requireSession(params.sessionId); await peer.command(backend, { action: 'cancel_turn', sessionId: params.sessionId }); })
    .onRequest('session/close', async ({ params }) => { requireSession(params.sessionId); await peer.command(backend, { action: 'close_session', sessionId: params.sessionId }); attached.delete(params.sessionId);
      for (const [key, pending] of prompts) if (pending.sessionId === params.sessionId) { prompts.delete(key); pending.resolve({ stopReason: 'cancelled' }); }
      return {}; })
    .onRequest('session/set_mode', async ({ params }) => { requireSession(params.sessionId); await peer.command(backend, { action: 'set_session_mode', sessionId: params.sessionId, payload: { modeId: params.modeId } }); return {}; })
    .onRequest('session/set_config_option', async ({ params }) => { requireSession(params.sessionId); await peer.command(backend, { action: 'set_config_option', sessionId: params.sessionId, payload: { key: params.configId, value: params.value } }); return { configOptions: configOptions(await backend.status(params.sessionId)) }; })
    .onRequest('session/list', async ({ params }) => {
      requireInitialized();
      if (params.cursor) throw RequestError.invalidParams('Unknown session list cursor');
      const bindings = state.list().filter(s => !s.deleted && s.agentType === agentName && (!params.cwd || s.cwd === params.cwd));
      const sessions = [];
      for (const binding of bindings) {
        const record = await backend.record(binding.runtimeRecordId || binding.sessionId);
        if (!record) continue;
        const live = backend.sessions.get(binding.sessionId);
        sessions.push({ sessionId: binding.sessionId, cwd: binding.cwd, title: record.name, updatedAt: record.lastUsedAt || record.createdAt,
          _meta: { [NS]: { agentCommand: record.agentCommand, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt, status: live?.activeTurn ? 'running' : 'idle', closed: false } } });
      }
      return { sessions };
    });
  app.onRequest('session/delete', async ({ params }) => {
    requireInitialized();
    const binding = state.get(params.sessionId);
    if (!binding || binding.deleted || binding.agentType !== agentName) throw new RequestError(-32001, 'Session not found');
    const owner = backend.sessions.get(params.sessionId)?.ws;
    await peer.command(backend, { action: 'close_session', sessionId: params.sessionId });
    owner?.send(JSON.stringify({ event: 'session_closed', sessionId: params.sessionId }));
    await peer.command(backend, { action: 'delete_session', sessionId: params.sessionId, runtimeRecordId: binding.runtimeRecordId });
    state.create({ ...binding, deleted: true });
    attached.delete(params.sessionId);
    return {};
  });
  app.onRequest(`${EXT}sessions/close_all`, (value: unknown) => value, async () => {
    requireInitialized();
    if (!extensions) throw RequestError.methodNotFound(`${EXT}sessions/close_all`);
    const owners = [...backend.sessions].map(([sessionId, session]) => ({ sessionId, peer: session.ws }));
    await peer.command(backend, { action: 'close_all_sessions' });
    for (const owner of owners) owner.peer?.send(JSON.stringify({ event: 'session_closed', sessionId: owner.sessionId }));
    return {};
  });
  app.onRequest(`${EXT}session/import`, (value: unknown): RecordValue => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw RequestError.invalidParams('Expected object');
    return value as RecordValue;
  }, async ({ params, signal }) => {
    requireInitialized();
    if (!extensions || typeof params.sessionId !== 'string' || !params.sessionId) throw RequestError.invalidParams('Native session ID required');
    return ensure({ ...params, _meta: { [NS]: { ...metadata(params), resumeSessionId: params.sessionId, capacityId: `import:${params.sessionId}` } } }, true, false, signal);
  });
  app.onRequest(`${EXT}capacity/cancel`, (value: unknown): RecordValue => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw RequestError.invalidParams('Expected object');
    return value as RecordValue;
  }, async ({ params }) => {
    requireInitialized();
    if (!extensions) throw RequestError.methodNotFound(`${EXT}capacity/cancel`);
    if (typeof params.capacityId !== 'string' || !params.capacityId.trim() || params.capacityId.length > 4096) throw RequestError.invalidParams('capacityId is required');
    await peer.command(backend, { action: 'capacity_cancel', capacityId: params.capacityId });
    return {};
  });
  const controls: Record<string, string> = { 'session/history': 'get_history', 'session/permission_mode': 'set_permission_mode', 'session/cancel_queued': 'cancel_queued', 'session/fork': 'fork_session', 'session/authenticate': 'authenticate', 'session/logout': 'logout' };
  for (const [method, action] of Object.entries(controls)) {
    app.onRequest(`${EXT}${method}`, (value: unknown): RecordValue => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw RequestError.invalidParams('Expected object');
      return value as RecordValue;
    }, async ({ params }) => {
      requireSession(params.sessionId);
      if (!extensions) throw RequestError.methodNotFound(method);
      const events = await peer.command(backend, { ...params, action });
      if (action === 'fork_session') {
        const fork = events.find(e => e.type === 'session_forked')?.payload?.session;
        if (fork) state.create({ sessionId: fork.id, agentType: agentName, cwd: fork.cwd, completeHistory: false });
      }
      if (action === 'get_history') return { items: events.find(e => e.event === 'history_response')?.items || [] };
      if (action === 'fork_session') return events.find(e => e.type === 'session_forked')?.payload || {};
      if (action === 'set_permission_mode') return { permissionMode: params.permissionMode };
      return {};
    });
  }
  ws.once('close', () => {
    connected = false;
    for (const item of interactive.values()) item.abort.abort();
    for (const pending of prompts.values()) pending.reject(failure(undefined, { origin: 'transport', operationId: pending.requestId, outcomeUnknown: true }));
    prompts.clear();
  });
  const connection = app.connect(webSocketStream(ws));
  client = connection.client;
  return connection;
}
