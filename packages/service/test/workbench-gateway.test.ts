import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Task } from '@a2a-js/sdk';
import { REMOTE_AGENT_METHODS, serveA2AGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import { createHumanReview } from '../src/execution/human-review.js';
import { createPptDeliveryRun, scriptDirectory, type PptDeliveryRun } from '../src/execution/ppt-delivery.js';

const token = 'independent-workbench-test-credential';
const preview = { title: '待审核文字稿', slides: Array.from({ length: 6 }, (_, i) => ({
  title: `第 ${i + 1} 页`, message: '项目事实', body: ['完整文字内容'], visual: '流程示意',
  sources: ['README.md:1'], facts: ['基于项目文件'], notes: '',
})) };

async function fixture(t: TestContext, workbench = true) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-gateway-'));
  const config: A2AGatewayConfig = { stateDirectory: join(root, 'state'), port: 0, remotes: {}, pollIntervalMs: 60_000,
    ...(workbench ? { workbench: { token, reviewerId: 'local-owner', reviewerName: '本机用户', allowedOrigins: ['allowed-root'] } } : {}) };
  let host = await serveA2AGateway(config, { report: false });
  // The constructor's initial reconcile is empty; no background dispatch is
  // involved in this HTTP admission/identity fixture.
  await new Promise<void>(resolve => setImmediate(resolve));
  let kicks = 0;
  (host.gateway as any).advanceDelivery = async () => { kicks++; };
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });

  const seed = async (originSessionId: string, title: string) => {
    const gateway = host.gateway, internals = gateway as any;
    const parent = gateway.ledger.prepare({ originSessionId, title,
      targetSnapshot: { targetId: 'delivery', provider: 'resident_role', roleId: 'delivery' },
      input: { prompt: 'private-prompt-must-not-leak', internalInput: 'private-input-must-not-leak' } });
    gateway.ledger.markDispatching(parent.attempt.attemptId);
    gateway.ledger.accept(parent.attempt.attemptId, { provider: 'resident_role', runId: parent.attempt.attemptId },
      { executionStatus: 'input_required', phase: 'awaiting_human' });
    const author = gateway.ledger.prepare({ originSessionId, title: `${title}：文稿`,
      targetSnapshot: { targetId: 'author', provider: 'a2a', roleId: 'author' }, input: {},
      parentJobRef: { sourceId: gateway.ledger.sourceId, jobId: parent.job.jobId }, parentAttemptId: parent.attempt.attemptId,
      purpose: 'project_script', resultRevision: 'script-v1' });
    gateway.ledger.markDispatching(author.attempt.attemptId);
    gateway.ledger.accept(author.attempt.attemptId, { taskId: 'author-task', sessionId: 'author-session' }, { executionStatus: 'completed' });
    const run = await createPptDeliveryRun({ sourceId: gateway.ledger.sourceId, jobId: parent.job.jobId,
      attemptId: parent.attempt.attemptId, originSessionId, input: { projectDirectory: root, projectName: title },
      policy: { workspaceRoot: join(root, 'jobs'), publicDirectory: join(root, 'public'), publicBaseUrl: 'http://127.0.0.1:1/artifacts',
        allowedProjectRoots: [root], summaryTargetId: 'author', makerTargetId: 'maker', reviewTargetId: 'quality',
        runtimeDocument: join(root, 'RUNTIME.md'), designSkill: join(root, 'SKILL.md'), pythonExecutable: '/usr/bin/python3' } });
    run.executionStatus = 'input_required'; run.stage = 'summary'; run.phase = 'awaiting_human';
    run.children.push({ purpose: 'project_script', revision: 1, targetId: 'author', child: {
      jobId: author.job.jobId, attemptId: author.attempt.attemptId, executionStatus: 'completed', submissionStatus: 'accepted', sessionId: 'author-session',
    } });
    await mkdir(scriptDirectory(run), { recursive: true });
    const bytes = JSON.stringify(preview), scriptPath = join(scriptDirectory(run), 'slide-script.json');
    await writeFile(scriptPath, bytes);
    run.scriptDigest = createHash('sha256').update(bytes).digest('hex');
    run.humanWaitStartedAt = new Date(Date.now() - 60_000).toISOString();
    const review = createHumanReview({ jobId: run.jobId, attemptId: run.attemptId, stage: 'summary',
      authorJobId: author.job.jobId, authorAttemptId: author.attempt.attemptId, authorSessionId: 'author-session',
      title: `${title}：6页文字稿`, revision: 'script-v1', digest: run.scriptDigest, preview, reviewerId: 'local-owner' });
    run.humanReviews = [review];
    internals.state.pptDeliveries.runs[run.attemptId] = run; internals.save();
    return { jobId: run.jobId, authorJobId: author.job.jobId, run, review, scriptPath,
      decision: { action: 'comment', revision: review.revision, digest: review.digest, clientRequestId: 'request-1', note: '第 2 页请补充依据。' } };
  };
  const request = (path: string, init: RequestInit = {}, credential: string | null = token) => fetch(`http://127.0.0.1:${host.port}` + path, {
    ...init, headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(init.headers ?? {}) },
  });
  return { root, config, seed, request, get gateway() { return host.gateway; }, get kicks() { return kicks; },
    restart: async () => { await host.close(); host = await serveA2AGateway(config, { report: false }); (host.gateway as any).advanceDelivery = async () => { kicks++; }; },
  };
}

const decisions = (jobId: string, reviewId: string) => `/workbench/tasks/${jobId}/reviews/${reviewId}/decisions`;
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('workbench HTTP is disabled without configuration and requires its separate credential', async t => {
  const disabled = await fixture(t, false);
  assert.equal((await disabled.request('/workbench/tasks')).status, 503);
  const f = await fixture(t);
  assert.equal((await f.request('/workbench/tasks', {}, null)).status, 401);
  assert.equal((await f.request('/workbench/tasks', {}, 'agent-remote-token')).status, 401);
  assert.equal((await f.request('/workbench/tasks', { headers: { Origin: 'http://web.example' } })).status, 403);
  const response = await f.request('/workbench/tasks');
  assert.equal(response.status, 200); assert.deepEqual((await response.json() as any).items, []);
  assert.ok(!Object.keys(REMOTE_AGENT_METHODS).some(method => /workbench|human.*decision/.test(method)));
  const invoke = await f.request('/invoke', post({ method: 'decideWorkbenchReview', params: {} }), null);
  assert.equal(invoke.status, 400);
});

test('workbench list and detail are scoped pure projections without private execution input', async t => {
  const f = await fixture(t), allowed = await f.seed('allowed-root', '可见项目'), hidden = await f.seed('private-root', '隐藏项目');
  const before = f.gateway.ledger.snapshot();
  const list = await f.request('/workbench/tasks?filter=pending&limit=50&offset=0');
  assert.equal(list.status, 200);
  const listed = await list.json() as any;
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].jobId, allowed.jobId);
  assert.equal(listed.counts.pending, 1);
  const detailResponse = await f.request(`/workbench/tasks/${allowed.jobId}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as any;
  assert.equal(detail.displayStatus, 'awaiting_human'); assert.equal(detail.children[0].jobId, allowed.authorJobId);
  assert.equal(detail.children[0].executionStatus, 'completed'); assert.equal(detail.reviews[0].canReview, true);
  assert.equal(detail.progress.stages.find((s: any) => s.stage === 'make').planned, true);
  assert.ok(detail.progress.humanWaitingMs >= 60_000);
  const encoded = JSON.stringify(detail);
  assert.ok(!encoded.includes('private-prompt-must-not-leak')); assert.ok(!encoded.includes('private-input-must-not-leak'));
  assert.ok(!encoded.includes(token)); assert.ok(!encoded.includes(hidden.jobId));
  assert.equal((await f.request(`/workbench/tasks/${hidden.jobId}`)).status, 404);
  assert.equal((await f.request('/workbench/tasks?originSessionId=private-root')).status, 400);
  assert.deepEqual(f.gateway.ledger.snapshot(), before); assert.equal(f.kicks, 0);
});

test('human comments retain waiting state, use configured identity and replay durably once', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '评论任务'), path = decisions(item.jobId, item.review.reviewId);
  const first = await f.request(path, post(item.decision));
  assert.equal(first.status, 200);
  const detail = await first.json() as any, recorded = detail.reviews[0].history[0];
  assert.equal(detail.displayStatus, 'awaiting_human'); assert.equal(detail.reviews[0].status, 'pending');
  assert.deepEqual(recorded.actor, { id: 'local-owner', displayName: '本机用户', source: '1agents-web' });
  assert.equal(recorded.note, item.decision.note); assert.equal(f.kicks, 0);
  const replay = await f.request(path, post(item.decision));
  const replayed = await replay.json() as any;
  assert.equal(replayed.reviews[0].history.length, 1); assert.equal(replayed.reviews[0].history[0].decisionId, recorded.decisionId);
  const conflict = await f.request(path, post({ ...item.decision, note: '换了内容，不能沿用幂等标识。' }));
  assert.equal(conflict.status, 409); assert.equal((await conflict.json() as any).error, 'idempotency_conflict');
  await f.restart();
  const afterRestart = await f.request(path, post(item.decision));
  assert.equal(afterRestart.status, 200);
  const durable = await afterRestart.json() as any;
  assert.equal(durable.reviews[0].history.length, 1); assert.equal(durable.reviews[0].history[0].decisionId, recorded.decisionId);
});

test('workbench rejects client identity, wrong version, unauthorized reviewer and changed frozen bytes', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '版本任务'), path = decisions(item.jobId, item.review.reviewId);
  const identity = await f.request(path, post({ ...item.decision, actor: { id: 'forged-human', source: '1agents-web' } }));
  assert.equal(identity.status, 400);
  const wrong = await f.request(path, post({ ...item.decision, revision: 'script-v0' }));
  assert.equal(wrong.status, 409); assert.equal((await wrong.json() as any).error, 'version_conflict');
  item.run.humanReviews![0]!.reviewerId = 'another-person';
  const otherPerson = await f.request(path, post(item.decision));
  assert.equal(otherPerson.status, 403);
  item.run.humanReviews![0]!.reviewerId = 'local-owner';
  await writeFile(item.scriptPath, JSON.stringify({ ...preview, title: '被替换的内容' }));
  const changedBytes = await f.request(path, post(item.decision));
  assert.equal(changedBytes.status, 409); assert.equal((await changedBytes.json() as any).error, 'version_conflict');
  assert.equal(item.run.humanReviews![0]!.history.length, 0); assert.equal(f.kicks, 0);
});

test('old review cannot approve a new version and repeated approval records one durable intent', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '批准任务'), path = decisions(item.jobId, item.review.reviewId);
  const old = structuredClone(item.review);
  old.reviewId = 'old-review'; old.revision = 'script-v0'; old.status = 'superseded';
  item.run.humanReviews!.unshift(old);
  const stale = await f.request(decisions(item.jobId, old.reviewId), post({ ...item.decision, action: 'approve', revision: old.revision }));
  assert.equal(stale.status, 409);
  const approvedInput = { ...item.decision, action: 'approve', note: undefined };
  const approved = await f.request(path, post(approvedInput));
  assert.equal(approved.status, 200);
  const first = await approved.json() as any, current = first.reviews.find((r: any) => r.reviewId === item.review.reviewId);
  assert.equal(current.status, 'approved'); assert.equal(current.resume.status, 'pending'); assert.equal(current.history.length, 1);
  const again = await f.request(path, post(approvedInput));
  assert.equal(again.status, 200);
  const replayed = (await again.json() as any).reviews.find((r: any) => r.reviewId === item.review.reviewId);
  assert.equal(replayed.history.length, 1); assert.equal(replayed.history[0].decisionId, current.history[0].decisionId);
  const persisted = JSON.parse(await readFile(join(f.config.stateDirectory, 'gateway.json'), 'utf8'));
  const run: PptDeliveryRun = persisted.pptDeliveries.runs[item.run.attemptId];
  const review = run.humanReviews!.find(r => r.reviewId === item.review.reviewId)!;
  assert.equal(review.resume!.decisionId, current.history[0].decisionId); assert.equal(review.status, 'approved');
  assert.equal(run.children.filter(child => child.purpose === 'ppt_production').length, 0);
});

test('canceling a waiting task removes its actionable review and pending view entry', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '取消等待任务');
  await f.gateway.invoke('execution_cancel', { originSessionId: 'allowed-root', jobId: item.jobId });
  const response = await f.request(`/workbench/tasks/${item.jobId}`);
  assert.equal(response.status, 200);
  const detail = await response.json() as any;
  assert.equal(detail.executionStatus, 'canceled');
  assert.equal(detail.displayStatus, 'canceled');
  assert.ok(detail.reviews.every((review: any) => !review.canReview));
  const pending = await f.request('/workbench/tasks?filter=pending');
  assert.equal((await pending.json() as any).items.length, 0);
  const saved = JSON.parse(await readFile(join(f.config.stateDirectory, 'gateway.json'), 'utf8'));
  const canceledNotice = saved.executionNotices.find((notice: any) => notice.jobId === item.jobId && notice.executionStatus === 'canceled');
  assert.ok(canceledNotice);
  assert.match(canceledNotice.text, /任务已取消/);
  assert.doesNotMatch(canceledNotice.text, /文字稿待人工确认|打开文字稿审核/);
});

test('process requests register once, answer once, and expire instead of accepting a late submit', async t => {
  const f = await fixture(t);
  const prepared = f.gateway.ledger.prepare({ originSessionId: 'allowed-root', title: '分发任务', targetSnapshot: { targetId: 'legacy:host' }, input: { prompt: 'secret-prompt' } });
  f.gateway.ledger.markDispatching(prepared.attempt.attemptId);
  f.gateway.ledger.accept(prepared.attempt.attemptId, { taskId: 'task-1', sessionId: 'dsh-1' }, { executionStatus: 'working' });
  const jobId = prepared.job.jobId;
  const body = { requestId: 'prc-1', jobId, attemptId: prepared.attempt.attemptId, sessionId: 'dsh-1', kind: 'question',
    questions: [{ id: '0', question: 'Choose targets', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] };
  const path = `/workbench/tasks/${jobId}/process-requests`;
  assert.equal((await f.request(path, post(body), null)).status, 401);
  assert.equal((await f.request(path, { ...post(body), headers: { Origin: 'http://web.example', 'Content-Type': 'application/json' } })).status, 403);
  const hidden = f.gateway.ledger.prepare({ originSessionId: 'private-root', title: '隐藏', targetSnapshot: { targetId: 'legacy:host' }, input: {} });
  f.gateway.ledger.markDispatching(hidden.attempt.attemptId);
  f.gateway.ledger.accept(hidden.attempt.attemptId, { taskId: 'hidden-task', sessionId: 'hidden' }, { executionStatus: 'working' });
  assert.equal((await f.request(`/workbench/tasks/${hidden.job.jobId}/process-requests`, post({ ...body, jobId: hidden.job.jobId, attemptId: hidden.attempt.attemptId }))).status, 404);
  const opened = await f.request(path, post(body));
  assert.equal(opened.status, 200);
  const created = await opened.json() as any;
  assert.equal(created.requestId, 'prc-1'); assert.equal(created.status, 'pending');
  assert.equal((await (await f.request(path, post(body))).json() as any).deadlineAt, created.deadlineAt);
  assert.equal((await f.request(path, post({ ...body, questions: [{ id: '0', question: 'Other question' }] }))).status, 409);
  const pending = await (await f.request('/workbench/tasks?filter=pending')).json() as any;
  assert.equal(pending.items.some((item: any) => item.jobId === jobId && item.pendingProcessRequestId === 'prc-1'), true);
  assert.equal(JSON.stringify(pending).includes('secret-prompt'), false);
  assert.equal(JSON.stringify(pending).includes(token), false);
  const answer = { clientRequestId: 'wb-1', outcome: 'accepted', answers: { 'Choose targets': ['A', 'B'] } };
  const answered = await f.request(`${path}/prc-1/answers`, post(answer));
  assert.equal(answered.status, 200);
  const detail = await answered.json() as any;
  assert.equal(detail.executionStatus, 'working');
  assert.equal(detail.pendingProcessRequestId, undefined);
  assert.equal(detail.processRequests[0].status, 'answered');
  assert.equal(detail.processRequests[0].canAnswer, false);
  assert.deepEqual(detail.processRequests[0].answer.answers, answer.answers);
  const replay = await (await f.request(`${path}/prc-1/answers`, post(answer))).json() as any;
  assert.equal(replay.processRequests[0].answer.at, detail.processRequests[0].answer.at);
  assert.equal((await f.request(`${path}/prc-1/answers`, post({ ...answer, clientRequestId: 'wb-2' }))).status, 409);
  const second = { ...body, requestId: 'prc-2', kind: 'plan', questions: undefined, planContent: 'Read the project' };
  assert.equal((await f.request(path, post(second))).status, 200);
  const internals = f.gateway as any;
  const stored = internals.state.processRequests.find((item: any) => item.requestId === 'prc-2');
  stored.deadlineAt = new Date(Date.now() - 1000).toISOString();
  internals.save();
  const viewed = await f.request(`${path}/prc-2`);
  assert.equal(viewed.status, 200);
  const viewedBody = await viewed.json() as any;
  assert.equal(viewedBody.status, 'expired');
  assert.equal(viewedBody.canAnswer, false);
  const late = await f.request(`${path}/prc-2/answers`, post({ clientRequestId: 'wb-late', outcome: 'approved' }));
  assert.equal(late.status, 409); assert.equal((await late.json() as any).error, 'expired');
  assert.equal(internals.state.processRequests.find((item: any) => item.requestId === 'prc-2').status, 'expired');
  await f.restart();
  const durable = await (await f.request(`/workbench/tasks/${jobId}`)).json() as any;
  assert.equal(durable.processRequests.find((item: any) => item.requestId === 'prc-1').answer.clientRequestId, 'wb-1');
  assert.equal(durable.processRequests.find((item: any) => item.requestId === 'prc-2').status, 'expired');
});

test('the deadline follows the configured timeout and reject-and-stop cancels the task with the note', async t => {
  const f = await fixture(t);
  f.config.workbench!.requestTimeoutMinutes = 30;
  await f.restart();
  const prepared = f.gateway.ledger.prepare({ originSessionId: 'allowed-root', title: '分发任务', targetSnapshot: { targetId: 'legacy:host' }, input: {} });
  f.gateway.ledger.markDispatching(prepared.attempt.attemptId);
  f.gateway.ledger.accept(prepared.attempt.attemptId, { taskId: 'task-1', sessionId: 'dsh-1' }, { executionStatus: 'working' });
  const jobId = prepared.job.jobId, path = `/workbench/tasks/${jobId}/process-requests`;
  const before = Date.now();
  const created = await (await f.request(path, post({ requestId: 'prc-tool', jobId, attemptId: prepared.attempt.attemptId, sessionId: 'dsh-1',
    kind: 'permission', toolTitle: 'run_terminal_command', toolDetail: '{"command":"rm -rf build"}' }))).json() as any;
  const ttl = Date.parse(created.deadlineAt) - before;
  assert.ok(ttl >= 30 * 60_000 - 1000 && ttl <= 30 * 60_000 + 1000, `deadline ${ttl}ms`);
  const answered = await f.request(`${path}/prc-tool/answers`, post({ clientRequestId: 'wb-stop', outcome: 'rejected', note: '不要删除构建目录', stopTask: true }));
  assert.equal(answered.status, 200);
  const detail = await answered.json() as any;
  assert.equal(detail.processRequests[0].answer.note, '不要删除构建目录');
  assert.equal(detail.processRequests[0].answer.stopTask, true);
  const cancellation = (f.gateway as any).state.executionCancellations[prepared.attempt.attemptId];
  assert.match(cancellation.reason, /人工拒绝工具调用并停止任务（run_terminal_command）：不要删除构建目录/);
  // A replay records nothing new and does not cancel twice.
  assert.equal((await f.request(`${path}/prc-tool/answers`, post({ clientRequestId: 'wb-stop', outcome: 'rejected', note: '不要删除构建目录', stopTask: true }))).status, 200);
});

test('abandoning through human review closes further child dispatch admission', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '人工放弃任务'), internals = f.gateway as any;
  internals.advanceDelivery = Object.getPrototypeOf(f.gateway).advanceDelivery;
  const response = await f.request(decisions(item.jobId, item.review.reviewId), post({ ...item.decision, action: 'cancel', note: undefined }));
  assert.equal(response.status, 200);
  await internals.advancingDeliveries.get(item.run.attemptId);
  assert.equal(f.gateway.workbenchTask(item.jobId).executionStatus, 'canceled');
  // A fake local transport makes any erroneous admission observable without
  // calling a model, a real remote service, or a production target.
  f.gateway.config.remotes.fixture = { url: 'http://127.0.0.1:1', token: 'machine-fixture-credential' };
  f.gateway.targets.ensureLegacyRemotes();
  let sends = 0;
  internals.checkDispatch = async () => {};
  internals.client = async () => ({ sendMessage: async () => {
    sends++;
    return Task.fromJSON({ id: 'forbidden-late-child', contextId: 'fixture-context', status: { state: 'TASK_STATE_WORKING' } });
  } });
  await assert.rejects(f.gateway.invoke('execution_submit', { originSessionId: 'allowed-root', targetId: 'legacy:fixture',
    input: { cwd: f.root, prompt: 'Should never dispatch after abandonment' },
    parentJobRef: { sourceId: f.gateway.ledger.sourceId, jobId: item.jobId }, parentAttemptId: item.run.attemptId,
  }), /closing or closed/);
  assert.equal(sends, 0);
});

test('agent drafts publish by name and a review decision does not publish', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/workbench/agents', {}, null)).status, 401);
  assert.equal((await f.request('/workbench/agents', { headers: { Origin: 'http://web.example' } })).status, 403);
  assert.equal((await f.request('/workbench/agents?filter=all')).status, 400);
  assert.ok(!Object.keys(REMOTE_AGENT_METHODS).includes('createWorkbenchAgent'));
  const invoke = await f.request('/invoke', post({ method: 'createWorkbenchAgent', params: { name: 'x', acpAgent: 'grok-build' } }), null);
  assert.equal(invoke.status, 400);
  const created = await f.request('/workbench/agents', post({ name: '公众号草稿', acpAgent: 'grok-build', targetId: 'writer', modeId: 'bypassPermissions',
    options: [{ id: 'reasoningEffort', value: 'high' }, { id: 'model', value: 'grok-2' }] }));
  assert.equal(created.status, 200);
  const draft = await created.json() as any;
  assert.equal(draft.draft.options[0].id, 'model');
  assert.equal(draft.developing.length, 1);
  const codex = await (await f.request('/workbench/agents', post({ name: '审稿草稿', acpAgent: 'codex', modeId: 'write', options: [{ id: 'verbosity', value: 'low' }] }))).json() as any;
  assert.equal(codex.developing.length, 2);
  const duplicate = await f.request('/workbench/agents', post({ name: '公众号草稿', acpAgent: 'grok-build' }));
  assert.equal(duplicate.status, 409);
  const updated = await f.request(`/workbench/agents/${draft.draft.agentId}/settings`, post({ modeId: 'acceptEdits' }));
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json() as any;
  assert.equal(updatedBody.draft.modeId, 'acceptEdits');
  assert.equal(updatedBody.developing.find((row: any) => row.acpAgent === 'codex').modeId, 'write');
  const item = await f.seed('allowed-root', '审核不发布');
  const decision = await f.request(decisions(item.jobId, item.review.reviewId), post(item.decision));
  assert.equal(decision.status, 200);
  const beforePublish = await (await f.request('/workbench/agents')).json() as any;
  assert.equal(beforePublish.published.length, 0);
  const published = await f.request(`/workbench/agents/${draft.draft.agentId}/publish`, post({ releaseName: '公众号-grok' }));
  assert.equal(published.status, 200);
  const release = await published.json() as any;
  assert.equal(release.release.releaseName, '公众号-grok');
  assert.equal(release.release.modeId, 'acceptEdits');
  assert.equal(release.developing.find((row: any) => row.agentId === draft.draft.agentId).targetId, undefined);
  assert.equal(release.published[0].agentId, 'release:公众号-grok');
  assert.equal(release.published[0].counterpartId, draft.draft.agentId);
  const again = await f.request(`/workbench/agents/${draft.draft.agentId}/publish`, post({ releaseName: '公众号-grok' }));
  assert.equal(again.status, 409);
  const missing = await f.request('/workbench/agents/agt-missing1/publish', post({ releaseName: '别的名字' }));
  assert.equal(missing.status, 404);
  const saved = JSON.parse(await readFile(join(f.config.stateDirectory, 'agent-registry.json'), 'utf8'));
  assert.equal(saved.releases.length, 1);
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.equal(JSON.stringify(release).includes(token), false);
});
