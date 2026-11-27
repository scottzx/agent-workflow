/** DSH session execution behind the shared A2A service's transport-independent backend. */
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import { A2APreflightError, bindA2AExecution, runA2APreflight, unbindA2AExecution, type A2ABackend, type A2AExecutionRef, type A2APreflightInput, type A2APrepareInput, type A2ARunResult, type A2ATarget } from '@1agents/acp-service/a2a';
import { toSafeError } from '@1agents/acp-service/runtime';
import { nativeTurnSafeError } from './native-failure.js';
import { modelSelectionOf } from './preset-route.js';

import type { DiagnosticLog } from './diagnostics.js';
import { consumeProcessReady, readProcessCapacity, readSessionRestore } from './process-admission.js';

export interface SessionControl {
  release(sessionId: string): Promise<{ processReleased: true | 'pending'; acp?: boolean }>;
  delete?(sessionId: string): Promise<{ processReleased: true | 'pending'; acp?: boolean }>;
  status(sessionId: string): Promise<{ attached: boolean; activeTurn: boolean; lastUsedAt?: string }>;
}

function sessionError(code: 'SESSION_NOT_FOUND' | 'SESSION_DELETED' | 'SESSION_CONFLICT' | 'MODEL_UNAVAILABLE' | 'MODEL_SELECTION_UNSUPPORTED' | 'UNKNOWN_MODEL_OR_GROUP', message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/** One provider/model pair the host can record. Routing groups use the same shape as concrete models. */
interface ModelRoute { provider: string; model: string }

/** Catalog rows are advisory. A missing or oddly shaped catalog must not throw before the default route is considered. */
function modelGroups(catalog: unknown): { id: string; models: { id: string; name?: string }[] }[] {
  const record = catalog && typeof catalog === 'object' ? catalog as { groups?: unknown; value?: { groups?: unknown } } : undefined;
  const groups = Array.isArray(record?.groups) ? record.groups : Array.isArray(record?.value?.groups) ? record.value.groups : [];
  return groups.flatMap(group => {
    if (!group || typeof group !== 'object') return [];
    const row = group as { id?: unknown; models?: unknown };
    if (typeof row.id !== 'string' || !row.id) return [];
    const models = Array.isArray(row.models) ? row.models : [];
    return [{ id: row.id, models: models.flatMap(model => {
      if (!model || typeof model !== 'object') return [];
      const item = model as { id?: unknown; name?: unknown };
      return typeof item.id === 'string' && item.id ? [{ id: item.id, ...(typeof item.name === 'string' ? { name: item.name } : {}) }] : [];
    }) }];
  });
}

/** The route a brand-new session would run when the caller omits provider and model. */
function hostDefault(ctx: Context, catalog: unknown): ModelRoute | undefined {
  const record = catalog && typeof catalog === 'object' ? catalog as { default?: ModelRoute; value?: { default?: ModelRoute } } : undefined;
  const listed = record?.default ?? record?.value?.default;
  if (typeof listed?.provider === 'string' && listed.provider && typeof listed?.model === 'string' && listed.model) return { provider: listed.provider, model: listed.model };
  const service = (ctx as { agentDefaultModel?: { currentSelection?: () => ModelRoute } }).agentDefaultModel
    ?? ctx.get?.('agentDefaultModel') as { currentSelection?: () => ModelRoute } | undefined;
  try {
    const current = service?.currentSelection?.();
    if (typeof current?.provider === 'string' && current.provider && typeof current?.model === 'string' && current.model) return { provider: current.provider, model: current.model };
  } catch { /* A default service that cannot be read is not itself a route. */ }
  return undefined;
}

function sameRoute(left: ModelRoute | undefined, right: ModelRoute): boolean {
  return left?.provider === right.provider && left?.model === right.model;
}

/** Host-authored catalog ids only. Provider error text never enters this sentence. */
function routingGroup(id: string, name: string): boolean {
  return id.startsWith('group/') || /routing group/i.test(name);
}

/** Caller-facing catalog. Provider failure text stays on the host. */
export function projectModelCatalog(catalog: unknown): { default: ModelRoute; groups: { id: string; name: string; models: { id: string; name: string; routingGroup?: true; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[] }[]; failures: { id: string; name: string }[] } {
  const record = catalog && typeof catalog === 'object' ? catalog as { default?: ModelRoute; value?: { default?: ModelRoute; groups?: unknown; failures?: unknown }; groups?: unknown; failures?: unknown } : {};
  const source = record.value && typeof record.value === 'object' ? record.value : record;
  const fallback = source.default;
  if (typeof fallback?.provider !== 'string' || !fallback.provider || typeof fallback.model !== 'string' || !fallback.model) throw new Error('DSH model catalog has no default route');
  const groups = Array.isArray(source.groups) ? source.groups : [];
  const failures = Array.isArray(source.failures) ? source.failures : [];
  return {
    default: { provider: fallback.provider, model: fallback.model },
    groups: groups.flatMap(group => {
      if (!group || typeof group !== 'object') return [];
      const row = group as { id?: unknown; name?: unknown; models?: unknown };
      if (typeof row.id !== 'string' || !row.id) return [];
      const name = typeof row.name === 'string' && row.name ? row.name : row.id;
      const models = Array.isArray(row.models) ? row.models.flatMap(model => {
        if (!model || typeof model !== 'object') return [];
        const item = model as { id?: unknown; name?: unknown; reasoning?: { efforts?: unknown; defaultEffort?: unknown } };
        if (typeof item.id !== 'string' || !item.id) return [];
        const modelName = typeof item.name === 'string' && item.name ? item.name : item.id;
        const efforts = Array.isArray(item.reasoning?.efforts) ? item.reasoning.efforts.flatMap(effort => {
          if (!effort || typeof effort !== 'object') return [];
          const option = effort as { id?: unknown; name?: unknown };
          return typeof option.id === 'string' && option.id && typeof option.name === 'string' && option.name ? [{ id: option.id, name: option.name }] : [];
        }) : [];
        const defaultEffort = typeof item.reasoning?.defaultEffort === 'string' && efforts.some(effort => effort.id === item.reasoning?.defaultEffort) ? item.reasoning.defaultEffort : undefined;
        return [{ id: item.id, name: modelName, ...(routingGroup(item.id, modelName) ? { routingGroup: true as const } : {}), ...(efforts.length ? { reasoning: { efforts, ...(defaultEffort ? { defaultEffort } : {}) } } : {}) }];
      }) : [];
      return [{ id: row.id, name, models }];
    }),
    failures: failures.flatMap(failure => {
      if (!failure || typeof failure !== 'object') return [];
      const row = failure as { id?: unknown; name?: unknown };
      if (typeof row.id !== 'string' || !row.id) return [];
      return [{ id: row.id, name: typeof row.name === 'string' && row.name ? row.name : row.id }];
    }),
  };
}

function unknownRoute(provider: string, model: string, candidates: readonly string[]): Error {
  const shown = candidates.filter(id => /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(id)).slice(0, 12);
  const available = shown.length ? `. Available: ${shown.join(', ')}` : '';
  return sessionError('UNKNOWN_MODEL_OR_GROUP', `Unknown model or routing group: ${provider}/${model}${available}`);
}

/** Host inspect either returns null or throws its own not-found error. Other failures stay unchanged. */
function isMissingSession(error: unknown, sessionId: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; message?: unknown };
  return value.name === 'ApiSessionNotFound'
    || value.message === `Session ${sessionId} not found`
    || value.message === `session "${sessionId}" not found`;
}

type SessionInspection = { meta: { id: string; cwd?: string; agentPreset?: string } } | null;

/**
 * Read a Session's identity without resuming it; null when it does not exist.
 * Current DSH dropped sessionController.inspect, so this observes the stored header through sessionQuery instead.
 */
export async function inspectSession(ctx: Context, sessionId: SessionId): Promise<SessionInspection> {
  if (typeof ctx.sessionController.inspect === 'function') return ctx.sessionController.inspect(sessionId);
  const live = ctx.sessions?.get?.(sessionId);
  if (live?.header) return { meta: { id: live.header.id, cwd: live.header.cwd, agentPreset: live.header.agentPreset } };
  const query = ctx.get('sessionQuery');
  if (!query) throw new Error('This DSH host offers neither sessionController.inspect nor sessionQuery');
  let observation;
  try { observation = await query.observeSession(sessionId, { projectionMode: 'none' }); }
  catch (error) { if (isMissingSession(error, sessionId)) return null; throw error; }
  try {
    const { id, cwd, agentPreset } = observation.header;
    return { meta: { id, ...(cwd === undefined ? {} : { cwd }), ...(agentPreset === undefined ? {} : { agentPreset }) } };
  } finally { observation[Symbol.dispose](); }
}

/**
 * The outcome of one DSH turn. A native failure is projected through the
 * runtime's public error model; an ACP session keeps its durable diagnostic.
 * @param reason The turn's own ending.
 * @param text The assistant text collected for this turn.
 * @param finalAnswerExpected Whether this turn owed a final answer.
 * @param operationId The caller's request identity, bound to the projected error.
 * @param diagnostic The durable ACP diagnostic of this turn, when one exists.
 * @param turnFailure The failure facts of a same-turn error event, when the host published one.
 */
export function resultOf(reason: TurnEndReason, text: string, finalAnswerExpected: boolean, operationId: string, diagnostic?: ReturnType<typeof toSafeError>, turnFailure?: unknown): A2ARunResult {
  switch (reason.kind) {
    case 'completed': return finalAnswerExpected && !text.trim()
      ? { outcome: 'failed', text, failureReason: 'missing-final-answer', detail: 'DSH completed the task without a final answer; ACP final-answer metadata contained no final output' }
      : { outcome: 'completed', text };
    case 'blocked': return { outcome: 'input-required', text, detail: 'DSH blocked the task before its next model step' };
    case 'error': {
      // A native DSH turn has no ACP diagnostic. Its own failure record names
      // the cause; without one the failure stays unknown rather than guessed.
      const error = diagnostic ?? nativeTurnSafeError(reason, operationId, turnFailure);
      return { outcome: 'failed', text, detail: error.message, error };
    }
    case 'max-tokens': return { outcome: 'failed', text, failureReason: 'max-tokens', detail: 'DSH reached the model output token limit' };
    case 'aborted': return { outcome: 'failed', text, failureReason: 'aborted', detail: 'DSH task execution was canceled',
      error: diagnostic ?? toSafeError(new DOMException('ACP execution cancelled.', 'AbortError'), { origin: 'dsh', operationId, outcomeUnknown: true }) };
    case 'interrupted': return { outcome: 'failed', text, failureReason: 'interrupted', detail: 'DSH task execution was interrupted',
      error: toSafeError(undefined, { origin: 'dsh', operationId, outcomeUnknown: true }) };
    case 'forked': return { outcome: 'failed', text, failureReason: 'forked', detail: 'DSH task turn was closed by a session fork' };
    // DSH's turn reasons are merge-extensible; an unknown ending cannot report success.
    default: return { outcome: 'failed', text, failureReason: 'unsupported-ending', detail: 'DSH returned an unsupported turn ending' };
  }
}

/** Read durable ACP metadata, leaving ordinary DSH messages compatible. */
function answerOf(content: readonly ContentBlock[], turn: number): { text: string; authoritative: boolean; phased: boolean } {
  const blocks = content.filter(part => part.type === 'text') as (ContentBlock & {
    text: string;
    acpResult?: { turn?: number; finalAnswer?: unknown };
    acpStream?: { turn?: number; messagePhase?: unknown };
  })[];
  const terminal = blocks.findLast(part => part.acpResult?.turn === turn && typeof part.acpResult.finalAnswer === 'string');
  if (terminal) return { text: terminal.acpResult!.finalAnswer as string, authoritative: true, phased: true };
  const phased = blocks.some(part => part.acpStream?.turn === turn
    && (part.acpStream.messagePhase === 'commentary' || part.acpStream.messagePhase === 'final_answer'));
  return {
    text: blocks.filter(part => !phased || (part.acpStream?.turn === turn && part.acpStream.messagePhase === 'final_answer')).map(part => part.text).join(''),
    authoritative: false, phased,
  };
}

async function waitForIdle(agent: Agent, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  const canceled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { await Promise.race([agent.whenIdle(), canceled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Uses public session-controller and inbox events to account for one A2A prompt's exact DSH turn. */
export class DshA2ABackend implements A2ABackend {
  private readonly executions = new Map<string, Promise<void>>();
  /** @param ctx DSH plugin context that owns session-controller and execution event registrations. */
  constructor(private readonly ctx: Context, private readonly diagnostics?: DiagnosticLog, private readonly sessions?: SessionControl) {}

  async close(target: A2ATarget): Promise<{ processReleased: true | 'pending'; acp?: boolean }> {
    if (!target.agentPreset?.startsWith('oneagents-acp-')) return { processReleased: true, acp: false };
    if (!this.sessions) {
      const error = new Error('Host close is not supported') as Error & { code: string };
      error.code = 'UNSUPPORTED';
      throw error;
    }
    return this.sessions.release(target.sessionId);
  }

  /** Non-ACP presets only drop the A2A binding; DSH session history is never deleted. */
  async delete(target: A2ATarget): Promise<{ processReleased: true | 'pending'; acp?: boolean }> {
    if (!target.agentPreset?.startsWith('oneagents-acp-')) return { processReleased: true, acp: false };
    if (!this.sessions?.delete) {
      const error = new Error('Host delete is not supported') as Error & { code: string };
      error.code = 'UNSUPPORTED';
      throw error;
    }
    return this.sessions.delete(target.sessionId);
  }

  async status(target: A2ATarget): Promise<{ attached: boolean; activeTurn: boolean; lastUsedAt?: string }> {
    if (target.agentPreset?.startsWith('oneagents-acp-') && this.sessions) return this.sessions.status(target.sessionId);
    const found = await inspectSession(this.ctx, target.sessionId as SessionId).catch(() => null);
    return { attached: found != null, activeTurn: false };
  }

  /** Restart reconciliation reads the plugin domain and never dispatches another prompt. */
  async recover(target: A2ATarget, options: { requestId: string }) {
    return this.diagnostics?.find(target.sessionId, options.requestId);
  }

  async preflight(input: A2APreflightInput) {
    return runA2APreflight(input);
  }

  /** Standard routes currently advertised by this host. Does not create a session. */
  async modelCatalog() {
    return projectModelCatalog(await this.ctx.sessionController.modelCatalog());
  }

  /** Create a new session or restore an explicitly addressed session without changing its workspace or preset.
   * @param input Remote host directory, preset, and optional existing DSH session identity.
   * @returns The resolved DSH session and its durable workspace and preset.
   */
  async prepare(input: A2APrepareInput, options?: { signal: AbortSignal }): Promise<A2ATarget> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    let previous: SessionInspection | undefined;
    if (input.sessionId !== undefined) {
      try {
        previous = await inspectSession(this.ctx, input.sessionId as SessionId);
      } catch (error) {
        if (isMissingSession(error, input.sessionId)) throw sessionError('SESSION_NOT_FOUND', `Session ${input.sessionId} not found`);
        throw error;
      }
      signal?.throwIfAborted();
      if (previous == null) throw sessionError('SESSION_NOT_FOUND', `Session ${input.sessionId} not found`);
    }
    if (previous != null && previous.meta.id !== input.sessionId) throw sessionError('SESSION_CONFLICT', 'Existing session identity conflicts');
    const requestedCwd = input.cwd ?? previous?.meta.cwd ?? process.cwd();
    if (!isAbsolute(requestedCwd)) throw new Error('A2A cwd must be an absolute directory on the DSH host');
    const cwd = await realpath(requestedCwd);
    signal?.throwIfAborted();
    if (!(await stat(cwd)).isDirectory()) throw new Error('A2A cwd must point to a directory on the DSH host');
    signal?.throwIfAborted();
    const preflight = await this.preflight({ ...input.preflight, cwd });
    signal?.throwIfAborted();
    if (!preflight.ok) throw new A2APreflightError(preflight);
    const agentPreset = input.agentPreset ?? previous?.meta.agentPreset;
    if (input.sessionId !== undefined && previous != null) {
      if (previous.meta.cwd === undefined || await realpath(previous.meta.cwd) !== cwd) throw sessionError('SESSION_CONFLICT', 'Existing session cwd conflicts');
      if (input.agentPreset !== undefined && input.agentPreset !== previous.meta.agentPreset) throw sessionError('SESSION_CONFLICT', 'Existing session preset conflicts');
      // create() only reuses blank Sessions on current DSH; resolve the saved
      // identity directly so an active or completed context keeps its queue.
      const agent = await this.agent(input.sessionId as SessionId);
      signal?.throwIfAborted();
      if (agent.id !== input.sessionId || agent.session.id !== input.sessionId) throw sessionError('SESSION_CONFLICT', 'Existing session identity conflicts');
      if (agent.session.header.cwd === undefined || await realpath(agent.session.header.cwd) !== cwd) throw sessionError('SESSION_CONFLICT', 'Existing session cwd conflicts');
      signal?.throwIfAborted();
      if (agent.session.header.agentPreset !== previous.meta.agentPreset) throw sessionError('SESSION_CONFLICT', 'Existing session preset conflicts');
      const allowUnresolved = input.provider === undefined ? false : await this.requireModel(input, agentPreset, signal);
      const selected = await this.selectModel(input, input.sessionId as SessionId, signal, allowUnresolved);
      return { sessionId: input.sessionId, cwd, ...(agentPreset === undefined ? {} : { agentPreset }), preflight, ...selected };
    }
    // Reject an unknown model before a blank session is created for it.
    const allowUnresolved = input.provider === undefined ? false : await this.requireModel(input, agentPreset, signal);
    const created = await this.ctx.sessionController.create({
      cwd,
      ...(agentPreset === undefined ? {} : { agentPreset }),
    });
    // Native create owns a durable blank session, not an ACP launch or prompt.
    // If its non-abortable host operation finishes late, do not restore or run it.
    signal?.throwIfAborted();
    const agent = await this.agent(created.sessionId);
    signal?.throwIfAborted();
    const selected = await this.selectModel(input, created.sessionId, signal, allowUnresolved);
    return {
      sessionId: created.sessionId,
      cwd: agent.session.header.cwd ?? cwd,
      ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
      preflight,
      ...selected,
    };
  }

  /**
   * Standard presets only. A catalog hit or the host's current default route is accepted.
   * Routing groups and slash model ids may fail exact-model resolution and are still recorded,
   * which is how a new session keeps magpie/group/daily-choice when the caller omits both fields.
   * @returns Whether exact resolveCallConfig may fail without rejecting the route.
   */
  private async requireModel(input: A2APrepareInput, agentPreset: string | undefined, signal?: AbortSignal): Promise<boolean> {
    if (agentPreset?.startsWith('oneagents-acp-')) throw sessionError('MODEL_SELECTION_UNSUPPORTED', 'provider and model apply only to standard presets');
    const requested: ModelRoute = { provider: input.provider!, model: input.model! };
    let catalog: unknown;
    try { catalog = await this.ctx.sessionController.modelCatalog(); }
    catch { catalog = undefined; }
    signal?.throwIfAborted();
    const groups = modelGroups(catalog);
    const match = groups.find(group => group.id === requested.provider)?.models.find(model => model.id === requested.model);
    const fallback = hostDefault(this.ctx, catalog);
    if (!match && !sameRoute(fallback, requested)) {
      throw unknownRoute(requested.provider, requested.model, groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`)));
    }
    const namedGroup = typeof match?.name === 'string' && /routing group/i.test(match.name);
    // Slash ids are opaque routes. Exact adapter lookup treats some of them as missing models
    // even though the session default runs them unchanged.
    return namedGroup || requested.model.startsWith('group/') || requested.model.includes('/') || (!match && sameRoute(fallback, requested));
  }

  /** Install the requested model before the first prompt and return what DSH resolved. Omitted fields leave the session unchanged. */
  private async selectModel(input: A2APrepareInput, sessionId: SessionId, signal?: AbortSignal, allowUnresolved = false): Promise<{ provider?: string; model?: string }> {
    if (input.provider === undefined || input.model === undefined) return {};
    let selected: { provider: string; model: string } = { provider: input.provider, model: input.model };
    try {
      const agent = await this.agent(sessionId);
      // sessionController.selectModel also saves the choice as the host's default model.
      // A task only chooses for its own session, so current DSH selects on the agent directly.
      const model = modelSelectionOf(agent);
      if (model) {
        if (this.ctx.llm.resolveCallConfig) {
          try { await this.ctx.llm.resolveCallConfig(selected); }
          catch (error) { if (!allowUnresolved) throw error; }
        }
        model.select(selected);
      } else ({ selected } = await this.ctx.sessionController.selectModel({ sessionId, ...selected }));
    }
    catch (error) { throw Object.assign(sessionError('MODEL_UNAVAILABLE', `DSH did not select ${input.provider}/${input.model}`), { cause: error }); }
    signal?.throwIfAborted();
    return { provider: selected.provider, model: selected.model };
  }

  /** Admit one identified queued prompt and wait only for its own turn, independent of the HTTP connection.
   * @param target Previously prepared DSH session.
   * @param prompt Plain-text A2A message content.
   * @param options Task-owned request identity and cancellation signal.
   * @returns The exact turn's ending and its final assistant text.
   */
  async run(target: A2ATarget, prompt: string, options: { requestId: string; signal: AbortSignal; beforeStart?: (signal?: AbortSignal) => Promise<void>; onCapacity?: (pending: { code: 'CAPACITY_PENDING'; position: number; waitedMs: number } | undefined) => void; execution?: A2AExecutionRef }): Promise<A2ARunResult> {
    options.signal.throwIfAborted();
    const queuedAbort = Promise.withResolvers<A2ARunResult>();
    const abort = (): void => { queuedAbort.reject(options.signal.reason); };
    options.signal.addEventListener('abort', abort, { once: true });
    const operation = (this.executions.get(target.sessionId) ?? Promise.resolve()).then(() => {
      options.signal.removeEventListener('abort', abort);
      options.signal.throwIfAborted();
      return this.execute(target, prompt, options);
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.executions.set(target.sessionId, tail);
    void tail.then(() => { if (this.executions.get(target.sessionId) === tail) this.executions.delete(target.sessionId); });
    try { return await Promise.race([operation, queuedAbort.promise]); }
    finally { options.signal.removeEventListener('abort', abort); }
  }

  private async execute(target: A2ATarget, prompt: string, options: { requestId: string; signal: AbortSignal; beforeStart?: (signal?: AbortSignal) => Promise<void>; onCapacity?: (pending: { code: 'CAPACITY_PENDING'; position: number; waitedMs: number } | undefined) => void; execution?: A2AExecutionRef }): Promise<A2ARunResult> {
    const agent = await this.agent(target.sessionId as SessionId);
    options.signal.throwIfAborted();
    const completion = Promise.withResolvers<A2ARunResult>();
    const startupAbort = new AbortController();
    const startupSignal = AbortSignal.any([options.signal, startupAbort.signal]);
    const listeners: (() => void)[] = [];
    let messageId: MessageId | undefined;
    let turn: number | undefined;
    let text = '';
    let finalAnswerExpected = false;
    let authoritativeAnswer = false;
    let settled = false;
    /** The failure facts of this turn's own error event, when the host published one. */
    let turnFailure: unknown;
    const owns = (message: UserMessage): boolean => message.source.kind === 'user'
      && 'rpcId' in message.source && message.source.rpcId === options.requestId;
    const settle = (result: A2ARunResult): void => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', cancel);
      completion.resolve(result);
    };
    const finishTurn = (reason: TurnEndReason): void => {
      const restoreMethod = readSessionRestore(agent.id);
      if (restoreMethod) Object.assign(target, { resumed: true, restoreMethod });
      const start = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start' && event.data.turn === turn);
      let diagnostic;
      try { diagnostic = this.diagnostics?.find(agent.id, options.requestId, turn, start?.seq); }
      catch { /* A stopping storage provider cannot supply durable diagnostics. */ }
      settle(resultOf(reason, text, finalAnswerExpected, options.requestId, diagnostic, turnFailure));
    };
    const cancel = (): void => {
      if (settled) return;
      if (turn !== undefined) {
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        // Root shutdown can remove event subscriptions before the final turn is
        // published. The public idle barrier still drains that exact activity.
        void agent.whenIdle().then(() => {
          if (settled) return;
          const ended = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end' && event.data.turn === turn);
          if (ended?.type === 'turn/end') finishTurn(ended.data.reason);
          else settle({ outcome: 'failed', text, failureReason: 'disposed',
            error: toSafeError(undefined, { origin: 'dsh', operationId: options.requestId, outcomeUnknown: true }) });
        }, () => {
          settle({ outcome: 'failed', text, failureReason: 'disposed',
            error: toSafeError(undefined, { origin: 'dsh', operationId: options.requestId, outcomeUnknown: true }) });
        });
      } else if (messageId !== undefined && agent.inbox.remove(messageId)) {
        settle({ outcome: 'failed', text, failureReason: 'discarded',
          error: toSafeError(new DOMException('ACP execution cancelled.', 'AbortError'),
            { origin: 'dsh', operationId: options.requestId, outcomeUnknown: false }) });
      }
    };
    // The session owns these temporary listeners until its turn settles. Plugin
    // unloading removes plugin effects concurrently with the server's cancel/drain.
    listeners.push(agent.ctx.on('agent/inbox/inserted', event => {
      if (event.agent !== agent || !owns(event.message)) return;
      messageId = event.message.id;
      if (options.signal.aborted) cancel();
    }));
    listeners.push(agent.ctx.on('agent/inbox/claimed', event => {
      if (event.agent !== agent || !owns(event.message)) return;
      messageId = undefined;
      turn = event.turn;
      turnFailure = undefined;
      if (options.signal.aborted) cancel();
    }));
    listeners.push(agent.ctx.on('agent/inbox/discarded', event => {
      if (event.agent === agent && owns(event.message)) {
        settle({ outcome: 'failed', text, failureReason: 'discarded', detail: 'DSH discarded the queued task before execution',
          ...(options.signal.aborted ? { error: toSafeError(new DOMException('ACP execution cancelled.', 'AbortError'),
            { origin: 'dsh', operationId: options.requestId, outcomeUnknown: false }) } : {}) });
      }
    }));
    listeners.push(agent.ctx.on('agent/disposed', event => {
      if (event.agent === agent) {
        settle({ outcome: 'failed', text, failureReason: 'disposed', detail: 'DSH session was disposed before the task finished',
          error: toSafeError(undefined, { origin: 'dsh', operationId: options.requestId, outcomeUnknown: turn !== undefined }) });
        startupAbort.abort(new Error('DSH session was disposed before startup'));
      }
    }));
    listeners.push(agent.ctx.on('agent/error', event => {
      // DSH reports the live failure of a turn here. The turn reason stays
      // authoritative; this only names a cause when the reason carries none.
      if (event.agent !== agent || event.turn !== turn) return;
      turnFailure = event.error;
    }));
    listeners.push(agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || turn === undefined) return;
      if (event.type === 'assistant/message' && event.data.turn === turn) {
        const next = answerOf(event.data.message.content, turn);
        if (next.authoritative) { text = next.text; authoritativeAnswer = true; finalAnswerExpected = true; }
        else if (!authoritativeAnswer && next.phased) { text = next.text; finalAnswerExpected = true; }
        else if (!finalAnswerExpected && next.text.length > 0) text = next.text;
      } else if (event.type === 'turn/end' && event.data.turn === turn) {
        finishTurn(event.data.reason);
      }
    }));
    options.signal.addEventListener('abort', cancel, { once: true });
    let capacityTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.onCapacity && target.agentPreset?.startsWith('oneagents-acp-')) {
      const tick = (): void => {
        const pending = readProcessCapacity(target.sessionId);
        if (pending) options.onCapacity?.({ code: 'CAPACITY_PENDING', position: pending.position, waitedMs: pending.waitedMs });
        else if (consumeProcessReady(target.sessionId)) options.onCapacity?.(undefined);
        capacityTimer = setTimeout(tick, 50);
        capacityTimer.unref?.();
      };
      tick();
    }
    try {
      if (options.execution) bindA2AExecution(target.sessionId, options.execution);
      // Recheck after event registration; cancellation can arrive during Agent restoration.
      options.signal.throwIfAborted();
      // Native user turns do not share this backend's execution map.
      try {
        if (options.beforeStart) await waitForIdle(agent, startupSignal);
        await options.beforeStart?.(startupSignal);
      } catch (error) {
        if (settled) return await completion.promise;
        throw error;
      }
      if (settled) return await completion.promise;
      options.signal.throwIfAborted();
      await this.ctx.sessionController.prompt({
        requestId: options.requestId as SessionRequestId,
        sessionId: agent.id,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, options.signal);
      if (options.signal.aborted) cancel();
      return await completion.promise;
    } finally {
      if (capacityTimer) clearTimeout(capacityTimer);
      if (options.execution) unbindA2AExecution(target.sessionId, options.execution);
      options.signal.removeEventListener('abort', cancel);
      for (const dispose of listeners.reverse()) dispose();
    }
  }

  private async agent(sessionId: SessionId): Promise<Agent> {
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId);
    if ('error' in resolved) throw resolved.error;
    return resolved.agent;
  }
}
