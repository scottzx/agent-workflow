import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { serveA2AGateway } from '../src/a2a/gateway.js';
import { projectApprovals } from '../src/execution/approvals-view.js';
import { workbenchCases } from '../src/execution/case-view.js';
import { createProcessRequest } from '../src/execution/process-request.js';
import { openTicket } from '../src/execution/ticket.js';
import { workbenchSnapshot, type WorkbenchSource } from '../src/execution/workbench.js';
import type { HumanReviewRequest } from '../src/execution/human-review.js';
import type { Handoff } from '../src/execution/handoff.js';
import type { LedgerState } from '../src/execution/ledger.js';
import type { Ticket } from '../src/execution/ticket.js';

const token = 'approvals-workbench-test-credential';
const relaySecret = 'page-relay-secret-for-approvals-tests-01';
const digest = 'a'.repeat(64);

function job(jobId: string, origin = 'owner', caseId = 'case-1') {
  return { sourceId: 'src', jobId, originSessionId: origin, accessScopeRef: origin, originKind: 'session' as const, originRef: origin,
    targetId: 'executor', currentAttemptId: `${jobId}-a`, executionStatus: 'working' as const, inFlightAttemptIds: [`${jobId}-a`],
    unresolvedAttemptIds: [], jobVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z', provenance: 'native' as const,
    ...(caseId ? { caseId } : {}) };
}

test('approvals view aggregates the four gates and the case inbox uses the same rows', () => {
  const owner = job('job-1');
  const other = job('job-hidden', 'other-origin');
  const ticket: Ticket = { schemaVersion: 1, roleId: 'demo-role', caseId: 'case-1', status: 'in_review', round: 2, items: [
    { id: 'P1', source: 'program', raisedInRound: 1, severity: 'must', where: 'S1', problem: '失败', state: 'open', log: [],
      crossCheck: { kind: 'self_vs_program', checkId: 'S1', claimedState: 'pass', actualVerdict: 'fail' } },
  ], proposals: [
    { id: 'R1-1', kind: 'locked', text: '不要改锁定结构', raisedInRound: 1, state: 'open' },
    { id: 'R1-2', kind: 'check', text: '把这条写成检查', raisedInRound: 1, state: 'open' },
    { id: 'R1-3', kind: 'role', text: '改提示词', raisedInRound: 1, state: 'open' },
    { id: 'R1-4', kind: 'locked', text: '已经处理', raisedInRound: 1, state: 'done' },
  ], history: [] };
  const hiddenTicket: Ticket = { ...ticket, proposals: [{ id: 'R9-1', kind: 'locked', text: '别的来源', raisedInRound: 1, state: 'open' }] };
  const handoff = { handoffId: 'h-1', caseId: 'case-1', fromJobId: 'job-1', fromAttemptId: 'job-1-a', toTargetId: 'maker', purpose: 'make',
    artifactRevision: 'rev-1', artifactDigest: digest, reason: '交给制作', status: 'proposed' as const, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' };
  const review = { reviewId: 'rev-1', jobId: 'job-1', status: 'pending', reviewerId: 'person', title: '文字稿', revision: 'rev-1', digest,
    createdAt: '2026-01-01T03:00:00.000Z', updatedAt: '2026-01-01T03:00:00.000Z', history: [] } as unknown as HumanReviewRequest;
  const foreignReview = { ...review, reviewId: 'rev-foreign', reviewerId: 'someone-else' } as HumanReviewRequest;
  const request = createProcessRequest({ jobId: 'job-1', attemptId: 'job-1-a', sessionId: 'session-1', kind: 'permission', toolTitle: 'bash' }, new Date('2026-01-01T01:00:00.000Z'), 60 * 60_000);
  const ledger = { version: 1 as const, sourceId: 'src', jobs: { 'job-1': owner, 'job-hidden': other }, attempts: {}, requests: {}, events: [],
    nextSequence: 1, acceptances: {}, tickets: { 'job-1': ticket, 'job-hidden': hiddenTicket }, handoffs: [handoff as Handoff] };
  const source: WorkbenchSource = { ledger: ledger as LedgerState, runs: [], reviews: [review, foreignReview], processRequests: [request],
    actorId: 'person', allowedOrigins: ['owner'], now: Date.parse('2026-01-01T01:30:00.000Z') };
  const view = projectApprovals(source);
  assert.deepEqual(view.counts, { process_request: 1, review: 1, handoff: 1, proposal: 2 });
  assert.equal(view.totalPending, 5);
  assert.equal(view.latestCreatedAt, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(view.items.map(item => item.kind), ['process_request', 'review', 'handoff', 'proposal', 'proposal']);
  assert.equal(view.items[0]?.processRequest?.toolTitle, 'bash');
  assert.equal(view.items[0]?.canDecide, true);
  assert.deepEqual(view.items.filter(item => item.kind === 'proposal').map(item => item.proposalKind), ['locked', 'check']);
  assert.equal(view.items.some(item => item.text === '改提示词' || item.text === '别的来源' || item.id === 'rev-foreign'), false);
  const summary = { ...view, items: undefined };
  assert.equal('items' in { totalPending: summary.totalPending, counts: summary.counts, latestCreatedAt: summary.latestCreatedAt }, false);

  const snapshot = workbenchSnapshot({ ...source, allowedOrigins: ['owner'] });
  const listed = snapshot.tasks.find(task => task.jobId === 'job-1');
  assert.equal(listed?.ticketSummary?.round, 2);
  assert.equal(listed?.ticketSummary?.mismatches, 1);
  assert.equal(listed?.ticketSummary?.openProposals, 3);
  const cases = workbenchCases(source, snapshot);
  const inbox = Object.values(cases.details)[0]?.inbox ?? [];
  assert.equal(inbox.some(item => item.kind === 'proposal' && item.proposalId === 'R1-1'), true);
  assert.equal(inbox.some(item => item.kind === 'proposal' && item.proposalKind === 'role'), false);
  assert.equal(inbox.filter(item => item.kind === 'review').length, 1);
});

async function gatewayFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-approvals-'));
  const project = join(root, 'project');
  const host = await serveA2AGateway({ stateDirectory: join(root, 'state'), port: 0, remotes: {}, pollIntervalMs: 60_000,
    workbench: { token, reviewerId: 'local-owner', reviewerName: '本机用户', pageRelaySecret: relaySecret, allowedOrigins: ['owner'], projectRoot: project } }, { report: false });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${host.port}`;
  const request = (path: string, init: RequestInit = {}, credential: string | null = token) => fetch(base + path, {
    ...init, headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(init.headers ?? {}) },
  });
  return { root, project, host, base, request, gateway: host.gateway };
}

test('GET /workbench/approvals summary omits rows and stays inside the allowed origins', async t => {
  const f = await gatewayFixture(t);
  const empty = await f.request('/workbench/approvals?summary=1');
  assert.equal(empty.status, 200);
  const summary = await empty.json() as { totalPending: number; items?: unknown; counts: Record<string, number> };
  assert.equal(summary.totalPending, 0);
  assert.equal(summary.items, undefined);
  assert.deepEqual(summary.counts, { process_request: 0, review: 0, handoff: 0, proposal: 0 });

  const prepared = f.gateway.ledger.prepare({ originSessionId: 'owner', title: '待批任务', caseId: 'case-1',
    targetSnapshot: { targetId: 'executor', provider: 'a2a', development: { channel: 'trial', phase: 'developing', agentId: 'draft-1', name: '试用' } },
    input: { prompt: '做完' } });
  f.gateway.ledger.markDispatching(prepared.attempt.attemptId);
  f.gateway.ledger.accept(prepared.attempt.attemptId, { taskId: 'task-1', sessionId: 'session-1' }, { executionStatus: 'working' });
  await f.gateway.openProcessRequest(prepared.job.jobId, { jobId: prepared.job.jobId, attemptId: prepared.attempt.attemptId, sessionId: 'session-1', kind: 'permission', toolTitle: 'bash' });
  const full = await (await f.request('/workbench/approvals')).json() as { totalPending: number; items: { kind: string; channel: string }[] };
  assert.equal(full.totalPending, 1);
  assert.equal(full.items[0]?.kind, 'process_request');
  assert.equal(full.items[0]?.channel, 'trial');
  assert.equal((await f.request('/workbench/approvals?filter=all')).status, 400);
});

test('task detail projects the ticket and a readable run-state, and ignores a symlink', async t => {
  const f = await gatewayFixture(t);
  const work = join(f.root, 'work');
  await mkdir(work);
  const nodes = [{ round: 1, nodeId: 'check_schema', status: 'completed', cached: true, inputDigest: 'abc' }];
  await writeFile(join(work, 'run-state.json'), JSON.stringify({ schemaVersion: 1, nodes }));
  const prepared = f.gateway.ledger.prepare({ originSessionId: 'owner', title: '带任务单', caseId: 'case-1',
    targetSnapshot: { targetId: 'executor', provider: 'a2a' }, input: { prompt: '交稿' } });
  f.gateway.ledger.changeTicket(prepared.job.originSessionId, prepared.job.jobId, () => {
    const opened = openTicket('demo-role', 'case-1', join(work, 'ticket.json'), { selfChecks: [{ id: 'S1', kind: 'self', severity: 'must', rule: '核对标题' }] });
    opened.ticket.selfChecks![0]!.state = 'pass';
    opened.ticket.selfChecks![0]!.note = '看过标题';
    opened.ticket.proposals.push({ id: 'R1-1', kind: 'locked', text: '不要改锁定结构', raisedInRound: 1, state: 'open' });
    opened.ticket.items.push({ id: 'P1', source: 'program', raisedInRound: 1, severity: 'must', where: 'S1', problem: '机检失败', state: 'open', log: [],
      crossCheck: { kind: 'self_vs_program', checkId: 'S1', claimedState: 'pass', claimedNote: '看过标题', actualVerdict: 'fail' } });
    return opened;
  });
  const detail = await (await f.request(`/workbench/tasks/${prepared.job.jobId}`)).json() as { ticket?: { proposals: { id: string }[] }; workflowRun?: { nodes: { nodeId: string; cached?: boolean }[] }; ticketSummary?: { selfCheckDone: number; selfCheckTotal: number; mismatches: number; openMust: number } };
  assert.equal(detail.ticket?.proposals[0]?.id, 'R1-1');
  assert.equal(detail.workflowRun?.nodes[0]?.nodeId, 'check_schema');
  assert.equal(detail.workflowRun?.nodes[0]?.cached, true);
  assert.equal(detail.ticketSummary?.selfCheckDone, 1);
  assert.equal(detail.ticketSummary?.selfCheckTotal, 1);
  assert.equal(detail.ticketSummary?.mismatches, 1);
  assert.equal(detail.ticketSummary?.openMust, 1);

  await rm(join(work, 'run-state.json'));
  await symlink(join(f.root, 'elsewhere.json'), join(work, 'run-state.json'));
  const again = await (await f.request(`/workbench/tasks/${prepared.job.jobId}`)).json() as { workflowRun?: unknown };
  assert.equal(again.workflowRun, undefined);
});

test('proposal writes are a person on the page and are refused to a bearer or an agent', async t => {
  const f = await gatewayFixture(t);
  const prepared = f.gateway.ledger.prepare({ originSessionId: 'owner', title: '提议任务', caseId: 'case-1',
    targetSnapshot: { targetId: 'executor', provider: 'a2a' }, input: { prompt: '交稿' } });
  f.gateway.ledger.changeTicket(prepared.job.originSessionId, prepared.job.jobId, () => {
    const opened = openTicket('demo-role', 'case-1');
    opened.ticket.proposals.push({ id: 'R1-1', kind: 'locked', text: '不要改锁定结构', raisedInRound: 1, state: 'open' });
    return opened;
  });
  const path = `/workbench/tasks/${prepared.job.jobId}/ticket/proposals/R1-1`;
  const body = JSON.stringify({ state: 'accepted', note: '页面采纳' });
  const bearer = await f.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(bearer.status, 403);
  assert.equal((await bearer.json() as { error: string }).error, 'page_action_required');
  assert.equal(f.gateway.ledger.ticket('owner', prepared.job.jobId).proposals[0]?.state, 'open');

  const login = await fetch(`${f.base}/workbench/ui/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: f.base }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const agent = await fetch(`${f.base}/workbench/ui/api/tasks/${prepared.job.jobId}/ticket/proposals/R1-1`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: f.base, Cookie: cookie, 'X-OneAgents-Origin': 'mcp' }, body });
  assert.equal(agent.status, 403);
  const forged = await fetch(`${f.base}/workbench/ui/api/tasks/${prepared.job.jobId}/ticket/proposals/R1-1`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: f.base, Cookie: cookie },
    body: JSON.stringify({ state: 'accepted', note: '冒充', by: { kind: 'coach', agent: 'x', sessionId: 'y' } }) });
  assert.equal(forged.status, 400);

  const page = await fetch(`${f.base}/workbench/ui/api/tasks/${prepared.job.jobId}/ticket/proposals/R1-1`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: f.base, Cookie: cookie }, body });
  assert.equal(page.status, 200);
  const saved = f.gateway.ledger.ticket('owner', prepared.job.jobId).proposals[0];
  assert.equal(saved?.state, 'accepted');
  assert.deepEqual(saved?.by, { kind: 'person', via: 'page' });
  assert.equal(saved?.note, '页面采纳');

  f.gateway.ledger.changeTicket('owner', prepared.job.jobId, current => {
    current!.proposals.push({ id: 'R1-2', kind: 'check', text: '补一条检查', raisedInRound: 1, state: 'open' });
    return { ticket: current!, changes: [] };
  });
  const relayed = await f.request(`/workbench/tasks/${prepared.job.jobId}/ticket/proposals/R1-2`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Page-Relay': relaySecret }, body: JSON.stringify({ state: 'rejected', note: '宿主转发拒绝' }) });
  assert.equal(relayed.status, 200);
  const second = f.gateway.ledger.ticket('owner', prepared.job.jobId).proposals.find(item => item.id === 'R1-2');
  assert.deepEqual(second?.by, { kind: 'person', via: 'relay' });
});

test('GET /workbench/roles/:roleId/rsi reads the role directory and rejects path escape', async t => {
  const f = await gatewayFixture(t);
  const role = join(f.project, '.1agents', 'roles', 'demo-role');
  await mkdir(join(role, 'cases'), { recursive: true });
  await mkdir(join(f.project, '.1agents', 'runtime', 'demo-role'), { recursive: true });
  await writeFile(join(role, 'profile.json'), JSON.stringify({ id: 'demo-role' }));
  await writeFile(join(role, 'checklist.json'), JSON.stringify({ items: [{ id: 'S1', kind: 'self', locked: true, severity: 'must', rule: '核对标题' }] }));
  await writeFile(join(role, 'workflow.json'), JSON.stringify({ nodes: [{ id: 'produce', type: 'executor_turn' }], policies: { trial: { maxProgramBounces: 1 }, formal: { maxProgramBounces: 2 } } }));
  await writeFile(join(f.project, '.1agents', 'runtime', 'demo-role', 'calibration.json'), JSON.stringify({
    schemaVersion: 1, roleId: 'demo-role', role: { dirty: true }, checksDigest: digest, calibratedAt: '2026-11-25T00:00:00.000Z',
    positiveSamples: 1, negativeSamples: 0, falsePositives: [], caughtHistoricalIssues: [], passed: true,
  }));
  const ok = await f.request('/workbench/roles/demo-role/rsi');
  assert.equal(ok.status, 200);
  const body = await ok.json() as { roleId: string; checklist: { items: { id: string; locked: boolean }[] }; workflow: { nodes: { id: string }[] }; calibration: { passed: boolean; calibratedAt: string } | null; version: { dirty: boolean }; gate: { ready?: boolean; error?: string } };
  assert.equal(body.roleId, 'demo-role');
  assert.equal(body.checklist.items[0]?.id, 'S1');
  assert.equal(body.checklist.items[0]?.locked, true);
  assert.equal(body.workflow.nodes[0]?.id, 'produce');
  assert.equal(body.calibration?.passed, true);
  assert.equal(body.calibration?.calibratedAt, '2026-11-25T00:00:00.000Z');
  assert.equal(body.version.dirty, true);
  assert.equal(body.gate.ready === true, false);

  assert.equal((await f.request('/workbench/roles/missing-role/rsi')).status, 404);
  assert.equal((await f.request('/workbench/roles/%2e%2e/rsi')).status, 404);
  assert.equal((await f.request('/workbench/roles/%2e%2e%2fetc/rsi')).status, 400);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(f.project, '.1agents', 'roles', 'escape'));
  assert.equal((await f.request('/workbench/roles/escape/rsi')).status, 404);
});
