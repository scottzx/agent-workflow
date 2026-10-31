/** Retry a process-slot probe without charging queue time against the handshake budget. */

export interface ProcessCapacityPending {
  position: number;
  waitedMs: number;
}

const noted = new Map<string, ProcessCapacityPending>();
const ready = new Set<string>();

export function noteProcessCapacity(sessionId: string, value: ProcessCapacityPending | undefined): void {
  if (!value) noted.delete(sessionId);
  else noted.set(sessionId, value);
}

export function noteProcessReady(sessionId: string): void {
  noted.delete(sessionId);
  ready.add(sessionId);
}

export function readProcessCapacity(sessionId: string): ProcessCapacityPending | undefined {
  const value = noted.get(sessionId);
  return value ? { ...value } : undefined;
}

export function consumeProcessReady(sessionId: string): boolean {
  return ready.delete(sessionId);
}

const restores = new Map<string, 'session/load' | 'session/resume'>();

export function noteSessionRestore(sessionId: string, method: 'session/load' | 'session/resume'): void {
  restores.set(sessionId, method);
}

export function readSessionRestore(sessionId: string): 'session/load' | 'session/resume' | undefined {
  return restores.get(sessionId);
}

export function capacityPendingOf(error: unknown): ProcessCapacityPending | undefined {
  if (!error || typeof error !== 'object') return;
  const value = error as { code?: unknown; message?: unknown; data?: unknown };
  if (value.code !== -32010 && value.message !== 'CAPACITY_PENDING') return;
  const data = value.data;
  if (!data || typeof data !== 'object') return;
  const pending = data as { position?: unknown; waitedMs?: unknown };
  if (typeof pending.position !== 'number' || !Number.isSafeInteger(pending.position) || pending.position < 1) return;
  if (typeof pending.waitedMs !== 'number' || !Number.isFinite(pending.waitedMs) || pending.waitedMs < 0) return;
  return { position: pending.position, waitedMs: pending.waitedMs };
}

/**
 * Each pending probe returns immediately and does not start handshakeMs.
 * A non-pending result is the attempt that owns the handshake budget.
 */
export async function requestWhenAdmitted<T>(options: {
  request: () => Promise<T>;
  signal: AbortSignal;
  isPending: (error: unknown) => ProcessCapacityPending | undefined;
  onPending?: (pending: ProcessCapacityPending) => void;
  cancel?: () => Promise<void>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
}): Promise<T> {
  const sleep = options.sleep ?? ((ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }));
  const pollMs = options.pollMs ?? 750;
  let queued = false;
  for (;;) {
    options.signal.throwIfAborted();
    try {
      return await options.request();
    } catch (error) {
      const pending = options.isPending(error);
      if (!pending) {
        // A queue entry left behind by an earlier pending attempt would block every later launch at the FIFO head.
        if (queued) await options.cancel?.().catch(() => undefined);
        throw error;
      }
      queued = true;
      options.onPending?.(pending);
      if (options.signal.aborted) {
        await options.cancel?.().catch(() => undefined);
        options.signal.throwIfAborted();
      }
      try { await sleep(pollMs, options.signal); }
      catch (sleepError) {
        await options.cancel?.().catch(() => undefined);
        throw sleepError;
      }
    }
  }
}
