import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentCard, Task } from '@a2a-js/sdk';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { REMOTE_AGENT_METHODS, serveA2AGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import { createHumanReview } from '../src/execution/human-review.js';
import { createPptDeliveryRun, scriptDirectory, type PptDeliveryRun } from '../src/execution/ppt-delivery.js';

const token = 'independent-workbench-test-credential';
const relaySecret = 'page-relay-secret-for-workbench-tests-0001';
const preview = { title: '待审核文字稿', slides: Array.from({ length: 6 }, (_, i) => ({
  title: `第 ${i + 1} 页`, message: '项目事实', body: ['完整文字内容'], visual: '流程示意',
  sources: ['README.md:1'], facts: ['基于项目文件'], notes: '',
})) };

async function fixture(t: TestContext, workbench = true) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-gateway-'));
  const config: A2AGatewayConfig = { stateDirectory: join(root, 'state'), port: 0, remotes: {}, pollIntervalMs: 60_000,
    ...(workbench ? { workbench: { token, reviewerId: 'local-owner', reviewerName: '本机用户', allowedOrigins: ['allowed-root'], pageRelaySecret: relaySecret } } : {}) };
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
  return { root, config, seed, request, get base() { return `http://127.0.0.1:${host.port}`; }, get gateway() { return host.gateway; }, get kicks() { return kicks; },
    restart: async () => { await host.close(); host = await serveA2AGateway(config, { report: false }); (host.gateway as any).advanceDelivery = async () => { kicks++; }; },
  };
}

const decisions = (jobId: string, reviewId: string) => `/workbench/tasks/${jobId}/reviews/${reviewId}/decisions`;
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/** A page request relayed by a host that serves the workbench page itself (DSH). */
const relayed = (body: unknown, secret = relaySecret): RequestInit => ({ ...post(body), headers: { 'Content-Type': 'application/json', 'X-Workbench-Page-Relay': secret } });

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
  assert.equal(detail.description, 'private-prompt-must-not-leak', 'the prompt is the task description'); assert.ok(!encoded.includes('private-input-must-not-leak'), 'other input fields stay private');
  assert.ok(!encoded.includes(token)); assert.ok(!encoded.includes(hidden.jobId));
  assert.equal((await f.request(`/workbench/tasks/${hidden.jobId}`)).status, 404);
  assert.equal((await f.request('/workbench/tasks?originSessionId=private-root')).status, 400);
  assert.deepEqual(f.gateway.ledger.snapshot(), before); assert.equal(f.kicks, 0);
});

test('human comments retain waiting state, use configured identity and replay durably once', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '评论任务'), path = decisions(item.jobId, item.review.reviewId);
  const first = await f.request(path, relayed(item.decision));
  assert.equal(first.status, 200);
  const detail = await first.json() as any, recorded = detail.reviews[0].history[0];
  assert.equal(detail.displayStatus, 'awaiting_human'); assert.equal(detail.reviews[0].status, 'pending');
  assert.deepEqual(recorded.actor, { id: 'local-owner', displayName: '本机用户', source: '1agents-web' });
  assert.equal(recorded.note, item.decision.note); assert.equal(f.kicks, 0);
  const replay = await f.request(path, relayed(item.decision));
  const replayed = await replay.json() as any;
  assert.equal(replayed.reviews[0].history.length, 1); assert.equal(replayed.reviews[0].history[0].decisionId, recorded.decisionId);
  const conflict = await f.request(path, relayed({ ...item.decision, note: '换了内容，不能沿用幂等标识。' }));
  assert.equal(conflict.status, 409); assert.equal((await conflict.json() as any).error, 'idempotency_conflict');
  await f.restart();
  const afterRestart = await f.request(path, relayed(item.decision));
  assert.equal(afterRestart.status, 200);
  const durable = await afterRestart.json() as any;
  assert.equal(durable.reviews[0].history.length, 1); assert.equal(durable.reviews[0].history[0].decisionId, recorded.decisionId);
});

test('workbench rejects client identity, wrong version, unauthorized reviewer and changed frozen bytes', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '版本任务'), path = decisions(item.jobId, item.review.reviewId);
  const identity = await f.request(path, relayed({ ...item.decision, actor: { id: 'forged-human', source: '1agents-web' } }));
  assert.equal(identity.status, 400);
  const wrong = await f.request(path, relayed({ ...item.decision, revision: 'script-v0' }));
  assert.equal(wrong.status, 409); assert.equal((await wrong.json() as any).error, 'version_conflict');
  item.run.humanReviews![0]!.reviewerId = 'another-person';
  const otherPerson = await f.request(path, relayed(item.decision));
  assert.equal(otherPerson.status, 403);
  item.run.humanReviews![0]!.reviewerId = 'local-owner';
  await writeFile(item.scriptPath, JSON.stringify({ ...preview, title: '被替换的内容' }));
  const changedBytes = await f.request(path, relayed(item.decision));
  assert.equal(changedBytes.status, 409); assert.equal((await changedBytes.json() as any).error, 'version_conflict');
  assert.equal(item.run.humanReviews![0]!.history.length, 0); assert.equal(f.kicks, 0);
});

test('old review cannot approve a new version and repeated approval records one durable intent', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '批准任务'), path = decisions(item.jobId, item.review.reviewId);
  const old = structuredClone(item.review);
  old.reviewId = 'old-review'; old.revision = 'script-v0'; old.status = 'superseded';
  item.run.humanReviews!.unshift(old);
  const stale = await f.request(decisions(item.jobId, old.reviewId), relayed({ ...item.decision, action: 'approve', revision: old.revision }));
  assert.equal(stale.status, 409);
  const approvedInput = { ...item.decision, action: 'approve', note: undefined };
  const approved = await f.request(path, relayed(approvedInput));
  assert.equal(approved.status, 200);
  const first = await approved.json() as any, current = first.reviews.find((r: any) => r.reviewId === item.review.reviewId);
  assert.equal(current.status, 'approved'); assert.equal(current.resume.status, 'pending'); assert.equal(current.history.length, 1);
  const again = await f.request(path, relayed(approvedInput));
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
  const response = await f.request(decisions(item.jobId, item.review.reviewId), relayed({ ...item.decision, action: 'cancel', note: undefined }));
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
  const decision = await f.request(decisions(item.jobId, item.review.reviewId), relayed(item.decision));
  assert.equal(decision.status, 200);
  const beforePublish = await (await f.request('/workbench/agents')).json() as any;
  assert.equal(beforePublish.published.length, 0);
  const published = await f.request(`/workbench/agents/${draft.draft.agentId}/publish`, relayed({ releaseName: '公众号-grok' }));
  assert.equal(published.status, 200);
  const release = await published.json() as any;
  assert.equal(release.release.releaseName, '公众号-grok');
  assert.equal(release.release.modeId, 'acceptEdits');
  assert.equal(release.developing.find((row: any) => row.agentId === draft.draft.agentId).targetId, undefined);
  assert.equal(release.published[0].agentId, 'release:公众号-grok');
  assert.equal(release.published[0].counterpartId, draft.draft.agentId);
  const again = await f.request(`/workbench/agents/${draft.draft.agentId}/publish`, relayed({ releaseName: '公众号-grok' }));
  assert.equal(again.status, 409);
  const missing = await f.request('/workbench/agents/agt-missing1/publish', relayed({ releaseName: '别的名字' }));
  assert.equal(missing.status, 404);
  const saved = JSON.parse(await readFile(join(f.config.stateDirectory, 'agent-registry.json'), 'utf8'));
  assert.equal(saved.releases.length, 1);
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.equal(JSON.stringify(release).includes(token), false);
});

test('only the page publishes and decides reviews; bearer callers need the page relay secret', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '只能人决定'), path = decisions(item.jobId, item.review.reviewId);
  const draft = await (await f.request('/workbench/agents', post({ name: '大纲草稿', acpAgent: 'grok-build', targetId: 'outline' }))).json() as any;
  const publish = `/workbench/agents/${draft.draft.agentId}/publish`;
  for (const init of [post(item.decision), relayed(item.decision, 'x'.repeat(relaySecret.length)), relayed(item.decision, 'short')]) {
    const refused = await f.request(path, init);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json() as any).error, 'page_action_required');
  }
  assert.equal((await f.request(publish, post({ releaseName: '大纲-grok' }))).status, 403);
  const untouched = await (await f.request(`/workbench/tasks/${item.jobId}`)).json() as any;
  assert.equal(untouched.reviews[0].history.length, 0);
  assert.equal((await (await f.request('/workbench/agents')).json() as any).published.length, 0);

  // A gateway without a relay secret accepts these two only from its own page.
  const secret = f.gateway.config.workbench!.pageRelaySecret;
  f.gateway.config.workbench!.pageRelaySecret = undefined;
  assert.equal((await f.request(path, relayed(item.decision))).status, 403);
  f.gateway.config.workbench!.pageRelaySecret = secret;
  assert.equal((await f.request(path, relayed(item.decision))).status, 200);
  assert.equal((await f.request(publish, relayed({ releaseName: '大纲-grok' }))).status, 200);

  // The gateway's own page needs no relay secret: its login and same-origin checks stand in for it.
  const other = await f.seed('allowed-root', '页面决定');
  const browser = (cookie?: string) => ({ 'Sec-Fetch-Site': 'same-origin', Origin: f.base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) });
  const login = await f.request('/workbench/ui/api/session', { method: 'POST', headers: browser(), body: JSON.stringify({ token }) }, null);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const onPage = await f.request(`/workbench/ui/api/tasks/${other.jobId}/reviews/${other.review.reviewId}/decisions`,
    { method: 'POST', headers: browser(cookie), body: JSON.stringify(other.decision) }, null);
  assert.equal(onPage.status, 200);
  assert.equal((await onPage.json() as any).reviews[0].history.length, 1);
});

test('workbench chat pages the stored A2A history newest-first inside the same scope as the task', async t => {
  const f = await fixture(t);
  const { jobId } = await f.seed('allowed-root', '对话任务'), hidden = await f.seed('private-root', '隐藏对话');
  const messages = Array.from({ length: 5 }, (_, i) => ({ messageId: `m${i}`, role: i % 2 ? 'ROLE_AGENT' : 'ROLE_USER', parts: [{ text: `message ${i}` }] }));
  (f.gateway as any).state.jobs.push({ remote: 'r', originSessionId: 'allowed-root', taskId: 'chat-task', contextId: 'c', cwd: '/x',
    checkedAt: new Date().toISOString(), ledgerJobId: jobId, attemptId: 'attempt-1',
    task: { id: 'chat-task', contextId: 'c', status: { state: 'TASK_STATE_WORKING', message: { messageId: 'm4', role: 'ROLE_USER', parts: [{ text: 'message 4' }] } }, history: messages } });
  const get = async (query: string) => (await f.request(`/workbench/tasks/${jobId}/chat${query}`)).json() as Promise<any>;

  const newest = await get('?limit=2'); assert.ok(newest.items, JSON.stringify(newest));
  assert.deepEqual(newest.items.map((item: any) => [item.kind, item.content]), [['assistant_text', 'message 3'], ['user', 'message 4']]);
  assert.equal(newest.hasMore, true);
  assert.equal(newest.total, 5, 'the status message repeats m4 and must not duplicate it');
  const older = await get(`?limit=2&before=${newest.nextCursor}`);
  assert.deepEqual(older.items.map((item: any) => item.content), ['message 1', 'message 2']);
  const oldest = await get(`?limit=5&before=${older.nextCursor}`);
  assert.deepEqual([oldest.items.length, oldest.hasMore, oldest.nextCursor], [1, false, undefined]);

  assert.equal((await f.request('/workbench/tasks/no-such-job/chat')).status, 404);
  assert.equal((await f.request(`/workbench/tasks/${hidden.jobId}/chat`)).status, 404, 'out-of-scope jobs expose no transcript');
  assert.equal((await f.request(`/workbench/tasks/${jobId}/chat?limit=0`)).status, 400);
  assert.equal((await f.request(`/workbench/tasks/${jobId}/chat`, {}, null)).status, 401);
  assert.equal((await f.request(`/workbench/tasks/${jobId}/chat`, { method: 'POST' })).status, 405);
});

test('a host that replaced a finished result asks the gateway to read that job again', async t => {
  const f = await fixture(t);
  const { jobId } = await f.seed('allowed-root', '接管任务'), hidden = await f.seed('private-root', '隐藏接管');
  const raw = (ledgerJobId: string, taskId: string) => ({ remote: 'r', originSessionId: 'allowed-root', taskId, contextId: 'c', cwd: '/x',
    checkedAt: new Date().toISOString(), ledgerJobId, attemptId: `${taskId}-attempt`, task: { id: taskId, contextId: 'c', status: { state: 'TASK_STATE_COMPLETED' } } });
  (f.gateway as any).state.jobs.push(raw(jobId, 'mine'), raw(hidden.jobId, 'theirs'), raw('other-job', 'unrelated'));
  const refreshed: string[] = [];
  (f.gateway as any).refresh = async (job: { taskId: string }) => { refreshed.push(job.taskId); };
  const ok = await f.request(`/workbench/tasks/${jobId}/refresh`, { method: 'POST' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as any).jobId, jobId);
  assert.deepEqual(refreshed, ['mine']);
  assert.equal((await f.request(`/workbench/tasks/${hidden.jobId}/refresh`, { method: 'POST' })).status, 404, 'out-of-scope jobs are not read');
  assert.equal((await f.request(`/workbench/tasks/${jobId}/refresh`, { method: 'POST' }, null)).status, 401);
  assert.equal((await f.request(`/workbench/tasks/${jobId}/refresh`)).status, 405);
  assert.deepEqual(refreshed, ['mine']);
});

test('workbench artifacts are read from the producing host and served only when the bytes match the receipt', async t => {
  const f = await fixture(t);
  const { jobId } = await f.seed('allowed-root', '产物任务'), hidden = await f.seed('private-root', '隐藏产物');
  const bytes = '# 产物\n', sha256 = createHash('sha256').update(bytes).digest('hex');
  let served = bytes; const asked: unknown[] = [];
  const remote = createServer((req, res) => { void (async () => {
    if (req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify(AgentCard.toJSON(AgentCard.fromJSON({ name: 'host', description: 'test', version: '1.0.0',
        supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] }))));
    }
    if (req.url !== '/a2a/artifacts/content' || req.headers.authorization !== 'Bearer host-token') { res.writeHead(404); return void res.end(); }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    asked.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(served);
  })(); });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>(resolve => { remote.closeAllConnections(); remote.close(() => resolve()); }));
  (f.gateway as any).config.remotes.host = { url: origin, token: 'host-token' };
  const artifacts = [{ path: '/work/.1agents/jobs/j/notes.md', size: Buffer.byteLength(bytes), sha256, mediaType: 'text/markdown' }];
  const raw = (ledgerJobId: string, taskId: string) => ({ remote: 'host', originSessionId: 'allowed-root', taskId, contextId: 'c', cwd: '/work',
    checkedAt: new Date().toISOString(), ledgerJobId, attemptId: `${taskId}-attempt`,
    task: { id: taskId, contextId: 'c', status: { state: 'TASK_STATE_COMPLETED' }, metadata: { '1agents': { result: { artifacts } } } } });
  (f.gateway as any).state.jobs.push(raw(jobId, 'artifact-task'), raw(hidden.jobId, 'hidden-task'));
  const path = (job: string, digest = sha256) => `/workbench/tasks/${job}/artifacts/${digest}`;

  const ok = await f.request(path(jobId));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), bytes);
  assert.equal(ok.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.match(ok.headers.get('content-security-policy') ?? '', /^sandbox;/);
  assert.match(ok.headers.get('content-disposition') ?? '', /notes\.md/);
  assert.deepEqual(asked, [{ taskId: 'artifact-task', path: artifacts[0]!.path, sha256 }], 'the host is asked for the receipt entry, not a caller path');

  assert.equal((await f.request(path(jobId, 'a'.repeat(64)))).status, 404);
  assert.equal((await f.request(path(hidden.jobId))).status, 404, 'out-of-scope tasks expose no artifact bytes');
  assert.equal((await f.request(path(jobId), {}, null)).status, 401);
  assert.equal((await f.request(path(jobId), { method: 'POST' })).status, 405);
  assert.equal((await f.request(`${path(jobId)}?x=1`)).status, 404);
  served = '# 被替换\n';
  const changed = await f.request(path(jobId));
  assert.equal(changed.status, 409, 'bytes that no longer match the receipt are refused');
  assert.equal((await changed.json() as any).error, 'artifact-digest-mismatch');
});
