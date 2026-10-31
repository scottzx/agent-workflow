/** Gateway session policy. This is not runtime ensureSession's mode. */
import { z } from 'zod';

export const sessionLifecycleSchema = z.object({
  mode: z.enum(['persistent', 'one-shot']).default('one-shot'),
  /** Omitted means 600 seconds. Zero disables idle close. Positive values override 600. */
  idleTtlSeconds: z.number().int().min(0).max(30 * 24 * 60 * 60).optional(),
  closeAfter: z.enum(['terminal', 'ack']).optional(),
}).strict();

export interface SessionLifecycle {
  mode: 'persistent' | 'one-shot';
  idleTtlSeconds: number;
  closeAfter: 'terminal' | 'ack';
}

export type CloseReason = 'explicit' | 'one-shot' | 'idle-ttl';
export type SessionRecordState = 'attached' | 'busy' | 'idle' | 'closing' | 'closed' | 'stale';

/** One-shot closes only these task states. REJECTED stays open. INPUT_REQUIRED stays open. */
export const ONE_SHOT_TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED',
]);

export function normalizeLifecycle(value: unknown, defaultIdleTtlSeconds = 600): SessionLifecycle {
  const parsed = sessionLifecycleSchema.parse(value ?? {});
  return {
    mode: parsed.mode,
    idleTtlSeconds: parsed.idleTtlSeconds ?? defaultIdleTtlSeconds,
    closeAfter: parsed.closeAfter ?? 'terminal',
  };
}

/** Jobs saved before one-shot became the default carry no lifecycle. They keep the persistent policy they ran under. */
export function legacyLifecycle(defaultIdleTtlSeconds = 600): SessionLifecycle {
  return { mode: 'persistent', idleTtlSeconds: defaultIdleTtlSeconds, closeAfter: 'terminal' };
}

export function isAcpAgentPreset(preset: string | undefined): boolean {
  return typeof preset === 'string' && preset.startsWith('oneagents-acp-');
}

/** One-shot only. Persistent idle close is the gateway's P3 scan, which also confirms remote status. */
export function oneShotShouldClose(lifecycle: SessionLifecycle | undefined, state: string, acknowledged: boolean): boolean {
  const policy = lifecycle ?? legacyLifecycle();
  if (policy.mode !== 'one-shot' || !ONE_SHOT_TERMINAL_STATES.has(state)) return false;
  return policy.closeAfter === 'ack' ? acknowledged : true;
}

export class A2ASessionError extends Error {
  constructor(readonly code: 'SESSION_NOT_FOUND' | 'SESSION_DELETED' | 'SESSION_CLOSED' | 'SESSION_BUSY' | 'SESSION_CONFLICT' | 'SESSION_ATTACH_IN_PROGRESS' | 'UNSUPPORTED' | 'REMOTE_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'A2ASessionError';
  }
}

export type ColdAttachStep = 'enqueued' | 'attach-failed' | 'attach-hung' | 'attach-done-no-turn' | 'activeTurn';

/** Record where a later message stopped. This does not invent an error code. */
export function classifyColdAttach(trace: {
  enqueued: boolean;
  attach: 'none' | 'pending' | 'failed' | 'done';
  turnStarted: boolean;
  activeTurn: boolean;
}): ColdAttachStep {
  if (trace.activeTurn || trace.turnStarted) return 'activeTurn';
  if (trace.attach === 'done') return 'attach-done-no-turn';
  if (trace.attach === 'failed') return 'attach-failed';
  if (trace.attach === 'pending') return 'attach-hung';
  return 'enqueued';
}
