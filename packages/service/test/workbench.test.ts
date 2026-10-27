import assert from 'node:assert/strict';
import test from 'node:test';
import { JobLedger, type LedgerTargetSnapshot } from '../src/execution/ledger.js';
import { createHumanReview, decideHumanReview } from '../src/execution/human-review.js';
import { createProcessRequest, PROCESS_REQUEST_TTL_MS } from '../src/execution/process-request.js';
import { workbenchSnapshot, listWorkbenchTasks, getWorkbenchTask } from '../src/execution/workbench.js';
import type { PptDeliveryRun } from '../src/execution/ppt-delivery.js';

function fixture() {
  const ledger = new JobLedger(undefined, () => {});
  const parent = ledger.prepare({ originSessionId: 'session-a', targetSnapshot: { targetId: 'delivery' }, input: {}, title: 'Project PPT' });
  ledger.markDispatching(parent.attempt.attemptId); ledger.accept(parent.attempt.attemptId, { runId: 'delivery-run' }, { executionStatus: 'input_required', phase: 'awaiting_human' });
  const author = ledger.prepare({ originSessionId: 'session-a', targetSnapshot: { targetId: 'author' }, input: { secret: 'never expose' }, title: 'Project script', purpose: 'project_script',
    parentJobRef: { sourceId: ledger.sourceId, jobId: parent.job.jobId }, parentAttemptId: parent.attempt.attemptId });
  ledger.markDispatching(author.attempt.attemptId); ledger.accept(author.attempt.attemptId, { taskId: 'author-task', sessionId: 'author-session' }, { executionStatus: 'completed', resultRevision: 'script-v1', resultDigest: 'a'.repeat(64), artifactLinks: ['file:///private/file', 'https://user:secret@example.invalid/file', 'https://example.invalid/script.md'] });
  const unrelated = ledger.prepare({ originSessionId: 'session-b', targetSnapshot: { targetId: 'other' }, input: {}, title: 'Unrelated task' });
  const review = createHumanReview({ jobId: parent.job.jobId, attemptId: parent.attempt.attemptId, stage: 'summary', authorJobId: author.job.jobId, authorAttemptId: author.attempt.attemptId,
    authorSessionId: 'author-session', title: 'Project script', reviewerId: 'owner', revision: 'script-v1', digest: 'a'.repeat(64),
    preview: { title: 'Project', slides: Array.from({ length: 6 }, (_, i) => ({ title: `Page ${i}`, message: 'Fact', body: ['Body'], visual: 'Diagram', sources: ['README.md:1'], facts: ['Fact'], notes: '' })) } }, '2026-10-22T06:00:00.000Z');
  const run = { jobId: parent.job.jobId, attemptId: parent.attempt.attemptId, phase: 'awaiting_human', stage: 'summary', executionStatus: 'input_required', sourceId: ledger.sourceId,
    revision: 1, policy: { requireHumanReview: true }, metrics: { elapsedMs: 1200 }, humanWaitingMs: 1000, humanWaitStartedAt: '2026-10-22T06:00:00.000Z',
    updatedAt: '2026-10-22T06:00:00.000Z', children: [{ purpose: 'project_script', revision: 1, targetId: 'author', child: { jobId: author.job.jobId, attemptId: author.attempt.attemptId, executionStatus: 'completed' } }] } as unknown as PptDeliveryRun;
  return { ledger, parent, author, unrelated, review, run };
}

test('parent waits while the author is complete, and planned stages are not fabricated tasks', () => {
  const f = fixture(), source = { ledger: f.ledger.snapshot(), runs: [f.run], reviews: [f.review], actorId: 'owner', now: Date.parse('2026-10-22T06:01:00.000Z') }, before = structuredClone(source);
  const snapshot = workbenchSnapshot(source), detail = getWorkbenchTask(snapshot, f.parent.job.jobId);
  assert.deepEqual(source, before); assert.equal(detail.executionStatus, 'input_required'); assert.equal(detail.displayStatus, 'awaiting_human');
  assert.equal(detail.pendingReviewId, f.review.reviewId); assert.equal(detail.children.length, 1);
  assert.equal(detail.children[0]!.executionStatus, 'completed'); assert.equal(detail.progress.stage, 'human_review');
  assert.equal(detail.progress.humanWaitingMs, 61000); assert.equal(detail.progress.executionElapsedMs, 1200);
  assert.equal(detail.progress.stages.find(s => s.stage === 'make')?.planned, true);
  assert.equal(detail.progress.stages.find(s => s.stage === 'make')?.jobId, undefined);
  assert.equal(detail.dependencies.filter(d => d.kind === 'depends_on').length, 0);
  const author = getWorkbenchTask(snapshot, f.author.job.jobId);
  assert.equal(author.progress.stages.length, 1); assert.equal(author.progress.stages[0]!.name, '文稿生成');
  assert.equal(author.ancestors[0]?.jobId, f.parent.job.jobId); assert.equal(author.reviews[0]?.canReview, true);
});

test('views aggregate root tasks, pending decisions belong to the actual assigned person', () => {
  const f = fixture(), snapshot = workbenchSnapshot({ ledger: f.ledger.snapshot(), runs: [f.run], reviews: [f.review], actorId: 'owner' });
  const all = listWorkbenchTasks(snapshot); assert.equal(all.items.length, 3); assert.equal(all.counts.all, 2); assert.equal(all.counts.pending, 1);
  const pending = listWorkbenchTasks(snapshot, { filter: 'pending' }); assert.equal(pending.total, 1); assert.equal(pending.items[0]?.jobId, f.parent.job.jobId);
  const other = workbenchSnapshot({ ledger: f.ledger.snapshot(), runs: [f.run], reviews: [f.review], actorId: 'other-person' });
  assert.equal(listWorkbenchTasks(other, { filter: 'pending' }).total, 0); assert.equal(getWorkbenchTask(other, f.parent.job.jobId).reviews[0]?.canReview, false);
  assert.equal(listWorkbenchTasks(snapshot, { limit: 1, offset: 1 }).items.length, 1);
});

test('authorized origins constrain all reads, and execution input and unsafe artifact links are omitted', () => {
  const f = fixture(), snapshot = workbenchSnapshot({ ledger: f.ledger.snapshot(), runs: [f.run], reviews: [f.review], actorId: 'owner', allowedOrigins: ['session-a'] });
  assert.equal(snapshot.tasks.length, 2); assert.throws(() => getWorkbenchTask(snapshot, f.unrelated.job.jobId), /authorized scope/);
  const author = getWorkbenchTask(snapshot, f.author.job.jobId);
  assert.equal('input' in author.attempts[0]!, false); assert.equal('targetSnapshot' in author.attempts[0]!, false);
  assert.deepEqual(author.attempts[0]?.result?.artifactLinks, ['https://example.invalid/script.md']);
  assert.deepEqual(author.attempts[0]?.resultHistory?.[0]?.artifactLinks, ['https://example.invalid/script.md']);
  assert.deepEqual(author.artifacts[0]?.artifacts, ['https://example.invalid/script.md']);
  author.title = 'mutated'; assert.notEqual(getWorkbenchTask(snapshot, f.author.job.jobId).title, 'mutated');
});

test('historical result versions apply the same receipt and artifact filtering as the current result', () => {
  const f = fixture();
  f.ledger.observe(f.author.attempt.attemptId, { structuredResultRef: { internal: 'private receipt' }, resultArtifacts: [
    { path: '/private/local-only', sha256: 'a'.repeat(64), size: 42 },
    { path: '/output/script.md', url: 'https://example.invalid/script.md', sha256: 'b'.repeat(64), size: 100, internal: 'omit' },
  ] });
  const source = f.ledger.snapshot(), before = structuredClone(source);
  const detail = getWorkbenchTask(workbenchSnapshot({ ledger: source, runs: [], reviews: [], actorId: 'owner' }), f.author.job.jobId);
  const attempt = detail.attempts[0]!;
  assert.equal(attempt.resultHistory?.length, 2);
  for (const result of [attempt.result!, ...attempt.resultHistory!]) {
    assert.equal(result.structuredResultRef, undefined);
    assert.deepEqual(result.artifactLinks, ['https://example.invalid/script.md']);
    if (result.resultArtifacts) assert.deepEqual(result.resultArtifacts, [{ path: '/output/script.md', url: 'https://example.invalid/script.md', sha256: 'b'.repeat(64), size: 100 }]);
  }
  assert.deepEqual(source, before);
});

test('human decisions appear in the event timeline without changing the ledger', () => {
  const f = fixture(), approved = decideHumanReview(f.review, { action: 'approve', clientRequestId: 'click-1', revision: f.review.revision, digest: f.review.digest },
    { id: 'owner', source: '1agents-web' }, f.review, '2026-10-22T06:01:00.000Z').review;
  const before = f.ledger.snapshot(), detail = getWorkbenchTask(workbenchSnapshot({ ledger: before, runs: [f.run], reviews: [approved], actorId: 'owner' }), f.parent.job.jobId);
  assert.equal(detail.events.find(e => e.type === 'human_review.approve')?.eventId, approved.history[0]?.decisionId);
  assert.equal(detail.reviews[0]?.resumeStatus, 'pending'); assert.equal(detail.reviews[0]?.canReview, false); assert.deepEqual(f.ledger.snapshot(), before);
});

test('a recorded approval awaiting recovery shows its real blocking reason rather than a running author', () => {
  const f = fixture(), review = decideHumanReview(f.review, { action: 'approve', clientRequestId: 'approved-but-blocked', revision: f.review.revision, digest: f.review.digest },
    { id: 'owner', source: '1agents-web' }, f.review).review;
  f.run.diagnostics = ['Human continuation deferred: Frozen source/script manifest changed'];
  const detail = getWorkbenchTask(workbenchSnapshot({ ledger: f.ledger.snapshot(), runs: [f.run], reviews: [review], actorId: 'owner' }), f.parent.job.jobId);
  assert.match(detail.progressSummary, /继续执行受阻/); assert.match(detail.progressSummary, /Frozen source/);
  assert.equal(detail.reviews[0]?.resumeStatus, 'pending'); assert.equal(detail.reviews[0]?.resumeError, 'Frozen source/script manifest changed');
  assert.doesNotMatch(detail.progressSummary, /文稿作者正在/);
});

test('a saved decision awaiting normal continuation is working rather than a user-facing exception', () => {
  const f = fixture(), review = decideHumanReview(f.review, { action: 'approve', clientRequestId: 'normal-resume', revision: f.review.revision, digest: f.review.digest },
    { id: 'owner', source: '1agents-web' }, f.review).review;
  const snapshot = workbenchSnapshot({ ledger: f.ledger.snapshot(), runs: [f.run], reviews: [review], actorId: 'owner' });
  assert.equal(getWorkbenchTask(snapshot, f.parent.job.jobId).displayStatus, 'resuming');
  assert.equal(listWorkbenchTasks(snapshot, { filter: 'failed' }).items.some(item => item.jobId === f.parent.job.jobId), false);
  assert.equal(listWorkbenchTasks(snapshot, { filter: 'working' }).items.some(item => item.jobId === f.parent.job.jobId), true);
});

test('a newer parent execution does not inherit pending review authority from an older round', () => {
  const f = fixture(); f.ledger.prepare({ originSessionId: 'session-a', targetSnapshot: { targetId: 'delivery' }, jobId: f.parent.job.jobId, input: {} });
  const detail = getWorkbenchTask(workbenchSnapshot({ ledger: f.ledger.snapshot(), runs: [f.run], reviews: [f.review], actorId: 'owner' }), f.parent.job.jobId);
  assert.equal(detail.pendingReviewId, undefined); assert.equal(detail.reviews[0]?.canReview, false); assert.equal(detail.attempts.length, 2);
});

test('a completed current round does not hide an unresolved historical execution', () => {
  const f = fixture(); f.ledger.observe(f.parent.attempt.attemptId, { executionStatus: 'unknown', stale: true, diagnostic: 'Old host is unavailable' });
  const next = f.ledger.prepare({ originSessionId: 'session-a', targetSnapshot: { targetId: 'delivery' }, jobId: f.parent.job.jobId, input: {} });
  f.ledger.markDispatching(next.attempt.attemptId); f.ledger.accept(next.attempt.attemptId, { runId: 'new-run' }, { executionStatus: 'completed' });
  const snapshot = workbenchSnapshot({ ledger: f.ledger.snapshot(), runs: [f.run], reviews: [f.review], actorId: 'owner' }), detail = getWorkbenchTask(snapshot, f.parent.job.jobId);
  assert.equal(detail.executionStatus, 'completed'); assert.deepEqual(detail.unresolvedAttemptIds, [f.parent.attempt.attemptId]);
  assert.equal(detail.attempts.find(a => a.attemptId === f.parent.attempt.attemptId)?.stale, true);
  assert.equal(listWorkbenchTasks(snapshot, { filter: 'failed' }).items.some(item => item.jobId === f.parent.job.jobId), true);
});

test('sibling task membership does not invent execution dependencies', () => {
  const f = fixture(); f.ledger.prepare({ originSessionId: 'session-a', targetSnapshot: { targetId: 'parallel' }, input: {}, title: 'Parallel task',
    parentJobRef: { sourceId: f.ledger.sourceId, jobId: f.parent.job.jobId }, parentAttemptId: f.parent.attempt.attemptId });
  const detail = getWorkbenchTask(workbenchSnapshot({ ledger: f.ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' }), f.parent.job.jobId);
  assert.equal(detail.children.length, 2); assert.equal(detail.dependencies.length, 2);
  assert.ok(detail.dependencies.every(edge => edge.kind === 'parent'));
});

test('pending review history never overrides a canceled, failed or completed parent task', () => {
  for (const executionStatus of ['canceled', 'failed', 'completed'] as const) {
    const f = fixture(); f.ledger.observe(f.parent.attempt.attemptId, { executionStatus }); f.run.executionStatus = executionStatus;
    const snapshot = workbenchSnapshot({ ledger: f.ledger.snapshot(), runs: [f.run], reviews: [f.review], actorId: 'owner' });
    const parent = getWorkbenchTask(snapshot, f.parent.job.jobId), author = getWorkbenchTask(snapshot, f.author.job.jobId);
    assert.equal(parent.displayStatus, executionStatus); assert.equal(parent.pendingReviewId, undefined);
    assert.equal(parent.reviews[0]?.status, 'pending'); assert.equal(parent.reviews[0]?.canReview, false); assert.equal(author.reviews[0]?.canReview, false);
    assert.equal(listWorkbenchTasks(snapshot, { filter: 'pending' }).total, 0); assert.equal(listWorkbenchTasks(snapshot).counts.pending, 0);
    if (executionStatus === 'failed') assert.equal(listWorkbenchTasks(snapshot, { filter: 'failed' }).items.some(item => item.jobId === f.parent.job.jobId), true);
  }
});

test('temporary tasks keep their execution service separate from their recorded presets and titles', () => {
  const ledger = new JobLedger(undefined, () => {});
  const first = ledger.prepare({ originSessionId: 'session-a', title: 'Only run pwd', input: {}, targetSnapshot: {
    targetId: 'legacy:ppt-beautifier', remote: 'ppt-beautifier', agentPreset: 'standard', provider: 'a2a', connectionId: 'remote:ppt-beautifier',
  } });
  const second = ledger.prepare({ originSessionId: 'session-a', title: 'Make a presentation', input: {}, targetSnapshot: {
    targetId: 'legacy:ppt-beautifier', remote: 'ppt-beautifier', agentPreset: 'oneagents-acp-codex',
  } });
  const defaults = ledger.prepare({ originSessionId: 'session-a', title: 'Use host configuration', input: {}, targetSnapshot: {
    targetId: 'general-host', targetKind: 'agent_host', targetName: 'General execution host', remote: 'ppt-beautifier',
  } });
  const snapshot = workbenchSnapshot({ ledger: ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' });
  const a = getWorkbenchTask(snapshot, first.job.jobId).execution, b = getWorkbenchTask(snapshot, second.job.jobId).execution;
  assert.equal(a.kind, 'temporary'); assert.equal(b.kind, 'temporary'); assert.equal(a.service, b.service);
  assert.equal(a.agentPreset, 'standard'); assert.equal(b.agentPreset, 'oneagents-acp-codex');
  assert.equal(a.presetStatus, 'recorded'); assert.equal(a.connectionId, 'remote:ppt-beautifier'); assert.equal(a.roleId, undefined);
  assert.equal(getWorkbenchTask(snapshot, defaults.job.jobId).execution.presetStatus, 'host_default');
  assert.equal(getWorkbenchTask(snapshot, defaults.job.jobId).execution.targetName, 'General execution host');
});

test('fixed roles, workflow drivers and incomplete historical identities use distinct execution kinds', () => {
  const ledger = new JobLedger(undefined, () => {});
  const prepare = (targetSnapshot: LedgerTargetSnapshot) => ledger.prepare({ originSessionId: 'session-a', input: {}, targetSnapshot });
  const resident = prepare({ targetId: 'writer', targetKind: 'resident_agent', targetName: '文稿作者', roleId: 'script-author',
    binding: { roleId: 'script-author', agentPreset: 'standard' }, remote: 'writing-host' });
  const workflow = prepare({ targetId: 'delivery', targetKind: 'resident_agent', roleId: 'ppt-delivery', agentPreset: 'internal-orchestrator',
    binding: { roleId: 'ppt-delivery', driver: 'ppt_delivery' }, remote: 'coordinator' });
  const genericWorkflow = prepare({ targetId: 'automation', targetKind: 'workflow', targetName: 'Order workflow', provider: 'activepieces' });
  const historical = prepare({ targetId: 'old-target' });
  const unknownLegacy = prepare({ targetId: 'legacy:missing-host', historicalConfigUnknown: true });
  const invalidPreset = prepare({ targetId: 'legacy:invalid-preset', agentPreset: 'x'.repeat(513) });
  const conflicting = prepare({ targetId: 'bad-host', targetKind: 'agent_host', binding: { roleId: 'fixed-role' } });
  const conflictingRole = prepare({ targetId: 'bad-role', targetKind: 'resident_agent', roleId: 'role-one', binding: { roleId: 'role-two' } });
  const source = { ledger: ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' }, before = structuredClone(source);
  const snapshot = workbenchSnapshot(source);
  assert.deepEqual(source, before);
  const role = getWorkbenchTask(snapshot, resident.job.jobId).execution;
  assert.equal(role.kind, 'resident'); assert.equal(role.roleId, 'script-author'); assert.equal(role.agentPreset, 'standard');
  assert.equal(role.targetName, '文稿作者');
  for (const job of [workflow.job, genericWorkflow.job]) {
    const execution = getWorkbenchTask(snapshot, job.jobId).execution;
    assert.equal(execution.kind, 'workflow'); assert.equal(execution.presetStatus, 'not_applicable'); assert.equal(execution.agentPreset, undefined);
  }
  assert.equal(getWorkbenchTask(snapshot, historical.job.jobId).execution.kind, 'unknown');
  assert.equal(getWorkbenchTask(snapshot, historical.job.jobId).execution.presetStatus, 'unknown');
  assert.equal(getWorkbenchTask(snapshot, unknownLegacy.job.jobId).execution.presetStatus, 'unknown');
  assert.equal(getWorkbenchTask(snapshot, unknownLegacy.job.jobId).execution.service, undefined);
  assert.equal(getWorkbenchTask(snapshot, invalidPreset.job.jobId).execution.presetStatus, 'unknown');
  assert.equal(getWorkbenchTask(snapshot, conflicting.job.jobId).execution.kind, 'unknown');
  assert.equal(getWorkbenchTask(snapshot, conflictingRole.job.jobId).execution.kind, 'unknown');
  assert.equal(getWorkbenchTask(snapshot, conflictingRole.job.jobId).execution.roleId, undefined);
  const fixtureWithRun = fixture();
  const runSnapshot = workbenchSnapshot({ ledger: fixtureWithRun.ledger.snapshot(), runs: [fixtureWithRun.run], reviews: [], actorId: 'owner' });
  assert.equal(getWorkbenchTask(runSnapshot, fixtureWithRun.parent.job.jobId).execution.kind, 'workflow');
  assert.equal(getWorkbenchTask(runSnapshot, fixtureWithRun.parent.job.jobId).attempts[0]?.execution.kind, 'workflow');
});

test('each attempt retains its frozen executor identity when a later attempt changes preset', () => {
  const ledger = new JobLedger(undefined, () => {});
  const first = ledger.prepare({ originSessionId: 'session-a', input: {}, targetSnapshot: {
    targetId: 'legacy:host', targetKind: 'agent_host', targetName: 'Original host name', remote: 'original-service', agentPreset: 'standard',
  } });
  ledger.markDispatching(first.attempt.attemptId); ledger.accept(first.attempt.attemptId, { taskId: 'old-task', remote: 'fallback-remote' }, { executionStatus: 'completed' });
  const next = ledger.prepare({ originSessionId: 'session-a', jobId: first.job.jobId, input: {}, targetSnapshot: {
    targetId: 'legacy:host', targetKind: 'agent_host', targetName: 'New host name', agentPreset: 'oneagents-acp-codex',
  } });
  ledger.markDispatching(next.attempt.attemptId); ledger.accept(next.attempt.attemptId, { taskId: 'new-task', remote: 'new-service' });
  const detail = getWorkbenchTask(workbenchSnapshot({ ledger: ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' }), first.job.jobId);
  assert.equal(detail.execution.agentPreset, 'oneagents-acp-codex'); assert.equal(detail.execution.service, 'new-service');
  assert.equal(detail.attempts.find(a => a.attemptId === first.attempt.attemptId)?.execution.agentPreset, 'standard');
  assert.equal(detail.attempts.find(a => a.attemptId === first.attempt.attemptId)?.execution.targetName, 'Original host name');
  assert.equal(detail.attempts.find(a => a.attemptId === first.attempt.attemptId)?.execution.service, 'original-service');
  assert.equal(detail.attempts.find(a => a.attemptId === next.attempt.attemptId)?.execution.targetName, 'New host name');
});

test('a legacy target ID alone cannot establish which default preset an absent or incomplete attempt used', () => {
  const ledger = new JobLedger(undefined, () => {});
  const prepare = () => ledger.prepare({ originSessionId: 'session-a', input: {}, targetSnapshot: { targetId: 'legacy:host' } });
  const missing = prepare(), incomplete = prepare(), recorded = prepare();
  const source = { ledger: ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' };
  delete source.ledger.attempts[missing.attempt.attemptId];
  source.ledger.attempts[incomplete.attempt.attemptId]!.targetSnapshot = {} as LedgerTargetSnapshot;
  const before = structuredClone(source), snapshot = workbenchSnapshot(source);
  for (const job of [missing.job, incomplete.job]) {
    const execution = getWorkbenchTask(snapshot, job.jobId).execution;
    assert.equal(execution.kind, 'temporary'); assert.equal(execution.presetStatus, 'unknown');
  }
  assert.equal(getWorkbenchTask(snapshot, recorded.job.jobId).execution.presetStatus, 'host_default');
  assert.deepEqual(source, before);
});

test('executor metadata exposes a bounded whitelist without raw binding, input, paths or endpoint credentials', () => {
  const ledger = new JobLedger(undefined, () => {});
  const prepared = ledger.prepare({ originSessionId: 'session-a', input: { prompt: 'private prompt' }, targetSnapshot: {
    targetId: 'legacy:host', targetKind: 'agent_host', remote: '  host-service  ', agentPreset: ' standard ',
    targetName: 'x'.repeat(513), endpoint: 'https://private.example/internal', cwd: '/private/workspace',
    binding: { allowedDirectories: ['/private/allowed'], skillRefs: ['private-skill'] },
  } });
  const source = { ledger: ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' };
  // Unexpected historical keys must not escape the read projection.
  source.ledger.attempts[prepared.attempt.attemptId]!.targetSnapshot.secret = 'private credential';
  const detail = getWorkbenchTask(workbenchSnapshot(source), prepared.job.jobId), metadata = detail.execution;
  assert.deepEqual(metadata, { kind: 'temporary', targetId: 'legacy:host', presetStatus: 'recorded', service: 'host-service', agentPreset: 'standard', provider: 'a2a',
    serviceInfo: { kind: 'a2a', source: 'target_snapshot', host: 'private.example', port: 443, locality: 'network', connectionAlias: 'host-service' } });
  assert.deepEqual(detail.attempts[0]?.execution, metadata);
  const output = JSON.stringify(detail);
  for (const privateValue of ['private prompt', 'https://private.example/internal', '/private/workspace', '/private/allowed', 'private-skill', 'private credential']) assert.equal(output.includes(privateValue), false);
});

test('service identity uses per-attempt endpoint evidence rather than a shared connection alias', () => {
  const ledger = new JobLedger(undefined, () => {});
  const prepare = (endpoint: string) => ledger.prepare({ originSessionId: 'session-a', input: {}, targetSnapshot: {
    targetId: 'legacy:ppt-beautifier', remote: 'ppt-beautifier', provider: 'a2a', endpoint,
  } });
  const local = prepare('http://127.0.0.1:3080/private-path?access=hidden-query#private-fragment');
  ledger.markDispatching(local.attempt.attemptId); ledger.accept(local.attempt.attemptId, { provider: 'a2a', taskId: 'actual-task', remote: 'actual-service', endpoint: 'https://actual.example:8443/private-receipt?access=receipt-query' });
  const remote = prepare('http://100.75.225.56:3088/');
  const defaults = prepare('https://remote.example/');
  const source = { ledger: ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' }, before = structuredClone(source);
  const snapshot = workbenchSnapshot(source);
  assert.deepEqual(source, before);
  const actual = getWorkbenchTask(snapshot, local.job.jobId).execution.serviceInfo;
  assert.deepEqual(actual, { kind: 'a2a', source: 'backend_run', host: 'actual.example', port: 8443, locality: 'network', connectionAlias: 'actual-service' });
  assert.deepEqual(getWorkbenchTask(snapshot, remote.job.jobId).execution.serviceInfo,
    { kind: 'a2a', source: 'target_snapshot', host: '100.75.225.56', port: 3088, locality: 'network', connectionAlias: 'ppt-beautifier' });
  assert.equal(getWorkbenchTask(snapshot, defaults.job.jobId).execution.serviceInfo?.port, 443);
  const output = JSON.stringify(snapshot);
  for (const secret of ['private-path', 'hidden-query', 'private-fragment', 'private-receipt', 'receipt-query']) assert.equal(output.includes(secret), false);
});

test('internal gateway workflows never claim their configured child host as the execution service', () => {
  const ledger = new JobLedger(undefined, () => {});
  const configured = ledger.prepare({ originSessionId: 'session-a', input: {}, targetSnapshot: {
    targetId: 'delivery', provider: 'resident_role', remote: 'ppt-beautifier', endpoint: 'http://127.0.0.1:3080/', binding: { driver: 'ppt_delivery' },
  } });
  const recorded = ledger.prepare({ originSessionId: 'session-a', input: {}, targetSnapshot: {
    targetId: 'old-delivery', remote: 'ppt-beautifier', endpoint: 'http://127.0.0.1:3080/',
  } });
  ledger.markDispatching(recorded.attempt.attemptId); ledger.accept(recorded.attempt.attemptId, { provider: 'resident_role', runId: 'coordinator-run' });
  const snapshot = workbenchSnapshot({ ledger: ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' });
  assert.deepEqual(getWorkbenchTask(snapshot, configured.job.jobId).execution.serviceInfo,
    { kind: 'gateway_workflow', source: 'target_snapshot', connectionAlias: 'ppt-beautifier' });
  assert.deepEqual(getWorkbenchTask(snapshot, recorded.job.jobId).execution.serviceInfo,
    { kind: 'gateway_workflow', source: 'workflow_run', connectionAlias: 'ppt-beautifier' });
  assert.equal(getWorkbenchTask(snapshot, recorded.job.jobId).execution.kind, 'workflow');
  const f = fixture(), detail = getWorkbenchTask(workbenchSnapshot({ ledger: f.ledger.snapshot(), runs: [f.run], reviews: [], actorId: 'owner' }), f.parent.job.jobId);
  assert.deepEqual(detail.execution.serviceInfo, { kind: 'gateway_workflow', source: 'workflow_run' });
});

test('missing or unsafe endpoint records remain unrecorded, and credentials never enter service metadata', () => {
  const ledger = new JobLedger(undefined, () => {});
  const prepare = (endpoint?: unknown, provider = 'a2a') => ledger.prepare({ originSessionId: 'session-a', input: {}, targetSnapshot: {
    targetId: 'legacy:host', remote: 'host', provider, ...(endpoint === undefined ? {} : { endpoint }),
  } });
  const jobs = [prepare(), prepare('https://user:password@private.example/path?token=query-secret'), prepare('file:///private/socket'), prepare('http://private.example/\nheader')];
  const ipv6 = prepare('http://[::1]:3080/');
  const numericDomain = prepare('http://127.example.invalid:3080/');
  const flow = prepare('https://flow.example/api/flows?auth=flow-secret', 'activepieces');
  const invalidAlias = prepare();
  const source = { ledger: ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' };
  source.ledger.attempts[invalidAlias.attempt.attemptId]!.targetSnapshot.remote = 'x'.repeat(513);
  const snapshot = workbenchSnapshot(source);
  for (const job of jobs) assert.deepEqual(getWorkbenchTask(snapshot, job.job.jobId).execution.serviceInfo, { kind: 'a2a', source: 'unrecorded', connectionAlias: 'host' });
  assert.deepEqual(getWorkbenchTask(snapshot, ipv6.job.jobId).execution.serviceInfo,
    { kind: 'a2a', source: 'target_snapshot', host: '::1', port: 3080, locality: 'loopback', connectionAlias: 'host' });
  assert.equal(getWorkbenchTask(snapshot, numericDomain.job.jobId).execution.serviceInfo?.locality, 'network');
  assert.equal(getWorkbenchTask(snapshot, flow.job.jobId).execution.serviceInfo?.kind, 'activepieces');
  assert.equal(getWorkbenchTask(snapshot, invalidAlias.job.jobId).execution.serviceInfo?.connectionAlias, undefined);
  const output = JSON.stringify(snapshot);
  for (const secret of ['password', 'query-secret', '/private/socket', 'flow-secret']) assert.equal(output.includes(secret), false);
});

test('historical service hosts stay frozen when a later execution uses another endpoint', () => {
  const ledger = new JobLedger(undefined, () => {});
  const first = ledger.prepare({ originSessionId: 'session-a', input: {}, targetSnapshot: { targetId: 'legacy:host', provider: 'a2a', remote: 'host', endpoint: 'http://old.example:3080/' } });
  ledger.markDispatching(first.attempt.attemptId); ledger.accept(first.attempt.attemptId, { taskId: 'first' }, { executionStatus: 'completed' });
  const next = ledger.prepare({ originSessionId: 'session-a', jobId: first.job.jobId, input: {}, targetSnapshot: { targetId: 'legacy:host', provider: 'a2a', remote: 'host', endpoint: 'http://new.example:3088/' } });
  const detail = getWorkbenchTask(workbenchSnapshot({ ledger: ledger.snapshot(), runs: [], reviews: [], actorId: 'owner' }), first.job.jobId);
  assert.equal(detail.execution.serviceInfo?.host, 'new.example');
  assert.equal(detail.attempts.find(a => a.attemptId === first.attempt.attemptId)?.execution.serviceInfo?.host, 'old.example');
  assert.equal(detail.attempts.find(a => a.attemptId === next.attempt.attemptId)?.execution.serviceInfo?.host, 'new.example');
});

test('a live process request waits in the confirmation queue and an expired one does not', () => {
  const ledger = new JobLedger(undefined, () => {});
  const parent = ledger.prepare({ originSessionId: 'session-a', targetSnapshot: { targetId: 'host' }, input: { prompt: 'secret-prompt' }, title: 'Distribution' });
  ledger.markDispatching(parent.attempt.attemptId);
  ledger.accept(parent.attempt.attemptId, { taskId: 'parent-task', sessionId: 'parent-session' }, { executionStatus: 'working' });
  const child = ledger.prepare({ originSessionId: 'session-a', targetSnapshot: { targetId: 'author' }, input: {}, title: 'Author',
    parentJobRef: { sourceId: ledger.sourceId, jobId: parent.job.jobId }, parentAttemptId: parent.attempt.attemptId });
  ledger.markDispatching(child.attempt.attemptId);
  ledger.accept(child.attempt.attemptId, { taskId: 'child-task', sessionId: 'dsh-1' }, { executionStatus: 'working' });
  const at = new Date('2026-10-27T02:00:00.000Z');
  const request = createProcessRequest({ requestId: 'prc-1', jobId: child.job.jobId, attemptId: child.attempt.attemptId, sessionId: 'dsh-1', kind: 'question',
    questions: [{ id: '0', question: 'Choose targets', options: [{ label: 'A' }], multiSelect: true }] }, at);
  const source = { ledger: ledger.snapshot(), runs: [], reviews: [], processRequests: [request], actorId: 'owner', now: at.getTime() + 60_000 };
  const before = structuredClone(source);
  const snapshot = workbenchSnapshot(source);
  assert.deepEqual(source, before);
  const detail = getWorkbenchTask(snapshot, child.job.jobId);
  assert.equal(detail.executionStatus, 'working');
  assert.equal(detail.displayStatus, 'awaiting_human');
  assert.equal(detail.pendingProcessRequestId, 'prc-1');
  assert.equal(detail.processRequests[0]?.canAnswer, true);
  assert.equal(detail.processRequests[0]?.questions?.[0]?.question, 'Choose targets');
  const parentDetail = getWorkbenchTask(snapshot, parent.job.jobId);
  assert.equal(parentDetail.executionStatus, 'working');
  assert.equal(parentDetail.pendingProcessRequestId, 'prc-1');
  assert.equal(parentDetail.processRequests[0]?.requestId, 'prc-1');
  assert.equal(JSON.stringify(snapshot).includes('secret-prompt'), false);
  const pending = listWorkbenchTasks(snapshot, { filter: 'pending' });
  assert.equal(pending.counts.pending, 1);
  assert.equal(pending.items.some(item => item.jobId === parent.job.jobId), true);
  assert.equal(pending.items.some(item => item.jobId === child.job.jobId), true);
  assert.equal(listWorkbenchTasks(snapshot, { filter: 'working' }).items.some(item => item.jobId === child.job.jobId || item.jobId === parent.job.jobId), false);
  const expired = workbenchSnapshot({ ...source, now: at.getTime() + PROCESS_REQUEST_TTL_MS + 1 });
  const expiredDetail = getWorkbenchTask(expired, child.job.jobId);
  assert.equal(expiredDetail.pendingProcessRequestId, undefined);
  assert.equal(expiredDetail.displayStatus, 'working');
  assert.equal(expiredDetail.processRequests[0]?.status, 'expired');
  assert.equal(expiredDetail.processRequests[0]?.canAnswer, false);
  assert.equal(listWorkbenchTasks(expired, { filter: 'pending' }).total, 0);
  assert.equal(request.status, 'pending');
});
