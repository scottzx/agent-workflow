import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import {
  A2A_APPROVAL_MCP_SERVER_NAME,
  A2A_APPROVAL_MCP_TOOLS,
  createA2AApprovalMcpHandler,
} from '../src/a2a/approval-mcp.js';
import { serveA2AGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';

const DIGEST = 'a'.repeat(64);

async function setupGateway(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'approval-mcp-'));
  const config: A2AGatewayConfig = {
    stateDirectory: join(root, 'state'),
    port: 0,
    remotes: {},
    pollIntervalMs: 60_000,
    workbench: { token: 'test-wb-token', reviewerId: 'owner-1', reviewerName: 'Owner' },
  };
  const host = await serveA2AGateway(config, { report: false });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const gateway = host.gateway;

  // Seed a running job with a pending permission process request and an active ticket with an open proposal.
  const originA = 'session-origin-a';
  const running = gateway.ledger.prepare({
    originSessionId: originA,
    title: '子任务：构建审批服务',
    targetSnapshot: { targetId: 'host-a', provider: 'a2a' },
    input: { prompt: 'Run tests' },
  });
  gateway.ledger.markDispatching(running.attempt.attemptId);
  gateway.ledger.accept(running.attempt.attemptId, { taskId: 'task-a', sessionId: 'child-sess-a' }, { executionStatus: 'working' });
  const prc = await gateway.openProcessRequest(running.job.jobId, {
    requestId: 'prc-mcp-test-1',
    jobId: running.job.jobId,
    attemptId: running.attempt.attemptId,
    sessionId: 'child-sess-a',
    kind: 'permission',
    toolTitle: 'run_command',
    toolDetail: '{"command":"pnpm test"}',
  });

  await gateway.invoke('ticket_open', {
    originSessionId: originA,
    jobId: running.job.jobId,
    roleId: 'ppt-beautifier',
    caseId: 'case-1',
  });
  await gateway.invoke('ticket_checks', {
    originSessionId: originA,
    jobId: running.job.jobId,
    results: [{ itemId: 'schema', pass: true, evidence: [] }],
  });
  await gateway.invoke('ticket_review', {
    originSessionId: originA,
    jobId: running.job.jobId,
    review: {
      verdict: 'revise',
      summary: 'Need tighter copy',
      scores: { clarity: 3 },
      issues: [{ where: 'slide 2', problem: 'Too wordy', suggestion: 'Trim to 3 bullets', severity: 'must' }],
      proposals: [{ kind: 'role', text: 'Add brevity checklist to role instructions' }],
    },
  });

  // Seed a second origin with a completed job for execution_review testing.
  const originB = 'session-origin-b';
  const completed = gateway.ledger.prepare({
    originSessionId: originB,
    title: '子任务：交付报告',
    targetSnapshot: { targetId: 'host-b', provider: 'a2a' },
    input: { prompt: 'Write report' },
    resultRevision: 'rev-1',
  });
  gateway.ledger.markDispatching(completed.attempt.attemptId);
  gateway.ledger.accept(completed.attempt.attemptId, { taskId: 'task-b', sessionId: 'child-sess-b' }, { executionStatus: 'completed' });
  gateway.ledger.observe(completed.attempt.attemptId, {
    executionStatus: 'completed',
    resultAvailable: true,
    resultSummary: 'Report ready',
    resultRevision: 'rev-1',
    resultDigest: DIGEST,
    artifactLinks: [],
  });

  return {
    gatewayUrl: `http://127.0.0.1:${host.port}`,
    gateway,
    originA,
    originB,
    runningJobId: running.job.jobId,
    runningAttemptId: running.attempt.attemptId,
    requestId: prc.requestId,
    completedJobId: completed.job.jobId,
    completedAttemptId: completed.attempt.attemptId,
  };
}

test('MCP handler lists approval tools, dispatches/queries tasks, aggregates pending approvals, and executes coach-scoped approvals/tickets/reviews', async (t) => {
  const env = await setupGateway(t);
  const mcp = createA2AApprovalMcpHandler({ gatewayUrl: env.gatewayUrl, coachAgent: 'dsh-coach' });

  // Handshake & tool discovery
  const init = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal((init?.result as { serverInfo: { name: string } }).serverInfo.name, A2A_APPROVAL_MCP_SERVER_NAME);
  assert.equal(await mcp.handleJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  const ping = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(ping?.result, {});
  const list = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const tools = (list?.result as { tools: typeof A2A_APPROVAL_MCP_TOOLS }).tools;
  assert.equal(tools.length, 20);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.trim().length > 0);
  }

  // 0. Task target discovery, task list, task get, and dispatch validation
  const targets = await mcp.invokeTool('a2a_target_list', {});
  assert.ok(!targets.isError);
  assert.ok(Array.isArray((targets.structuredContent as { targets: unknown[] }).targets));

  const listed = await mcp.invokeTool('a2a_task_list', { originSessionId: env.originA });
  assert.ok(!listed.isError);
  assert.equal((listed.structuredContent as { total: number }).total, 1);

  const got = await mcp.invokeTool('a2a_task_get', { originSessionId: env.originA, jobId: env.runningJobId });
  assert.ok(!got.isError);
  assert.equal((got.structuredContent as { jobId: string }).jobId, env.runningJobId);

  const badDispatchBoth = await mcp.invokeTool('a2a_task_dispatch', {
    originSessionId: env.originA,
    targetId: 'host-a',
    remote: 'scott-mac-dsh',
    cwd: '/tmp',
    prompt: 'ambiguous',
  });
  assert.equal(badDispatchBoth.isError, true);
  assert.match(badDispatchBoth.content[0]?.text ?? '', /either targetId.*or remote/i);

  const badDispatchNoCwd = await mcp.invokeTool('a2a_task_dispatch', {
    originSessionId: env.originA,
    remote: 'scott-mac-dsh',
    prompt: 'missing cwd',
  });
  assert.equal(badDispatchNoCwd.isError, true);
  assert.match(badDispatchNoCwd.content[0]?.text ?? '', /cwd is required/i);

  // 1. Cross-task pending approvals (unfiltered and filtered)
  const pendingAll = await mcp.invokeTool('a2a_pending_approvals', {});
  assert.ok(!pendingAll.isError);
  const allData = pendingAll.structuredContent as {
    counts: { pendingProcessRequests: number; openTicketProposals: number; activeTickets: number };
    processRequests: { requestId: string; canAnswer: boolean; originSessionId: string }[];
    ticketProposals: { id: string; state: string; jobId: string }[];
    openTickets: { jobId: string; pendingItemCount: number; openProposalCount: number }[];
  };
  assert.deepEqual(allData.counts, { pendingProcessRequests: 1, openTicketProposals: 1, activeTickets: 1 });
  assert.equal(allData.processRequests[0]?.requestId, env.requestId);
  assert.equal(allData.processRequests[0]?.canAnswer, true);
  assert.equal(allData.ticketProposals[0]?.id, 'R1-1');
  assert.equal(allData.openTickets[0]?.pendingItemCount, 1);

  const pendingOther = await mcp.invokeTool('a2a_pending_approvals', { originSessionId: env.originB });
  assert.equal((pendingOther.structuredContent as { counts: { pendingProcessRequests: number } }).counts.pendingProcessRequests, 0);

  // 2. Process requests query & approval (auto clientRequestId + forced coach actor)
  const reqs = await mcp.invokeTool('a2a_process_requests', { originSessionId: env.originA, jobId: env.runningJobId });
  assert.ok(!reqs.isError);
  assert.equal((reqs.structuredContent as { requests: unknown[] }).requests.length, 1);

  const answered = await mcp.invokeTool('a2a_process_answer', {
    originSessionId: env.originA,
    jobId: env.runningJobId,
    requestId: env.requestId,
    outcome: 'approved',
    note: 'Safe test command within task scope',
  });
  assert.ok(!answered.isError, answered.content[0]?.text);
  const answeredRecord = answered.structuredContent as { status: string; answer: { outcome: string; clientRequestId: string; decidedBy: { kind: string; agent: string; sessionId: string } } };
  assert.equal(answeredRecord.status, 'answered');
  assert.equal(answeredRecord.answer.outcome, 'approved');
  assert.match(answeredRecord.answer.clientRequestId, /^mcp:/);
  assert.deepEqual(answeredRecord.answer.decidedBy, { kind: 'coach', agent: 'dsh-coach', sessionId: env.originA });

  // After approval, pending process requests drops to 0 unless includeResolved=true.
  const pendingAfter = await mcp.invokeTool('a2a_pending_approvals', { originSessionId: env.originA });
  assert.equal((pendingAfter.structuredContent as { counts: { pendingProcessRequests: number } }).counts.pendingProcessRequests, 0);
  const withResolved = await mcp.invokeTool('a2a_pending_approvals', { originSessionId: env.originA, includeResolved: true });
  assert.equal((withResolved.structuredContent as { processRequests: unknown[] }).processRequests.length, 1);

  // 3. Ticket read & proposal settle (forced coach actor)
  const ticket = await mcp.invokeTool('a2a_ticket_get', { originSessionId: env.originA, jobId: env.runningJobId });
  assert.ok(!ticket.isError);
  assert.equal((ticket.structuredContent as { roleId: string }).roleId, 'ppt-beautifier');

  const decided = await mcp.invokeTool('a2a_ticket_proposal_decide', {
    originSessionId: env.originA,
    jobId: env.runningJobId,
    proposalId: 'R1-1',
    state: 'accepted',
    note: 'Adopt in next role revision',
    coachAgent: 'antigravity',
    coachSessionId: 'coach-sess-99',
  });
  assert.ok(!decided.isError, decided.content[0]?.text);
  const proposal = (decided.structuredContent as { proposals: { id: string; state: string; by: { kind: string; agent: string; sessionId: string } }[] }).proposals[0]!;
  assert.equal(proposal.state, 'accepted');
  assert.deepEqual(proposal.by, { kind: 'coach', agent: 'antigravity', sessionId: 'coach-sess-99' });

  // 4. Coach-level execution review
  const reviewed = await mcp.invokeTool('a2a_execution_review', {
    originSessionId: env.originB,
    jobId: env.completedJobId,
    attemptId: env.completedAttemptId,
    resultRevision: 'rev-1',
    resultDigest: DIGEST,
    reviewStatus: 'accepted',
    note: 'Digest verified',
  });
  assert.ok(!reviewed.isError, reviewed.content[0]?.text);
  const reviewRecord = reviewed.structuredContent as { reviewStatus: string; decidedBy: { kind: string; agent: string; sessionId: string } };
  assert.equal(reviewRecord.reviewStatus, 'accepted');
  assert.deepEqual(reviewRecord.decidedBy, { kind: 'coach', agent: 'dsh-coach', sessionId: env.originB });

  // 5. Rejects unknown fields (including attempting to pass decidedBy: person)
  const forged = await mcp.invokeTool('a2a_process_answer', {
    originSessionId: env.originA,
    jobId: env.runningJobId,
    requestId: env.requestId,
    outcome: 'approved',
    decidedBy: { kind: 'person' },
  });
  assert.equal(forged.isError, true);
  assert.match(forged.content[0]?.text ?? '', /Unrecognized key|decidedBy/i);

  // 6. Unknown tool returns JSON-RPC -32602
  const unknown = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  assert.equal(unknown?.error?.code, -32602);
});

test('acp-service mcp stdio subprocess speaks clean newline-delimited JSON-RPC over stdin/stdout', async (t) => {
  const env = await setupGateway(t);
  const binPath = resolve(import.meta.dirname, '../bin/acp-service.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', binPath, 'mcp', '--url', env.gatewayUrl, '--agent', 'stdio-test'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });

  const rl = createInterface({ input: child.stdout });
  const responses: Record<string, unknown>[] = [];
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>();
  rl.on('line', line => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    responses.push(parsed);
    const id = parsed.id as number | undefined;
    if (id !== undefined && waiters.has(id)) {
      waiters.get(id)!(parsed);
      waiters.delete(id);
    }
  });

  const rpc = (id: number, method: string, params?: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolveMsg, rejectMsg) => {
    const timer = setTimeout(() => rejectMsg(new Error(`Timed out waiting for RPC #${id} (${method})`)), 10_000);
    waiters.set(id, msg => { clearTimeout(timer); resolveMsg(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
  });

  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.1' } });
  assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, A2A_APPROVAL_MCP_SERVER_NAME);

  const list = await rpc(2, 'tools/list');
  assert.equal((list.result as { tools: unknown[] }).tools.length, 20);

  const pending = await rpc(3, 'tools/call', { name: 'a2a_pending_approvals', arguments: {} });
  const result = pending.result as { isError?: boolean; structuredContent: { counts: { pendingProcessRequests: number } } };
  assert.ok(!result.isError);
  assert.equal(result.structuredContent.counts.pendingProcessRequests, 1);

  child.stdin.end();
  const exitCode = await new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)));
  assert.equal(exitCode, 0);
});

test('a2a_task_dispatch, continue, cancel, bind and ack forward coach-stamped payloads without direct HTTP calls from caller', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: Record<string, unknown> };
    calls.push(body);
    if (body.method === 'remote_agent_ack' && body.params.noticeId === 'exec-notice-1') {
      return new Response(JSON.stringify({ error: 'Notice not found for this origin session' }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, echoedMethod: body.method, jobId: 'job-echo-1' }), { status: 200 });
  };

  const mcp = createA2AApprovalMcpHandler({ gatewayUrl: 'http://127.0.0.1:36814', coachAgent: 'dsh', fetch: fakeFetch });

  // 1. Dispatch via remote (remote_agent_spawn)
  const r1 = await mcp.invokeTool('a2a_task_dispatch', {
    originSessionId: 'sess-1',
    remote: 'scott-mac-dsh',
    cwd: '/tmp/work',
    agentPreset: 'standard',
    title: 'Spawn via MCP',
    prompt: 'Run check',
  });
  assert.ok(!r1.isError, r1.content[0]?.text);
  assert.equal(calls[0]?.method, 'remote_agent_spawn');
  assert.match(String(calls[0]?.params.clientRequestId), /^mcp:/);
  assert.deepEqual(calls[0]?.params.initiatedBy, { kind: 'coach', agent: 'dsh', sessionId: 'sess-1' });

  // 2. Dispatch via targetId (execution_submit) with top-level prompt shortcut
  const r2 = await mcp.invokeTool('a2a_task_dispatch', {
    originSessionId: 'sess-1',
    targetId: 'ppt-beautifier',
    title: 'Submit via MCP',
    prompt: 'Beautify slides',
    caseId: 'case-9',
    coachAgent: 'antigravity',
    coachSessionId: 'coach-9',
  });
  assert.ok(!r2.isError, r2.content[0]?.text);
  assert.equal(calls[1]?.method, 'execution_submit');
  assert.deepEqual(calls[1]?.params.input, { prompt: 'Beautify slides' });
  assert.equal(calls[1]?.params.caseId, 'case-9');
  assert.deepEqual(calls[1]?.params.initiatedBy, { kind: 'coach', agent: 'antigravity', sessionId: 'coach-9' });

  // 3. Session bind, task continue, task cancel
  assert.ok(!(await mcp.invokeTool('a2a_session_bind', { originSessionId: 'sess-1', host: 'dsh-local', sessionId: 'sess-1' })).isError);
  assert.equal(calls[2]?.method, 'session_bind');

  assert.ok(!(await mcp.invokeTool('a2a_task_continue', { originSessionId: 'sess-1', jobId: 'job-1', prompt: 'Follow up' })).isError);
  assert.equal(calls[3]?.method, 'execution_continue');
  assert.deepEqual(calls[3]?.params.input, { prompt: 'Follow up' });
  assert.deepEqual(calls[3]?.params.initiatedBy, { kind: 'coach', agent: 'dsh', sessionId: 'sess-1' });

  assert.ok(!(await mcp.invokeTool('a2a_task_cancel', { originSessionId: 'sess-1', jobId: 'job-1', cascade: true })).isError);
  assert.equal(calls[4]?.method, 'execution_cancel');
  assert.equal(calls[4]?.params.cascade, true);

  // 4. Notice ack auto-fallback from remote_agent_ack to execution_ack
  const ackRes = await mcp.invokeTool('a2a_notice_ack', { originSessionId: 'sess-1', noticeId: 'exec-notice-1' });
  assert.ok(!ackRes.isError, ackRes.content[0]?.text);
  assert.equal(calls[5]?.method, 'remote_agent_ack');
  assert.equal(calls[6]?.method, 'execution_ack');
});

test('approval MCP fills the default origin, binds it idempotently, and lets an explicit id override it', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: Record<string, unknown> };
    calls.push(body);
    if (body.method === 'session_bind' && body.params.sessionId === 'already-taken') {
      return new Response(JSON.stringify({ error: 'Origin session is already bound to a different host or session' }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, echoedMethod: body.method }), { status: 200 });
  };
  const mcp = createA2AApprovalMcpHandler({
    gatewayUrl: 'http://127.0.0.1:36814',
    defaultOriginSessionId: 'origin-default',
    defaultSessionHost: 'dsh-local',
    defaultHostSessionId: 'host-sess',
    autoBindDefaultSession: true,
    fetch: fakeFetch,
  });
  const identity = await mcp.invokeTool('a2a_session_identity', {});
  assert.equal(identity.isError, undefined);
  assert.deepEqual(identity.structuredContent, {
    configured: true, originSessionId: 'origin-default', host: 'dsh-local', sessionId: 'host-sess', autoBindDefaultSession: true,
  });
  assert.equal(JSON.stringify(identity).includes('token'), false);
  assert.equal(calls.length, 0);

  const dispatched = await mcp.invokeTool('a2a_task_dispatch', {
    targetId: 'role-a', prompt: 'use the default origin',
    notifySessions: [{ role: 'downstream', target: { host: 'dsh-local', sessionId: 'down-1' } }],
  });
  assert.equal(dispatched.isError, undefined, dispatched.content[0]?.text);
  assert.equal(calls[0]?.method, 'session_bind');
  assert.deepEqual(calls[0]?.params, { originSessionId: 'origin-default', host: 'dsh-local', sessionId: 'host-sess' });
  assert.equal(calls[1]?.method, 'execution_submit');
  assert.equal(calls[1]?.params.originSessionId, 'origin-default');
  assert.deepEqual(calls[1]?.params.notifySessions, [{ role: 'downstream', target: { host: 'dsh-local', sessionId: 'down-1' } }]);

  const explicit = await mcp.invokeTool('a2a_task_dispatch', { originSessionId: 'explicit-origin', targetId: 'role-a', prompt: 'override' });
  assert.equal(explicit.isError, undefined, explicit.content[0]?.text);
  assert.equal(calls[2]?.method, 'execution_submit');
  assert.equal(calls[2]?.params.originSessionId, 'explicit-origin');

  const overridden = await mcp.invokeTool('a2a_session_bind', { host: 'codex-local', sessionId: 'thread-1' });
  assert.equal(overridden.isError, undefined, overridden.content[0]?.text);
  assert.deepEqual(calls[3]?.params, { originSessionId: 'origin-default', host: 'codex-local', sessionId: 'thread-1' });

  const binding = await mcp.invokeTool('a2a_session_binding_get', {});
  assert.equal(binding.isError, undefined, binding.content[0]?.text);
  assert.deepEqual(calls[4]?.params, { originSessionId: 'origin-default' });

  const conflict = createA2AApprovalMcpHandler({
    gatewayUrl: 'http://127.0.0.1:36814',
    defaultOriginSessionId: 'origin-default',
    defaultSessionHost: 'dsh-local',
    defaultHostSessionId: 'already-taken',
    fetch: fakeFetch,
  });
  const stillDispatched = await conflict.invokeTool('a2a_task_dispatch', { targetId: 'role-a', prompt: 'keep going' });
  assert.equal(stillDispatched.isError, undefined, stillDispatched.content[0]?.text);
  assert.equal(calls.at(-2)?.method, 'session_bind');
  assert.equal(calls.at(-1)?.method, 'execution_submit');
  assert.equal(calls.at(-1)?.params.originSessionId, 'origin-default');

  const bare = createA2AApprovalMcpHandler({ gatewayUrl: 'http://127.0.0.1:36814', fetch: fakeFetch, autoBindDefaultSession: false });
  const missing = await bare.invokeTool('a2a_task_get', { jobId: 'job-1' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]?.text ?? '', /A2A_DEFAULT_ORIGIN_SESSION_ID/);

  const fallback = createA2AApprovalMcpHandler({
    gatewayUrl: 'http://127.0.0.1:36814', defaultOriginSessionId: 'origin-only', fetch: fakeFetch,
  });
  const fallbackIdentity = await fallback.invokeTool('a2a_session_identity', {});
  assert.equal((fallbackIdentity.structuredContent as { sessionId?: string }).sessionId, 'origin-only');
  assert.equal((fallbackIdentity.structuredContent as { configured: boolean }).configured, true);
});

test('a2a_task_dispatch forwards deliveryMode to execution_submit and remote_agent_spawn', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: Record<string, unknown> };
    calls.push(body);
    return new Response(JSON.stringify({ ok: true, jobId: 'job-mode' }), { status: 200 });
  };
  const mcp = createA2AApprovalMcpHandler({ gatewayUrl: 'http://127.0.0.1:36814', fetch: fakeFetch });
  const submitted = await mcp.invokeTool('a2a_task_dispatch', {
    originSessionId: 'sess-1', targetId: 'role-a', prompt: 'edit in place', deliveryMode: 'workspace_git',
  });
  assert.equal(submitted.isError, undefined, submitted.content[0]?.text);
  assert.equal(calls[0]?.method, 'execution_submit');
  assert.equal((calls[0]?.params.input as { deliveryMode?: string }).deliveryMode, 'workspace_git');
  const spawned = await mcp.invokeTool('a2a_task_dispatch', {
    originSessionId: 'sess-1', remote: 'scott-mac-dsh', cwd: '/tmp/work', prompt: 'read only', deliveryMode: 'none',
  });
  assert.equal(spawned.isError, undefined, spawned.content[0]?.text);
  assert.equal(calls[1]?.method, 'remote_agent_spawn');
  assert.equal(calls[1]?.params.deliveryMode, 'none');
  const continued = await mcp.invokeTool('a2a_task_continue', {
    originSessionId: 'sess-1', jobId: 'job-mode', prompt: 'keep going', deliveryMode: 'workspace_files',
  });
  assert.equal(continued.isError, undefined, continued.content[0]?.text);
  assert.equal(calls[2]?.method, 'execution_continue');
  assert.equal(calls[2]?.params.deliveryMode, 'workspace_files');
  assert.equal((calls[2]?.params.input as { deliveryMode?: string }).deliveryMode, 'workspace_files');
  const rejected = await mcp.invokeTool('a2a_task_dispatch', {
    originSessionId: 'sess-1', targetId: 'role-a', prompt: 'bad', deliveryMode: 'sideways',
  });
  assert.equal(rejected.isError, true);
});

test('mcp cli help documents the default origin session', async () => {
  const { spawn } = await import('node:child_process');
  const binPath = resolve(import.meta.dirname, '../bin/acp-service.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', binPath, 'mcp', '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  assert.equal(code, 0, out);
  assert.match(out, /A2A_DEFAULT_ORIGIN_SESSION_ID/);
  assert.match(out, /--origin-session/);
  assert.match(out, /--session-host/);
  assert.match(out, /--host-session/);
  assert.match(out, /--no-auto-bind/);
  assert.match(out, /--project-root/);
  assert.match(out, /A2A_PROJECT_ROOT/);
  assert.match(out, /a2a_role_rules_get/);
});

const repoRoot = resolve(import.meta.dirname, '../../..');

test('a2a_role_rules_get is listed, hot-loads from disk, and refuses a projectRoot outside the pinned root', async t => {
  let fetched = 0;
  const fetchImpl: typeof globalThis.fetch = async () => {
    fetched += 1;
    throw new Error('gateway should not be called');
  };
  const pinned = createA2AApprovalMcpHandler({ projectRoot: repoRoot, fetch: fetchImpl });
  const list = await pinned.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = (list?.result as { tools: { name: string; inputSchema: { required?: string[]; additionalProperties?: boolean; properties?: { phase?: { enum?: string[] } } } }[] }).tools;
  const spec = tools.find(tool => tool.name === 'a2a_role_rules_get');
  assert.ok(spec);
  assert.equal(spec.inputSchema.additionalProperties, false);
  assert.deepEqual([...(spec.inputSchema.required ?? [])].sort(), ['roleId']);
  assert.deepEqual(spec.inputSchema.properties?.phase?.enum, ['all', 'implement', 'review', 'gate', 'coach']);

  const loaded = await pinned.invokeTool('a2a_role_rules_get', { roleId: 'pr-delivery', phase: 'implement', projectRoot: join(repoRoot, 'packages/service') });
  assert.equal(loaded.isError, undefined, loaded.content[0]?.text);
  const implement = loaded.structuredContent as { phase: string; roleInstructions?: string; qaInstructions?: string; digest: string; files: string[] };
  assert.equal(implement.phase, 'implement');
  assert.match(implement.roleInstructions ?? '', /PR 交付 Worker/);
  assert.equal(implement.qaInstructions, undefined);
  assert.equal(implement.files.includes('QA.md'), false);
  assert.equal(fetched, 0);

  const outside = await realpath(await mkdtemp(join(tmpdir(), 'role-rules-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(outside, '.1agents/roles/pr-delivery'), { recursive: true });
  await writeFile(join(outside, '.1agents/roles/pr-delivery/ROLE.md'), 'OUTSIDE-SECRET\n');
  await writeFile(join(outside, '.1agents/roles/pr-delivery/profile.json'), JSON.stringify({
    id: 'pr-delivery', version: '9.9.9', skills: [{ key: 'only', name: 'only-skill' }],
  }));
  const rejected = await pinned.invokeTool('a2a_role_rules_get', { roleId: 'pr-delivery', projectRoot: outside });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0]?.text ?? '', /outside the allowed project|does not exist/);
  assert.equal((rejected.content[0]?.text ?? '').includes('OUTSIDE-SECRET'), false);
  assert.equal(fetched, 0);

  const unsafe = await pinned.invokeTool('a2a_role_rules_get', { roleId: '../pr-delivery' });
  assert.equal(unsafe.isError, true);
  assert.match(unsafe.content[0]?.text ?? '', /Unsafe roleId/);

  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'role-rules-hot-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const role = join(scratch, '.1agents/roles/pr-delivery');
  await mkdir(role, { recursive: true });
  await writeFile(join(role, 'profile.json'), await readFile(join(repoRoot, '.1agents/roles/pr-delivery/profile.json')));
  await writeFile(join(role, 'ROLE.md'), 'before\n');
  const previous = process.env.A2A_PROJECT_ROOT;
  process.env.A2A_PROJECT_ROOT = scratch;
  const fromEnv = createA2AApprovalMcpHandler({ fetch: fetchImpl });
  if (previous === undefined) delete process.env.A2A_PROJECT_ROOT;
  else process.env.A2A_PROJECT_ROOT = previous;
  const first = await fromEnv.invokeTool('a2a_role_rules_get', { roleId: 'pr-delivery', phase: 'implement' });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  const firstDigest = (first.structuredContent as { digest: string }).digest;
  await writeFile(join(role, 'ROLE.md'), 'before\nHOT-ROLE\n');
  const second = await fromEnv.invokeTool('a2a_role_rules_get', { roleId: 'pr-delivery', phase: 'implement' });
  assert.match((second.structuredContent as { roleInstructions: string }).roleInstructions, /HOT-ROLE/);
  assert.notEqual((second.structuredContent as { digest: string }).digest, firstDigest);
  assert.equal(fetched, 0);
});

test('a2a_role_rules_get rejects a forged .git and accepts a real worktree of the pinned repository', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'role-rules-forge-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const pinned = join(parent, 'repo');
  const worktree = join(parent, 'wt');
  const other = join(parent, 'wt-b');
  await mkdir(join(pinned, '.1agents/roles/demo'), { recursive: true });
  await writeFile(join(pinned, '.1agents/roles/demo/profile.json'), JSON.stringify({
    id: 'demo', version: '1.0.0', skills: [{ key: 'only', name: 'only-skill' }],
  }));
  await writeFile(join(pinned, '.1agents/roles/demo/ROLE.md'), 'PINNED-ROLE\n');
  await writeFile(join(pinned, 'README.md'), 'anchor\n');
  const git = promisify(execFile);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'role-rules', GIT_AUTHOR_EMAIL: 'role-rules@example.com', GIT_COMMITTER_NAME: 'role-rules', GIT_COMMITTER_EMAIL: 'role-rules@example.com' };
  const runGit = (cwd: string, args: string[]) => git('git', args, { cwd, env: gitEnv });
  await runGit(pinned, ['init', '-b', 'main']);
  await runGit(pinned, ['add', 'README.md', '.1agents/roles/demo/profile.json', '.1agents/roles/demo/ROLE.md']);
  await runGit(pinned, ['commit', '--no-gpg-sign', '-m', 'init']);
  await runGit(pinned, ['worktree', 'add', '-b', 'delivery', worktree]);
  await runGit(pinned, ['worktree', 'add', '-b', 'delivery-b', other]);
  const pinnedGit = await realpath(join(pinned, '.git'));
  const wtGitdir = (await readFile(join(worktree, '.git'), 'utf8')).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(wtGitdir);
  let fetched = 0;
  const mcp = createA2AApprovalMcpHandler({
    projectRoot: pinned,
    fetch: async () => { fetched += 1; throw new Error('gateway should not be called'); },
  });
  const forged = [
    ['link', async (dir: string) => { await symlink(pinnedGit, join(dir, '.git')); }],
    ['main-gitdir', async (dir: string) => { await writeFile(join(dir, '.git'), `gitdir: ${pinnedGit}\n`); }],
    ['worktree-gitdir', async (dir: string) => { await writeFile(join(dir, '.git'), `gitdir: ${wtGitdir}\n`); }],
  ] as const;
  for (const [name, plant] of forged) {
    const dir = join(parent, `forged-${name}`);
    await mkdir(join(dir, '.1agents/roles/demo'), { recursive: true });
    await writeFile(join(dir, '.1agents/roles/demo/profile.json'), JSON.stringify({
      id: 'demo', version: '9.9.9', skills: [{ key: 'only', name: 'only-skill' }],
    }));
    await writeFile(join(dir, '.1agents/roles/demo/ROLE.md'), 'FORGED-SECRET\n');
    await plant(dir);
    const rejected = await mcp.invokeTool('a2a_role_rules_get', { roleId: 'demo', projectRoot: dir });
    assert.equal(rejected.isError, true, name);
    assert.match(rejected.content[0]?.text ?? '', /outside the allowed project/);
    assert.equal((rejected.content[0]?.text ?? '').includes('FORGED-SECRET'), false, name);
  }
  const fromWorktree = await mcp.invokeTool('a2a_role_rules_get', { roleId: 'demo', projectRoot: join(worktree, '.1agents') });
  assert.equal(fromWorktree.isError, undefined, fromWorktree.content[0]?.text);
  assert.match((fromWorktree.structuredContent as { roleInstructions?: string }).roleInstructions ?? '', /PINNED-ROLE/);
  const pinnedOnWorktree = createA2AApprovalMcpHandler({
    projectRoot: worktree,
    fetch: async () => { fetched += 1; throw new Error('gateway should not be called'); },
  });
  const mainAgain = await pinnedOnWorktree.invokeTool('a2a_role_rules_get', { roleId: 'demo', projectRoot: pinned });
  assert.equal(mainAgain.isError, undefined, mainAgain.content[0]?.text);
  const sibling = await pinnedOnWorktree.invokeTool('a2a_role_rules_get', { roleId: 'demo', projectRoot: other });
  assert.equal(sibling.isError, undefined, sibling.content[0]?.text);
  await mkdir(join(other, 'nested'));
  const nested = await pinnedOnWorktree.invokeTool('a2a_role_rules_get', { roleId: 'demo', projectRoot: join(other, 'nested') });
  assert.equal(nested.isError, undefined, nested.content[0]?.text);
  assert.equal(fetched, 0);
});
