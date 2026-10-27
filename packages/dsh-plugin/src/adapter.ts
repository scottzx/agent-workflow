/** Presents an external Agent's output through DSH's existing streaming surface. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LlmAdapter, GenerateOptions, StreamChunk, LlmModelInfo, ContentBlock, MessageId } from '@deepseek-ai/dsh-llm';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { Diagnostics } from './diagnostics.js';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type { NewSessionRequest, SessionUpdate, RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionModeState, AvailableCommand } from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import { connect, object, type JsonObject } from './transport.js';
import { State, hasActiveWriter, type Binding } from './state.js';
import { mergeTool, type RemoteTool } from './tool-events.js';
import { toSafeError } from '@1agents/acp-service/runtime';
import { capacityPendingOf, noteProcessCapacity, noteProcessReady, noteSessionRestore, requestWhenAdmitted } from './process-admission.js';
export interface SessionPolicy {
  /** Exact workspace and ACP registry name; no global or wildcard policy. */
  cwd: string;
  agent: string;
  permissionMode: 'approve-reads' | 'approve-all' | 'deny-all';
  initialModeId?: string;
}
export interface Config { serviceUrl: string; agents: string[]; stateDirectory: string; reconnectAttempts: number; reconnectDelayMs: number; sessionPolicies?: SessionPolicy[] }
export function validateSessionPolicies(policies: SessionPolicy[] = []): SessionPolicy[] {
  const seen = new Set<string>();
  if (!Array.isArray(policies)) throw new Error('sessionPolicies must be an array');
  return policies.map(policy => {
    if (!policy || typeof policy.cwd !== 'string' || !isAbsolute(policy.cwd)
      || typeof policy.agent !== 'string' || !/^[a-z0-9_-]+$/i.test(policy.agent)
      || !['approve-reads', 'approve-all', 'deny-all'].includes(policy.permissionMode)
      || (policy.initialModeId !== undefined && (typeof policy.initialModeId !== 'string' || !policy.initialModeId))) {
      throw new Error('Invalid workspace-scoped ACP session policy');
    }
    const normalized = { ...policy, cwd: resolve(policy.cwd) };
    const key = JSON.stringify([normalized.cwd, normalized.agent]);
    if (seen.has(key)) throw new Error('Duplicate workspace-scoped ACP session policy');
    seen.add(key); return normalized;
  });
}
export interface Capabilities {
  agent: string;
  writable?: boolean;
  blocked?: 'active-writer';
  commands: AvailableCommand[];
  configOptions: SessionConfigOption[];
  modes?: SessionModeState;
}
type Link = Awaited<ReturnType<typeof connect>>;
/** A failed remote close must keep its identity until the host explicitly recovers it. */
type RecoveringBinding = Binding & { initializationCleanupPending?: true };
const recoveryMessage = 'ACP session initialization failed and remote cleanup could not be confirmed; host recovery is required before retrying.';
type AcpStream = { turn: number; step: number; requestId: string; messagePhase?: 'commentary' | 'final_answer'; messageId?: string };

/** Only the negotiated service's direct canonical error data is a projection. */
function serviceProjection(error: unknown): JsonObject | undefined {
  if (!(error instanceof RequestError) || error.code !== -32000
    || !error.data || typeof error.data !== 'object' || Array.isArray(error.data)) return;
  const data = error.data as JsonObject;
  if (typeof data.category !== 'string' || !['quota', 'rate_limit', 'budget', 'auth', 'cancelled', 'timeout', 'permission', 'unknown'].includes(data.category)) return;
  if (typeof data.origin !== 'string' || !['cli', 'runtime', 'queue', 'acp', 'service', 'transport', 'dsh', 'a2a'].includes(data.origin)) return;
  if (typeof data.retryable !== 'boolean' || typeof data.outcomeUnknown !== 'boolean') return;
  return data;
}

/** Only actual cancellation rejections may replace a racing provider failure. */
function isDeletedAcpSession(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === -32003 || value.message === 'Session was deleted';
}

function isCancellationRejection(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  // The SDK leaves a canceled request pending for the peer's reply. A real
  // service error can still arrive; only its cancellation reply is an abort.
  if (error instanceof RequestError) return error.code === -32800;
  // node:timers/promises rejects its canceled reconnect delay with this cause.
  return error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason;
}

const ownedFailures = new WeakMap<Error, ReturnType<typeof toSafeError>>();

/** The official host receives its normal error; complete facts live in the plugin domain. */
function publicFailure(safe: ReturnType<typeof toSafeError>, _requestId: string): LlmError {
  const error = Object.assign(new LlmError(safe.message, safe.code ?? 'ACP_TURN_FAILED'), safe);
  ownedFailures.set(error, safe); return error;
}

/** Producer/consumer queue; errors are delivered after already received chunks. */
class Queue<T> {
  values: T[] = []; done = false; error: unknown;
  private wake = Promise.withResolvers<void>();
  push(value: T) { this.values.push(value); this.wake.resolve(); }
  end(error?: unknown) { this.done = true; this.error = error; this.wake.resolve(); }
  async *read() {
    while (true) {
      while (this.values.length) yield this.values.shift()!;
      if (this.done) { if (this.error) throw this.error; return; }
      await this.wake.promise;
      this.wake = Promise.withResolvers<void>();
    }
  }
}

export class AcpAdapter implements LlmAdapter {
  private state: State;
  private initializationFailures = new Map<string, Error>();
  private controllers = new Map<string, AbortController>();
  private jobs = new Set<Promise<void>>();
  private links = new Map<string, Promise<Link>>();
  private connections = new Map<string, Promise<Link>>();
  private capabilities = new Map<string, Capabilities>();
  private commandScopes = new Map<string, () => Promise<unknown>>();
  private commandContexts = new Map<string, Context>();
  private commandDisposers = new Map<string, (() => void)[]>();
  private output = new Map<string, (update: SessionUpdate) => void>();
  private lifetime = new AbortController();
  constructor(private ctx: Context, private config: Config, private readonly diagnostics?: Diagnostics) { this.state = new State(config.stateDirectory); }
  providerInfo(provider: string) { return { id: provider, name: 'ACP Agents' }; }
  providerRetryPolicy() { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }; }
  imageRequestPricing() { return undefined; }
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    return [];
  }
  async resolveModel(provider: string, model: string) {
    if (!this.config.agents.includes(model)) throw new Error(`ACP Agent is not configured: ${model}`);
    return { provider, id: model, name: `ACP · ${model}`, inputModalities: ['text' as const] };
  }
  async prepareCall(provider: string, model: string) { return { model: await this.resolveModel(provider, model), stream: (o: GenerateOptions) => this.stream(o) }; }
  async dispose() {
    for (const c of this.controllers.values()) c.abort();
    this.lifetime.abort();
    await Promise.allSettled(this.jobs);
    for (const link of await Promise.allSettled(this.links.values())) if (link.status === 'fulfilled') link.value.close();
    for (const disposers of this.commandDisposers.values()) for (const dispose of disposers) dispose();
    this.links.clear();
    await Promise.allSettled([...this.commandScopes.values()].map(dispose => dispose()));
    this.commandScopes.clear();
    this.commandContexts.clear();
  }
  agentName(agent: Agent): string | undefined {
    const preset = this.ctx.sessionProjections.stateOf(agent.session, 'agentPreset');
    if (typeof preset !== 'string' || !preset.startsWith('oneagents-acp-')) return;
    const name = preset.slice('oneagents-acp-'.length);
    return this.config.agents.includes(name) ? name : undefined;
  }
  async describe(agent: Agent): Promise<Capabilities | null> {
    const name = this.agentName(agent);
    if (!name) return null;
    try { await this.connection(agent); }
    catch (error) {
      if (!this.state.get(agent.id)?.imported || !hasActiveWriter(error)) throw error;
      return { agent: name, commands: [], configOptions: [], writable: false, blocked: 'active-writer' };
    }
    return { ...this.capabilities.get(agent.id)!, writable: true };
  }
  async configure(agent: Agent, configId: string, value: string): Promise<Capabilities> {
    if (this.controllers.has(agent.id)) throw new Error('Wait for the current ACP turn to finish before changing configuration');
    const link = await this.connection(agent);
    const sessionId = this.state.get(agent.id)!.sessionId!;
    const capabilities = this.capabilities.get(agent.id)!;
    if (configId === '$mode') {
      if (!capabilities.modes?.availableModes.some(m => m.id === value)) throw new Error('Unknown ACP mode');
      await link.rpc.request('session/set_mode', { sessionId, modeId: value });
      capabilities.modes.currentModeId = value;
    } else {
      const option = capabilities.configOptions.find(o => o.id === configId);
      if (!option) throw new Error('Unknown ACP configuration');
      const result = await link.rpc.request('session/set_config_option', { sessionId, configId, value });
      capabilities.configOptions = result.configOptions;
    }
    return capabilities;
  }
  /** Import native history without prompting; callers persist the returned service identity before creating DSH history.
   * @param name Configured ACP registry identifier.
   * @param cwd Existing original working directory.
   * @param nativeSessionId Original Agent session identifier.
   * @returns Binding using the service’s new identity and resume restoration mode.
   */
  async importNative(name: string, cwd: string, nativeSessionId: string): Promise<Binding> {
    if (!this.config.agents.includes(name)) throw new Error(`ACP Agent is not configured: ${name}`);
    const endpoint = new URL(`/agents/${encodeURIComponent(name)}`, this.config.serviceUrl);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const task = (async () => {
      const link = await connect(endpoint.href, {
        update: () => {},
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
        question: async () => ({ outcome: 'cancelled' }),
        plan: async () => ({ outcome: 'abandoned' }),
      }, this.lifetime.signal);
      try {
        const capacityId = `import:${nativeSessionId}`;
        const result = object(await requestWhenAdmitted({
          signal: this.lifetime.signal,
          isPending: capacityPendingOf,
          cancel: async () => { await link.rpc.request('_1agents/capacity/cancel', { capacityId }).catch(() => undefined); },
          request: () => link.rpc.request('_1agents/session/import', {
            sessionId: nativeSessionId, cwd, mcpServers: [],
            _meta: { '1agents': { permissionMode: 'approve-reads', capacityId } },
          }, { cancellationSignal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]) }),
        }));
        if (typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('ACP import returned no service session ID');
        return { agent: name, cwd, endpoint: endpoint.href, sessionId: result.sessionId, restoreMethod: 'session/resume' as const };
      } finally { link.close(); await link.closed; }
    })();
    const settled = task.then(() => {}, () => {});
    this.jobs.add(settled);
    try { return await task; } finally { this.jobs.delete(settled); }
  }
  private publishCommands(agent: Agent, commands: AvailableCommand[]): void {
    const scope = this.commandContexts.get(agent.id);
    if (!scope) return; // A final transport notification may follow Agent disposal.
    for (const dispose of this.commandDisposers.get(agent.id) ?? []) dispose();
    const disposers: (() => void)[] = [];
    this.commandDisposers.set(agent.id, disposers);
    for (const command of commands) {
      // /model is the client picker over the Agent's advertised model options.
      if (command.name === 'model' || !/^[a-z][a-z0-9_-]*$/.test(command.name)) continue;
      disposers.push(scope.commands.register({
        name: command.name, description: command.description || `ACP /${command.name}`,
        ...(command.input ? { input: { hint: command.input.hint || 'Arguments' } } : {}),
        handler: ({ rawInput }) => {
          agent.followup({ id: randomUUID() as MessageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `/${command.name}${rawInput}` }] });
          return { kind: 'success' };
        },
      }));
    }
  }
  private async connection(agent: Agent, capacityId?: string, callerSignal?: AbortSignal): Promise<Link> {
    const operation = (this.connections.get(agent.id) ?? Promise.resolve())
      .catch(() => undefined).then(() => this.openConnection(agent, capacityId, callerSignal));
    this.connections.set(agent.id, operation);
    try { return await operation; }
    finally { if (this.connections.get(agent.id) === operation) this.connections.delete(agent.id); }
  }
  private async openConnection(agent: Agent, capacityId?: string, callerSignal?: AbortSignal): Promise<Link> {
    const name = this.agentName(agent);
    if (!name) throw new Error('ACP is available only in an ACP Agent preset; start a new ACP session');
    const cwd = agent.session.header.cwd;
    if (!cwd) throw new Error('Create the ACP session in a workspace first');
    const endpoint = new URL(`/agents/${encodeURIComponent(name)}`, this.config.serviceUrl);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const initializationFailure = this.initializationFailures.get(agent.id);
    if (initializationFailure) throw initializationFailure;
    let binding = this.state.get(agent.id);
    if (binding && 'initializationCleanupPending' in binding) throw new Error(recoveryMessage);
    if (binding && (binding.agent !== name || binding.cwd !== cwd || binding.endpoint !== endpoint.href)) {
      const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
      const previousEndpoint = new URL(`/agents/${encodeURIComponent(binding.agent)}`, this.config.serviceUrl);
      previousEndpoint.protocol = endpoint.protocol;
      if (binding.imported || !boundary || boundary.openTurnStartSeq !== null || boundary.lastTurn > 0
        || binding.agent === name || binding.cwd !== cwd || binding.endpoint !== previousEndpoint.href) {
        throw new Error('This session is bound to another ACP Agent or endpoint; start a new session');
      }
      // Capability discovery may bind a draft before its first turn.
      // Retire its transport and commands before initializing the selected Agent.
      (await this.links.get(agent.id))?.close();
      this.links.delete(agent.id);
      this.capabilities.delete(agent.id);
      for (const dispose of this.commandDisposers.get(agent.id) ?? []) dispose();
      this.commandDisposers.delete(agent.id);
      binding = undefined;
    }
    const existing = this.links.get(agent.id);
    if (existing) return existing;
    if (binding?.imported && !binding.sessionId) {
      // Retry the original native identity after its writer releases it; never open an empty replacement.
      binding = { ...await this.importNative(name, cwd, binding.imported.nativeSessionId), imported: binding.imported };
      this.state.save(agent.id, binding);
    }
    const operation = (async () => {
      if (!this.commandContexts.has(agent.id)) {
        const fiber = await agent.ctx.inject(['commands'], scope => {
          this.commandContexts.set(agent.id, scope);
          scope.effect(() => async () => {
            const link = this.links.get(agent.id), active = this.controllers.get(agent.id);
            active?.abort();
            // Keep the response transport alive while the official loop drains
            // cancellation and the plugin commits its diagnostic receipt.
            if (active) try { await agent.whenIdle(); } catch { /* The loop also reports a failed disposal. */ }
            try { (await link)?.close(); } catch { /* Connection setup already failed. */ }
            if (this.links.get(agent.id) === link) this.links.delete(agent.id);
            if (this.commandContexts.get(agent.id) === scope) {
              this.commandContexts.delete(agent.id);
              this.commandScopes.delete(agent.id);
              this.capabilities.delete(agent.id);
              this.commandDisposers.delete(agent.id);
            }
          });
        });
        this.commandScopes.set(agent.id, async () => fiber.dispose());
      }
      const capabilities: Capabilities = { agent: name, commands: [], configOptions: [] };
      this.capabilities.set(agent.id, capabilities);
      const interactionSignal = (signal: AbortSignal) => AbortSignal.any([signal, this.lifetime.signal, ...(this.controllers.has(agent.id) ? [this.controllers.get(agent.id)!.signal] : [])]);
      const link = await connect(endpoint.href, {
        update: update => {
          if (this.capabilities.get(agent.id) !== capabilities) return;
          if (update.sessionUpdate === 'available_commands_update') {
            capabilities.commands = update.availableCommands;
            this.publishCommands(agent, update.availableCommands);
          } else if (update.sessionUpdate === 'config_option_update') capabilities.configOptions = update.configOptions;
          else if (update.sessionUpdate === 'current_mode_update' && capabilities.modes) capabilities.modes.currentModeId = update.currentModeId;
          this.output.get(agent.id)?.(update);
        },
        permission: (p, s) => this.permission(agent, p, interactionSignal(s)),
        question: (p, s) => this.question(agent, p, interactionSignal(s)),
        plan: (p, s) => this.plan(agent, p, interactionSignal(s)),
      }, this.lifetime.signal);
      let createdBinding: Binding | undefined;
      try {
        const policy = this.config.sessionPolicies?.find(p => p.cwd === resolve(cwd) && p.agent === name);
        const params: NewSessionRequest = { cwd, mcpServers: [], _meta: { '1agents': {
          permissionMode: policy?.permissionMode ?? 'approve-reads', ...(capacityId ? { capacityId } : {}),
        } } };
        const admit = <T>(request: () => Promise<T>): Promise<T> => capacityId
          ? requestWhenAdmitted({
            request,
            signal: callerSignal ? AbortSignal.any([this.lifetime.signal, callerSignal]) : this.lifetime.signal,
            isPending: capacityPendingOf,
            onPending: pending => noteProcessCapacity(agent.id, pending),
            cancel: async () => { await link.rpc.request('_1agents/capacity/cancel', { capacityId }).catch(() => undefined); },
          })
          : request();
        // Queue waits return immediately. This 60s bound covers only the attempt that holds the slot.
        const handshake = () => AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000), ...(callerSignal ? [callerSignal] : [])]);
        const restoreMethod = binding ? binding.restoreMethod ?? 'session/load' : undefined;
        const result = binding
          ? await admit(() => link.rpc.request(restoreMethod!, { ...params, sessionId: binding.sessionId! }, { cancellationSignal: handshake() }))
          : await admit(() => link.rpc.request('session/new', params, { cancellationSignal: handshake() }));
        if (binding && restoreMethod) noteSessionRestore(agent.id, restoreMethod);
        if (!binding) createdBinding = { agent: name, endpoint: endpoint.href, cwd, sessionId: (result as { sessionId: string }).sessionId };
        capabilities.configOptions = result.configOptions ?? capabilities.configOptions;
        capabilities.modes = result.modes ?? undefined;
        // Select an advertised native mode before the first prompt. Loading an
        // existing session must retain its native mode and user selections.
        if (!binding && policy?.initialModeId) {
          if (!capabilities.modes?.availableModes.some(m => m.id === policy.initialModeId)) throw new Error('Configured initial ACP mode is not advertised by the Agent');
          await link.rpc.request('session/set_mode', { sessionId: (result as { sessionId: string }).sessionId, modeId: policy.initialModeId }, { cancellationSignal: handshake() });
          capabilities.modes.currentModeId = policy.initialModeId;
        }
        if (createdBinding) this.state.save(agent.id, createdBinding);
        void link.closed.then(() => { if (this.links.get(agent.id) === operation) this.links.delete(agent.id); });
        return link;
      } catch (error) {
        if (binding && isDeletedAcpSession(error)) {
          link.close();
          const deleted = new LlmError('Session was deleted', 'SESSION_DELETED');
          // The stream catch replaces unowned errors with ACP_TURN_FAILED. Keep this code.
          ownedFailures.set(deleted, toSafeError(deleted, { origin: 'acp', outcomeUnknown: false }));
          throw deleted;
        }
        let failure = error;
        if (createdBinding) {
          const cleanup = new AbortController();
          try {
            // SDK cancellation alone only notifies the peer, so bound the wait locally as well.
            await Promise.race([
              link.rpc.request('session/close', { sessionId: createdBinding.sessionId! }, { cancellationSignal: cleanup.signal }),
              delay(5000, undefined, { signal: cleanup.signal }).then(() => { throw new Error(recoveryMessage); }),
            ]);
          } catch {
            // Preserve a recovery identity rather than create another process on retry.
            const recoveryError = new Error(recoveryMessage);
            this.initializationFailures.set(agent.id, recoveryError);
            const recovering: RecoveringBinding = { ...createdBinding, initializationCleanupPending: true };
            try { this.state.save(agent.id, recovering); }
            catch { /* The in-memory guard still blocks retry if local storage is also unavailable. */ }
            failure = recoveryError;
          } finally { cleanup.abort(); }
        }
        link.close();
        throw failure;
      }
    })();
    this.links.set(agent.id, operation);
    try { return await operation; }
    catch (error) { if (this.links.get(agent.id) === operation) this.links.delete(agent.id); throw error; }
  }
  /** Ordinary ACP release. The binding, session id, and restore method stay. No session/delete. */
  async releaseSession(sessionId: string): Promise<{ processReleased: true | 'pending'; acp: boolean }> {
    const agent = this.ctx.agents.get(sessionId as never);
    if (!agent) {
      const error = new Error('Session not found') as Error & { code: string };
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    if (!this.agentName(agent)) return { processReleased: true, acp: false };
    const binding = this.state.get(agent.id);
    const pending = this.links.get(agent.id);
    const link = pending ? await pending.catch(() => undefined) : undefined;
    if (link && binding?.sessionId) {
      try {
        await link.rpc.request('session/close', { sessionId: binding.sessionId }, {
          cancellationSignal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!/not found|Session not found|-32001/i.test(message)) {
          const wrapped = new Error('Remote session close failed') as Error & { code: string };
          wrapped.code = 'REMOTE_UNAVAILABLE';
          throw wrapped;
        }
      }
      link.close();
      if (this.links.get(agent.id) === pending) this.links.delete(agent.id);
    }
    return { processReleased: 'pending', acp: true };
  }
  /**
   * Controlled delete. ACP session/delete closes the process and marks the record deleted.
   * The DSH session and its history stay. A detached session gets a bare link, so no agent process starts.
   */
  async deleteSession(sessionId: string): Promise<{ processReleased: true | 'pending'; acp: boolean }> {
    const agent = this.ctx.agents.get(sessionId as never);
    if (!agent) {
      const error = new Error('Session not found') as Error & { code: string };
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    if (!this.agentName(agent)) return { processReleased: true, acp: false };
    const binding = this.state.get(agent.id);
    if (!binding?.sessionId || 'initializationCleanupPending' in binding) return { processReleased: true, acp: true };
    const pending = this.links.get(agent.id);
    const attached = pending ? await pending.catch(() => undefined) : undefined;
    const link = attached ?? await connect(binding.endpoint, {
      update: () => {},
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      question: async () => ({ outcome: 'cancelled' }),
      plan: async () => ({ outcome: 'abandoned' }),
    }, this.lifetime.signal);
    try {
      await link.rpc.request('session/delete', { sessionId: binding.sessionId }, {
        cancellationSignal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!/not found|Session not found|-32001/i.test(message)) {
        const wrapped = new Error('Remote session delete failed') as Error & { code: string };
        wrapped.code = 'REMOTE_UNAVAILABLE';
        throw wrapped;
      }
    } finally {
      link.close();
      if (attached && this.links.get(agent.id) === pending) this.links.delete(agent.id);
    }
    return { processReleased: attached ? 'pending' : true, acp: true };
  }
  async sessionStatus(sessionId: string): Promise<{ attached: boolean; activeTurn: boolean }> {
    const agent = this.ctx.agents.get(sessionId as never);
    if (!agent) return { attached: false, activeTurn: false };
    return { attached: this.links.has(agent.id), activeTurn: this.controllers.has(agent.id) };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const agent = options.sessionId ? this.ctx.agents.get(options.sessionId) : undefined;
    if (!agent || options.purpose) throw new Error('ACP requires a foreground DSH session; auxiliary model calls are unsupported');
    if (this.controllers.has(agent.id)) throw new Error('ACP session already has a running request');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    signal.addEventListener('abort', () => controller.abort(), { once: true });
    this.controllers.set(agent.id, controller);
    const queue = new Queue<StreamChunk>();
    const task = this.run(agent, options, signal, queue).then(() => queue.end(), error => queue.end(error));
    this.jobs.add(task);
    try { yield* queue.read(); }
    finally { controller.abort(); await task; this.jobs.delete(task); this.controllers.delete(agent.id); }
  }
  private async permission(agent: Agent, params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const allow = params.options.find(o => o.kind === 'allow_once');
    const deny = params.options.find(o => o.kind === 'reject_once');
    if (!allow) return { outcome: { outcome: 'cancelled' } };
    const decision = await this.ctx.approval.request({ agent, toolName: params.toolCall.title || 'ACP tool',
      reason: JSON.stringify(params.toolCall.rawInput ?? params.toolCall.content ?? {}, null, 2), signal });
    const selected = decision === 'allowed-once' ? allow : decision === 'rejected' ? deny : undefined;
    return { outcome: selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } };
  }
  private async question(agent: Agent, p: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const questions = (Array.isArray(p.questions) ? p.questions : []).map((value, i) => {
      const q = object(value);
      return { id: String(i), question: String(q.question ?? ''), header: typeof q.header === 'string' ? q.header : undefined,
        options: Array.isArray(q.options) ? q.options.map(value => { const o = object(value); return { label: String(o.label), description: typeof o.description === 'string' ? o.description : undefined }; }) : undefined,
        multiSelect: q.multiSelect === true };
    });
    try {
      const result = await this.ctx.userQuestions.ask({ agent, questions, signal });
      return { outcome: 'accepted', answers: Object.fromEntries(result.answers.map(a => [questions[Number(a.id)].question, a.custom || (a.selected.length === 1 ? a.selected[0] : a.selected)])) };
    } catch (error) { if (signal.aborted) return { outcome: 'cancelled' }; throw error; }
  }
  private async plan(agent: Agent, p: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    try {
      const result = await this.ctx.userQuestions.ask({ agent, signal, questions: [{ id: 'plan', question: 'ACP Agent 请求执行计划', detail: String(p.planContent ?? ''), options: [{ label: '批准' }, { label: '拒绝' }], intent: { kind: 'plan-review', approve: '批准' } }] });
      return { outcome: result.answers[0]?.selected.includes('批准') ? 'approved' : 'rejected' };
    } catch (error) { if (signal.aborted) return { outcome: 'abandoned' }; throw error; }
  }
  private async run(agent: Agent, options: GenerateOptions, signal: AbortSignal, queue: Queue<StreamChunk>): Promise<void> {
    const cwd = agent.session.header.cwd;
    if (!cwd) throw new Error('Create the ACP session in a workspace first');
    // Only newly admitted input goes to the stateful remote Agent. Its native
    // conversation already owns prior turns and tool results.
    let start = options.messages.length - 1;
    while (start >= 0 && options.messages[start].role !== 'assistant') start--;
    if (this.agentName(agent) !== options.model) throw new Error('ACP is available only in its matching Agent preset; start a new ACP session');
    const importedIds = new Set(this.state.get(agent.id)?.imported?.messageIds ?? []);
    const input = options.messages.slice(start + 1).filter(m => m.role === 'user' && m.source?.kind === 'user' && (m.id === undefined || !importedIds.has(m.id)));
    const blocks = input.flatMap(m => m.content);
    if (!blocks.length || blocks.some(b => b.type !== 'text')) throw new Error('This ACP plugin currently accepts text prompts only');
    const text = blocks.map(b => (b as { text: string }).text).join('\n\n');
    const requestId = 'dsh-' + createHash('sha256').update(JSON.stringify([agent.id, input.map(m => m.id)])).digest('hex');
    const endpoint = new URL(`/agents/${encodeURIComponent(options.model)}`, this.config.serviceUrl); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    let binding = this.state.get(agent.id);
    if (binding && (binding.agent !== options.model || binding.cwd !== cwd || binding.endpoint !== endpoint.href)) throw new Error('This session is bound to another ACP Agent or endpoint; start a new session');
    const seen = new Set<number>();
    const tools = new Map<string, RemoteTool>();
    const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
    const stepStart = boundary?.lastStepStartSeq == null ? undefined : agent.session.eventAt(boundary.lastStepStartSeq);
    const turn = boundary?.lastTurn ?? 0;
    const step = stepStart?.type === 'step/start' ? stepStart.data.step : 0;
    let index = 0, current: 'text' | 'reasoning' | undefined, content = '', answer = '';
    let hasPhasedText = false, streamedFinalAnswer = false;
    let currentStream: AcpStream | undefined;
    const acpStream = { turn, step, requestId };
    const endBlock = () => { if (current) { queue.push({ type: 'block-end', index, block: { type: current, text: content, acpStream: currentStream } as ContentBlock }); index++; current = undefined; currentStream = undefined; content = ''; } };
    const emit = (kind: 'text' | 'reasoning', text: string, identity: Pick<AcpStream, 'messagePhase' | 'messageId'> = {}) => {
      if (!text) return;
      const stream = { ...acpStream, ...identity };
      if (current !== kind || currentStream?.messagePhase !== stream.messagePhase || currentStream?.messageId !== stream.messageId) {
        endBlock(); current = kind; currentStream = stream;
        queue.push({ type: 'block-start', index, blockType: kind, acpStream: stream } as StreamChunk);
      }
      content += text;
      if (kind === 'text') {
        answer += text;
        if (identity.messagePhase !== undefined) hasPhasedText = true;
        if (identity.messagePhase === 'final_answer') streamedFinalAnswer = true;
      }
      const chunk = kind === 'text' ? { type: 'text-delta' as const, index, text, acpStream: stream } : { type: 'reasoning-delta' as const, index, text, acpStream: stream };
      queue.push(chunk);
    };
    const update = (u: SessionUpdate) => {
      const meta = u._meta?.['1agents'] as JsonObject | undefined;
      if (meta?.turnId !== requestId) return;
      if (typeof meta.sequence !== 'number') return;
      if (seen.has(meta.sequence)) return;
      seen.add(meta.sequence);
      if ((u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk') && u.content.type === 'text') {
        emit(u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning', u.content.text, {
          ...(meta.messagePhase === 'commentary' || meta.messagePhase === 'final_answer' ? { messagePhase: meta.messagePhase } : {}),
          ...(typeof meta.messageId === 'string' ? { messageId: meta.messageId } : {}),
        });
      }
      else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const tool = mergeTool(tools.get(u.toolCallId), u);
        tools.set(u.toolCallId, tool);
        // Known stream records preserve plugin metadata across save/reload.
        // Empty text is inert; only the plugin projects it into remote Tool cards.
        endBlock();
        const block = { type: 'text' as const, text: '', acpTool: { turn, step, requestId, sequence: meta.sequence, tool } };
        queue.push({ type: 'block-start', index, blockType: 'text' });
        queue.push({ type: 'block-end', index, block });
        index++;
      }
    };
    let active: Awaited<ReturnType<typeof connect>> | undefined;
    let requestSent = false, nativeConfirmed = false;
    const save = async (action: () => Promise<unknown>) => {
      try { await action(); } catch {
        throw publicFailure(toSafeError(undefined, { origin: 'dsh', operationId: requestId,
          outcomeUnknown: requestSent && !nativeConfirmed }), requestId);
      }
    };
    let diagnosticId: string | undefined;
    const cancelled = (outcomeUnknown: boolean, origin: 'dsh' | 'acp' = 'dsh'): LlmError => publicFailure(
      toSafeError(new DOMException('ACP execution cancelled.', 'AbortError'), { origin, operationId: requestId, outcomeUnknown }), requestId);
    const cancel = () => { if (binding?.sessionId) void active?.rpc.notify('session/cancel', { sessionId: binding.sessionId }).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (this.diagnostics) await save(async () => {
        const turnStartSeq = boundary?.openTurnStartSeq;
        if (turnStartSeq == null) throw new Error('ACP diagnostic turn boundary is unavailable');
        // Old failed turns may have no assistant message separating their input.
        // Only this turn's admitted user messages can own this attempt's facts.
        const admittedIds = new Set(agent.session.snapshotEvents().flatMap(event =>
          event.type === 'user/message' && event.seq > turnStartSeq ? [event.data.id] : []));
        const admitted = input.filter(message => message.id !== undefined && admittedIds.has(message.id));
        diagnosticId = await this.diagnostics!.begin({ sessionId: agent.id, turn,
          turnStartSeq, stepStartSeq: boundary?.lastStepStartSeq ?? 0, nativeRequestId: requestId,
          messageIds: [...new Set(admitted.flatMap(m => m.id === undefined ? [] : [m.id]))],
          requestIds: [...new Set(admitted.flatMap(m => m.role === 'user' && m.source?.kind === 'user' && 'rpcId' in m.source
            && typeof m.source.rpcId === 'string' ? [m.source.rpcId] : []))],
        });
      });
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          this.output.set(agent.id, update);
          const capacityId = input.flatMap(message => message.role === 'user' && message.source?.kind === 'user' && 'rpcId' in message.source
            && typeof message.source.rpcId === 'string' && message.source.rpcId.startsWith('a2a-') ? [message.source.rpcId] : [])[0];
          try {
            active = await this.connection(agent, capacityId, signal);
            noteProcessReady(agent.id);
          } catch (error) {
            noteProcessCapacity(agent.id, undefined);
            throw error;
          }
          binding = this.state.get(agent.id)!;
          signal.throwIfAborted();
          if (diagnosticId) await save(() => this.diagnostics!.submitted(diagnosticId!));
          signal.throwIfAborted();
          requestSent = true;
          const result = await active.rpc.request('session/prompt', { sessionId: binding.sessionId!, prompt: [{ type: 'text', text }],
            _meta: { '1agents': { turnManaged: true, turnId: requestId, requestId } } }, { cancellationSignal: signal });
          nativeConfirmed = true;
          if (diagnosticId) await save(() => this.diagnostics!.confirmed(diagnosticId!));
          // A received terminal reply establishes the outcome even if the consumer
          // just aborted. Preserve cancellation without emitting any more chunks.
          if (signal.aborted) throw cancelled(false, result.stopReason === 'cancelled' ? 'acp' : 'dsh');
          const meta = result._meta?.['1agents'] as JsonObject | undefined;
          if (typeof meta?.finalAnswer === 'string' && (!answer || (hasPhasedText && !streamedFinalAnswer))) {
            emit('text', meta.finalAnswer, { messagePhase: 'final_answer' });
          }
          endBlock();
          if (typeof meta?.finalAnswer === 'string') {
            // The terminal answer is authoritative even when it is empty. Keep
            // it durable without printing a second copy of streamed output.
            const block = { type: 'text' as const, text: '', acpResult: { ...acpStream, finalAnswer: meta.finalAnswer } };
            queue.push({ type: 'block-start', index, blockType: 'text' });
            queue.push({ type: 'block-end', index, block });
            index++;
          }
          if (result.stopReason === 'cancelled') throw cancelled(false, 'acp');
          queue.push({ type: 'finish', reason: result.stopReason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' } });
          return;
        } catch (error) {
          if (error instanceof LlmError) throw error;
          if (isCancellationRejection(error, signal)) { endBlock(); throw cancelled(requestSent); }
          // Only transport loss is retried. The managed request ID makes an
          // uncertain delivery idempotent; provider errors remain errors.
          if (error instanceof RequestError || (active && active.ws.readyState === 1) || attempt >= this.config.reconnectAttempts) {
            const transportLost = !active || active.ws.readyState !== 1;
            // The negotiated service sends its canonical projection directly in
            // RequestError.data. Other native and transport errors remain raw.
            const projected = serviceProjection(error);
            const safe = toSafeError(projected ?? error, { trustedProjection: projected !== undefined,
              origin: transportLost ? 'transport' : 'dsh', operationId: requestId,
              outcomeUnknown: projected ? projected.outcomeUnknown === true : transportLost && requestSent });
            // A pending import has no service identity while its original
            // writer owns the native session. Retain that local explanation
            // without copying the failed restoration's provider message.
            if (!requestSent && binding?.imported && !binding.sessionId && safe.category === 'unknown') {
              safe.message = 'The imported ACP session is not ready; check for an active writer before retrying.';
            }
            // Complete facts are saved in the plugin domain before the official
            // host normalizes this ordinary LlmError.
            throw publicFailure(safe, requestId);
          }
          await delay(this.config.reconnectDelayMs, undefined, { signal });
        } finally { active = undefined; }
      }
    } catch (error) {
      const failure = isCancellationRejection(error, signal) ? cancelled(requestSent && !nativeConfirmed) : error;
      if (diagnosticId) {
        const safe = failure instanceof Error && ownedFailures.get(failure) || toSafeError(failure, {
          origin: 'dsh', operationId: requestId, outcomeUnknown: requestSent && !nativeConfirmed });
        try { await this.diagnostics!.settle(diagnosticId, safe); } catch {
          throw publicFailure(toSafeError(undefined, { origin: 'dsh', operationId: requestId,
            outcomeUnknown: requestSent && !nativeConfirmed }), requestId);
        }
      }
      throw failure instanceof Error && ownedFailures.has(failure) ? failure : publicFailure(toSafeError(failure, {
        origin: 'dsh', operationId: requestId, outcomeUnknown: requestSent && !nativeConfirmed }), requestId);
    } finally { signal.removeEventListener('abort', cancel); this.output.delete(agent.id); }
  }
}
