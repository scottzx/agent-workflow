/** DSH session execution behind the shared A2A service's transport-independent backend. */
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import { A2APreflightError, runA2APreflight, type A2ABackend, type A2APreflightInput, type A2APrepareInput, type A2ARunResult, type A2ATarget } from '@1agents/acp-service/a2a';
import { toSafeError } from '@1agents/acp-service/runtime';

import type { Diagnostics } from './diagnostics.js';
import { consumeProcessReady, readProcessCapacity, readSessionRestore } from './process-admission.js';

export interface SessionControl {
  release(sessionId: string): Promise<{ processReleased: true | 'pending'; acp?: boolean }>;
  delete?(sessionId: string): Promise<{ processReleased: true | 'pending'; acp?: boolean }>;
  status(sessionId: string): Promise<{ attached: boolean; activeTurn: boolean; lastUsedAt?: string }>;
}

function sessionError(code: 'SESSION_NOT_FOUND' | 'SESSION_DELETED' | 'SESSION_CONFLICT' | 'MODEL_UNAVAILABLE' | 'MODEL_SELECTION_UNSUPPORTED', message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/** Host inspect either returns null or throws its own not-found error. Other failures stay unchanged. */
function isMissingSession(error: unknown, sessionId: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; message?: unknown };
  return value.name === 'ApiSessionNotFound'
    || value.message === `Session ${sessionId} not found`
    || value.message === `session "${sessionId}" not found`;
}

function resultOf(reason: TurnEndReason, text: string, finalAnswerExpected: boolean, operationId: string, diagnostic?: ReturnType<typeof toSafeError>): A2ARunResult {
  switch (reason.kind) {
    case 'completed': return finalAnswerExpected && !text.trim()
      ? { outcome: 'failed', text, failureReason: 'missing-final-answer', detail: 'DSH completed the task without a final answer; ACP final-answer metadata contained no final output' }
      : { outcome: 'completed', text };
    case 'blocked': return { outcome: 'input-required', text, detail: 'DSH blocked the task before its next model step' };
    case 'error': {
      const error = diagnostic ?? toSafeError(undefined, { origin: 'dsh', operationId });
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
  constructor(private readonly ctx: Context, private readonly diagnostics?: Diagnostics, private readonly sessions?: SessionControl) {}

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
    const found = await this.ctx.sessionController.inspect(target.sessionId as SessionId).catch(() => null);
    return { attached: found != null, activeTurn: false };
  }

  /** Restart reconciliation reads the plugin domain and never dispatches another prompt. */
  async recover(target: A2ATarget, options: { requestId: string }) {
    return this.diagnostics?.find(target.sessionId, options.requestId);
  }

  async preflight(input: A2APreflightInput) {
    return runA2APreflight(input);
  }

  /** Create a new session or restore an explicitly addressed session without changing its workspace or preset.
   * @param input Remote host directory, preset, and optional existing DSH session identity.
   * @returns The resolved DSH session and its durable workspace and preset.
   */
  async prepare(input: A2APrepareInput, options?: { signal: AbortSignal }): Promise<A2ATarget> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    let previous: Awaited<ReturnType<Context['sessionController']['inspect']>> | undefined;
    if (input.sessionId !== undefined) {
      try {
        previous = await this.ctx.sessionController.inspect(input.sessionId as SessionId);
      } catch (error) {
        if (isMissingSession(error, input.sessionId)) throw sessionError('SESSION_NOT_FOUND', `Session ${input.sessionId} not found`);
        throw error;
      }
      signal?.throwIfAborted();
      if (previous == null) throw sessionError('SESSION_NOT_FOUND', `Session ${input.sessionId} not found`);
    }
    if (previous !== undefined && previous.meta.id !== input.sessionId) throw sessionError('SESSION_CONFLICT', 'Existing session identity conflicts');
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
    if (input.sessionId !== undefined && previous !== undefined) {
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
      if (input.provider !== undefined) await this.requireModel(input, agentPreset, signal);
      const selected = await this.selectModel(input, input.sessionId as SessionId, signal);
      return { sessionId: input.sessionId, cwd, ...(agentPreset === undefined ? {} : { agentPreset }), preflight, ...selected };
    }
    // Reject an unknown model before a blank session is created for it.
    if (input.provider !== undefined) await this.requireModel(input, agentPreset, signal);
    const created = await this.ctx.sessionController.create({
      cwd,
      ...(agentPreset === undefined ? {} : { agentPreset }),
    });
    // Native create owns a durable blank session, not an ACP launch or prompt.
    // If its non-abortable host operation finishes late, do not restore or run it.
    signal?.throwIfAborted();
    const agent = await this.agent(created.sessionId);
    signal?.throwIfAborted();
    const selected = await this.selectModel(input, created.sessionId, signal);
    return {
      sessionId: created.sessionId,
      cwd: agent.session.header.cwd ?? cwd,
      ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
      preflight,
      ...selected,
    };
  }

  /** Standard presets only. The catalog must list the exact model; a miss never falls back to the host default. */
  private async requireModel(input: A2APrepareInput, agentPreset: string | undefined, signal?: AbortSignal): Promise<void> {
    if (agentPreset?.startsWith('oneagents-acp-')) throw sessionError('MODEL_SELECTION_UNSUPPORTED', 'provider and model apply only to standard presets');
    const catalog = await this.ctx.sessionController.modelCatalog();
    signal?.throwIfAborted();
    if (!catalog.groups.some(group => group.id === input.provider && group.models.some(model => model.id === input.model))) {
      throw sessionError('MODEL_UNAVAILABLE', `Model ${input.provider}/${input.model} is not in the DSH model catalog`);
    }
  }

  /** Install the requested model before the first prompt and return what DSH resolved. Omitted fields leave the session unchanged. */
  private async selectModel(input: A2APrepareInput, sessionId: SessionId, signal?: AbortSignal): Promise<{ provider?: string; model?: string }> {
    if (input.provider === undefined || input.model === undefined) return {};
    let selected;
    try { ({ selected } = await this.ctx.sessionController.selectModel({ sessionId, provider: input.provider, model: input.model })); }
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
  async run(target: A2ATarget, prompt: string, options: { requestId: string; signal: AbortSignal; beforeStart?: (signal?: AbortSignal) => Promise<void>; onCapacity?: (pending: { code: 'CAPACITY_PENDING'; position: number; waitedMs: number } | undefined) => void }): Promise<A2ARunResult> {
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

  private async execute(target: A2ATarget, prompt: string, options: { requestId: string; signal: AbortSignal; beforeStart?: (signal?: AbortSignal) => Promise<void>; onCapacity?: (pending: { code: 'CAPACITY_PENDING'; position: number; waitedMs: number } | undefined) => void }): Promise<A2ARunResult> {
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
      settle(resultOf(reason, text, finalAnswerExpected, options.requestId, diagnostic));
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
