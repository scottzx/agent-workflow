/** Durable admission to host-owned conversation queues; acceptance is not business completion. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { deliverSessionMessage, messageCorrelationSchema, SessionDeliveryError, sessionNoticeSchema, type MessageCorrelation, type SessionDeliveryMode, type SessionHost, type SessionNoticeMeta } from './session-hosts.js';

const id = z.string().trim().min(1).max(512);
const deliveryModeSchema = z.enum(['queue', 'steer']);
/** One host admission can carry several queued messages; stay well below the 256 KiB host body limit. */
export const MAX_BATCH_BYTES = 200 * 1024;
const MERGE_SUMMARY_MAX_CHARS = 240;
/** Everything a merged segment shows about one queued message. */
export interface MergeBatchEntry {
  messageId: string;
  fromSessionId?: string;
  notice?: SessionNoticeMeta;
  createdAt: string;
  text: string;
}
/**
 * Frame a queue batch as numbered Chinese segments. The real UTF-8 size of this output is the only
 * merge budget check: attribution fields (`msg_from_session_id`, message IDs) can be hundreds of
 * bytes each, so an estimate would let an over-limit body through.
 */
export function formatMergedBatchText(batch: readonly MergeBatchEntry[]): string {
  const segments = batch.map((entry, index) => {
    const source = entry.fromSessionId
      ? `msg_from_session_id: ${entry.fromSessionId}${entry.notice ? `（系统通知: ${entry.messageId}）` : ''}`
      : entry.notice ? `系统通知: ${entry.messageId}` : `系统消息: ${entry.messageId}`;
    return [`[第 ${index + 1}/${batch.length} 条]`, `来源: ${source}`, `时间: ${entry.createdAt}`, '', entry.text].join('\n');
  });
  return [
    `[队列合并 · 共 ${batch.length} 条消息]`,
    '以下待发消息在同一会话队列中合并为一次投递，请按顺序逐条处理。',
    '',
    ...segments,
  ].join('\n\n');
}
/** Message ID namespaces owned by durable task notifications; callers must never queue into them. */
export const RESERVED_MESSAGE_ID_PREFIXES = ['a2a-notice:', 'execution-notice:', 'process-request:', 'sub-notice:'] as const;
export function isReservedMessageId(messageId: string): boolean {
  return RESERVED_MESSAGE_ID_PREFIXES.some(prefix => messageId.startsWith(prefix));
}
export const sessionOriginSchema = z.object({ originSessionId: id }).strict();
export const sessionBindSchema = sessionOriginSchema.extend({ host: id, sessionId: id }).strict();
export const sessionMessageSchema = sessionOriginSchema.extend({ messageId: id }).strict();
export const sessionSendSchema = sessionMessageSchema.extend({
  /** Sender identity shown to the receiving session; older gateways omit it. */
  fromSessionId: id.optional(),
  text: z.string().min(1).max(256 * 1024).refine(value => Boolean(value.trim())),
  mode: deliveryModeSchema.optional(),
  notice: sessionNoticeSchema.optional(),
  /** Optional L0 `MessageCorrelation` tags; older saved deliveries simply do not have them. */
  correlation: messageCorrelationSchema.optional(),
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
  /** Subscriber queues only. A blocked target is not an owner origin. */
  subscriberDeliveries: SessionDeliveryCounts;
  blockedTargets: number;
}
export interface SessionDeliveryReceipt extends SessionBinding {
  messageId: string;
  fromSessionId?: string;
  mode?: SessionDeliveryMode;
  notice?: SessionNoticeMeta;
  correlation?: MessageCorrelation;
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
  messageId: id, fromSessionId: id.optional(), text: sessionSendSchema.shape.text, mode: deliveryModeSchema.optional(), notice: sessionNoticeSchema.optional(),
  correlation: messageCorrelationSchema.optional(),
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
  fromSessionId: id.optional(),
  text: sessionSendSchema.shape.text,
  mode: deliveryModeSchema.optional(),
  notice: sessionNoticeSchema.optional(),
  correlation: messageCorrelationSchema.optional(),
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
  fromSessionId?: string;
  mode?: SessionDeliveryMode;
  notice?: SessionNoticeMeta;
  correlation?: MessageCorrelation;
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
  fromSessionId?: string;
  text: string;
  mode?: SessionDeliveryMode;
  notice?: SessionNoticeMeta;
  correlation?: MessageCorrelation;
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
    // Old gateways reject an unknown key. Omit the subscriber queue until it is used.
    const { targetDeliveries, ...ownerState } = this.state;
    const payload = targetDeliveries.length ? this.state : ownerState;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(payload)); fsyncSync(fd); } finally { closeSync(fd); }
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
  /** Configured host aliases, used to resolve an implicit cross-session message target. */
  hostNames(): string[] { return Object.keys(this.hosts); }
  /** Hosts already bound to one host session, without duplicates. */
  hostsForSession(sessionId: string): string[] {
    return [...new Set(this.state.bindings.filter(value => value.sessionId === sessionId).map(value => value.host))];
  }
  /** The single owner origin of one (host, session) target. Ambiguous targets have no owner FIFO. */
  originForTarget(host: string, sessionId: string): string | undefined {
    const origins = [...new Set(this.state.bindings
      .filter(value => value.host === host && value.sessionId === sessionId)
      .map(value => value.originSessionId))];
    return origins.length === 1 ? origins[0] : undefined;
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
      // The context tags are part of the payload: reusing an id for another context is a different message.
      const sameCorrelation = JSON.stringify(previous.correlation ?? null) === JSON.stringify(input.correlation ?? null);
      if (previous.text !== input.text || (previous.mode ?? 'queue') !== (input.mode ?? 'queue') || !sameNotice || !sameCorrelation
        || previous.fromSessionId !== input.fromSessionId) {
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
      ...(input.fromSessionId ? { fromSessionId: input.fromSessionId } : {}),
      text: input.text,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.notice ? { notice: input.notice } : {}),
      ...(input.correlation ? { correlation: input.correlation } : {}),
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
      const sameCorrelation = JSON.stringify(previous.correlation ?? null) === JSON.stringify(input.correlation ?? null);
      if (previous.text !== text || (previous.mode ?? 'queue') !== (input.mode ?? 'queue') || !sameNotice || !sameCorrelation
        || previous.host !== input.host || previous.sessionId !== input.sessionId
        || previous.fromSessionId !== input.fromSessionId) {
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
      ...(input.fromSessionId ? { fromSessionId: input.fromSessionId } : {}),
      text,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.notice ? { notice: input.notice } : {}),
      ...(input.correlation ? { correlation: input.correlation } : {}),
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
    const deliveries = this.countsOf(this.state.deliveries);
    const subscriberDeliveries = this.countsOf(this.state.targetDeliveries);
    const blockedOrigins = new Set(this.state.deliveries.flatMap(delivery => delivery.status === 'unknown' || delivery.status === 'rejected' ? [delivery.originSessionId] : []));
    const blockedTargets = new Set(this.state.targetDeliveries.flatMap(delivery => delivery.status === 'unknown' || delivery.status === 'rejected' ? [delivery.targetKey] : []));
    return { bindings: this.state.bindings.length, deliveries, blockedOrigins: blockedOrigins.size, subscriberDeliveries, blockedTargets: blockedTargets.size };
  }
  private countsOf(deliveries: readonly { status: SessionDeliveryStatus; processedAt?: string }[]): SessionDeliveryCounts {
    const counts = this.tally(deliveries);
    return {
      total: counts.total, pending: counts.pending, dispatching: counts.dispatching, retrying: counts.retrying,
      accepted: counts.accepted, unknown: counts.unknown, rejected: counts.rejected,
    };
  }
  private tally(deliveries: readonly { status: SessionDeliveryStatus; processedAt?: string }[]): SessionDeliveryCounts & { unprocessed: number } {
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
  /** One FIFO entry: an owner delivery or a subscriber/direct target delivery. */
  private due(entry: Delivery | TargetDelivery, now: number): boolean {
    if (entry.nextAttemptAt && Date.parse(entry.nextAttemptAt) > now) return false;
    return entry.status === 'pending' || entry.status === 'retrying';
  }
  /**
   * The contiguous run of due queue messages behind one FIFO head. A steer message is always alone and
   * ends the run; unknown, rejected, dispatching, not-yet-due retrying and different host/session
   * entries are hard boundaries, so a failed or uncertain admission is never merged with later work.
   */
  private collectBatch(head: Delivery | TargetDelivery, fifo: readonly (Delivery | TargetDelivery)[]): (Delivery | TargetDelivery)[] {
    if (head.mode === 'steer') return [head];
    const start = fifo.indexOf(head);
    if (start < 0) return [head];
    const now = Date.now();
    const batch: (Delivery | TargetDelivery)[] = [];
    for (let index = start; index < fifo.length; index++) {
      const entry = fifo[index]!;
      // Acknowledged before dispatch: it will never be delivered, so it cannot be a merge partner either.
      if (entry.processedAt) continue;
      if (entry.mode === 'steer') break;
      if (!this.due(entry, now)) break;
      if (entry.host !== head.host || entry.sessionId !== head.sessionId || entry.hostFingerprint !== head.hostFingerprint) break;
      // The exact formatted UTF-8 size is the budget: framing includes sender and message IDs.
      if (batch.length && Buffer.byteLength(formatMergedBatchText([...batch, entry]), 'utf8') > MAX_BATCH_BYTES) break;
      batch.push(entry);
    }
    return batch.length ? batch : [head];
  }
  /** A batch that carries any notice collapses into one notice summary; a pure relay batch stays relay. */
  private batchNotice(batch: readonly (Delivery | TargetDelivery)[]): SessionNoticeMeta | undefined {
    if (batch.length === 1) return batch[0]!.notice;
    if (!batch.some(entry => entry.notice)) return undefined;
    if (batch.some(entry => entry.notice?.form === 'notice')) {
      const first = batch.find(entry => entry.notice?.form === 'notice')!;
      const detail = first.notice?.form === 'notice' ? first.notice.summary : '';
      const raw = `队列合并 · 共 ${batch.length} 条消息${detail ? `：${detail}` : ''}`;
      const summary = raw.length <= MERGE_SUMMARY_MAX_CHARS ? raw : `${raw.slice(0, MERGE_SUMMARY_MAX_CHARS - 1)}…`;
      return { form: 'notice', summary };
    }
    return batch.every(entry => entry.notice?.form === 'relay') ? { form: 'relay' } : undefined;
  }
  /**
   * Deliver the head of one FIFO plus its mergeable queue tail. `scopeId` is the owner origin or the
   * subscriber target key, never mixed. A single message keeps its historical host message ID.
   */
  private async pumpQueue(head: Delivery | TargetDelivery | undefined, scopeId: string, fifo: readonly (Delivery | TargetDelivery)[]): Promise<void> {
    if (!head || this.closed || this.storageFailed) return;
    // The first unresolved admission holds later messages in this FIFO only.
    if (['unknown', 'rejected', 'dispatching'].includes(head.status)) return;
    if (head.nextAttemptAt && Date.parse(head.nextAttemptAt) > Date.now()) return;
    const host = this.hosts[head.host];
    if (!host || fingerprint(host) !== head.hostFingerprint) {
      head.status = 'unknown'; head.error = 'Saved host configuration is missing or its destination changed';
      head.updatedAt = new Date().toISOString(); this.save(); return;
    }
    const batch = this.collectBatch(head, fifo);
    const text = batch.length === 1 ? batch[0]!.text : formatMergedBatchText(batch);
    const notice = this.batchNotice(batch);
    const mode = batch.length > 1 ? 'queue' : (batch[0]!.mode ?? 'queue');
    const startedAt = new Date().toISOString();
    // Mark the whole batch in flight atomically before the host call, so a restart never re-sends part of it.
    for (const entry of batch) {
      entry.status = 'dispatching'; entry.attempts++; entry.updatedAt = startedAt;
      delete entry.nextAttemptAt; delete entry.error;
    }
    this.save();
    let failure: { status: SessionDeliveryStatus; error: string; retryable: boolean } | undefined;
    try {
      // Host deduplication keeps the ledger scope; a merged batch hashes every message ID in order.
      const hostMessageId = `1agents-session:${createHash('sha256').update(JSON.stringify([scopeId, ...batch.map(entry => entry.messageId)])).digest('hex')}`;
      const result = await deliverSessionMessage(host, {
        sessionId: head.sessionId, messageId: hostMessageId, text,
        ...(mode === 'steer' ? { mode } : {}),
        ...(notice ? { notice } : {}),
        ...(batch.length === 1 && batch[0]!.fromSessionId ? { fromSessionId: batch[0]!.fromSessionId } : {}),
        // A merged segment carries several contexts, so only a single message can name one honestly.
        ...(batch.length === 1 && batch[0]!.correlation ? { correlation: batch[0]!.correlation } : {}),
      }, this.controller.signal);
      const updatedAt = new Date().toISOString();
      for (const entry of batch) {
        entry.status = 'accepted'; entry.hostReceiptId = result.hostReceiptId; entry.updatedAt = updatedAt;
        delete entry.error;
      }
    } catch (error) {
      failure = error instanceof SessionDeliveryError && error.retryable && !error.outcomeUnknown
        ? { status: 'retrying', retryable: true, error: error.message }
        : {
          status: error instanceof SessionDeliveryError && !error.outcomeUnknown ? 'rejected' : 'unknown',
          retryable: false,
          error: error instanceof SessionDeliveryError ? error.message : 'Host admission failed; verify delivery before retrying',
        };
    }
    if (failure) {
      const updatedAt = new Date().toISOString();
      for (const entry of batch) {
        entry.status = failure.status;
        if (failure.retryable) {
          entry.nextAttemptAt = new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(entry.attempts - 1, 6))).toISOString();
        }
        entry.error = failure.error;
        entry.updatedAt = updatedAt;
      }
    }
    this.save();
  }
  async reconcile(): Promise<void> {
    if (this.closed || this.storageFailed) return;
    if (this.pumping) { this.repump = true; return this.pumping; }
    const run = async (): Promise<void> => {
      do {
        this.repump = false;
        const ownerFifos = new Map<string, Delivery[]>();
        for (const value of this.state.deliveries) {
          const fifo = ownerFifos.get(value.originSessionId);
          if (fifo) fifo.push(value); else ownerFifos.set(value.originSessionId, [value]);
        }
        const targetFifos = new Map<string, TargetDelivery[]>();
        for (const value of this.state.targetDeliveries) {
          const fifo = targetFifos.get(value.targetKey);
          if (fifo) fifo.push(value); else targetFifos.set(value.targetKey, [value]);
        }
        // Owner origins and subscriber targets are separate FIFOs and run side by side.
        await Promise.allSettled([
          ...[...ownerFifos].map(([origin, fifo]) => this.pumpQueue(fifo.find(value => value.status !== 'accepted' && !value.processedAt), origin, fifo)),
          ...[...targetFifos].map(([targetKey, fifo]) => this.pumpQueue(fifo.find(value => value.status !== 'accepted' && !value.processedAt), targetKey, fifo)),
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
