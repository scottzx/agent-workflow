import assert from 'node:assert/strict';
import test from 'node:test';
import { JobLedger } from '../src/execution/ledger.js';
import { continueByConvention, decideHandoff, HandoffError, offerConvention, proposeHandoff } from '../src/execution/handoff.js';
import { classifySpace, rolePublicationDirectory } from '../src/execution/spaces.js';
import { workbenchSnapshot, getWorkbenchTask } from '../src/execution/workbench.js';

const digest = 'a'.repeat(64);
function completed() {
  const ledger = new JobLedger(undefined, () => {});
  const prepared = ledger.prepare({ originSessionId: 'root', caseId: 'case-1', title: '文稿', targetSnapshot: { targetId: 'author' }, input: {} });
  ledger.markDispatching(prepared.attempt.attemptId);
  ledger.accept(prepared.attempt.attemptId, { taskId: 'task-1' }, { executionStatus: 'completed', resultRevision: 'r1', resultDigest: digest, artifactLinks: [] });
  return { ledger, job: prepared.job, attempt: prepared.attempt };
}
const proposal = (jobId: string, attemptId: string, extra: Record<string, unknown> = {}) => ({
  originSessionId: 'root', jobId, attemptId, caseId: 'case-1', toTargetId: 'maker', purpose: 'make',
  artifactRevision: 'r1', artifactDigest: digest, reason: '文稿可以制作', ...extra,
});

test('a proposal records an edge and does not open the next job', () => {
  const { ledger, job, attempt } = completed();
  const handoff = proposeHandoff(ledger, 'root', proposal(job.jobId, attempt.attemptId));
  assert.equal(handoff.status, 'proposed');
  assert.equal(ledger.list('root').length, 1);
  assert.equal(ledger.snapshot().events.some(event => event.type === 'handoff.proposed'), true);
  assert.throws(() => proposeHandoff(ledger, 'root', proposal(job.jobId, attempt.attemptId, { artifactDigest: 'b'.repeat(64) })), HandoffError);
});

test('one matching convention accepts the proposal, two matches refuse to choose', () => {
  const { ledger, job, attempt } = completed();
  offerConvention(ledger, { originSessionId: 'root', caseId: 'case-1', fromTargetId: 'author', toTargetId: 'maker', toPurpose: 'make', when: 'acceptance_accepted', requireHuman: false, clientRequestId: 'rule-1' });
  assert.equal(proposeHandoff(ledger, 'root', proposal(job.jobId, attempt.attemptId, { clientRequestId: 'early' })).status, 'proposed', 'a convention that has not been achieved does not accept the proposal');
  const achieved = completed();
  offerConvention(achieved.ledger, { originSessionId: 'root', caseId: 'case-1', fromTargetId: 'author', toTargetId: 'maker', toPurpose: 'make', when: 'acceptance_accepted', requireHuman: false });
  achieved.ledger.acceptance('root', achieved.job.jobId, { attemptId: achieved.attempt.attemptId, resultRevision: 'r1', resultDigest: digest, reviewStatus: 'accepted', decidedBy: { kind: 'person' } });
  const accepted = proposeHandoff(achieved.ledger, 'root', proposal(achieved.job.jobId, achieved.attempt.attemptId));
  assert.equal(accepted.status, 'accepted');

  const waiting = completed();
  offerConvention(waiting.ledger, { originSessionId: 'root', caseId: 'case-1', fromTargetId: 'author', toTargetId: 'maker', toPurpose: 'make', when: 'acceptance_accepted', requireHuman: true });
  const proposed = proposeHandoff(waiting.ledger, 'root', proposal(waiting.job.jobId, waiting.attempt.attemptId));
  assert.equal(proposed.status, 'proposed', 'a convention that asks for a person only proposes');
  assert.throws(() => decideHandoff(waiting.ledger, { originSessionId: 'root', handoffId: proposed.handoffId, decision: 'accept', decidedBy: { kind: 'person' } }),
    /A person decides on the workbench page/, 'the agent channel may not write that a person agreed');
  assert.throws(() => decideHandoff(waiting.ledger, { originSessionId: 'root', handoffId: proposed.handoffId, decision: 'accept', decidedBy: { kind: 'person', id: 'someone-else' } },
    { allowPerson: true, reviewerId: 'owner' }), /belongs to another reviewer/);
  const decided = decideHandoff(waiting.ledger, { originSessionId: 'root', handoffId: proposed.handoffId, decision: 'accept', decidedBy: { kind: 'person', id: 'owner' } },
    { allowPerson: true, reviewerId: 'owner' });
  assert.equal(decided.status, 'accepted');
  assert.equal(decided.decidedBy?.id, 'owner');

  const other = completed();
  offerConvention(other.ledger, { originSessionId: 'root', caseId: 'case-1', toTargetId: 'maker', toPurpose: 'make', when: 'acceptance_accepted', requireHuman: false });
  offerConvention(other.ledger, { originSessionId: 'root', caseId: 'case-1', fromTargetId: 'author', toTargetId: 'maker', toPurpose: 'make', when: 'acceptance_accepted', requireHuman: false });
  other.ledger.acceptance('root', other.job.jobId, { attemptId: other.attempt.attemptId, resultRevision: 'r1', resultDigest: digest, reviewStatus: 'accepted', decidedBy: { kind: 'person' } });
  assert.throws(() => proposeHandoff(other.ledger, 'root', proposal(other.job.jobId, other.attempt.attemptId)), /More than one achieved convention/);
});

test('an achieved convention records the next hop and still does not dispatch it', () => {
  const { ledger, job, attempt } = completed();
  offerConvention(ledger, { originSessionId: 'root', caseId: 'case-1', fromTargetId: 'author', toTargetId: 'maker', toPurpose: 'make', when: 'acceptance_accepted', requireHuman: false });
  ledger.acceptance('root', job.jobId, { attemptId: attempt.attemptId, resultRevision: 'r1', resultDigest: digest, reviewStatus: 'accepted', decidedBy: { kind: 'person' } });
  const handoff = continueByConvention(ledger, 'root', job.jobId);
  assert.equal(handoff?.status, 'accepted');
  assert.equal(continueByConvention(ledger, 'root', job.jobId), undefined);
  assert.equal(ledger.list('root').filter(item => item.parentJobRef).length, 0);
});

test('only an accepted handoff can be marked taken, and the child must match it', () => {
  const { ledger, job, attempt } = completed();
  const handoff = proposeHandoff(ledger, 'root', proposal(job.jobId, attempt.attemptId));
  const child = ledger.prepare({ originSessionId: 'root', caseId: 'case-1', targetSnapshot: { targetId: 'maker' }, input: {}, purpose: 'make', resultRevision: 'r1',
    parentJobRef: { sourceId: ledger.sourceId, jobId: job.jobId }, parentAttemptId: attempt.attemptId });
  assert.throws(() => ledger.markHandoffTaken('root', handoff.handoffId, child.job.jobId), /accepted/);
  decideHandoff(ledger, { originSessionId: 'root', handoffId: handoff.handoffId, decision: 'accept', decidedBy: { kind: 'coach', sessionId: 'coach-session' } });
  const taken = ledger.markHandoffTaken('root', handoff.handoffId, child.job.jobId);
  assert.equal(taken.status, 'taken');
  assert.equal(taken.childJobId, child.job.jobId);
  assert.equal(ledger.markHandoffTaken('root', handoff.handoffId, child.job.jobId).status, 'taken');
});

test('the workbench draws a proposed handoff without inventing its destination, and keeps an unfired convention off the edges', () => {
  const { ledger, job, attempt } = completed();
  offerConvention(ledger, { originSessionId: 'root', caseId: 'case-1', fromTargetId: 'author', toTargetId: 'reviewer', toPurpose: 'review', when: 'acceptance_accepted', requireHuman: true });
  proposeHandoff(ledger, 'root', proposal(job.jobId, attempt.attemptId));
  const detail = getWorkbenchTask(workbenchSnapshot({ ledger: ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' }), job.jobId);
  const edge = detail.dependencies.find(item => item.kind === 'handoff');
  assert.equal(edge?.status, 'proposed');
  assert.equal(edge?.to, undefined);
  assert.equal(detail.legalNext?.some(item => item.toTargetId === 'reviewer' && item.achieved === false), true);
  assert.equal(detail.dependencies.some(item => item.to === 'reviewer'), false);
});

test('role publication, a job directory and a shared artifact space stay distinct', () => {
  assert.equal(rolePublicationDirectory('/work', 'ppt-beautifier'), '/work/.1agents/roles/ppt-beautifier/published');
  assert.equal(rolePublicationDirectory('/work', '../ppt'), undefined);
  assert.equal(classifySpace('/work', '/work/.1agents/roles/author/published'), 'role_publication');
  assert.equal(classifySpace('/work', '/work/.1agents/jobs/job-1', '/work/.1agents/jobs/job-1', '/work/shared'), 'job');
  assert.equal(classifySpace('/work', '/work/shared/deck.pptx', '/work/.1agents/jobs/job-1', '/work/shared'), 'artifact_space');
  assert.equal(classifySpace('/work', '/work/shared-other', '/work/.1agents/jobs/job-1', '/work/shared'), 'outside');
});
