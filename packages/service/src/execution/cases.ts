/**
 * One thing. A case owns its tasks, its handoffs, its shared artifact space, its receipts and its facts.
 * The ledger keeps the record. Nothing here dispatches work, judges a result or accepts a handoff.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JobLedger, LedgerActor } from './ledger.js';

export interface CaseRecord {
  caseId: string;
  originSessionId: string;
  /** What this thing is for, in the owner's words. */
  goal: string;
  title?: string;
  createdAt: string;
  /** Absent on a compatibility projection of an older job that only carried a case id. */
  createdBy?: LedgerActor;
  updatedAt: string;
  /** True when the record is projected from older jobs instead of opened through case_open. */
  legacy?: boolean;
}

export class CaseError extends Error {
  constructor(readonly code: 'not_found' | 'conflict' | 'invalid', message: string) {
    super(message);
    this.name = 'CaseError';
  }
}

const id = z.string().trim().min(1).max(512);
export const caseActorSchema = z.object({ kind: z.enum(['person', 'coach']), id: id.optional(),
  agent: z.string().trim().min(1).max(512).optional(), sessionId: z.string().trim().min(1).max(512).optional() }).strict();
export const caseOpenSchema = z.object({ originSessionId: id, caseId: id.optional(),
  goal: z.string().trim().min(1).max(4000), title: z.string().trim().min(1).max(200).optional(),
  createdBy: caseActorSchema.optional() }).strict();

/** The ledger keys cases by origin and id together; the page never shows one origin's case to another. */
export const caseKey = (originSessionId: string, caseId: string): string => `${originSessionId}\u0000${caseId}`;

/**
 * Open a case. The id is chosen by the caller or minted here; a repeated id with the same goal returns the
 * same case instead of a second one.
 */
export function openCase(ledger: JobLedger, raw: unknown): CaseRecord {
  const input = caseOpenSchema.parse(raw);
  const caseId = input.caseId ?? `case-${randomUUID()}`;
  const existing = ledger.findCase(input.originSessionId, caseId);
  if (existing) {
    if (existing.goal !== input.goal) throw new CaseError('conflict', 'This case already exists with another goal');
    return existing;
  }
  const now = new Date().toISOString();
  return ledger.commitCase({ caseId, originSessionId: input.originSessionId, goal: input.goal,
    ...(input.title ? { title: input.title } : {}), createdAt: now, updatedAt: now,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}) });
}

/** The opened case, or a compatibility projection of an older job that only carried a case id. */
export function projectCase(ledger: JobLedger, originSessionId: string, caseId: string): CaseRecord | undefined {
  const record = ledger.findCase(originSessionId, caseId);
  if (record) return record;
  const jobs = Object.values(ledger.snapshot().jobs)
    .filter(job => job.originSessionId === originSessionId && job.caseId === caseId);
  if (!jobs.length) return undefined;
  const oldest = jobs.reduce((first, job) => ((first.createdAt ?? '') <= (job.createdAt ?? '') ? first : job));
  return { caseId, originSessionId, goal: oldest.title ?? '', createdAt: oldest.createdAt ?? new Date(0).toISOString(),
    updatedAt: oldest.updatedAt, legacy: true };
}

/** A case must exist before a convention, a shared space or a task may name it. */
export function requireCase(ledger: JobLedger, originSessionId: string, caseId: string): CaseRecord {
  const record = projectCase(ledger, originSessionId, caseId);
  if (!record) throw new CaseError('not_found', 'No such case; open it first');
  return record;
}

/** Every case this origin owns, opened ones first and compatibility projections last. */
export function listCases(ledger: JobLedger, originSessionId?: string): CaseRecord[] {
  const opened = ledger.casesFor(originSessionId);
  const projected = new Map<string, CaseRecord>();
  for (const job of Object.values(ledger.snapshot().jobs)) {
    if (!job.caseId || (originSessionId && job.originSessionId !== originSessionId)) continue;
    const key = caseKey(job.originSessionId, job.caseId);
    if (projected.has(key) || opened.some(item => caseKey(item.originSessionId, item.caseId) === key)) continue;
    const record = projectCase(ledger, job.originSessionId, job.caseId);
    if (record) projected.set(key, record);
  }
  return [...opened, ...projected.values()]
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
