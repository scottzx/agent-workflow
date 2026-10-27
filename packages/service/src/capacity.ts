/** Device-wide admission control. These limits are conservative estimates, not measured hardware maxima. */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, freemem, homedir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DirectoryLease } from './a2a/lease.js';

export type CapacityKind = 'process' | 'task';
export type CapacitySource = 'automatic' | 'interactive';
/** Process leases only. Missing on a record means the lease stays unlabeled. */
export type ProcessLeaseOrigin = 'prewarm' | 'job' | 'user-opened';
export interface CapacityMemoryReading {
  totalBytes: number;
  availableBytes: number;
  source?: 'system-available' | 'macos-reclaimable-estimate' | 'host-provider';
}
export interface CapacityOptions {
  directory?: string;
  softLimit?: number;
  hardLimit?: number;
  memoryReserveBytes?: number;
  estimatedInstanceBytes?: number;
  /** Host-owned memory reader, useful for deterministic admission tests. Never populate from a task payload. */
  memoryProvider?: () => CapacityMemoryReading;
}
export interface CapacityRequest { kind: CapacityKind; source: CapacitySource; id: string; origin?: ProcessLeaseOrigin }
export interface CapacityLimits { soft: number; hard: number; basis: 'hardware-estimate' | 'configured' }
export interface CapacitySnapshot {
  limits: CapacityLimits;
  used: number;
  automatic: number;
  interactive: number;
  availableAutomatic: number;
  availableInteractive: number;
  memory: CapacityMemoryReading & {
    reserveBytes: number;
    estimatedInstanceBytes: number;
    startupReservedBytes: number;
    availableForStartupBytes: number;
    availableSlots: number;
    startupWindowMs: number;
  };
}
export interface CapacityLease { spawned(pid: number): Promise<void>; recheck(): Promise<void>; release(): Promise<void> }
export interface CapacityProcessSession { id: string; ownerPid: number; childPid?: number }
export interface CapacityInspection {
  taskSlot: { limit: number; used: number };
  processSlot: { limit: number; used: number };
  sessions: Record<ProcessLeaseOrigin | 'unlabeled', CapacityProcessSession[]>;
}
export type CapacityErrorCode = 'ACP_CAPACITY_SOFT_LIMIT' | 'ACP_CAPACITY_HARD_LIMIT' | 'ACP_CAPACITY_MEMORY_LIMIT';
export class CapacityError extends Error {
  constructor(readonly code: CapacityErrorCode) {
    super(code === 'ACP_CAPACITY_MEMORY_LIMIT'
      ? 'Available device memory is below the ACP startup reserve; retry after memory is freed.'
      : code === 'ACP_CAPACITY_SOFT_LIMIT'
      ? 'Automatic ACP capacity is full; retry after an active task or process finishes.'
      : 'Device ACP capacity is full; retry after an active task or process finishes.');
    this.name = 'CapacityError';
  }
}

interface Reservation extends CapacityRequest {
  version: 1;
  token: string;
  ownerPid: number;
  childPid?: number;
  startupUntil: number;
}
const processOrigins = new Set<ProcessLeaseOrigin>(['prewarm', 'job', 'user-opened']);
const MiB = 1024 ** 2;
const startupWindowMs = 30_000;
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const stateMessage = 'ACP capacity state is unavailable; check the local host capacity state before retrying.';
const pidIsValid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const validKind = (value: unknown): value is CapacityKind => value === 'process' || value === 'task';
const validSource = (value: unknown): value is CapacitySource => value === 'automatic' || value === 'interactive';

/** Allow roughly one automatic agent per two CPUs and 3 GiB, then keep at least one manual slot. */
export function estimateCapacityLimits(): CapacityLimits {
  const cores = availableParallelism();
  const memoryGiB = totalmem() / (1024 ** 3);
  const soft = Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(memoryGiB / 3)));
  const hard = Math.max(soft + 1, Math.min(cores, Math.floor(memoryGiB / 2)));
  return { soft, hard, basis: 'hardware-estimate' };
}

function limit(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function bytes(value: unknown, environment: string | undefined, label: string, allowZero = false): number | undefined {
  let parsed = value;
  if (parsed === undefined && environment !== undefined) {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(environment)) throw new Error(`${label} must be a valid memory size`);
    parsed = Number(environment) * MiB;
  }
  if (parsed === undefined) return undefined;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a valid memory size`);
  }
  return parsed;
}

/** Darwin's raw free count excludes reclaimable inactive caches. Purgeable pages are not added twice. */
export function parseMacOSAvailableMemory(output: string, totalBytes: number): number {
  const pageSize = /page size of (\d+) bytes/.exec(output);
  if (!pageSize || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error(stateMessage);
  const pageBytes = Number(pageSize[1]);
  if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0) throw new Error(stateMessage);
  let pages = 0;
  for (const label of ['free', 'inactive', 'speculative']) {
    const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(output);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(stateMessage);
    pages += Number(match[1]);
  }
  const available = pages * pageBytes;
  if (!Number.isSafeInteger(available)) throw new Error(stateMessage);
  return Math.min(totalBytes, available);
}

function currentMemory(): CapacityMemoryReading {
  const totalBytes = totalmem();
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 1000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'] });
      return { totalBytes, availableBytes: parseMacOSAvailableMemory(output, totalBytes), source: 'macos-reclaimable-estimate' };
    } catch { /* Fall back conservatively when the host cannot read its reclaimable-page estimate. */ }
  }
  // availableMemory also respects the process/container allocation when the Node host exposes it.
  const processAvailable = process.availableMemory?.();
  return { totalBytes, availableBytes: Math.min(freemem(), processAvailable ?? Infinity), source: 'system-available' };
}

/** Only ESRCH proves death. Permission failures and PID reuse retain the reservation. */
function isDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export function resolveCapacityDirectory(options: CapacityOptions = {}): string {
  const directory = options.directory ?? process.env.ACP_CAPACITY_DIRECTORY ?? join(homedir(), '.1agents', 'state', 'acp-capacity');
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('ACP capacity directory must be a nonempty path');
  return resolve(directory);
}

export class CapacityGovernor {
  private readonly directory: string;
  private readonly limits: CapacityLimits;
  private readonly memoryProvider: () => CapacityMemoryReading;
  private readonly memoryReserveBytes: number;
  private readonly estimatedInstanceBytes: number;

  constructor(options: CapacityOptions = {}) {
    this.directory = resolveCapacityDirectory(options);
    const estimate = estimateCapacityLimits();
    const soft = limit(options.softLimit ?? process.env.ACP_CAPACITY_SOFT_LIMIT, 'ACP capacity soft limit');
    const hard = limit(options.hardLimit ?? process.env.ACP_CAPACITY_HARD_LIMIT, 'ACP capacity hard limit');
    this.limits = {
      soft: soft ?? (hard === undefined ? estimate.soft : Math.min(estimate.soft, hard - 1)),
      hard: hard ?? Math.max(estimate.hard, (soft ?? estimate.soft) + 1),
      basis: soft === undefined && hard === undefined ? 'hardware-estimate' : 'configured',
    };
    if (this.limits.soft < 1 || this.limits.hard <= this.limits.soft || !Number.isSafeInteger(this.limits.hard)) {
      throw new Error('ACP capacity hard limit must exceed the soft limit and reserve at least one interactive slot');
    }
    this.memoryProvider = options.memoryProvider ?? currentMemory;
    if (typeof this.memoryProvider !== 'function') throw new Error('ACP capacity memory provider must be a function');
    this.memoryReserveBytes = bytes(options.memoryReserveBytes, process.env.ACP_CAPACITY_MEMORY_RESERVE_MB,
      'ACP capacity memory reserve', true) ?? Math.max(512 * MiB, Math.min(4 * 1024 * MiB, Math.floor(totalmem() * 0.1)));
    this.estimatedInstanceBytes = bytes(options.estimatedInstanceBytes, process.env.ACP_CAPACITY_INSTANCE_MEMORY_MB,
      'ACP estimated instance memory') ?? 1024 * MiB;
  }

  async acquire(request: CapacityRequest): Promise<CapacityLease> {
    if (!request || !validKind(request.kind) || !validSource(request.source) || typeof request.id !== 'string' ||
        !request.id.trim() || request.id.length > 4096 ||
        (request.origin !== undefined && (request.kind !== 'process' || !processOrigins.has(request.origin)))) {
      throw new Error('Invalid ACP capacity request');
    }
    const reservation: Reservation = { version: 1, token: randomUUID(), ownerPid: process.pid, startupUntil: Date.now() + startupWindowMs,
      kind: request.kind, source: request.source, id: request.id, ...(request.origin ? { origin: request.origin } : {}) };
    await this.transaction(() => {
      const records = this.readReservations();
      this.ensurePolicy(records);
      const state = this.count(request.kind, records);
      if (state.used >= this.limits.hard) throw new CapacityError('ACP_CAPACITY_HARD_LIMIT');
      if (request.source === 'automatic' && state.used >= this.limits.soft) throw new CapacityError('ACP_CAPACITY_SOFT_LIMIT');
      if (state.memory.availableSlots < 1) throw new CapacityError('ACP_CAPACITY_MEMORY_LIMIT');
      this.writeReservation({ ...reservation, startupUntil: Date.now() + startupWindowMs });
    });

    // Serialize methods on an individual lease so release can never be followed by resurrection.
    let released = false;
    let pending: Promise<void> = Promise.resolve();
    const queue = (operation: () => Promise<void>): Promise<void> => {
      const result = pending.then(operation);
      pending = result.catch(() => undefined);
      return result;
    };
    return {
      recheck: () => queue(async () => {
        if (released) throw new Error('ACP capacity lease has already been released');
        await this.transaction(() => {
          const records = this.readReservations();
          this.ensurePolicy(records);
          if (!records.some(item => item.token === reservation.token && item.ownerPid === process.pid)) throw new Error(stateMessage);
          const state = this.count(request.kind, records, reservation.token);
          if (state.memory.availableSlots < 1) throw new CapacityError('ACP_CAPACITY_MEMORY_LIMIT');
          const own = records.find(item => item.token === reservation.token)!;
          this.writeReservation({ ...own, startupUntil: Date.now() + startupWindowMs });
        });
      }),
      spawned: pid => queue(async () => {
        if (!pidIsValid(pid) || request.kind !== 'process') throw new Error('Invalid ACP child process registration');
        if (released) throw new Error('ACP capacity lease has already been released');
        await this.transaction(() => {
          const current = this.readReservation(this.reservationPath(reservation.token));
          if (current.ownerPid !== process.pid || current.token !== reservation.token ||
              (current.childPid !== undefined && current.childPid !== pid)) throw new Error(stateMessage);
          this.writeReservation({ ...current, childPid: pid, startupUntil: Date.now() + startupWindowMs });
        });
      }),
      release: () => queue(async () => {
        if (released) return;
        await this.transaction(() => {
          try { unlinkSync(this.reservationPath(reservation.token)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        });
        released = true;
      }),
    };
  }

  async snapshot(kind: CapacityKind): Promise<CapacitySnapshot> {
    if (!validKind(kind)) throw new Error('Invalid ACP capacity kind');
    return this.transaction(() => {
      const records = this.readReservations();
      this.ensurePolicy(records);
      return this.count(kind, records);
    });
  }

  /**
   * Read both ledgers and process-lease origins. Does not acquire, release, or relabel.
   * A missing origin stays unlabeled. Dead owners stay on disk for the next admission pass.
   */
  async inspect(): Promise<CapacityInspection> {
    return this.transaction(() => {
      const records = this.readReservations(false);
      const limit = this.recordedLimit() ?? this.limits.soft;
      const sessions: CapacityInspection['sessions'] = { prewarm: [], job: [], 'user-opened': [], unlabeled: [] };
      for (const record of records) {
        if (record.kind !== 'process') continue;
        const row = { id: record.id, ownerPid: record.ownerPid, ...(record.childPid !== undefined ? { childPid: record.childPid } : {}) };
        if (record.origin && processOrigins.has(record.origin)) sessions[record.origin].push(row);
        else sessions.unlabeled.push(row);
      }
      const used = (kind: CapacityKind) => records.filter(record => record.kind === kind).length;
      return { taskSlot: { limit, used: used('task') }, processSlot: { limit, used: used('process') }, sessions };
    });
  }

  private count(kind: CapacityKind, reservations: Reservation[], excludeStartupToken?: string): CapacitySnapshot {
    const matching = reservations.filter(item => item.kind === kind);
    const automatic = matching.filter(item => item.source === 'automatic').length;
    const used = matching.length;
    const reading = this.memoryProvider();
    if (!reading || !Number.isSafeInteger(reading.totalBytes) || reading.totalBytes <= 0 ||
        !Number.isSafeInteger(reading.availableBytes) || reading.availableBytes < 0 || reading.availableBytes > reading.totalBytes) {
      throw new Error(stateMessage);
    }
    // Pending processes retain their budget until spawn is registered. Stable leases stay counted
    // for concurrency, but actual free memory carries their cost after the startup window expires.
    // Share startup memory budget across kinds. Without an explicit task-to-child association,
    // short-lived double counting is safer than letting unrelated starts spend the same bytes.
    const starting = reservations.filter(item => item.token !== excludeStartupToken &&
      ((item.kind === 'process' && item.childPid === undefined) || item.startupUntil > Date.now()));
    const startupReservedBytes = starting.length * this.estimatedInstanceBytes;
    const availableForStartupBytes = Math.max(0, reading.availableBytes - this.memoryReserveBytes - startupReservedBytes);
    const availableSlots = Math.floor(availableForStartupBytes / this.estimatedInstanceBytes);
    return { limits: { ...this.limits }, used, automatic, interactive: used - automatic,
      availableAutomatic: Math.max(0, Math.min(this.limits.soft - used, this.limits.hard - used, availableSlots)),
      availableInteractive: Math.max(0, Math.min(this.limits.hard - used, availableSlots)),
      memory: { ...reading, source: reading.source ?? 'host-provider', reserveBytes: this.memoryReserveBytes, estimatedInstanceBytes: this.estimatedInstanceBytes,
        startupReservedBytes, availableForStartupBytes, availableSlots, startupWindowMs } };
  }

  private recordedLimit(): number | undefined {
    try {
      const value = this.readJson(join(this.directory, 'policy.json')) as { version?: unknown; softLimit?: unknown };
      if (!value || value.version !== 1 || !Number.isSafeInteger(value.softLimit) || (value.softLimit as number) < 1) throw new Error(stateMessage);
      return value.softLimit as number;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private readReservations(reclaim = true): Reservation[] {
    const records: Reservation[] = [];
    for (const name of readdirSync(this.directory)) {
      if (name === '.lock' || name === 'policy.json') continue;
      if (name === 'queue') {
        const stat = lstatSync(join(this.directory, name));
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(stateMessage);
        continue;
      }
      // A crash before an atomic rename leaves no admitted caller and therefore no spawned child.
      if (/^pending-[a-f0-9-]{36}\.json$/.test(name)) { unlinkSync(join(this.directory, name)); continue; }
      if (!/^lease-[a-f0-9-]{36}\.json$/.test(name)) throw new Error(stateMessage);
      const path = join(this.directory, name);
      const record = this.readReservation(path);
      if (name !== `lease-${record.token}.json`) throw new Error(stateMessage);
      // An unregistered process may have spawned just before its owner crashed. Never guess it dead.
      const reclaimable = isDead(record.ownerPid) &&
        (record.kind === 'task' || (record.childPid !== undefined && isDead(record.childPid)));
      if (reclaim && reclaimable) unlinkSync(path);
      else records.push(record);
    }
    return records;
  }

  private reservationPath(token: string): string { return join(this.directory, `lease-${token}.json`); }

  private ensurePolicy(records: Reservation[]): void {
    const policy = { version: 1, softLimit: this.limits.soft, hardLimit: this.limits.hard,
      memoryReserveBytes: this.memoryReserveBytes, estimatedInstanceBytes: this.estimatedInstanceBytes };
    const path = join(this.directory, 'policy.json');
    let current: Record<string, unknown> | undefined;
    try {
      current = this.readJson(path) as Record<string, unknown>;
      if (!current || current.version !== 1 || !Number.isSafeInteger(current.softLimit) || (current.softLimit as number) < 1 ||
          !Number.isSafeInteger(current.hardLimit) || (current.hardLimit as number) <= (current.softLimit as number) ||
          !Number.isSafeInteger(current.memoryReserveBytes) || (current.memoryReserveBytes as number) < 0 ||
          !Number.isSafeInteger(current.estimatedInstanceBytes) || (current.estimatedInstanceBytes as number) <= 0) throw new Error(stateMessage);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (records.length) throw new Error(stateMessage);
    }
    const matches = current && Object.entries(policy).every(([key, value]) => current![key] === value);
    if (matches) return;
    // Hosts sharing a device cannot raise each other's active policy by choosing different options.
    // Drain first; releases do not require a policy match, so active hosts can always finish.
    if (records.length) throw new Error(stateMessage);
    this.writeJson(path, policy);
  }

  private readJson(path: string): unknown {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error(stateMessage);
      return JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
  }

  private readReservation(path: string): Reservation {
    const value = this.readJson(path) as Reservation;
    if (!value || value.version !== 1 || typeof value.token !== 'string' || !tokenPattern.test(value.token) ||
        !pidIsValid(value.ownerPid) || !validKind(value.kind) || !validSource(value.source) ||
        typeof value.id !== 'string' || !value.id.trim() || value.id.length > 4096 ||
        !Number.isSafeInteger(value.startupUntil) || value.startupUntil < 0 ||
        (value.childPid !== undefined && (!pidIsValid(value.childPid) || value.kind !== 'process')) ||
        (value.origin !== undefined && (value.kind !== 'process' || !processOrigins.has(value.origin)))) throw new Error(stateMessage);
    return value;
  }

  private writeReservation(record: Reservation): void {
    this.writeJson(this.reservationPath(record.token), record);
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

  private async transaction<T>(operation: () => T): Promise<T> {
    let lease: DirectoryLease | undefined;
    const deadline = performance.now() + 5000;
    do {
      try { lease = new DirectoryLease(this.directory); break; }
      catch { if (performance.now() >= deadline) throw new Error(stateMessage); }
      await delay(10 + Math.floor(Math.random() * 20));
    } while (true);
    try { return operation(); }
    catch (error) {
      if (error instanceof CapacityError) throw error;
      throw new Error(stateMessage);
    } finally {
      try { lease.close(); }
      catch { throw new Error(stateMessage); }
    }
  }
}
