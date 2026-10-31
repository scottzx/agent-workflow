/** Version-bound human decisions. Callers persist each returned value before scheduling work. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const id = z.string().trim().min(1).max(512);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** Upper bound for one human-reviewed slide script; the page count itself follows the frozen script (N pages). */
export const MAX_HUMAN_REVIEW_SLIDES = 200;
export const humanReviewPreviewSchema = z.object({
  title: z.string().min(1),
  slides: z.array(z.object({ title: z.string().min(1), message: z.string(), body: z.array(z.string()),
    visual: z.string(), sources: z.array(z.string()).min(1), facts: z.array(z.string()).min(1), notes: z.string() }).strict()).min(1).max(MAX_HUMAN_REVIEW_SLIDES),
}).strict();
const markdownReviewPreviewSchema = z.object({
  kind: z.literal('markdown'), title: z.string().min(1), markdown: z.string().min(1).max(256 * 1024),
  reportPath: z.string().min(1), slides: z.array(z.never()).length(0),
}).strict();
const reviewPreviewSchema = z.union([humanReviewPreviewSchema, markdownReviewPreviewSchema]);
export type HumanReviewPreview = z.infer<typeof reviewPreviewSchema>;
export const humanReviewActorSchema = z.object({ id, displayName: z.string().trim().min(1).max(200).optional(), source: z.literal('1agents-web') }).strict();
export type HumanReviewActor = z.infer<typeof humanReviewActorSchema>;
export const humanReviewDecisionSchema = z.object({
  clientRequestId: id, action: z.enum(['comment', 'approve', 'changes_requested', 'cancel']),
  revision: id, digest: sha256, note: z.string().trim().max(16000).optional(),
}).strict().superRefine((input, ctx) => {
  if (['comment', 'changes_requested'].includes(input.action) && !input.note) {
    ctx.addIssue({ code: 'custom', path: ['note'], message: 'Comment and changes_requested require a note' });
  }
});
export type HumanReviewDecisionInput = z.infer<typeof humanReviewDecisionSchema>;
export type HumanReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'superseded' | 'canceled';
export interface HumanReviewDecision extends HumanReviewDecisionInput {
  decisionId: string; actor: HumanReviewActor; at: string;
}
export interface HumanReviewRequest {
  reviewId: string; jobId: string; attemptId: string; stage: 'summary' | 'report';
  authorJobId: string; authorAttemptId: string; authorSessionId: string;
  revision: string; digest: string; title: string; preview: HumanReviewPreview;
  reviewerId: string; status: HumanReviewStatus; createdAt: string; updatedAt: string;
  history: HumanReviewDecision[];
  resume?: { status: 'pending' | 'applied'; action: Exclude<HumanReviewDecisionInput['action'], 'comment'>;
    decisionId: string; appliedAt?: string };
}
export type HumanReviewCreateInput = Omit<HumanReviewRequest, 'reviewId' | 'status' | 'history' | 'resume' | 'createdAt' | 'updatedAt'> & { reviewId?: string };
export interface HumanReviewBinding { attemptId: string; revision: string; digest: string }
export class HumanReviewError extends Error {
  constructor(readonly code: 'forbidden' | 'version_conflict' | 'already_decided' | 'idempotency_conflict', message: string) { super(message); }
}
const timestamp = () => new Date().toISOString();

export function createHumanReview(input: HumanReviewCreateInput, at = timestamp()): HumanReviewRequest {
  const parsed = z.object({ reviewId: id.optional(), jobId: id, attemptId: id, stage: z.enum(['summary', 'report']),
    authorJobId: id, authorAttemptId: id, authorSessionId: id, revision: id, digest: sha256, title: z.string().min(1),
    preview: reviewPreviewSchema, reviewerId: id }).strict().parse(input);
  return { ...parsed, reviewId: parsed.reviewId ?? randomUUID(), status: 'pending', createdAt: at, updatedAt: at, history: [] };
}

/** A replay may acknowledge an old durable decision but cannot schedule it a second time. */
export function decideHumanReview(request: HumanReviewRequest, input: HumanReviewDecisionInput,
  actorInput: HumanReviewActor, current: HumanReviewBinding, at = timestamp()): { review: HumanReviewRequest; decision: HumanReviewDecision; idempotent: boolean } {
  const actor = humanReviewActorSchema.parse(actorInput), decisionInput = humanReviewDecisionSchema.parse(input);
  if (actor.id !== request.reviewerId) throw new HumanReviewError('forbidden', 'Review is assigned to another person');
  if (decisionInput.revision !== request.revision || decisionInput.digest !== request.digest) {
    throw new HumanReviewError('version_conflict', 'Decision does not match the displayed review version');
  }
  const replay = request.history.find(item => item.clientRequestId === decisionInput.clientRequestId);
  if (replay) {
    if (replay.actor.id !== actor.id || replay.actor.source !== actor.source || replay.action !== decisionInput.action
      || replay.revision !== decisionInput.revision || replay.digest !== decisionInput.digest || replay.note !== decisionInput.note) {
      throw new HumanReviewError('idempotency_conflict', 'clientRequestId conflicts with a recorded decision');
    }
    return { review: structuredClone(request), decision: structuredClone(replay), idempotent: true };
  }
  if (request.attemptId !== current.attemptId || request.revision !== current.revision || request.digest !== current.digest) {
    throw new HumanReviewError('version_conflict', 'This review has been replaced by a newer execution or content version');
  }
  if (request.status !== 'pending') throw new HumanReviewError('already_decided', 'This review is no longer pending');
  const review = structuredClone(request), decision: HumanReviewDecision = { ...decisionInput, decisionId: randomUUID(), actor, at };
  review.history.push(decision); review.updatedAt = at;
  if (decision.action !== 'comment') {
    review.status = ({ approve: 'approved', changes_requested: 'changes_requested', cancel: 'canceled' } as const)[decision.action];
    review.resume = { status: 'pending', action: decision.action, decisionId: decision.decisionId };
  }
  return { review, decision, idempotent: false };
}

export function markHumanReviewApplied(request: HumanReviewRequest, decisionId: string, at = timestamp()): HumanReviewRequest {
  if (!request.resume || request.resume.decisionId !== decisionId) throw new HumanReviewError('version_conflict', 'Continuation does not match the recorded decision');
  const review = structuredClone(request);
  if (review.resume!.status === 'pending') { review.resume!.status = 'applied'; review.resume!.appliedAt = at; review.updatedAt = at; }
  return review;
}

export function supersedeHumanReview(request: HumanReviewRequest, at = timestamp()): HumanReviewRequest {
  const review = structuredClone(request);
  if (review.status === 'pending') { review.status = 'superseded'; review.updatedAt = at; }
  return review;
}
