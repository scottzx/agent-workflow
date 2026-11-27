import assert from 'node:assert/strict';
import test from 'node:test';
import { JobLedger, type LedgerState } from '../src/execution/ledger.js';

const target = { targetId: 'ppt', configVersion: 1, connectionId: 'local', connectionVersion: 1, provider: 'a2a', remote: 'dsh' };
const input = { originSessionId: 'root', targetSnapshot: target, input: { prompt: 'produce slides', cwd: '/project' } };
function fixture() {
  let saved: LedgerState | undefined;
  const ledger = new JobLedger(undefined, next => { saved = structuredClone(next); });
  return { ledger, saved: () => saved };
}
function running(ledger: JobLedger, request = input) {
  const prepared = ledger.prepare(request); ledger.markDispatching(prepared.attempt.attemptId);
  ledger.accept(prepared.attempt.attemptId, { provider: 'a2a', remote: 'dsh', taskId: prepared.attempt.attemptId, contextId: 'context' }, { executionStatus: 'working' });
  return prepared;
}

test('pre-dispatch IDs, durable source, canonical request idempotence and scope are stable across restart', () => {
  const f = fixture(), first = f.ledger.prepare({ ...input, clientRequestId: 'stable' });
  assert.equal(first.attempt.submissionStatus, 'prepared'); assert.equal(first.attempt.backendRunRef, undefined);
  assert.equal(f.saved()?.attempts[first.attempt.attemptId]?.jobId, first.job.jobId);
  assert.equal(f.saved()?.events[0]?.type, 'job.created');
  const restored = new JobLedger(f.saved(), () => {});
  assert.equal(restored.sourceId, f.ledger.sourceId);
  const again = restored.prepare({ ...input, targetSnapshot: { ...target, configVersion: 2 }, input: { cwd: '/project', prompt: 'produce slides' }, clientRequestId: 'stable' });
  assert.equal(again.idempotent, true); assert.equal(again.attempt.attemptId, first.attempt.attemptId);
  assert.equal(again.attempt.targetConfigVersion, 1);
  assert.throws(() => restored.prepare({ ...input, input: { prompt: 'other' }, clientRequestId: 'stable' }), /conflicts/);
  const other = restored.prepare({ ...input, originSessionId: 'other', clientRequestId: 'stable' });
  assert.notEqual(other.job.jobId, first.job.jobId);
  assert.throws(() => restored.get('other', first.job.jobId), /not found/);
  assert.equal(restored.events('other').length, 1);
});

test('failed persistence changes neither state nor returned objects and snapshots do not alias state', () => {
  let reject = false;
  const ledger = new JobLedger(undefined, () => { if (reject) throw new Error('disk full'); });
  const first = ledger.prepare(input), before = ledger.snapshot(); reject = true;
  assert.throws(() => ledger.markDispatching(first.attempt.attemptId), /disk full/);
  assert.deepEqual(ledger.snapshot(), before);
  first.job.title = 'mutated'; before.jobs[first.job.jobId]!.title = 'another mutation';
  assert.equal(ledger.get('root', first.job.jobId).title, undefined);
});

test('read-only replay uses the original snapshot, checks the same digest and scope, and returns the requested old attempt', () => {
  let saves = 0;
  const ledger = new JobLedger(undefined, () => { saves++; });
  const first = ledger.prepare({ ...input, clientRequestId: 'original-request' });
  ledger.prepare({ ...input, jobId: first.job.jobId, clientRequestId: 'next-round' });
  const before = ledger.snapshot(), count = saves;
  const replay = ledger.replay({ ...input, targetSnapshot: { targetId: target.targetId }, clientRequestId: 'original-request' });
  assert.equal(replay?.idempotent, true); assert.equal(replay?.attempt.attemptId, first.attempt.attemptId);
  assert.equal(replay?.attempt.targetConfigVersion, 1); assert.notEqual(replay?.job.currentAttemptId, first.attempt.attemptId);
  assert.equal(saves, count); assert.deepEqual(ledger.snapshot(), before);
  assert.throws(() => ledger.replay({ ...input, targetSnapshot: { targetId: 'different-target' }, clientRequestId: 'original-request' }), /conflicts/);
  assert.throws(() => ledger.replay({ ...input, input: { prompt: 'different' }, clientRequestId: 'original-request' }), /conflicts/);
  assert.equal(ledger.replay({ ...input, originSessionId: 'other', clientRequestId: 'original-request' }), undefined);
  assert.equal(ledger.replay({ ...input, clientRequestId: 'missing' }), undefined);
  assert.equal(ledger.replay(input), undefined);
  replay!.attempt.targetSnapshot.targetId = 'caller mutated';
  assert.equal(ledger.getAttempt(first.attempt.attemptId).targetSnapshot.targetId, target.targetId);
});

test('trusted digest input pins the caller request while actual merged execution input remains frozen', () => {
  const { ledger } = fixture(), first = ledger.prepare(input);
  const request = { prompt: 'revise only' };
  const continued = ledger.prepare({ ...input, jobId: first.job.jobId, input: { ...request, cwd: '/project', inherited: 'v1' },
    requestDigestInput: request, clientRequestId: 'partial-continue' });
  assert.deepEqual(continued.attempt.input, { ...request, cwd: '/project', inherited: 'v1' });
  const replay = ledger.replay({ ...input, jobId: first.job.jobId, input: { ...request, cwd: '/project', inherited: 'later-default' },
    requestDigestInput: request, clientRequestId: 'partial-continue' });
  assert.equal(replay?.attempt.attemptId, continued.attempt.attemptId);
  assert.deepEqual(replay?.attempt.input, continued.attempt.input);
  assert.throws(() => ledger.replay({ ...input, jobId: first.job.jobId, requestDigestInput: { prompt: 'changed caller request' },
    clientRequestId: 'partial-continue' }), /conflicts/);
});

test('uncertain acceptance blocks dispatch, survives restart, and reconciles without changing identity', () => {
  const f = fixture(), prepared = f.ledger.prepare(input), id = prepared.attempt.attemptId;
  f.ledger.markDispatching(id); f.ledger.markUnknown(id, 'response lost');
  const ledger = new JobLedger(f.saved(), () => {});
  assert.equal(ledger.get('root', prepared.job.jobId).unresolvedAttemptIds[0], id);
  assert.throws(() => ledger.prepare({ ...input, jobId: prepared.job.jobId, clientRequestId: 'new' }), /submission_unknown/);
  ledger.accept(id, { taskId: 'confirmed', remote: 'dsh' }, { executionStatus: 'completed', resultSummary: 'done' });
  assert.equal(ledger.get('root', prepared.job.jobId).executionStatus, 'completed');
  assert.deepEqual(ledger.get('root', prepared.job.jobId).unresolvedAttemptIds, []);
  assert.throws(() => ledger.knownNotSubmitted(id, { executionStatus: 'failed' }), /accepted/);
  assert.throws(() => ledger.accept(id, { taskId: 'different' }), /cannot be replaced/);
});

test('proven no submission is terminal, owns no fake run ID, and retry creates another attempt', () => {
  const { ledger } = fixture(), first = ledger.prepare(input);
  ledger.knownNotSubmitted(first.attempt.attemptId, { executionStatus: 'rejected', diagnostic: 'input refused' });
  const a = ledger.getAttempt(first.attempt.attemptId);
  assert.equal(a.backendRunRef, undefined); assert.equal(a.submissionStatus, 'known_not_submitted'); assert.equal(a.executionStatus, 'rejected');
  assert.throws(() => ledger.markDispatching(a.attemptId), /prepared/);
  const second = ledger.prepare({ ...input, jobId: first.job.jobId, clientRequestId: 'retry' });
  assert.notEqual(second.attempt.attemptId, first.attempt.attemptId);
  assert.equal(second.attempt.previousAttemptId, first.attempt.attemptId);
});

test('queued explicit rounds keep independent states and late previous callbacks cannot select an old result', () => {
  const { ledger } = fixture(), first = running(ledger);
  const second = running(ledger, { ...input, jobId: first.job.jobId } as typeof input);
  ledger.observe(second.attempt.attemptId, { executionStatus: 'completed', resultSummary: 'latest' });
  let view = ledger.get('root', first.job.jobId);
  assert.equal(view.executionStatus, 'completed'); assert.deepEqual(view.inFlightAttemptIds, [first.attempt.attemptId]);
  ledger.observe(first.attempt.attemptId, { executionStatus: 'failed', resultSummary: 'old error' });
  view = ledger.get('root', first.job.jobId);
  assert.equal(view.result?.resultSummary, 'latest'); assert.equal(view.currentAttemptId, second.attempt.attemptId);
  assert.deepEqual(view.inFlightAttemptIds, []);
  ledger.observe(second.attempt.attemptId, { executionStatus: 'working', stale: true, resultSummary: 'stale poison' });
  view = ledger.get('root', first.job.jobId);
  assert.equal(view.executionStatus, 'completed'); assert.equal(view.attempts[1]?.stale, true);
  assert.equal(view.result?.resultSummary, 'latest');
  assert.match(view.attempts[1]?.diagnostic ?? '', /Conflicting/);
});

test('normal polling avoids duplicate events; execution remains working while child jobs complete', () => {
  const { ledger } = fixture(), parent = running(ledger);
  const child = running(ledger, { ...input, parentJobRef: { sourceId: ledger.sourceId, jobId: parent.job.jobId },
    parentAttemptId: parent.attempt.attemptId, purpose: 'production' } as typeof input);
  ledger.observe(parent.attempt.attemptId, { executionStatus: 'working', phase: 'waiting_children' });
  const events = ledger.events('root', parent.job.jobId).length;
  ledger.observe(parent.attempt.attemptId, { executionStatus: 'working', phase: 'waiting_children' });
  assert.equal(ledger.events('root', parent.job.jobId).length, events);
  ledger.observe(child.attempt.attemptId, { executionStatus: 'completed' });
  const view = ledger.get('root', parent.job.jobId);
  assert.equal(view.executionStatus, 'working'); assert.equal(view.children.length, 1);
  assert.equal(view.children[0]?.executionStatus, 'completed');
});

test('parent refs reject wrong source, scope, attempt, mutation and self-reference', () => {
  const { ledger } = fixture(), parent = running(ledger), other = running(ledger);
  const relation = { parentJobRef: { sourceId: ledger.sourceId, jobId: parent.job.jobId }, parentAttemptId: parent.attempt.attemptId };
  assert.throws(() => ledger.prepare({ ...input, ...relation, originSessionId: 'outsider' }), /not found/);
  assert.throws(() => ledger.prepare({ ...input, ...relation, parentJobRef: { ...relation.parentJobRef, sourceId: 'foreign' } }), /same ledger source/);
  assert.throws(() => ledger.prepare({ ...input, ...relation, parentAttemptId: other.attempt.attemptId }), /does not belong/);
  assert.throws(() => ledger.prepare({ ...input, parentAttemptId: parent.attempt.attemptId }), /required together/);
  assert.throws(() => ledger.prepare({ ...input, ...relation, jobId: parent.job.jobId }), /cannot change its parent/);
  const child = ledger.prepare({ ...input, ...relation });
  assert.throws(() => ledger.prepare({ ...input, jobId: parent.job.jobId, parentJobRef: { sourceId: ledger.sourceId, jobId: child.job.jobId }, parentAttemptId: child.attempt.attemptId }), /cannot change its parent/);
  assert.throws(() => ledger.prepare({ ...input, jobId: child.job.jobId, targetSnapshot: { targetId: 'reviewer' } }), /original target/);
});

test('acceptance binds exact result bytes and revision, is separate from execution, and does not transfer to retry', () => {
  const { ledger } = fixture(), first = running(ledger), id = first.attempt.attemptId;
  ledger.observe(id, { executionStatus: 'completed', resultDigest: 'digest-v1', resultRevision: 'v1', artifactLinks: ['https://example.invalid/final.pptx'] });
  assert.throws(() => ledger.acceptance('root', first.job.jobId, { attemptId: id, resultDigest: 'wrong', resultRevision: 'v1', reviewStatus: 'accepted' }), /does not match/);
  ledger.acceptance('root', first.job.jobId, { attemptId: id, resultDigest: 'digest-v1', resultRevision: 'v1', reviewStatus: 'accepted' });
  assert.equal(ledger.get('root', first.job.jobId).businessAcceptance?.reviewStatus, 'accepted');
  ledger.observe(id, { resultDigest: 'digest-v2', resultRevision: 'v2' });
  assert.equal(ledger.get('root', first.job.jobId).businessAcceptance, undefined);
  const retry = ledger.prepare({ ...input, jobId: first.job.jobId });
  assert.equal(ledger.get('root', first.job.jobId).businessAcceptance, undefined);
  assert.equal(ledger.get('root', first.job.jobId).acceptanceHistory.length, 1);
  assert.equal(ledger.getAttempt(id).executionStatus, 'completed'); assert.equal(retry.attempt.executionStatus, 'not_started');
});

test('completed results acquire stable versions and host artifact hashes participate in the digest', () => {
  const f = fixture(), first = running(f.ledger), id = first.attempt.attemptId;
  const observation = { resultSummary: 'published package', artifactLinks: ['https://example.invalid/article.html'],
    resultArtifacts: [{ path: '/output/article.html', size: 100, sha256: 'a'.repeat(64) }] };
  f.ledger.observe(id, observation);
  assert.equal(f.ledger.getAttempt(id).result?.resultRevision, undefined);
  f.ledger.observe(id, { ...observation, executionStatus: 'completed' });
  const original = f.ledger.get('root', first.job.jobId).result!;
  assert.equal(original.resultRevision, 'result-1'); assert.match(original.resultDigest!, /^[a-f0-9]{64}$/);
  f.ledger.acceptance('root', first.job.jobId, { attemptId: id, resultRevision: original.resultRevision!, resultDigest: original.resultDigest!, reviewStatus: 'accepted' });
  const events = f.ledger.events('root').length;
  const ledger = new JobLedger(f.saved(), () => {});
  ledger.observe(id, { ...observation, checkedAt: '2026-10-22T12:00:00.000Z', resultArtifacts: [{ sha256: 'a'.repeat(64), size: 100, path: '/output/article.html' }] });
  let view = ledger.get('root', first.job.jobId);
  assert.equal(view.result?.resultRevision, original.resultRevision); assert.equal(view.result?.resultDigest, original.resultDigest);
  assert.equal(view.resultHistory.length, 1); assert.equal(ledger.events('root').length, events);
  assert.equal(view.businessAcceptance?.reviewStatus, 'accepted');
  ledger.observe(id, { resultArtifacts: [{ path: '/output/article.html', size: 100, sha256: 'b'.repeat(64) }] });
  view = ledger.get('root', first.job.jobId);
  assert.equal(view.result?.resultRevision, 'result-2'); assert.notEqual(view.result?.resultDigest, original.resultDigest);
  assert.deepEqual(view.resultHistory[0], original); assert.equal(view.resultHistory.length, 2);
  assert.equal(view.businessAcceptance, undefined); assert.equal(view.acceptanceHistory.length, 1);
  assert.throws(() => ledger.acceptance('root', first.job.jobId, { attemptId: id, resultRevision: original.resultRevision!, resultDigest: original.resultDigest!, reviewStatus: 'accepted' }), /does not match/);
  ledger.observe(id, observation);
  view = ledger.get('root', first.job.jobId);
  assert.equal(view.result?.resultDigest, original.resultDigest); assert.equal(view.result?.resultRevision, 'result-3');
  assert.equal(view.businessAcceptance, undefined);
  view.resultHistory[0]!.resultSummary = 'mutated';
  assert.equal(ledger.get('root', first.job.jobId).resultHistory[0]?.resultSummary, original.resultSummary);
});

test('explicit revisions cannot overwrite history, stale observations cannot change versions and old rounds cannot be reviewed', () => {
  const { ledger } = fixture(), first = running(ledger), id = first.attempt.attemptId;
  const observation = { executionStatus: 'completed' as const, resultSummary: 'v1', resultRevision: 'revision-1', resultDigest: 'artifact-digest-1' };
  ledger.observe(id, observation);
  const original = ledger.get('root', first.job.jobId).result!;
  assert.throws(() => ledger.observe(id, { resultSummary: 'different', resultRevision: 'revision-1', resultDigest: 'artifact-digest-1' }), /cannot be overwritten/);
  assert.deepEqual(ledger.get('root', first.job.jobId).result, original);
  ledger.observe(id, { executionStatus: 'working', resultSummary: 'late progress' });
  assert.equal(ledger.get('root', first.job.jobId).resultHistory.length, 1);
  assert.deepEqual(ledger.get('root', first.job.jobId).result, original);
  ledger.observe(id, { resultSummary: 'v2', resultRevision: 'revision-2', resultDigest: 'artifact-digest-2' });
  assert.throws(() => ledger.observe(id, observation), /cannot be overwritten/);
  ledger.prepare({ ...input, jobId: first.job.jobId });
  assert.throws(() => ledger.acceptance('root', first.job.jobId, { attemptId: id, resultRevision: 'revision-2', resultDigest: 'artifact-digest-2', reviewStatus: 'accepted' }), /current completed attempt/);
});

test('unavailable results cannot be accepted and do not display an earlier acceptance', () => {
  const { ledger } = fixture(), first = running(ledger), id = first.attempt.attemptId;
  ledger.observe(id, { executionStatus: 'completed', resultSummary: 'done' });
  const result = ledger.get('root', first.job.jobId).result!;
  const review = { attemptId: id, resultRevision: result.resultRevision!, resultDigest: result.resultDigest!, reviewStatus: 'accepted' as const };
  ledger.acceptance('root', first.job.jobId, review);
  ledger.observe(id, { resultAvailable: false });
  assert.equal(ledger.get('root', first.job.jobId).businessAcceptance, undefined);
  assert.throws(() => ledger.acceptance('root', first.job.jobId, review), /available result/);
});

test('a provisional domain revision can complete with its final receipt without publishing the waiting state as a version', () => {
  const { ledger } = fixture(), first = running(ledger), id = first.attempt.attemptId;
  ledger.observe(id, { executionStatus: 'input_required', resultSummary: 'waiting for human review', resultRevision: 'report-v1', resultDigest: 'report-digest' });
  assert.equal(ledger.get('root', first.job.jobId).resultHistory.length, 0);
  ledger.observe(id, { executionStatus: 'completed', resultSummary: 'human approved', resultRevision: 'report-v1', resultDigest: 'report-digest' });
  const view = ledger.get('root', first.job.jobId);
  assert.equal(view.result?.resultRevision, 'report-v1'); assert.equal(view.resultHistory.length, 1);
  assert.equal(view.resultHistory[0]?.resultSummary, 'human approved');
});

test('legacy migration is idempotent per task and never groups a reused context or fabricates creation times', () => {
  const { ledger } = fixture();
  const records = ['a', 'b'].map(taskId => ({ originSessionId: 'root', remote: 'dsh', taskId, contextId: 'shared', executionStatus: 'completed' as const }));
  const migrated = ledger.migrateLegacy(records);
  assert.notEqual(migrated[0]?.jobId, migrated[1]?.jobId);
  assert.deepEqual(ledger.migrateLegacy(records), migrated);
  assert.equal(ledger.list('root').length, 2);
  for (const job of ledger.list('root')) { assert.equal(job.createdAt, null); assert.equal(job.attempts[0]?.createdAt, null); assert.equal(job.provenance, 'legacy'); }
  const events = ledger.events('root');
  assert.equal(events.length, 2); assert.deepEqual(events.map(event => event.sequence), [1, 2]);
  const state = ledger.snapshot(); state.events[0]!.type = 'modified';
  assert.equal(ledger.events('root')[0]?.type, 'job.migrated');
});

test('snapshots reject plaintext credentials; cancellation intent alone does not mark execution canceled', () => {
  const { ledger } = fixture();
  assert.throws(() => ledger.prepare({ ...input, targetSnapshot: { ...target, token: 'private' } }), /Plaintext credential/);
  const first = running(ledger);
  ledger.requestCancellation(first.attempt.attemptId);
  assert.equal(ledger.getAttempt(first.attempt.attemptId).executionStatus, 'working');
  assert.ok(ledger.getAttempt(first.attempt.attemptId).cancellationRequestedAt);
});

test('restart only quarantines dispatching attempts; prepared and accepted facts remain unchanged', () => {
  const f = fixture(), dispatching = f.ledger.prepare(input), prepared = f.ledger.prepare(input), accepted = running(f.ledger);
  f.ledger.markDispatching(dispatching.attempt.attemptId);
  const restored = new JobLedger(f.saved(), () => {});
  assert.deepEqual(restored.recoverAfterRestart(), [dispatching.attempt.attemptId]);
  assert.equal(restored.getAttempt(dispatching.attempt.attemptId).submissionStatus, 'submission_unknown');
  assert.equal(restored.getAttempt(prepared.attempt.attemptId).submissionStatus, 'prepared');
  assert.equal(restored.getAttempt(accepted.attempt.attemptId).submissionStatus, 'accepted');
  const events = restored.events('root').length;
  assert.deepEqual(restored.recoverAfterRestart(), []);
  assert.equal(restored.events('root').length, events);
});

test('a failure fact survives a failed round and is cleared when the round is not failed', () => {
  const { ledger } = fixture();
  const attempt = running(ledger);
  const error = { category: 'quota', message: 'Provider quota exhausted.', retryable: false, providerCode: 'quota_exhausted' } as const;
  ledger.observe(attempt.attempt.attemptId, { executionStatus: 'failed', error });
  assert.deepEqual(ledger.getAttempt(attempt.attempt.attemptId).error, error);
  assert.deepEqual(ledger.get('root', attempt.job.jobId).error, error);
  ledger.observe(attempt.attempt.attemptId, { executionStatus: 'working' });
  assert.equal(ledger.getAttempt(attempt.attempt.attemptId).error, undefined, 'a working round carries no failure fact');
  assert.equal(ledger.get('root', attempt.job.jobId).error, undefined);
  ledger.observe(attempt.attempt.attemptId, { executionStatus: 'failed', error });
  ledger.observe(attempt.attempt.attemptId, { executionStatus: 'completed' });
  assert.equal(ledger.getAttempt(attempt.attempt.attemptId).error, undefined, 'a completed round carries no failure fact');
});
