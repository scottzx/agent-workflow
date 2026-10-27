/** Durable device-wide FIFO admission for automatically invoked ACP work. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DirectoryLease } from './a2a/lease.js';
import { CapacityError, CapacityGovernor, resolveCapacityDirectory,
  type CapacityLease, type CapacityOptions, type CapacityRequest, type ProcessLeaseOrigin } from './capacity.js';

export interface CapacityQueueWaitOptions {
  signal?: AbortSignal;
  /** Called once only when admission actually has to wait. */
  onPending?: () => void;
}
/** Non-blocking FIFO result. The queue entry stays until admission or cancel. */
export interface CapacityPendingAdmission {
  pending: true;
  position: number;
  waitedMs: number;
}
export interface CapacityQueueTimingOptions { pollIntervalMs?: number }
interface QueueEntry extends CapacityRequest {
  version: 1;
  token: string;
  ownerPid: number;
  sequence: number;
  enqueuedAt: number;
}
interface QueueState { entries: QueueEntry[]; lastSequence: number }
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const stateMessage = 'ACP capacity queue state is unavailable; check the local host queue state before retrying.';
const processOrigins = new Set<ProcessLeaseOrigin>(['prewarm', 'job', 'user-opened']);
const validRequest = (value: CapacityRequest): boolean => !!value &&
  (value.kind === 'task' || value.kind === 'process') &&
  (value.source === 'automatic' || value.source === 'interactive') &&
  typeof value.id === 'string' && !!value.id.trim() && value.id.length <= 4096 &&
  (value.origin === undefined || (value.kind === 'process' && processOrigins.has(value.origin)));
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Permission failures do not prove that a queued owner has exited. */
function isDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export class CapacityQueue {
  private readonly directory: string;
  private readonly governor: CapacityGovernor;
  private readonly pollIntervalMs: number;

  constructor(options: CapacityOptions = {}, timing: CapacityQueueTimingOptions = {}) {
    this.directory = join(resolveCapacityDirectory(options), 'queue');
    this.governor = new CapacityGovernor(options);
    this.pollIntervalMs = timing.pollIntervalMs ?? 750;
    if (!isPositiveInteger(this.pollIntervalMs)) throw new Error('ACP capacity queue poll interval must be a positive safe integer');
  }

  async acquire(request: CapacityRequest, { signal, onPending }: CapacityQueueWaitOptions = {}): Promise<CapacityLease> {
    if (!validRequest(request)) throw new Error('Invalid ACP capacity request');
    signal?.throwIfAborted();
    // Manual work keeps the governor's reserved interactive room even while automatic work waits.
    if (request.source === 'interactive') {
      const lease = await this.governor.acquire(request);
      if (signal?.aborted) { await lease.release(); signal.throwIfAborted(); }
      return lease;
    }

    const entry: QueueEntry = { ...request, version: 1, token: randomUUID(), ownerPid: process.pid,
      enqueuedAt: Date.now(), sequence: 0 };
    let queued = false;
    let acquired: CapacityLease | undefined;
    let returned = false;
    let reportedPending = false;
    try {
      await this.transaction(() => {
        signal?.throwIfAborted();
        const state = this.readState();
        if (state.lastSequence >= Number.MAX_SAFE_INTEGER) throw new Error(stateMessage);
        entry.sequence = state.lastSequence + 1;
        // Advance the durable counter before publishing the entry; a crash may leave a harmless gap.
        this.writeJson(join(this.directory, 'counter.json'), { version: 1, lastSequence: entry.sequence });
        queued = true;
        this.writeJson(this.entryPath(entry.token), entry);
      }, signal);

      while (true) {
        signal?.throwIfAborted();
        await this.transaction(async () => {
          signal?.throwIfAborted();
          const state = this.readState();
          const own = state.entries.find(item => item.token === entry.token);
          if (!own || own.ownerPid !== process.pid || own.sequence !== entry.sequence) throw new Error(stateMessage);
          // Task and child-process capacity have separate FIFOs, avoiding a waiting parent blocking its child.
          const head = state.entries.find(item => item.kind === request.kind);
          if (head?.token !== entry.token) return;
          try { acquired = await this.governor.acquire(request); }
          catch (error) { if (error instanceof CapacityError) return; throw error; }
          signal?.throwIfAborted();
          this.removeEntry(entry);
          queued = false;
        }, signal);
        if (acquired) {
          signal?.throwIfAborted();
          returned = true;
          return acquired;
        }
        if (!reportedPending) { reportedPending = true; onPending?.(); }
        try { await delay(this.pollIntervalMs, undefined, { signal }); }
        catch (error) { signal?.throwIfAborted(); throw error; }
      }
    } finally {
      // An abort or storage failure between admission and delivery must not leak a capacity slot.
      try { if (acquired && !returned) await acquired.release(); }
      finally { if (queued) await this.transaction(() => this.removeEntry(entry)); }
    }
  }

  /**
   * Enqueue if needed and return immediately.
   * A free head slot is acquired in this same call. A full slot keeps the entry and reports position.
   * Retries with the same id reuse that entry. Callers without a queue id keep using acquire().
   */
  async tryAdmit(request: CapacityRequest, { signal }: { signal?: AbortSignal } = {}): Promise<CapacityLease | CapacityPendingAdmission> {
    if (!validRequest(request)) throw new Error('Invalid ACP capacity request');
    signal?.throwIfAborted();
    if (request.source === 'interactive') {
      const lease = await this.governor.acquire(request);
      if (signal?.aborted) { await lease.release(); signal.throwIfAborted(); }
      return lease;
    }
    let acquired: CapacityLease | undefined;
    let pending: CapacityPendingAdmission | undefined;
    let created = false;
    let entry: QueueEntry | undefined;
    try {
      await this.transaction(async () => {
        signal?.throwIfAborted();
        const state = this.readState();
        const existing = state.entries.find(item => item.id === request.id && item.kind === request.kind && item.ownerPid === process.pid);
        if (existing) entry = existing;
        else {
          if (state.lastSequence >= Number.MAX_SAFE_INTEGER) throw new Error(stateMessage);
          entry = { ...request, version: 1, token: randomUUID(), ownerPid: process.pid,
            enqueuedAt: Date.now(), sequence: state.lastSequence + 1 };
          this.writeJson(join(this.directory, 'counter.json'), { version: 1, lastSequence: entry.sequence });
          created = true;
          this.writeJson(this.entryPath(entry.token), entry);
        }
        const current = this.readState();
        const own = current.entries.find(item => item.token === entry!.token);
        if (!own || own.ownerPid !== process.pid) throw new Error(stateMessage);
        const same = current.entries.filter(item => item.kind === request.kind);
        const position = same.findIndex(item => item.token === own.token) + 1;
        const waitedMs = Math.max(0, Date.now() - own.enqueuedAt);
        if (position < 1) throw new Error(stateMessage);
        const head = same[0];
        if (head?.token !== own.token) { pending = { pending: true, position, waitedMs }; return; }
        try { acquired = await this.governor.acquire(request); }
        catch (error) {
          if (error instanceof CapacityError) { pending = { pending: true, position, waitedMs }; return; }
          throw error;
        }
        this.removeEntry(own);
        created = false;
      }, signal);
    } catch (error) {
      if (created && entry) await this.transaction(() => this.removeEntry(entry!)).catch(() => undefined);
      throw error;
    }
    if (signal?.aborted) {
      if (acquired) await acquired.release();
      else if (entry) await this.transaction(() => this.removeEntry(entry!)).catch(() => undefined);
      signal.throwIfAborted();
    }
    if (acquired) return acquired;
    if (!pending) throw new Error(stateMessage);
    return pending;
  }

  /** Age of the oldest still-owned queue entry. Missing queues and dead owners are not rewritten. */
  async headWaitMs(kind: CapacityRequest['kind']): Promise<number> {
    if (kind !== 'task' && kind !== 'process') throw new Error('Invalid ACP capacity request');
    if (!existsSync(this.directory)) return 0;
    return this.transaction(() => {
      let head: QueueEntry | undefined;
      for (const name of readdirSync(this.directory)) {
        if (name === '.lock' || name === 'counter.json' || /^pending-[a-f0-9-]{36}\.json$/.test(name)) continue;
        if (!/^entry-[a-f0-9-]{36}\.json$/.test(name)) throw new Error(stateMessage);
        const entry = this.readEntry(join(this.directory, name));
        if (name !== `entry-${entry.token}.json` || entry.kind !== kind || isDead(entry.ownerPid)) continue;
        if (!head || entry.sequence < head.sequence) head = entry;
      }
      return head ? Math.max(0, Date.now() - head.enqueuedAt) : 0;
    });
  }

  /** Current admission counts. Uses this queue's governor, including its configured limit. */
  async slotView(): Promise<{ taskSlot: { limit: number; used: number }; processSlot: { limit: number; used: number; headWaitMs: number } }> {
    const task = await this.governor.snapshot('task');
    const process = await this.governor.snapshot('process');
    return {
      taskSlot: { limit: task.limits.soft, used: task.used },
      processSlot: { limit: process.limits.soft, used: process.used, headWaitMs: await this.headWaitMs('process') },
    };
  }

  /** Drop this process's queued entry. A lease already returned to the caller is not released here. */
  async cancel(request: { id: string; kind: CapacityRequest['kind'] }): Promise<boolean> {
    if (typeof request.id !== 'string' || !request.id.trim() || request.id.length > 4096) throw new Error('Invalid ACP capacity request');
    if (request.kind !== 'task' && request.kind !== 'process') throw new Error('Invalid ACP capacity request');
    let removed = false;
    await this.transaction(() => {
      const own = this.readState().entries.find(item => item.id === request.id && item.kind === request.kind && item.ownerPid === process.pid);
      if (!own) return;
      this.removeEntry(own);
      removed = true;
    });
    return removed;
  }

  private entryPath(token: string): string { return join(this.directory, `entry-${token}.json`); }

  private readState(): QueueState {
    const entries: QueueEntry[] = [];
    let lastSequence: number | undefined;
    for (const name of readdirSync(this.directory)) {
      if (name === '.lock') continue;
      // Only a completed atomic rename can publish a queue record.
      if (/^pending-[a-f0-9-]{36}\.json$/.test(name)) { unlinkSync(join(this.directory, name)); continue; }
      if (name === 'counter.json') {
        const value = this.readJson(join(this.directory, name)) as { version?: number; lastSequence?: number };
        if (!value || value.version !== 1 || !Number.isSafeInteger(value.lastSequence) || (value.lastSequence as number) < 0) throw new Error(stateMessage);
        lastSequence = value.lastSequence;
        continue;
      }
      if (!/^entry-[a-f0-9-]{36}\.json$/.test(name)) throw new Error(stateMessage);
      const entry = this.readEntry(join(this.directory, name));
      if (name !== `entry-${entry.token}.json`) throw new Error(stateMessage);
      if (isDead(entry.ownerPid)) unlinkSync(this.entryPath(entry.token));
      else entries.push(entry);
    }
    // Missing/regressed/duplicated sequence state cannot safely establish FIFO order.
    const sequences = new Set(entries.map(item => item.sequence));
    if (sequences.size !== entries.length || entries.some(item => item.sequence > (lastSequence ?? -1))) throw new Error(stateMessage);
    entries.sort((a, b) => a.sequence - b.sequence);
    return { entries, lastSequence: lastSequence ?? 0 };
  }

  private readJson(path: string): unknown {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error(stateMessage);
      return JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
  }

  private readEntry(path: string): QueueEntry {
    const value = this.readJson(path) as QueueEntry;
    if (!validRequest(value) || value.version !== 1 || typeof value.token !== 'string' || !tokenPattern.test(value.token) ||
        !isPositiveInteger(value.ownerPid) || !isPositiveInteger(value.sequence) ||
        !Number.isSafeInteger(value.enqueuedAt) || value.enqueuedAt < 0 || value.source !== 'automatic') throw new Error(stateMessage);
    return value;
  }

  private removeEntry(entry: QueueEntry): void {
    const path = this.entryPath(entry.token);
    try {
      const current = this.readEntry(path);
      if (current.token !== entry.token || current.ownerPid !== process.pid || current.sequence !== entry.sequence) throw new Error(stateMessage);
      unlinkSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private writeJson(path: string, value: unknown): void {
    const temporary = join(this.directory, `pending-${randomUUID()}.json`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temporary, path); }
    finally {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  private async transaction<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    let lease: DirectoryLease | undefined;
    const deadline = performance.now() + 5000;
    do {
      signal?.throwIfAborted();
      try { lease = new DirectoryLease(this.directory); break; }
      catch { if (performance.now() >= deadline) throw new Error(stateMessage); }
      try { await delay(10 + Math.floor(Math.random() * 20), undefined, { signal }); }
      catch (error) { signal?.throwIfAborted(); throw error; }
    } while (true);
    try { return await operation(); }
    catch (error) {
      if (signal?.aborted && error === signal.reason) throw error;
      throw new Error(stateMessage);
    } finally {
      try { lease.close(); }
      catch { throw new Error(stateMessage); }
    }
  }
}
