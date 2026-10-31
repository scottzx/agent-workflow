import assert from 'node:assert/strict';
import test from 'node:test';
import { createHumanReview, decideHumanReview, markHumanReviewApplied, supersedeHumanReview,
  type HumanReviewActor, type HumanReviewCreateInput, type HumanReviewDecisionInput } from '../src/execution/human-review.js';

const at = '2026-10-22T06:00:00.000Z';
const actor: HumanReviewActor = { id: 'owner', displayName: 'Owner', source: '1agents-web' };
const input: HumanReviewCreateInput = { jobId: 'parent', attemptId: 'parent-attempt', stage: 'summary', authorJobId: 'author', authorAttemptId: 'author-attempt',
  authorSessionId: 'author-session', revision: 'script-v1', digest: 'a'.repeat(64), title: 'Project script', reviewerId: actor.id,
  preview: { title: 'Project', slides: Array.from({ length: 6 }, (_, i) => ({ title: `Page ${i}`, message: 'Fact', body: ['Content'], visual: 'Diagram', sources: ['README.md:1'], facts: ['Fact'], notes: '' })) } };
const decision: HumanReviewDecisionInput = { action: 'approve', clientRequestId: 'click-1', revision: input.revision, digest: input.digest };
const binding = { attemptId: input.attemptId, revision: input.revision, digest: input.digest };

test('approval binds frozen content and leaves a durable continuation pending until acknowledged', () => {
  const review = createHumanReview(input, at), before = structuredClone(review);
  const approved = decideHumanReview(review, decision, actor, binding, at);
  assert.deepEqual(review, before); assert.equal(approved.review.status, 'approved');
  assert.equal(approved.review.resume?.status, 'pending'); assert.equal(approved.review.resume?.decisionId, approved.decision.decisionId);
  assert.deepEqual(approved.decision.actor, actor); assert.equal(approved.decision.at, at);
  const applied = markHumanReviewApplied(approved.review, approved.decision.decisionId, '2026-10-22T06:01:00.000Z');
  assert.equal(applied.resume?.status, 'applied'); assert.equal(approved.review.resume?.status, 'pending');
  assert.deepEqual(markHumanReviewApplied(applied, approved.decision.decisionId), applied);
  assert.throws(() => markHumanReviewApplied(approved.review, 'unrelated-decision'), /does not match/);
});

test('comments never approve, and empty comments or modification requests are rejected', () => {
  const review = createHumanReview(input, at);
  for (const action of ['comment', 'changes_requested'] as const) assert.throws(() => decideHumanReview(review, { ...decision, action, note: '  ' }, actor, binding));
  const commented = decideHumanReview(review, { ...decision, action: 'comment', note: 'Clarify page 2' }, actor, binding, at);
  assert.equal(commented.review.status, 'pending'); assert.equal(commented.review.resume, undefined);
  const modified = decideHumanReview(commented.review, { ...decision, clientRequestId: 'change-1', action: 'changes_requested', note: 'Fix page 2' }, actor, binding, at);
  assert.equal(modified.review.status, 'changes_requested'); assert.equal(modified.review.resume?.action, 'changes_requested');
  assert.equal(modified.review.history.length, 2); assert.equal(commented.review.history.length, 1);
});

test('replay acknowledges one durable decision and rejects reuse of its key for different content', () => {
  const approved = decideHumanReview(createHumanReview(input, at), decision, actor, binding, at);
  const replay = decideHumanReview(approved.review, decision, actor, { ...binding, revision: 'script-v2' });
  assert.equal(replay.idempotent, true); assert.equal(replay.decision.decisionId, approved.decision.decisionId);
  assert.equal(replay.review.history.length, 1);
  assert.throws(() => decideHumanReview(approved.review, { ...decision, note: 'different payload' }, actor, binding), /conflicts/);
  assert.throws(() => decideHumanReview(approved.review, { ...decision, clientRequestId: 'new-click' }, actor, binding), /no longer pending/);
});

test('another user, forged source, stale execution and stale version cannot decide a review', () => {
  const review = createHumanReview(input, at);
  assert.throws(() => decideHumanReview(review, decision, { ...actor, id: 'other-person' }, binding), /another person/);
  assert.throws(() => decideHumanReview(review, decision, { ...actor, source: 'agent' } as unknown as HumanReviewActor, binding));
  assert.throws(() => decideHumanReview(review, { ...decision, digest: 'b'.repeat(64) }, actor, binding), /displayed review version/);
  assert.throws(() => decideHumanReview(review, decision, actor, { ...binding, attemptId: 'next-parent-attempt' }), /replaced/);
  assert.throws(() => decideHumanReview(review, decision, actor, { ...binding, revision: 'script-v2' }), /replaced/);
  assert.equal(review.status, 'pending'); assert.deepEqual(review.history, []);
});

test('replaced previews remain immutable and cancellation is a distinct recorded decision', () => {
  const review = createHumanReview(input, at), old = supersedeHumanReview(review, at);
  assert.equal(old.status, 'superseded'); assert.equal(review.status, 'pending'); assert.deepEqual(old.preview, review.preview);
  assert.throws(() => decideHumanReview(old, decision, actor, binding), /no longer pending/);
  const canceled = decideHumanReview(review, { ...decision, action: 'cancel' }, actor, binding, at);
  assert.equal(canceled.review.status, 'canceled'); assert.equal(canceled.review.resume?.action, 'cancel');
  assert.throws(() => createHumanReview({ ...input, preview: { ...input.preview, slides: [] } }));
  assert.throws(() => createHumanReview({ ...input, digest: 'not-a-digest' }));
});

test('human review previews follow the actual script page count instead of a fixed six pages', () => {
  const page = input.preview.slides[0]!;
  for (const count of [1, 5, 8, 12, 30]) {
    const slides = Array.from({ length: count }, (_, i) => ({ ...page, title: `Page ${i + 1}` }));
    assert.equal(createHumanReview({ ...input, preview: { ...input.preview, slides } }, at).preview.slides.length, count);
  }
  assert.throws(() => createHumanReview({ ...input, preview: { ...input.preview, slides: Array.from({ length: 201 }, () => page) } }));
});
