/** Live ACP questions, plan approvals and tool permissions. Callers persist each returned value before the waiting call resumes. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const id = z.string().trim().min(1).max(512);
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const plain = (max: number) => z.string().max(max).refine(value => !control.test(value), 'Control characters are not allowed');
const optionSchema = z.object({
  label: plain(500).pipe(z.string().trim().min(1)),
  description: plain(2000).pipe(z.string().trim().min(1)).optional(),
}).strict();
export const processQuestionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  question: plain(4000).pipe(z.string().trim().min(1)),
  header: plain(200).pipe(z.string().trim().min(1)).optional(),
  options: z.array(optionSchema).max(20).optional(),
  multiSelect: z.boolean().optional(),
}).strict();
export type ProcessQuestion = z.infer<typeof processQuestionSchema>;
const answerValue = z.union([plain(8000), z.array(plain(8000)).max(20)]);
export const processRequestAnswerSchema = z.object({
  clientRequestId: id,
  outcome: z.enum(['accepted', 'cancelled', 'approved', 'rejected', 'abandoned']),
  answers: z.record(z.string().trim().min(1).max(4000), answerValue).optional(),
}).strict();
export type ProcessRequestAnswerInput = z.infer<typeof processRequestAnswerSchema>;

type ProcessKind = 'question' | 'plan' | 'permission';
const processKind = z.enum(['question', 'plan', 'permission']);
/** The tool name and the arguments a person approves. Tool output never enters the record. */
const toolTitle = plain(500).pipe(z.string().trim().min(1));
const toolDetail = plain(16 * 1024);

function assertBody(input: { kind: ProcessKind; questions?: ProcessQuestion[]; planContent?: string; toolTitle?: string; toolDetail?: string }, ctx: z.RefinementCtx): void {
  if (input.kind === 'question' && !input.questions?.length) ctx.addIssue({ code: 'custom', path: ['questions'], message: 'A question request needs questions' });
  if (input.kind === 'plan' && !input.planContent) ctx.addIssue({ code: 'custom', path: ['planContent'], message: 'A plan request needs plan text' });
  if (input.kind === 'permission' && !input.toolTitle) ctx.addIssue({ code: 'custom', path: ['toolTitle'], message: 'A permission request needs the tool title' });
  if (input.kind !== 'plan' && input.planContent) ctx.addIssue({ code: 'custom', path: ['planContent'], message: 'Only a plan request has plan text' });
  if (input.kind !== 'question' && input.questions) ctx.addIssue({ code: 'custom', path: ['questions'], message: 'Only a question request has questions' });
  if (input.kind !== 'permission' && (input.toolTitle || input.toolDetail)) ctx.addIssue({ code: 'custom', path: ['toolTitle'], message: 'Only a permission request names a tool' });
}

export const processRequestCreateSchema = z.object({
  requestId: id.optional(),
  jobId: id,
  attemptId: id,
  sessionId: id,
  kind: processKind,
  questions: z.array(processQuestionSchema).min(1).max(20).optional(),
  planContent: plain(64 * 1024).pipe(z.string().trim().min(1)).optional(),
  toolTitle: toolTitle.optional(),
  toolDetail: toolDetail.optional(),
}).strict().superRefine(assertBody);
export type ProcessRequestCreateInput = z.infer<typeof processRequestCreateSchema>;

export const PROCESS_REQUEST_TTL_MS = 5 * 60 * 1000;
export type ProcessRequestStatus = 'pending' | 'answered' | 'cancelled' | 'expired';
export interface ProcessRequestAnswer extends ProcessRequestAnswerInput { at: string }
export interface ProcessRequest {
  requestId: string;
  jobId: string;
  attemptId: string;
  sessionId: string;
  kind: ProcessKind;
  questions?: ProcessQuestion[];
  planContent?: string;
  toolTitle?: string;
  toolDetail?: string;
  status: ProcessRequestStatus;
  createdAt: string;
  deadlineAt: string;
  updatedAt: string;
  answer?: ProcessRequestAnswer;
}
export const processRequestSchema = z.object({
  requestId: id,
  jobId: id,
  attemptId: id,
  sessionId: id,
  kind: processKind,
  questions: z.array(processQuestionSchema).min(1).max(20).optional(),
  planContent: plain(64 * 1024).pipe(z.string().trim().min(1)).optional(),
  toolTitle: toolTitle.optional(),
  toolDetail: toolDetail.optional(),
  status: z.enum(['pending', 'answered', 'cancelled', 'expired']),
  createdAt: z.string().datetime(),
  deadlineAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  answer: processRequestAnswerSchema.extend({ at: z.string().datetime() }).optional(),
}).strict().superRefine(assertBody);

export class ProcessRequestError extends Error {
  constructor(readonly code: 'forbidden' | 'expired' | 'already_decided' | 'idempotency_conflict' | 'not_found' | 'invalid', message: string) { super(message); }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sameProcessRequest(record: ProcessRequest, input: ProcessRequestCreateInput): boolean {
  return record.jobId === input.jobId && record.attemptId === input.attemptId && record.sessionId === input.sessionId
    && record.kind === input.kind && stable(record.questions ?? null) === stable(input.questions ?? null)
    && (record.planContent ?? '') === (input.planContent ?? '')
    && (record.toolTitle ?? '') === (input.toolTitle ?? '') && (record.toolDetail ?? '') === (input.toolDetail ?? '');
}

export function createProcessRequest(input: ProcessRequestCreateInput, at = new Date()): ProcessRequest {
  const parsed = processRequestCreateSchema.parse(input);
  const createdAt = at.toISOString();
  return {
    requestId: parsed.requestId ?? randomUUID(), jobId: parsed.jobId, attemptId: parsed.attemptId, sessionId: parsed.sessionId, kind: parsed.kind,
    ...(parsed.questions ? { questions: parsed.questions } : {}), ...(parsed.planContent ? { planContent: parsed.planContent } : {}),
    ...(parsed.toolTitle ? { toolTitle: parsed.toolTitle } : {}), ...(parsed.toolDetail ? { toolDetail: parsed.toolDetail } : {}),
    status: 'pending', createdAt, updatedAt: createdAt, deadlineAt: new Date(at.getTime() + PROCESS_REQUEST_TTL_MS).toISOString(),
  };
}

function assertAnswer(request: ProcessRequest, input: ProcessRequestAnswerInput): void {
  if (request.kind === 'question') {
    if (input.outcome !== 'accepted' && input.outcome !== 'cancelled') throw new ProcessRequestError('invalid', 'Question answers must be accepted or cancelled');
    if (input.outcome === 'cancelled' && input.answers && Object.keys(input.answers).length) throw new ProcessRequestError('invalid', 'A cancelled question has no answers');
    if (input.outcome === 'accepted') {
      const expected = request.questions?.map(question => question.question) ?? [];
      const answers = input.answers ?? {};
      if (expected.length !== Object.keys(answers).length || expected.some(question => !Object.hasOwn(answers, question))) {
        throw new ProcessRequestError('invalid', 'Answers must address the recorded questions');
      }
    }
    return;
  }
  if (request.kind === 'permission') {
    if (!['approved', 'rejected', 'cancelled'].includes(input.outcome)) throw new ProcessRequestError('invalid', 'Permission answers must be approved, rejected, or cancelled');
    if (input.answers) throw new ProcessRequestError('invalid', 'A permission answer has no question answers');
    return;
  }
  if (!['approved', 'rejected', 'abandoned'].includes(input.outcome)) throw new ProcessRequestError('invalid', 'Plan answers must be approved, rejected, or abandoned');
  if (input.answers) throw new ProcessRequestError('invalid', 'A plan answer has no question answers');
}

/** A repeated clientRequestId returns the recorded answer. A late answer does not change an expired request. */
export function answerProcessRequest(request: ProcessRequest, input: ProcessRequestAnswerInput, at = new Date()): { request: ProcessRequest; idempotent: boolean } {
  const parsed = processRequestAnswerSchema.parse(input);
  assertAnswer(request, parsed);
  if (request.answer?.clientRequestId === parsed.clientRequestId) {
    if (request.answer.outcome !== parsed.outcome || stable(request.answer.answers ?? null) !== stable(parsed.answers ?? null)) {
      throw new ProcessRequestError('idempotency_conflict', 'clientRequestId conflicts with a recorded answer');
    }
    return { request: structuredClone(request), idempotent: true };
  }
  if (request.status === 'expired') throw new ProcessRequestError('expired', 'This process request has expired');
  if (request.answer || request.status !== 'pending') throw new ProcessRequestError('already_decided', 'This process request is no longer pending');
  if (Date.parse(request.deadlineAt) <= at.getTime()) throw new ProcessRequestError('expired', 'This process request has expired');
  const next = structuredClone(request);
  next.status = parsed.outcome === 'cancelled' || parsed.outcome === 'abandoned' ? 'cancelled' : 'answered';
  next.answer = { ...parsed, at: at.toISOString() };
  next.updatedAt = next.answer.at;
  return { request: next, idempotent: false };
}

export function expireProcessRequest(request: ProcessRequest, at = new Date()): ProcessRequest {
  const next = structuredClone(request);
  if (next.status === 'pending') { next.status = 'expired'; next.updatedAt = at.toISOString(); }
  return next;
}

/** Reading a pending request past its deadline shows expired and does not change the stored record. */
export function projectProcessRequest(request: ProcessRequest, now = Date.now()): ProcessRequest {
  const next = structuredClone(request);
  if (next.status === 'pending' && Date.parse(next.deadlineAt) <= now) next.status = 'expired';
  return next;
}
