/** Plugin-owned ACP diagnostics; official DSH session events remain unchanged. */
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import { randomUUID } from 'node:crypto';
import { z } from 'dsh-zod';
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { DirectoryLease, isStorageBusy } from '@1agents/acp-service/a2a';
import { toSafeError, type SafeError } from '@1agents/acp-service/runtime';

const identitySchema = z.object({
  sessionId: z.string().min(1).max(256), turn: z.number().int().nonnegative(),
  turnStartSeq: z.number().int().nonnegative(), stepStartSeq: z.number().int().nonnegative(),
  nativeRequestId: z.string().regex(/^dsh-[a-f0-9]{64}$/),
  messageIds: z.array(z.string().min(1).max(256)).min(1).max(128), requestIds: z.array(z.string().min(1).max(256)).max(128),
}).strict();
const errorSchema = z.object({
  category: z.enum(['quota', 'rate_limit', 'budget', 'auth', 'cancelled', 'timeout', 'permission', 'unknown']),
  providerCode: z.enum(['usageLimitExceeded', 'quota_exhausted', 'insufficient_quota', 'rateLimitExceeded',
    'rate_limited', 'rate_limit_exceeded', 'sessionBudgetExceeded', 'budget_exhausted', 'unauthorized',
    'auth_required', 'authentication_required']).optional(),
  retryable: z.boolean(), outcomeUnknown: z.boolean(),
  code: z.string().max(128).optional(), detailCode: z.string().max(128).optional(),
  origin: z.enum(['cli', 'runtime', 'queue', 'acp', 'service', 'transport', 'dsh', 'a2a']),
}).strict().refine(value => {
  const safe = toSafeError(value, { trustedProjection: true });
  return safe.code === value.code && safe.detailCode === value.detailCode;
});
const recordSchema = z.object({
  id: z.string().uuid(), serial: z.number().int().positive(), identity: identitySchema,
  phase: z.enum(['prepared', 'submitted', 'confirmed', 'settled']),
  error: errorSchema.optional(),
}).strict().refine(value => value.phase === 'settled' || value.phase === 'confirmed' || value.error === undefined);
const spec = defineDomain({ name: 'oneagents_acp_diagnostics', version: 1,
  tables: { attempts: domainTable<string, z.infer<typeof recordSchema>>(recordSchema) } });
export type DiagnosticIdentity = z.infer<typeof identitySchema>;
type DiagnosticRecord = z.infer<typeof recordSchema>;
/** Methods the adapter and A2A backend actually call. A follower may implement them in memory. */
export interface DiagnosticLog {
  begin(identity: DiagnosticIdentity): Promise<string>;
  submitted(id: string): Promise<void>;
  confirmed(id: string): Promise<void>;
  settle(id: string, error?: SafeError): Promise<void>;
  find(sessionId: string, requestId: string, turn?: number, turnStartSeq?: number): SafeError | undefined;
  close(): Promise<void>;
}

/** Shared by the owned Adapter and A2A backend; every mutating method awaits durability. */
export class Diagnostics {
  private serial = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(private readonly domain: Domain<typeof spec>) {
    const serials = new Set<number>();
    for (const [key, record] of domain.table('attempts').entries()) {
      if (record.id !== key || serials.has(record.serial)) throw new Error('Invalid ACP diagnostic identity');
      serials.add(record.serial); this.serial = Math.max(this.serial, record.serial);
    }
  }
  /** Open the plugin's schema-validated domain using the configured official storage facility. */
  static async open(facility: DomainFacility): Promise<Diagnostics> {
    let domain: Domain<typeof spec>;
    try { domain = await facility.open(spec); } catch { throw new Error('ACP diagnostic storage could not be opened; check its configuration and version.'); }
    try { return new Diagnostics(domain); }
    catch { await domain.close(); throw new Error('Invalid ACP diagnostic storage identity.'); }
  }
  private write<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ACP diagnostics are closed'));
    const next = this.chain.then(action); this.chain = next.catch(() => {}); return next;
  }
  /** Persist admission before starting a native delivery attempt. */
  begin(identity: DiagnosticIdentity): Promise<string> {
    const snapshot = identitySchema.parse(identity);
    return this.write(async () => {
      const serial = this.serial + 1;
      if (!Number.isSafeInteger(serial)) throw new Error('ACP diagnostic sequence exhausted');
      const id = randomUUID();
      await this.domain.table('attempts').put(id, { id, serial, identity: snapshot, phase: 'prepared' });
      this.serial = serial; return id;
    });
  }
  /** Mark a conservative delivery attempt, before asking the cooperative SDK to send. */
  submitted(id: string): Promise<void> {
    return this.write(async () => {
      await this.domain.table('attempts').update(id, record => {
        if (record.phase !== 'prepared' && record.phase !== 'submitted') throw new Error('ACP diagnostic attempt already confirmed');
        return { ...record, phase: 'submitted' };
      });
    });
  }
  /** Persist a received terminal reply before allowing host output or cancellation to settle. */
  confirmed(id: string): Promise<void> {
    return this.write(async () => {
      await this.domain.table('attempts').update(id, record => {
        if (record.phase === 'settled') throw new Error('ACP diagnostic attempt already settled');
        return { ...record, phase: 'confirmed' };
      });
    });
  }
  /** Save only the safe whitelist before any failure is given to the official host. */
  settle(id: string, error?: SafeError): Promise<void> {
    const safe = error === undefined ? undefined : errorSchema.parse({
      category: error.category, retryable: error.retryable, outcomeUnknown: error.outcomeUnknown, origin: error.origin,
      ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.detailCode === undefined ? {} : { detailCode: error.detailCode }),
    });
    return this.write(async () => {
      await this.domain.table('attempts').update(id, record => {
        if (record.phase === 'settled') throw new Error('ACP diagnostic attempt already settled');
        return { ...record, phase: 'settled', ...(safe === undefined ? {} : { error: safe }) };
      });
    });
  }
  /** Resolve only this request's newest owned attempt; a pending retry never borrows an older failure. */
  find(sessionId: string, requestId: string, turn?: number, turnStartSeq?: number): SafeError | undefined {
    const records = [...this.domain.table('attempts').entries()].map(([, record]) => record)
      .filter(record => record.identity.sessionId === sessionId && record.identity.requestIds.includes(requestId)
        && (turn === undefined || record.identity.turn === turn)
        && (turnStartSeq === undefined || record.identity.turnStartSeq === turnStartSeq));
    const record = records.sort((a, b) => b.serial - a.serial)[0];
    if (!record) return;
    return record.error ? toSafeError(record.error, { trustedProjection: true, origin: 'dsh', operationId: requestId })
      : toSafeError(undefined, { origin: 'dsh', operationId: requestId, outcomeUnknown: record.phase === 'submitted' });
  }
  /** Drain writes before unloading; the owner first drains A2A and the Adapter. */
  async close(): Promise<void> { this.closed = true; await this.chain; await this.domain.close(); }
}

/** Process-local diagnostics. Used when another instance already owns the directory, so chat can continue without writing its files. */
class MemoryDiagnostics implements DiagnosticLog {
  private serial = 0;
  private readonly records = new Map<string, DiagnosticRecord>();
  private closed = false;
  begin(identity: DiagnosticIdentity): Promise<string> {
    if (this.closed) return Promise.reject(new Error('ACP diagnostics are closed'));
    const snapshot = identitySchema.parse(identity);
    const serial = this.serial + 1;
    if (!Number.isSafeInteger(serial)) return Promise.reject(new Error('ACP diagnostic sequence exhausted'));
    const id = randomUUID();
    this.records.set(id, { id, serial, identity: snapshot, phase: 'prepared' });
    this.serial = serial;
    return Promise.resolve(id);
  }
  submitted(id: string): Promise<void> {
    return this.update(id, record => {
      if (record.phase !== 'prepared' && record.phase !== 'submitted') throw new Error('ACP diagnostic attempt already confirmed');
      return { ...record, phase: 'submitted' };
    });
  }
  confirmed(id: string): Promise<void> {
    return this.update(id, record => {
      if (record.phase === 'settled') throw new Error('ACP diagnostic attempt already settled');
      return { ...record, phase: 'confirmed' };
    });
  }
  settle(id: string, error?: SafeError): Promise<void> {
    const safe = error === undefined ? undefined : errorSchema.parse({
      category: error.category, retryable: error.retryable, outcomeUnknown: error.outcomeUnknown, origin: error.origin,
      ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.detailCode === undefined ? {} : { detailCode: error.detailCode }),
    });
    return this.update(id, record => {
      if (record.phase === 'settled') throw new Error('ACP diagnostic attempt already settled');
      return { ...record, phase: 'settled', ...(safe === undefined ? {} : { error: safe }) };
    });
  }
  find(sessionId: string, requestId: string, turn?: number, turnStartSeq?: number): SafeError | undefined {
    const records = [...this.records.values()].filter(record => record.identity.sessionId === sessionId && record.identity.requestIds.includes(requestId)
      && (turn === undefined || record.identity.turn === turn)
      && (turnStartSeq === undefined || record.identity.turnStartSeq === turnStartSeq));
    const record = records.sort((a, b) => b.serial - a.serial)[0];
    if (!record) return;
    return record.error ? toSafeError(record.error, { trustedProjection: true, origin: 'dsh', operationId: requestId })
      : toSafeError(undefined, { origin: 'dsh', operationId: requestId, outcomeUnknown: record.phase === 'submitted' });
  }
  async close(): Promise<void> { this.closed = true; }
  private update(id: string, change: (record: DiagnosticRecord) => DiagnosticRecord): Promise<void> {
    if (this.closed) return Promise.reject(new Error('ACP diagnostics are closed'));
    const current = this.records.get(id);
    if (!current) return Promise.reject(new Error('ACP diagnostic attempt is missing'));
    this.records.set(id, change(current));
    return Promise.resolve();
  }
}

/** Own the official storage plugins until A2A and native calls have drained. */
export async function openDiagnostics(directory: string, options?: { onConflict?: 'throw' | 'readonly' }): Promise<{ diagnostics: DiagnosticLog; close: () => Promise<void>; mode: 'read-write' | 'read-only' }> {
  let lease: DirectoryLease;
  try { lease = new DirectoryLease(directory); }
  catch (error) {
    if (options?.onConflict === 'readonly' && isStorageBusy(error)) {
      const diagnostics = new MemoryDiagnostics();
      return { diagnostics, mode: 'read-only', close: () => diagnostics.close() };
    }
    throw error;
  }
  // The host's shared facility can close concurrently during root teardown.
  // This private composition gives the consumer an explicit drain-before-close order.
  const storage = new Context();
  try {
    await storage.plugin(Storage);
    await storage.plugin(JsonStorage, { root: directory });
    const mounted = await storage.plugin(StorageDomain, { backend: 'json' });
    await mounted.await();
    const diagnostics = await Diagnostics.open(storage.storageDomain);
    let closing: Promise<void> | undefined;
    return { diagnostics, mode: 'read-write', close: () => closing ??= (async () => {
      try { await diagnostics.close(); } finally { try { await storage.fiber.dispose(); } finally { lease.close(); } }
    })() };
  } catch {
    try { await storage.fiber.dispose(); } finally { lease.close(); }
    throw new Error('ACP diagnostic storage could not be opened; check its configuration and version.');
  }
}
