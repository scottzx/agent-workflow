import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
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

test('MCP handler lists 6 tools, aggregates pending approvals, and executes coach-scoped approvals/tickets/reviews', async (t) => {
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
  assert.equal(tools.length, 6);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.trim().length > 0);
  }

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
  assert.equal((list.result as { tools: unknown[] }).tools.length, 6);

  const pending = await rpc(3, 'tools/call', { name: 'a2a_pending_approvals', arguments: {} });
  const result = pending.result as { isError?: boolean; structuredContent: { counts: { pendingProcessRequests: number } } };
  assert.ok(!result.isError);
  assert.equal(result.structuredContent.counts.pendingProcessRequests, 1);

  child.stdin.end();
  const exitCode = await new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)));
  assert.equal(exitCode, 0);
});
