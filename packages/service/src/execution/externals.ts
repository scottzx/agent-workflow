/**
 * What the outside world says about one thing.
 *
 * A receipt is proof that a specific byte left through a specific channel. A fact is a number someone measured.
 * Neither is a task status: publishing does not complete a job, and a number below a target is not a failure.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JobLedger, LedgerActor } from './ledger.js';
import { CaseError, requireCase } from './cases.js';

export interface CaseReceipt {
  receiptId: string;
  caseId: string;
  originSessionId: string;
  /** The channel this went out through, e.g. a public account. */
  channel: string;
  /** The channel's own id for the published item. Together with the channel it is the receipt's key. */
  remoteId: string;
  /** The exact bytes that were published. */
  artifactDigest: string;
  artifactRevision?: string;
  jobId?: string;
  attemptId?: string;
  url?: string;
  publishedAt: string;
  recordedAt: string;
  recordedBy?: LedgerActor;
}

export interface CaseFact {
  factId: string;
  caseId: string;
  originSessionId: string;
  metric: string;
  value: number;
  unit?: string;
  /** Who measured it. A pull from a channel, or a person. */
  source: string;
  observedAt: string;
  recordedAt: string;
}

export type FactOperator = 'gte' | 'lte' | 'gt' | 'lt';

const id = z.string().trim().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });

export const receiptRecordSchema = z.object({ originSessionId: id, caseId: id, channel: id, remoteId: id,
  artifactDigest: digest, artifactRevision: id.optional(), jobId: id.optional(), attemptId: id.optional(),
  url: z.string().url().optional(), publishedAt: instant.optional(), recordedBy: z.lazy(() => writerSchema).optional() }).strict();
export const factRecordSchema = z.object({ originSessionId: id, caseId: id, metric: id, value: z.number().finite(),
  unit: id.optional(), source: id, observedAt: instant.optional(), recordedBy: z.lazy(() => writerSchema).optional() }).strict();

/** Who may write an external fact or a receipt: a person on the page, an application with the credential, or a coach. */
const writerSchema = z.object({ kind: z.enum(['person', 'coach', 'application']), id: id.optional(),
  agent: z.string().trim().min(1).max(512).optional(), sessionId: z.string().trim().min(1).max(512).optional() }).strict();

/**
 * Record that these bytes went out. The channel and its own id are the key: the same key with the same digest
 * is the same receipt, and the same key with another digest is a conflict, never an overwrite.
 */
export function recordReceipt(ledger: JobLedger, raw: unknown): CaseReceipt {
  const input = receiptRecordSchema.parse(raw);
  requireCase(ledger, input.originSessionId, input.caseId);
  const prior = ledger.receiptsFor(input.originSessionId, input.caseId)
    .find(item => item.channel === input.channel && item.remoteId === input.remoteId);
  if (prior) {
    if (prior.artifactDigest !== input.artifactDigest) throw new CaseError('conflict', 'This channel id already has a receipt for another digest');
    return prior;
  }
  const now = new Date().toISOString();
  return ledger.commitReceipt({ receiptId: randomUUID(), caseId: input.caseId, originSessionId: input.originSessionId,
    channel: input.channel, remoteId: input.remoteId, artifactDigest: input.artifactDigest,
    ...(input.artifactRevision ? { artifactRevision: input.artifactRevision } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}), ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.url ? { url: input.url } : {}),
    publishedAt: input.publishedAt ?? now, recordedAt: now, ...(input.recordedBy ? { recordedBy: input.recordedBy } : {}) });
}

/** Record one measured number. The platform stores it and does not say whether it is good. */
export function recordFact(ledger: JobLedger, raw: unknown): CaseFact {
  const input = factRecordSchema.parse(raw);
  requireCase(ledger, input.originSessionId, input.caseId);
  const now = new Date().toISOString();
  return ledger.commitFact({ factId: randomUUID(), caseId: input.caseId, originSessionId: input.originSessionId,
    metric: input.metric, value: input.value, ...(input.unit ? { unit: input.unit } : {}), source: input.source,
    observedAt: input.observedAt ?? now, recordedAt: now, ...(input.recordedBy ? { recordedBy: input.recordedBy } : {}) });
}

/** Does this measurement satisfy the condition a convention stores? */
export function factSatisfied(value: number, operator: FactOperator, threshold: number): boolean {
  if (operator === 'gte') return value >= threshold;
  if (operator === 'lte') return value <= threshold;
  if (operator === 'gt') return value > threshold;
  return value < threshold;
}
