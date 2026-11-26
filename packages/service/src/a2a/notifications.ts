/** Task and case notification subscriptions. The owner origin stays singular; subscribers are extra readers. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().trim().min(1).max(512);
export const subscriptionEventSchema = z.enum(['terminal', 'handoff', 'progress', 'process_request']);
export const subscriptionRoleSchema = z.enum(['coordinator', 'downstream', 'observer']);
export const subscriptionModeSchema = z.enum(['queue', 'steer']);
export type SubscriptionEvent = z.infer<typeof subscriptionEventSchema>;
export type SubscriptionRole = z.infer<typeof subscriptionRoleSchema>;
export type SubscriptionMode = z.infer<typeof subscriptionModeSchema>;

/** Default events when the caller omits `events`. `process_request` is never implied. */
export const DEFAULT_SUBSCRIPTION_EVENTS: Record<SubscriptionRole, SubscriptionEvent[]> = {
  coordinator: ['progress', 'terminal', 'handoff'],
  downstream: ['terminal', 'handoff'],
  observer: ['terminal'],
};

export const notifyTargetSchema = z.object({
  originSessionId: id.optional(),
  host: id.optional(),
  sessionId: id.optional(),
}).strict().superRefine((target, ctx) => {
  const byOrigin = Boolean(target.originSessionId);
  const byHost = Boolean(target.host || target.sessionId);
  if (byOrigin === byHost) {
    ctx.addIssue({ code: 'custom', message: 'target must be exactly one of originSessionId or host+sessionId' });
  }
  if (!byOrigin && (!target.host || !target.sessionId)) {
    ctx.addIssue({ code: 'custom', message: 'explicit target requires both host and sessionId' });
  }
});
export type NotifyTarget = z.infer<typeof notifyTargetSchema>;

const subscriptionFilterSchema = z.object({
  purpose: id.optional(),
  targetId: id.optional(),
}).strict();

export const notifySubscriptionInputSchema = z.object({
  scope: z.enum(['job', 'case']).optional(),
  jobId: id.optional(),
  caseId: id.optional(),
  target: notifyTargetSchema,
  role: subscriptionRoleSchema,
  events: z.array(subscriptionEventSchema).min(1).max(4).optional(),
  mode: subscriptionModeSchema.optional(),
  filter: subscriptionFilterSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.events && new Set(input.events).size !== input.events.length) {
    ctx.addIssue({ code: 'custom', path: ['events'], message: 'events must not contain duplicates' });
  }
});
export type NotifySubscriptionInput = z.infer<typeof notifySubscriptionInputSchema>;

export const notificationSubscriptionSchema = z.object({
  subscriptionId: id,
  originSessionId: id,
  scope: z.enum(['job', 'case']),
  jobId: id.optional(),
  caseId: id.optional(),
  target: notifyTargetSchema,
  role: subscriptionRoleSchema,
  events: z.array(subscriptionEventSchema).min(1).max(4),
  mode: subscriptionModeSchema,
  filter: subscriptionFilterSchema.optional(),
  createdAt: id,
}).strict();
export type NotificationSubscription = z.infer<typeof notificationSubscriptionSchema>;

export const notificationSubscribeSchema = z.object({
  originSessionId: id,
  scope: z.enum(['job', 'case']),
  jobId: id.optional(),
  caseId: id.optional(),
  target: notifyTargetSchema,
  role: subscriptionRoleSchema,
  events: z.array(subscriptionEventSchema).min(1).max(4).optional(),
  mode: subscriptionModeSchema.optional(),
  filter: subscriptionFilterSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.events && new Set(input.events).size !== input.events.length) {
    ctx.addIssue({ code: 'custom', path: ['events'], message: 'events must not contain duplicates' });
  }
  if (input.scope === 'job' && !input.jobId) ctx.addIssue({ code: 'custom', path: ['jobId'], message: 'job subscription requires jobId' });
  if (input.scope === 'case' && !input.caseId) ctx.addIssue({ code: 'custom', path: ['caseId'], message: 'case subscription requires caseId' });
});

export const notificationUnsubscribeSchema = z.object({
  originSessionId: id,
  subscriptionId: id,
}).strict();

export const notificationListSchema = z.object({
  originSessionId: id,
  jobId: id.optional(),
  caseId: id.optional(),
}).strict();

export function subscriberTargetKey(host: string, sessionId: string): string {
  return `sub:${host}:${sessionId}`;
}

/** Stable idempotency key. The same event and target collapse to one delivery. */
export function subscriberMessageId(eventKey: string, host: string, sessionId: string): string {
  const targetHash = createHash('sha256').update(`${host}\0${sessionId}`).digest('hex').slice(0, 16);
  const safeKey = eventKey.length > 180 ? createHash('sha256').update(eventKey).digest('hex').slice(0, 32) : eventKey;
  return `sub-notice:${safeKey}:${targetHash}`;
}

function cleanFilter(filter: z.infer<typeof subscriptionFilterSchema> | undefined): NotificationSubscription['filter'] | undefined {
  if (!filter?.purpose && !filter?.targetId) return undefined;
  return { ...(filter.purpose ? { purpose: filter.purpose } : {}), ...(filter.targetId ? { targetId: filter.targetId } : {}) };
}

/** Fill role defaults and bind the subscription to the job or case that created it. */
export function materializeSubscription(
  originSessionId: string,
  input: NotifySubscriptionInput,
  defaults: { scope: 'job' | 'case'; jobId?: string; caseId?: string },
  createdAt = new Date().toISOString(),
): NotificationSubscription {
  const scope = input.scope ?? defaults.scope;
  const jobId = input.jobId ?? (scope === 'job' ? defaults.jobId : undefined);
  const caseId = input.caseId ?? defaults.caseId;
  if (scope === 'job' && !jobId) throw new Error('Job subscription requires jobId');
  if (scope === 'case' && !caseId) throw new Error('Case subscription requires caseId');
  const events = [...new Set(input.events ?? DEFAULT_SUBSCRIPTION_EVENTS[input.role])];
  const mode = input.mode ?? 'queue';
  const filter = cleanFilter(input.filter);
  const target = input.target.originSessionId
    ? { originSessionId: input.target.originSessionId }
    : { host: input.target.host!, sessionId: input.target.sessionId! };
  const draft = {
    originSessionId,
    scope,
    ...(jobId ? { jobId } : {}),
    ...(caseId ? { caseId } : {}),
    target,
    role: input.role,
    events,
    mode,
    ...(filter ? { filter } : {}),
    createdAt,
  };
  const subscriptionId = createHash('sha256').update(JSON.stringify({
    originSessionId,
    scope,
    jobId: jobId ?? null,
    caseId: caseId ?? null,
    target,
    role: input.role,
    events: [...events].sort(),
    mode,
    filter: filter ?? null,
  })).digest('hex');
  return notificationSubscriptionSchema.parse({ ...draft, subscriptionId });
}
