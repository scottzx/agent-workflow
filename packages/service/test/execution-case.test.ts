import assert from 'node:assert/strict';
import test from 'node:test';
import { JobLedger } from '../src/execution/ledger.js';
import { openCase, projectCase, requireCase, listCases, CaseError } from '../src/execution/cases.js';
import { recordFact, recordReceipt } from '../src/execution/externals.js';
import { decideHandoff, offerConvention, proposeHandoff, proposeByFact } from '../src/execution/handoff.js';

const digest = 'a'.repeat(64);

function ledgerWithCase(goal = '本周选题') {
  const ledger = new JobLedger(undefined, () => {});
  const record = openCase(ledger, { originSessionId: 'root', goal });
  return { ledger, record };
}

test('a case is opened once: the same id and goal returns the same thing, another goal is a conflict', () => {
  const { ledger, record } = ledgerWithCase();
  assert.equal(record.goal, '本周选题');
  assert.equal(record.createdAt.length > 0, true);
  const again = openCase(ledger, { originSessionId: 'root', caseId: record.caseId, goal: '本周选题' });
  assert.equal(again.caseId, record.caseId);
  assert.throws(() => openCase(ledger, { originSessionId: 'root', caseId: record.caseId, goal: '别的目标' }), CaseError);
  assert.equal(ledger.casesFor('root').length, 1);
});

test('a convention, a shared space and a task may only name a case that exists', () => {
  const { ledger, record } = ledgerWithCase();
  assert.throws(() => offerConvention(ledger, { originSessionId: 'root', caseId: 'ghost', toTargetId: 'maker', toPurpose: 'make', when: 'acceptance_accepted' }), CaseError);
  const rule = offerConvention(ledger, { originSessionId: 'root', caseId: record.caseId, toTargetId: 'maker', toPurpose: 'make', when: 'acceptance_accepted', requireHuman: true });
  assert.equal(rule.caseId, record.caseId);
});

test('an older job that only carried a case id is projected, and its record is not rewritten', () => {
  const ledger = new JobLedger(undefined, () => {});
  ledger.prepare({ originSessionId: 'root', caseId: 'legacy-case', title: '旧任务', targetSnapshot: { targetId: 'author' }, input: {} });
  const projected = projectCase(ledger, 'root', 'legacy-case');
  assert.equal(projected?.legacy, true);
  assert.equal(projected?.goal, '旧任务');
  assert.equal(ledger.casesFor('root').length, 0, 'the projection writes nothing back');
  assert.equal(requireCase(ledger, 'root', 'legacy-case').caseId, 'legacy-case');
  assert.equal(projectCase(ledger, 'root', 'nothing'), undefined);
  assert.equal(listCases(ledger, 'root').length, 1);
});

test('a receipt is keyed by channel and remote id, and the same key never holds another digest', () => {
  const { ledger, record } = ledgerWithCase();
  const receipt = recordReceipt(ledger, { originSessionId: 'root', caseId: record.caseId, channel: 'wechat', remoteId: 'post-1', artifactDigest: digest });
  assert.equal(receipt.artifactDigest, digest);
  const again = recordReceipt(ledger, { originSessionId: 'root', caseId: record.caseId, channel: 'wechat', remoteId: 'post-1', artifactDigest: digest });
  assert.equal(again.receiptId, receipt.receiptId, 'the same bytes are the same receipt');
  assert.throws(() => recordReceipt(ledger, { originSessionId: 'root', caseId: record.caseId, channel: 'wechat', remoteId: 'post-1', artifactDigest: 'b'.repeat(64) }), CaseError);
  assert.equal(ledger.receiptsFor('root', record.caseId).length, 1);
});

test('a measured fact only proposes the next hop; it never decides and never dispatches', () => {
  const ledger = new JobLedger(undefined, () => {});
  const record = openCase(ledger, { originSessionId: 'root', goal: '选题' });
  const prepared = ledger.prepare({ originSessionId: 'root', caseId: record.caseId, title: '稿子', targetSnapshot: { targetId: 'author' }, input: {} });
  ledger.markDispatching(prepared.attempt.attemptId);
  ledger.accept(prepared.attempt.attemptId, { taskId: 'task-1' }, { executionStatus: 'completed', resultRevision: 'r1', resultDigest: digest, artifactLinks: [] });
  const rule = offerConvention(ledger, { originSessionId: 'root', caseId: record.caseId, toTargetId: 'rewriter', toPurpose: 'retitle',
    when: 'fact_reached', requireHuman: false, condition: { metric: 'reads', operator: 'gte', value: 1000 } });
  recordFact(ledger, { originSessionId: 'root', caseId: record.caseId, metric: 'reads', value: 10, source: 'wechat' });
  assert.equal(ledger.handoffsFor('root', prepared.job.jobId).length, 0, 'a fact below the threshold proposes nothing');
  recordFact(ledger, { originSessionId: 'root', caseId: record.caseId, metric: 'reads', value: 5000, source: 'wechat' });
  const proposal = proposeByFact(ledger, 'root', record.caseId, rule, '事实达到约定条件');
  assert.equal(proposal?.status, 'proposed', 'the threshold proposes; it does not accept');
  assert.equal(ledger.list('root').length, 1, 'a proposal never opens the next task');
  assert.throws(() => decideHandoff(ledger, { originSessionId: 'root', handoffId: proposal!.handoffId, decision: 'accept', decidedBy: { kind: 'person' } }), /A person decides/);
});
