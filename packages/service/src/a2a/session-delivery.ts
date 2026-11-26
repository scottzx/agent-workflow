/** Durable admission to host-owned conversation queues; acceptance is not business completion. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { deliverSessionMessage, SessionDeliveryError, sessionNoticeSchema, type SessionDeliveryMode, type SessionHost, type SessionNoticeMeta } from './session-hosts.js';

const id = z.string().trim().min(1).max(512);
const deliveryModeSchema = z.enum(['queue', 'steer']);
export const sessionOriginSchema = z.object({ originSessionId: id }).strict();
export const sessionBindSchema = sessionOriginSchema.extend({ host: id, sessionId: id }).strict();
export const sessionMessageSchema = sessionOriginSchema.extend({ messageId: id }).strict();
export const sessionSendSchema = sessionMessageSchema.extend({
  text: z.string().min(1).max(256 * 1024).refine(value => Boolean(value.trim())),
  mode: deliveryModeSchema.optional(),
  notice: sessionNoticeSchema.optional(),
}).strict();
export const sessionResolveSchema = sessionMessageSchema.extend({ accepted: z.boolean(), note: id, hostReceiptId: id.optional() }).strict();

export interface SessionBinding {
  originSessionId: string;
  host: string;
  sessionId: string;
  createdAt: string;
}
interface StoredBinding extends SessionBinding { hostFingerprint: string }
export type SessionDeliveryStatus = 'pending' | 'dispatching' | 'retrying' | 'accepted' | 'unknown' | 'rejected';
export interface SessionDeliveryCounts {
  total: number;
  pending: number;
  dispatching: number;
  retrying: number;
  accepted: number;
  unknown: number;
  rejected: number;
}
export interface SessionBindingStatus {
  originSessionId: string;
  bound: boolean;
  binding?: SessionBinding;
  deliveries: SessionDeliveryCounts & { unprocessed: number };
  blocked: boolean;
}
export interface SessionDeliverySummary {
  bindings: number;
  deliveries: SessionDeliveryCounts;
  blockedOrigins: number;
}
export interface SessionDeliveryReceipt extends SessionBinding {
  messageId: string;
  mode?: SessionDeliveryMode;
  notice?: SessionNoticeMeta;
  status: SessionDeliveryStatus;
  attempts: number;
  updatedAt: string;
  nextAttemptAt?: string;
  hostReceiptId?: string;
  error?: string;
  processedAt?: string;
  resolutionNote?: string;
}
interface Delivery extends SessionDeliveryReceipt { text: string; hostFingerprint: string }
const deliveryStatusSchema = z.enum(['pending', 'dispatching', 'retrying', 'accepted', 'unknown', 'rejected']);
const bindingSchema = sessionBindSchema.extend({ createdAt: id, hostFingerprint: id }).strict();
const deliverySchema = bindingSchema.extend({
  messageId: id, text: sessionSendSchema.shape.text, mode: deliveryModeSchema.optional(), notice: sessionNoticeSchema.optional(),
  status: deliveryStatusSchema,
  attempts: z.number().int().nonnegative(), updatedAt: id,
  nextAttemptAt: id.optional(), hostReceiptId: id.optional(), error: id.optional(),
  processedAt: id.optional(), resolutionNote: id.optional(),
}).strict();
/** Subscriber deliveries are not owner bindings. Old files omit this array. */
const targetDeliverySchema = z.object({
  targetKey: z.string().trim().min(1).max(1200),
  host: id,
  sessionId: id,
  hostFingerprint: id,
  messageId: id,
  text: sessionSendSchema.shape.text,
  mode: deliveryModeSchema.optional(),
  notice: sessionNoticeSchema.optional(),
  status: deliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  createdAt: id,
  updatedAt: id,
  nextAttemptAt: id.optional(),
  hostReceiptId: id.optional(),
  error: id.optional(),
  processedAt: id.optional(),
  resolutionNote: id.optional(),
}).strict();
const stateSchema = z.object({
  version: z.literal(1),
  bindings: z.array(bindingSchema),
  deliveries: z.array(deliverySchema),
  targetDeliveries: z.array(targetDeliverySchema).optional(),
}).strict();
type TargetDelivery = z.output<typeof targetDeliverySchema>;
type State = { version: 1; bindings: StoredBinding[]; deliveries: Delivery[]; targetDeliveries: TargetDelivery[] };
export interface TargetDeliveryReceipt {
  targetKey: string;
  host: string;
  sessionId: string;
  messageId: string;
  mode?: SessionDeliveryMode;
  notice?: SessionNoticeMeta;
  status: SessionDeliveryStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  hostReceiptId?: string;
  error?: string;
  processedAt?: string;
  resolutionNote?: string;
}
export interface TargetEnqueueInput {
  targetKey: string;
  host: string;
  sessionId: string;
  messageId: string;
  text: string;
  mode?: SessionDeliveryMode;
  notice?: SessionNoticeMeta;
}

/** Credentials may rotate; a host alias must never silently redirect saved messages. */
function fingerprint(host: SessionHost): string {
  const { headers, timeoutMs, ...locator } = host as SessionHost & { headers?: unknown; timeoutMs?: number };
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(locator).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
}
function receipt(delivery: Delivery): SessionDeliveryReceipt {
  const { text, hostFingerprint, ...view } = delivery;
  return { ...view };
}
function targetReceipt(delivery: TargetDelivery): TargetDeliveryReceipt {
  const { text, hostFingerprint, ...view } = delivery;
  return { ...view };
}

/** Owned by the gateway's single-writer storage lease. */
export class SessionDelivery {
  private readonly file: string;
  private readonly state: State;
  private readonly controller = new AbortController();
  private pumping?: Promise<void>;
  private repump = false;
  private closed = false;
  private storageFailed = false;

  constructor(directory: string, private readonly hosts: Record<string, SessionHost>) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'session-delivery.json');
    try {
      const parsed = stateSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      this.state = { ...parsed, targetDeliveries: parsed.targetDeliveries ?? [] };
      const origins = new Set<string>(), messages = new Set<string>(), targets = new Set<string>();
      for (const binding of this.state.bindings) {
        if (origins.has(binding.originSessionId)) throw new Error('Duplicate session binding');
        origins.add(binding.originSessionId);
      }
      for (const delivery of this.state.deliveries) {
        const key = JSON.stringify([delivery.originSessionId, delivery.messageId]);
        if (messages.has(key)) throw new Error('Duplicate session delivery');
        messages.add(key);
        const binding = this.state.bindings.find(value => value.originSessionId === delivery.originSessionId);
        if (!binding || binding.host !== delivery.host || binding.sessionId !== delivery.sessionId || binding.hostFingerprint !== delivery.hostFingerprint) throw new Error('Session delivery binding mismatch');
        if (delivery.status === 'dispatching') {
          delivery.status = 'unknown';
          delivery.error = 'Gateway restarted during host admission; verify the host before resolving';
          delivery.updatedAt = new Date().toISOString();
        }
      }
      for (const delivery of this.state.targetDeliveries) {
        const key = JSON.stringify([delivery.targetKey, delivery.messageId]);
        if (targets.has(key)) throw new Error('Duplicate session delivery');
        targets.add(key);
        if (delivery.status === 'dispatching') {
          delivery.status = 'unknown';
          delivery.error = 'Gateway restarted during host admission; verify the host before resolving';
          delivery.updatedAt = new Date().toISOString();
        }
      }
      this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, bindings: [], deliveries: [], targetDeliveries: [] };
    }
  }

  private save(): void {
    if (this.storageFailed) throw new Error('Session delivery storage is unavailable; repair storage and restart the gateway');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      const dir = openSync(path.dirname(this.file), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch {
      this.storageFailed = true;
      throw new Error('Session delivery storage is unavailable; repair storage and restart the gateway');
    }
  }
  get healthy(): boolean { return !this.storageFailed; }
  private requireWritable(): void {
    if (this.closed) throw new Error('Session delivery is closed');
    if (this.storageFailed) throw new Error('Session delivery storage is unavailable; repair storage and restart the gateway');
  }
  hasBinding(originSessionId: string): boolean { return this.state.bindings.some(value => value.originSessionId === originSessionId); }
  hasDelivery(originSessionId: string, messageId: string): boolean {
    return this.state.deliveries.some(value => value.originSessionId === originSessionId && value.messageId === messageId);
  }
  bind(input: z.output<typeof sessionBindSchema>): SessionBinding {
    this.requireWritable();
    const host = this.hosts[input.host];
    if (!host) throw new Error('Unknown session host');
    if (host.kind === 'codex' && !z.uuid().safeParse(input.sessionId).success) throw new Error('Codex session ID must be a thread UUID');
    const previous = this.state.bindings.find(value => value.originSessionId === input.originSessionId);
    if (previous) {
      if (previous.host !== input.host || previous.sessionId !== input.sessionId || previous.hostFingerprint !== fingerprint(host)) throw new Error('Origin session is already bound to a different host or session');
      const { hostFingerprint, ...view } = previous; return { ...view };
    }
    const binding = { ...input, hostFingerprint: fingerprint(host), createdAt: new Date().toISOString() };
    this.state.bindings.push(binding);
    try { this.save(); } catch (error) { this.state.bindings.pop(); throw error; }
    const { hostFingerprint, ...view } = binding; return view;
  }
  enqueue(input: z.output<typeof sessionSendSchema>): SessionDeliveryReceipt {
    this.requireWritable();
    const previous = this.state.deliveries.find(value => value.originSessionId === input.originSessionId && value.messageId === input.messageId);
    if (previous) {
      const sameNotice = JSON.stringify(previous.notice ?? null) === JSON.stringify(input.notice ?? null);
      if (previous.text !== input.text || (previous.mode ?? 'queue') !== (input.mode ?? 'queue') || !sameNotice) {
        throw new Error('Message ID was already used for different content');
      }
      return receipt(previous);
    }
    const binding = this.state.bindings.find(value => value.originSessionId === input.originSessionId);
    if (!binding) throw new Error('Origin session is not bound');
    const now = new Date().toISOString();
    const delivery: Delivery = {
      ...binding,
      messageId: input.messageId,
      text: input.text,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.notice ? { notice: input.notice } : {}),
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      status: 'pending',
    };
    this.state.deliveries.push(delivery);
    try { this.save(); } catch (error) { this.state.deliveries.pop(); throw error; }
    return receipt(delivery);
  }
  /**
   * Resolve a subscriber target without creating a binding.
   * An origin target must already be bound. An explicit host must exist; Codex session IDs must be UUIDs.
   */
  resolveTarget(input: { originSessionId?: string; host?: string; sessionId?: string }): { host: string; sessionId: string } {
    const byOrigin = Boolean(input.originSessionId);
    const byHost = Boolean(input.host || input.sessionId);
    if (byOrigin === byHost) throw new Error('Subscription target must be exactly one of originSessionId or host+sessionId');
    if (byOrigin) {
      const binding = this.state.bindings.find(value => value.originSessionId === input.originSessionId);
      if (!binding) throw new Error('Subscription origin session is not bound');
      if (!this.hosts[binding.host]) throw new Error('Unknown session host');
      return { host: binding.host, sessionId: binding.sessionId };
    }
    if (!input.host || !input.sessionId) throw new Error('Explicit subscription target requires both host and sessionId');
    const host = this.hosts[input.host];
    if (!host) throw new Error('Unknown session host');
    if (host.kind === 'codex' && !z.uuid().safeParse(input.sessionId).success) throw new Error('Codex session ID must be a thread UUID');
    return { host: input.host, sessionId: input.sessionId };
  }
  /** Queue one subscriber delivery on its own FIFO. A blocked target never shares the owner origin queue. */
  enqueueTarget(input: TargetEnqueueInput): TargetDeliveryReceipt {
    this.requireWritable();
    const targetKey = input.targetKey.trim();
    if (!targetKey || targetKey.length > 1200) throw new Error('Invalid subscription target key');
    const host = this.hosts[input.host];
    if (!host) throw new Error('Unknown session host');
    if (host.kind === 'codex' && !z.uuid().safeParse(input.sessionId).success) throw new Error('Codex session ID must be a thread UUID');
    const text = sessionSendSchema.shape.text.parse(input.text);
    const previous = this.state.targetDeliveries.find(value => value.targetKey === targetKey && value.messageId === input.messageId);
    if (previous) {
      const sameNotice = JSON.stringify(previous.notice ?? null) === JSON.stringify(input.notice ?? null);
      if (previous.text !== text || (previous.mode ?? 'queue') !== (input.mode ?? 'queue') || !sameNotice
        || previous.host !== input.host || previous.sessionId !== input.sessionId) {
        throw new Error('Message ID was already used for different content');
      }
      return targetReceipt(previous);
    }
    const now = new Date().toISOString();
    const delivery: TargetDelivery = {
      targetKey,
      host: input.host,
      sessionId: input.sessionId,
      hostFingerprint: fingerprint(host),
      messageId: input.messageId,
      text,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.notice ? { notice: input.notice } : {}),
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      status: 'pending',
    };
    this.state.targetDeliveries.push(delivery);
    try { this.save(); } catch (error) { this.state.targetDeliveries.pop(); throw error; }
    return targetReceipt(delivery);
  }
  getTarget(input: { targetKey: string; messageId: string }): TargetDeliveryReceipt {
    this.requireWritable();
    const delivery = this.state.targetDeliveries.find(value => value.targetKey === input.targetKey && value.messageId === input.messageId);
    if (!delivery) throw new Error('Delivery not found for this subscription target');
    return targetReceipt(delivery);
  }
  get(input: z.output<typeof sessionMessageSchema>): SessionDeliveryReceipt { this.requireWritable(); return receipt(this.find(input)); }
  getBindingStatus(originSessionId: string): SessionBindingStatus {
    this.requireWritable();
    const stored = this.state.bindings.find(value => value.originSessionId === originSessionId);
    const deliveries = this.tally(this.state.deliveries.filter(value => value.originSessionId === originSessionId));
    const blocked = deliveries.unknown > 0 || deliveries.rejected > 0;
    if (!stored) return { originSessionId, bound: false, deliveries, blocked };
    const { hostFingerprint, ...binding } = stored;
    return { originSessionId, bound: true, binding, deliveries, blocked };
  }
  /** In-memory counters for /health. A storage failure stays on `healthy` and must not hide this read. */
  summary(): SessionDeliverySummary {
    const counts = this.tally(this.state.deliveries);
    const deliveries: SessionDeliveryCounts = {
      total: counts.total, pending: counts.pending, dispatching: counts.dispatching, retrying: counts.retrying,
      accepted: counts.accepted, unknown: counts.unknown, rejected: counts.rejected,
    };
    const blockedOrigins = new Set(this.state.deliveries.flatMap(delivery => delivery.status === 'unknown' || delivery.status === 'rejected' ? [delivery.originSessionId] : []));
    return { bindings: this.state.bindings.length, deliveries, blockedOrigins: blockedOrigins.size };
  }
  private tally(deliveries: readonly Delivery[]): SessionDeliveryCounts & { unprocessed: number } {
    const counts: SessionDeliveryCounts & { unprocessed: number } = {
      total: deliveries.length, pending: 0, dispatching: 0, retrying: 0, accepted: 0, unknown: 0, rejected: 0, unprocessed: 0,
    };
    for (const delivery of deliveries) {
      counts[delivery.status] += 1;
      if (!delivery.processedAt) counts.unprocessed += 1;
    }
    return counts;
  }
  private find(input: z.output<typeof sessionMessageSchema>): Delivery {
    const delivery = this.state.deliveries.find(value => value.originSessionId === input.originSessionId && value.messageId === input.messageId);
    if (!delivery) throw new Error('Delivery not found for this origin session');
    return delivery;
  }
  resolve(input: z.output<typeof sessionResolveSchema>): SessionDeliveryReceipt {
    this.requireWritable();
    const delivery = this.find(input);
    if (!['unknown', 'rejected'].includes(delivery.status)) throw new Error('Only unknown or rejected host admission can be resolved');
    delivery.status = input.accepted ? 'accepted' : 'pending';
    delivery.resolutionNote = input.note;
    if (input.hostReceiptId) delivery.hostReceiptId = input.hostReceiptId;
    delivery.updatedAt = new Date().toISOString();
    delete delivery.error; delete delivery.nextAttemptAt;
    this.save(); return receipt(delivery);
  }
  acknowledgeNotice(originSessionId: string, noticeId: string): void {
    this.acknowledgeMessage(originSessionId, `a2a-notice:${noticeId}`);
  }
  acknowledgeProcessRequest(originSessionId: string, requestId: string): void {
    this.acknowledgeMessage(originSessionId, `process-request:${requestId}`);
  }
  acknowledgeMessage(originSessionId: string, messageId: string): void {
    this.requireWritable();
    const delivery = this.state.deliveries.find(value => value.originSessionId === originSessionId && value.messageId === messageId);
    if (delivery && !delivery.processedAt) {
      delivery.processedAt = new Date().toISOString(); delivery.updatedAt = delivery.processedAt; this.save();
    }
  }
  /** The head of one FIFO. `scopeId` is the owner origin or the subscriber target key, never mixed. */
  private async pumpQueue(delivery: Delivery | TargetDelivery | undefined, scopeId: string): Promise<void> {
    if (!delivery || this.closed || this.storageFailed) return;
    // The first unresolved admission holds later messages in this FIFO only.
    if (['unknown', 'rejected', 'dispatching'].includes(delivery.status)) return;
    if (delivery.nextAttemptAt && Date.parse(delivery.nextAttemptAt) > Date.now()) return;
    const host = this.hosts[delivery.host];
    if (!host || fingerprint(host) !== delivery.hostFingerprint) {
      delivery.status = 'unknown'; delivery.error = 'Saved host configuration is missing or its destination changed';
      delivery.updatedAt = new Date().toISOString(); this.save(); return;
    }
    delivery.status = 'dispatching'; delivery.attempts++; delivery.updatedAt = new Date().toISOString();
    delete delivery.nextAttemptAt; this.save();
    try {
      // Host deduplication must preserve the ledger's origin/message scope, or the subscriber target scope.
      const hostMessageId = `1agents-session:${createHash('sha256').update(JSON.stringify([scopeId, delivery.messageId])).digest('hex')}`;
      const result = await deliverSessionMessage(host, {
        sessionId: delivery.sessionId, messageId: hostMessageId, text: delivery.text,
        ...(delivery.mode ? { mode: delivery.mode } : {}),
        ...(delivery.notice ? { notice: delivery.notice } : {}),
      }, this.controller.signal);
      delivery.status = 'accepted'; delivery.hostReceiptId = result.hostReceiptId;
      delete delivery.error;
    } catch (error) {
      if (error instanceof SessionDeliveryError && error.retryable && !error.outcomeUnknown) {
        delivery.status = 'retrying';
        delivery.nextAttemptAt = new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(delivery.attempts - 1, 6))).toISOString();
      } else delivery.status = error instanceof SessionDeliveryError && !error.outcomeUnknown ? 'rejected' : 'unknown';
      delivery.error = error instanceof SessionDeliveryError ? error.message : 'Host admission failed; verify delivery before retrying';
    }
    delivery.updatedAt = new Date().toISOString(); this.save();
  }
  async reconcile(): Promise<void> {
    if (this.closed || this.storageFailed) return;
    if (this.pumping) { this.repump = true; return this.pumping; }
    const run = async (): Promise<void> => {
      do {
        this.repump = false;
        const origins = [...new Set(this.state.deliveries.map(value => value.originSessionId))];
        const targetKeys = [...new Set(this.state.targetDeliveries.map(value => value.targetKey))];
        // Owner origins and subscriber targets are separate FIFOs and run side by side.
        await Promise.allSettled([
          ...origins.map(origin => this.pumpQueue(this.state.deliveries.find(value => value.originSessionId === origin && value.status !== 'accepted' && !value.processedAt), origin)),
          ...targetKeys.map(targetKey => this.pumpQueue(this.state.targetDeliveries.find(value => value.targetKey === targetKey && value.status !== 'accepted' && !value.processedAt), targetKey)),
        ]);
      } while (this.repump && !this.closed && !this.storageFailed);
    };
    this.pumping = run();
    try { await this.pumping; } finally { this.pumping = undefined; }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.controller.abort(); await this.pumping;
  }
}
