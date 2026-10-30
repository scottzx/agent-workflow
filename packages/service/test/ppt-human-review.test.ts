import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { advancePptDelivery, createPptDeliveryRun, scriptDirectory, scriptRevisionName,
  type PptDeliveryAdapter, type PptDeliveryChild, type PptDeliveryChildRequest, type PptDeliveryRun } from '../src/execution/ppt-delivery.js';
import { decideHumanReview, type HumanReviewDecisionInput } from '../src/execution/human-review.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function fixture(t: TestContext, slideCount = 6) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ppt-human-review-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const files: { path: string; sha256: string }[] = [];
  for (let i = 0; i < Math.max(6, slideCount); i++) {
    const path = `fact-${i}.md`, content = `Source fact ${i}`;
    await writeFile(join(project, path), content); files.push({ path, sha256: hash(content) });
  }
  let run = await createPptDeliveryRun({ sourceId: 'human-test-source', jobId: 'human-parent', attemptId: 'human-parent-attempt', originSessionId: 'origin-session',
    input: { projectDirectory: project, projectName: 'Human reviewed project' },
    policy: { workspaceRoot: join(root, 'jobs'), publicDirectory: join(root, 'public'), publicBaseUrl: 'http://example.invalid/artifacts',
      allowedProjectRoots: [project], summaryTargetId: 'script-author', makerTargetId: 'ppt-maker', reviewTargetId: 'independent-reviewer',
      runtimeDocument: join(root, 'runtime.md'), designSkill: join(root, 'skill.md'), pythonExecutable: '/usr/bin/python3', maxDurationMs: 3600000, maxExecutionRetries: 0 } });
  for (const path of [run.policy.runtimeDocument, run.policy.designSkill]) await writeFile(path, 'fixture');
  let now = Date.parse(run.createdAt), saved = JSON.stringify(run), sequence = 0;
  const snapshots: string[] = [], calls: { request: PptDeliveryChildRequest; previous?: PptDeliveryChild }[] = [];
  const accepted = new Map<string, PptDeliveryChild>(), states = new Map<string, PptDeliveryChild>();
  const parentUpdates: Parameters<PptDeliveryAdapter['updateParent']>[0][] = [];
  async function submit(request: PptDeliveryChildRequest, previous?: PptDeliveryChild) {
    calls.push({ request: structuredClone(request), ...(previous ? { previous: structuredClone(previous) } : {}) });
    const replay = accepted.get(request.clientRequestId);
    if (replay) return structuredClone(states.get(replay.attemptId)!);
    const id = ++sequence, child: PptDeliveryChild = { jobId: previous?.jobId ?? `child-${id}`, attemptId: `child-attempt-${id}`, targetId: request.targetId,
      executionStatus: 'working', submissionStatus: 'accepted', sessionId: previous?.sessionId ?? `${request.purpose}-session` };
    accepted.set(request.clientRequestId, child); states.set(child.attemptId, child); return structuredClone(child);
  }
  const adapter: PptDeliveryAdapter = {
    async persist(value) { saved = JSON.stringify(value); snapshots.push(saved); },
    async submitChild(request) { return submit(request); }, async continueChild(request) { return submit(request, request.child); },
    async getChild(child) { return structuredClone(states.get(child.attemptId)!); }, async ackChild() {},
    async updateParent(update) { parentUpdates.push(structuredClone(update)); }, async preflightPublication() {}, now: () => now,
  };
  async function writeScript(revision = run.scriptRevision ?? 1) {
    const directory = join(run.jobDirectory, 'coordinator', `script-v${revision}`); await mkdir(directory, { recursive: true });
    const script = { title: `Project script v${revision}`, slides: files.slice(0, slideCount).map((file, i) => ({ title: `Page ${i} v${revision}`, message: `Source fact ${i}`,
      body: [`Version ${revision} content`], visual: 'Diagram', sources: [`${file.path}:1`], facts: [`Source fact ${i}`], notes: '' })) };
    await writeFile(join(directory, 'slide-script.json'), JSON.stringify(script));
    await writeFile(join(directory, 'slide-script.md'), `# Script v${revision}`); await writeFile(join(directory, 'project-summary.md'), `Project summary v${revision}`);
    await writeFile(join(directory, 'source-manifest.json'), JSON.stringify({ projectDirectory: project, gitHead: 'unknown', gitStatus: '', files }));
    return directory;
  }
  await writeScript();
  async function step() { await advancePptDelivery(run, adapter); run = JSON.parse(saved); }
  async function completeCurrent() { assert.ok(run.currentChild); states.get(run.currentChild.attemptId)!.executionStatus = 'completed'; await step(); }
  async function untilHuman() { await step(); now += 1000; await completeCurrent(); assert.equal(run.phase, 'awaiting_human'); }
  async function decide(action: HumanReviewDecisionInput['action'], note?: string, clientRequestId = `decision-${action}`) {
    const index = run.humanReviews!.length - 1, review = run.humanReviews![index]!;
    const result = decideHumanReview(review, { action, revision: review.revision, digest: review.digest, clientRequestId, ...(note ? { note } : {}) },
      { id: 'local-owner', displayName: 'Owner', source: '1agents-web' }, { attemptId: run.attemptId, revision: scriptRevisionName(run), digest: run.scriptDigest! }, new Date(now).toISOString());
    run.humanReviews![index] = result.review; await adapter.persist(run); return result.review;
  }
  return { root, adapter, snapshots, calls, accepted, states, parentUpdates, step, completeCurrent, untilHuman, decide, writeScript,
    get run() { return run; }, get latestReview() { return run.humanReviews!.at(-1)!; }, get saved() { return saved; },
    restore(serialized: string) { run = JSON.parse(serialized); saved = serialized; }, advanceTime(ms: number) { now += ms; } };
}

test('completed script enters persistent human wait and a comment never starts the maker', async t => {
  const f = await fixture(t); assert.equal(f.run.policy.requireHumanReview, true);
  await f.untilHuman(); assert.equal(f.run.executionStatus, 'input_required'); assert.equal(f.run.stage, 'summary');
  assert.equal(f.latestReview.status, 'pending'); assert.equal(f.latestReview.revision, 'script-v1');
  assert.equal(f.latestReview.authorSessionId, 'project_script-session'); assert.equal(f.latestReview.preview.slides.length, 6);
  assert.equal(f.latestReview.digest, hash(await readFile(join(scriptDirectory(f.run), 'slide-script.json'))));
  assert.ok(f.parentUpdates.some(update => update.phase === 'awaiting_human' && update.executionStatus === 'input_required'));
  const calls = f.calls.length; await f.decide('comment', 'Please explain page 2'); await f.step(); await f.step();
  assert.equal(f.latestReview.status, 'pending'); assert.equal(f.latestReview.resume, undefined); assert.equal(f.calls.length, calls);
  assert.equal(f.calls.filter(call => call.request.purpose === 'ppt_production').length, 0);
});

test('human changes return to the original author and only the approved new script reaches production', async t => {
  const f = await fixture(t); await f.untilHuman();
  const first = structuredClone(f.latestReview), originalPath = join(scriptDirectory(f.run), 'slide-script.json'), originalBytes = await readFile(originalPath);
  const author = structuredClone(f.run.currentChild!);
  await f.decide('changes_requested', 'Page 2: give the business context first'); await f.step();
  assert.equal(f.run.scriptRevision, 2); assert.equal(f.run.revision, 1); assert.equal(f.run.humanRevisionRounds, 1);
  assert.equal(f.run.metrics.qualityRevisions, 0); assert.equal(f.run.currentChild!.jobId, author.jobId);
  assert.notEqual(f.run.currentChild!.attemptId, author.attemptId); assert.equal(f.run.currentChild!.sessionId, author.sessionId);
  const continuation = f.calls.at(-1)!; assert.equal(continuation.previous?.attemptId, author.attemptId);
  assert.equal(continuation.request.targetId, 'script-author'); assert.equal(continuation.request.resultRevision, 'script-v2');
  assert.match(String(continuation.request.input.prompt), /Page 2: give the business context first/);
  assert.match(String(continuation.request.input.prompt), /coordinator\/script-v2/);
  assert.deepEqual(await readFile(originalPath), originalBytes);
  await f.writeScript(2); f.advanceTime(1000); await f.completeCurrent();
  assert.equal(f.run.phase, 'awaiting_human'); assert.equal(f.run.executionStatus, 'input_required');
  assert.equal(f.run.humanReviews!.length, 2); assert.equal(f.latestReview.revision, 'script-v2'); assert.notEqual(f.latestReview.digest, first.digest);
  assert.equal(f.latestReview.status, 'pending'); assert.equal(f.run.humanReviews![0]!.status, 'changes_requested');
  assert.throws(() => decideHumanReview(first, { action: 'approve', clientRequestId: 'old-link-approve', revision: first.revision, digest: first.digest },
    { id: 'local-owner', source: '1agents-web' }, { attemptId: f.run.attemptId, revision: scriptRevisionName(f.run), digest: f.run.scriptDigest! }), /replaced/);
  await f.step(); assert.equal(f.calls.filter(call => call.request.purpose === 'ppt_production').length, 0);
  await f.decide('approve'); await f.step();
  assert.equal(f.run.stage, 'make'); assert.equal(f.run.executionStatus, 'working'); assert.equal(f.latestReview.resume?.status, 'applied');
  const maker = f.calls.find(call => call.request.purpose === 'ppt_production')!;
  assert.ok(maker); const scriptPath = join(scriptDirectory(f.run), 'slide-script.json');
  const contract = JSON.parse(await readFile(join(f.run.jobDirectory, 'revision-1', 'production-contract.json'), 'utf8'));
  assert.equal(contract.scriptPath, scriptPath); assert.equal(contract.scriptSha256, f.latestReview.digest);
  assert.equal(contract.scriptSha256, hash(await readFile(scriptPath))); assert.notEqual(contract.scriptPath, originalPath);
  assert.ok((maker.request.input.preflight as { requiredFiles: string[] }).requiredFiles.includes(scriptPath));
  assert.equal(f.run.metrics.qualityRevisions, 0); assert.deepEqual(await readFile(originalPath), originalBytes);
});

test('human waiting beyond the execution budget does not consume model execution time', async t => {
  const f = await fixture(t); await f.untilHuman(); const elapsedBefore = f.run.metrics.elapsedMs;
  f.advanceTime(2 * 3600000); await f.step();
  assert.equal(f.run.executionStatus, 'input_required'); assert.equal(f.run.phase, 'awaiting_human'); assert.equal(f.run.metrics.elapsedMs, elapsedBefore);
  await f.decide('approve'); await f.step();
  assert.equal(f.run.stage, 'make'); assert.equal(f.run.executionStatus, 'working'); assert.ok(f.run.humanWaitingMs! >= 2 * 3600000);
  assert.ok(f.run.metrics.elapsedMs < f.run.policy.maxDurationMs); assert.equal(f.run.diagnostics.some(message => message.includes('预算耗尽')), false);
});

test('a decision persisted before restart resumes once with the same durable dispatch identity', async t => {
  const f = await fixture(t); await f.untilHuman(); await f.decide('approve');
  const decided = f.saved; f.restore(JSON.stringify(JSON.parse(decided))); await f.step();
  assert.equal(f.run.stage, 'make'); assert.equal(f.latestReview.history.length, 1); assert.equal(f.latestReview.resume?.status, 'applied');
  const checkpoints = f.snapshots.map(value => ({ serialized: value, run: JSON.parse(value) as PptDeliveryRun }));
  const beforeMaker = checkpoints.findLast(item => item.run.stage === 'make' && !item.run.currentChild && !item.run.pending && item.run.humanReviews!.at(-1)!.resume?.status === 'applied');
  assert.ok(beforeMaker); const maker = f.run.currentChild!;
  f.restore(beforeMaker.serialized); await f.step(); await f.step();
  assert.equal(f.run.currentChild!.jobId, maker.jobId); assert.equal(f.run.currentChild!.attemptId, maker.attemptId);
  const makerCalls = f.calls.filter(call => call.request.purpose === 'ppt_production'); assert.ok(makerCalls.length >= 2);
  assert.equal(new Set(makerCalls.map(call => call.request.clientRequestId)).size, 1);
  assert.equal([...f.accepted.values()].filter(child => child.targetId === 'ppt-maker').length, 1);
  assert.equal(f.latestReview.history.length, 1);
});

test('a persisted author revision intent survives restart without creating another content version', async t => {
  const f = await fixture(t); await f.untilHuman(); await f.decide('changes_requested', 'Rewrite page 4'); await f.step();
  const intent = f.snapshots.map(serialized => ({ serialized, run: JSON.parse(serialized) as PptDeliveryRun }))
    .findLast(item => item.run.summaryRevisionPending && !item.run.currentChild && item.run.humanReviews!.at(-1)!.resume?.status === 'applied');
  assert.ok(intent); const revised = f.run.currentChild!;
  f.restore(intent.serialized); await f.step();
  assert.equal(f.run.scriptRevision, 2); assert.equal(f.run.humanRevisionRounds, 1); assert.equal(f.run.currentChild!.attemptId, revised.attemptId);
  assert.equal(f.run.currentChild!.sessionId, 'project_script-session'); assert.equal(f.run.summaryRevisionPending, undefined);
  const revisionCalls = f.calls.filter(call => call.previous); assert.ok(revisionCalls.length >= 2);
  assert.equal(new Set(revisionCalls.map(call => call.request.clientRequestId)).size, 1); assert.equal(f.run.metrics.qualityRevisions, 0);
});

test('approved script byte drift is held for reconciliation and cannot start production', async t => {
  const f = await fixture(t); await f.untilHuman(); await f.decide('approve');
  const path = join(scriptDirectory(f.run), 'slide-script.json'), original = await readFile(path, 'utf8');
  await writeFile(path, original.replace('Version 1 content', 'Changed after approval'));
  await f.step(); assert.equal(f.run.stage, 'summary'); assert.equal(f.calls.filter(call => call.request.purpose === 'ppt_production').length, 0);
  assert.equal(f.latestReview.resume?.status, 'pending'); assert.ok(f.run.diagnostics.some(message => message.includes('Human continuation deferred')));
});

for (const slideCount of [8, 12]) {
  test(`a ${slideCount}-page script reaches human review with all ${slideCount} pages and production keeps N pages`, async t => {
    const f = await fixture(t, slideCount); await f.untilHuman();
    assert.equal(f.run.phase, 'awaiting_human'); assert.equal(f.latestReview.status, 'pending');
    assert.equal(f.latestReview.preview.slides.length, slideCount);
    assert.match(f.latestReview.title, new RegExp(`${slideCount}页文字稿`));
    await f.decide('approve'); await f.step();
    assert.equal(f.run.stage, 'make'); assert.equal(f.run.executionStatus, 'working');
    const contract = JSON.parse(await readFile(join(f.run.jobDirectory, 'revision-1', 'production-contract.json'), 'utf8'));
    assert.equal(contract.slideCount, slideCount); assert.equal(contract.artifacts.length, slideCount + 2);
    assert.ok(contract.artifacts.some((item: { path: string }) => item.path.endsWith(`slide-${slideCount}.png`)));
  });
}
