import assert from 'node:assert/strict';
import test from 'node:test';
import { describeTrail } from '../bin/trail.js';
import { JobLedger } from '../src/execution/ledger.js';

test('a trail answers who asked, what ran, who approved, what came out and who read it, and says when one was not recorded', () => {
  const ledger = new JobLedger(undefined, () => {}), coach = { kind: 'coach', agent: 'claude-code', sessionId: 'cc-1' } as const;
  const { job, attempt } = ledger.prepare({ originSessionId: 'root', title: '大纲', input: {}, initiatedBy: coach,
    targetSnapshot: { targetId: 'legacy:host', remote: 'host', agentPreset: 'standard', cwd: '/work' } });
  ledger.markDispatching(attempt.attemptId);
  ledger.accept(attempt.attemptId, { taskId: 't' }, { executionStatus: 'working' });
  ledger.observe(attempt.attemptId, { executionStatus: 'completed', resultAvailable: true, resultRevision: 'result-1', resultDigest: 'abc' });
  ledger.acceptance('root', job.jobId, { attemptId: attempt.attemptId, resultRevision: 'result-1', resultDigest: 'abc', reviewStatus: 'accepted', decidedBy: { kind: 'person' } });
  const request = { requestId: 'prc-1', kind: 'permission', toolTitle: 'Run git', status: 'answered', answer: { outcome: 'approved', note: '只读', decidedBy: coach } };
  const old = { requestId: 'prc-2', kind: 'plan', status: 'answered', answer: { outcome: 'approved' } };
  const text = describeTrail(ledger.get('root', job.jobId), [request, old] as any, ledger.events('root', job.jobId));
  assert.match(text, /发起：教练 claude-code cc-1（来源 root）/);
  assert.match(text, /legacy:host · host · standard · \/work/);
  assert.match(text, /prc-1 Run git：approved，教练 claude-code cc-1：只读/);
  assert.match(text, /prc-2 plan：approved，未记录/, 'records from before actors were named say so');
  assert.match(text, /结果 result-1，摘要 abc/);
  assert.match(text, /accepted，人，结果 result-1/);
  assert.match(text, /job\.acceptance_recorded/);
});
