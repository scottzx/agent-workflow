import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RemoteAgentGateway } from '../src/a2a/gateway.js';
import { formatSubscriberNotice, formatSubscriberNoticeSummary } from '../src/a2a/notices.js';
import { subscriberMessageId, subscriberTargetKey } from '../src/a2a/notifications.js';
import { createA2AServer } from '../src/a2a/server.js';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';

test('subscriber notices name the role and stay read-only', () => {
  const notice = {
    role: 'coordinator' as const, event: 'handoff' as const, originSessionId: 'origin-1', caseId: 'case-1', jobId: 'job-1',
    status: 'accepted', title: '接力', summary: '交给下游',
    handoff: { handoffId: 'h-1', status: 'accepted', purpose: 'review', toTargetId: 'legacy:other', childJobId: 'job-2' },
    artifacts: [{ name: '报告', url: 'https://example.test/report.md' }],
  };
  const text = formatSubscriberNotice(notice);
  assert.match(text, /总协调人 coordinator/);
  assert.match(text, /只读订阅通知，不替代主归属会话的审批或主 ack/);
  assert.match(text, /case-1/);
  assert.match(text, /job-1/);
  assert.match(text, /h-1/);
  assert.match(text, /review/);
  assert.match(text, /legacy:other/);
  assert.match(text, /报告/);
  const summary = formatSubscriberNoticeSummary(notice);
  assert.ok(summary.length <= 120);
  assert.match(summary, /交接/);
  const downstream = formatSubscriberNotice({ ...notice, role: 'downstream', event: 'process_request', processRequest: { requestId: 'prc-1', kind: 'permission' } });
  assert.match(downstream, /下游 downstream/);
  assert.match(downstream, /仅通知，请主归属处理/);
  assert.doesNotMatch(downstream, /ONEAGENTS_REVIEW_TOKEN|Bearer /);
});

class Backend implements A2ABackend {
  private nextSession = 0;
  readonly runs: Array<{ finish: (result: A2ARunResult) => void }> = [];
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    return { sessionId: input.sessionId ?? `remote-session-${++this.nextSession}`, cwd: input.cwd!, agentPreset: input.agentPreset };
  }
  async run(_target: A2ATarget, _prompt: string, options: { signal: AbortSignal }): Promise<A2ARunResult> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      options.signal.addEventListener('abort', abort, { once: true });
      this.runs.push({ finish: result => { options.signal.removeEventListener('abort', abort); resolve(result); } });
      if (options.signal.aborted) abort();
    });
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function stop(server: Server): Promise<void> {
  const done = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await done;
}
async function until<T>(operation: () => Promise<T>, predicate: (result: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const result = await operation();
    if (predicate(result)) return result;
    if (Date.now() >= deadline) throw new Error('multi-session notification condition deadline');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('case and job subscriptions fan out without duplicating the owner or blocking on a bad downstream', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'multi-session-notify-'));
  const prompts: Array<{ sessionId: string; text: string }> = [];
  const local = createServer((req, res) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const promptPath = req.url === '/api/session/prompt' || req.url === '/api/1agents-acp/session/deliver';
      if (req.method !== 'POST' || !promptPath) {
        res.writeHead(404); res.end(); return;
      }
      const request = body.payload?.args?.request ?? {};
      const sessionId = String(request.sessionId ?? '');
      const text = String(request.text ?? request.content?.[0]?.text ?? '');
      if (req.url === '/api/session/prompt' || req.url === '/api/1agents-acp/session/deliver') prompts.push({ sessionId, text });
      if (sessionId === 'bad-unknown') { req.socket.destroy(); return; }
      if (sessionId === 'bad-rejected') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }));
    })().catch(() => { if (!res.headersSent) { res.writeHead(400); res.end(); } });
  });
  const dshUrl = await listen(local);
  const backend = new Backend();
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const remoteServer = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') host.cardHandler(req, res);
    else void host.handler(req, res);
  });
  const remoteUrl = await listen(remoteServer);
  host = await createA2AServer({ backend, capacity: testCapacity(root), publicUrl: remoteUrl, stateDirectory: join(root, 'remote'), token: 'synthetic-remote-token', defaultAgentPreset: 'coding' });
  const gateway = new RemoteAgentGateway({
    stateDirectory: join(root, 'gateway'), port: 0,
    remotes: {
      remote: { url: remoteUrl, token: 'synthetic-remote-token' },
      other: { url: remoteUrl, token: 'synthetic-remote-token' },
    },
    sessionHosts: { dsh: { kind: 'dsh', url: dshUrl, headers: { Authorization: 'Bearer synthetic-dsh-token' }, timeoutMs: 1000 } },
    pollIntervalMs: 60_000,
    workbench: { token: 'synthetic-workbench-token', reviewerId: 'owner-1' },
  });
  t.after(async () => {
    await gateway.close();
    await host.close();
    await Promise.all([stop(remoteServer), stop(local)]);
    await rm(root, { recursive: true, force: true });
  });

  const origin = 'origin-owner';
  const coord = 'origin-coord';
  await gateway.invoke('session_bind', { originSessionId: origin, host: 'dsh', sessionId: 'owner-session' });
  await gateway.invoke('session_bind', { originSessionId: coord, host: 'dsh', sessionId: 'coord-session' });
  const opened = await gateway.invoke('case_open', {
    originSessionId: origin, caseId: 'case-fanout', goal: 'track the handoff',
    notifySessions: [
      { role: 'coordinator', target: { originSessionId: coord }, events: ['progress', 'terminal', 'handoff', 'process_request'] },
      { role: 'downstream', target: { host: 'dsh', sessionId: 'healthy-session' } },
      { role: 'downstream', target: { host: 'dsh', sessionId: 'bad-rejected' } },
      { role: 'downstream', target: { host: 'dsh', sessionId: 'bad-unknown' } },
      { role: 'observer', target: { host: 'dsh', sessionId: 'observer-session' } },
      { role: 'observer', target: { host: 'dsh', sessionId: 'owner-session' } },
      { role: 'downstream', target: { host: 'dsh', sessionId: 'filtered-purpose' }, filter: { purpose: 'nope' } },
      { role: 'downstream', target: { host: 'dsh', sessionId: 'filtered-target' }, filter: { targetId: 'legacy:remote' } },
    ],
  }) as { caseId: string };
  assert.equal(opened.caseId, 'case-fanout');
  await assert.rejects(gateway.invoke('notification_subscribe', {
    originSessionId: origin, scope: 'case', caseId: opened.caseId, role: 'observer', target: { host: 'missing', sessionId: 'x' },
  }), /Unknown session host/);
  await assert.rejects(gateway.invoke('notification_subscribe', {
    originSessionId: origin, scope: 'case', caseId: opened.caseId, role: 'observer',
    target: { host: 'dsh', sessionId: 'not-used' }, events: ['terminal', 'terminal'],
  }), /duplicate/);

  const target = (sessionId: string) => subscriberTargetKey('dsh', sessionId);
  const pull = (sessionId: string, eventKey: string) => {
    try { return gateway.sessions.getTarget({ targetKey: target(sessionId), messageId: subscriberMessageId(eventKey, 'dsh', sessionId) }); }
    catch { return undefined; }
  };
  const accepted = async (sessionId: string, eventKey: string) => until(async () => {
    await gateway.reconcile();
    return pull(sessionId, eventKey);
  }, receipt => receipt?.status === 'accepted');

  const first = await gateway.invoke('execution_submit', {
    originSessionId: origin, targetId: 'legacy:remote', caseId: opened.caseId, purpose: 'make', title: '第一跳',
    input: { cwd: '/synthetic/project', prompt: 'Produce a synthetic result', agentPreset: 'coding' },
    notifySessions: [{ role: 'downstream', target: { host: 'dsh', sessionId: 'healthy-session' } }],
  }) as { jobId: string; attemptId: string; error?: string };
  assert.equal(first.error, undefined, first.error);
  await until(async () => backend.runs.length, count => count >= 1);
  await until(async () => {
    await gateway.reconcile();
    return pull('coord-session', `progress:working:${first.attemptId}`) ?? pull('coord-session', `progress:submitted:${first.attemptId}`);
  }, receipt => receipt?.status === 'accepted');
  assert.equal(pull('healthy-session', `progress:working:${first.attemptId}`), undefined);
  assert.equal(pull('healthy-session', `progress:submitted:${first.attemptId}`), undefined);

  await gateway.openProcessRequest(first.jobId, {
    requestId: 'prc-fanout', jobId: first.jobId, attemptId: first.attemptId, sessionId: 'child-1',
    kind: 'permission', toolTitle: 'bash', toolDetail: 'ls',
  });
  const processReceipt = await accepted('coord-session', `process:prc-fanout`);
  assert.ok(processReceipt);
  assert.match(prompts.find(item => item.sessionId === 'coord-session' && item.text.includes('prc-fanout'))?.text ?? '', /只读订阅/);
  assert.equal(processReceipt.mode ?? 'queue', 'queue');
  assert.equal(pull('healthy-session', 'process:prc-fanout'), undefined);
  assert.equal(pull('observer-session', 'process:prc-fanout'), undefined);

  backend.runs[0]!.finish({ outcome: 'completed', text: 'Synthetic result ready' });
  const terminalKey = `terminal:${first.attemptId}:completed`;
  await accepted('coord-session', terminalKey);
  await accepted('healthy-session', terminalKey);
  await accepted('observer-session', terminalKey);
  await accepted('filtered-target', terminalKey);
  assert.equal(pull('filtered-purpose', terminalKey), undefined);
  assert.equal(pull('owner-session', terminalKey), undefined);
  assert.equal(prompts.filter(item => item.sessionId === 'owner-session' && item.text.includes('只读订阅')).length, 0);
  assert.equal(prompts.filter(item => item.sessionId === 'healthy-session' && item.text.includes(first.jobId) && item.text.includes('终态')).length, 1);
  const coordText = prompts.find(item => item.sessionId === 'coord-session' && item.text.includes('终态') && item.text.includes(first.jobId))?.text ?? '';
  assert.match(coordText, /总协调人/);
  assert.match(coordText, /case-fanout/);
  assert.match(coordText, /不替代主归属/);
  assert.equal(gateway.sessions.getTarget({ targetKey: target('bad-rejected'), messageId: subscriberMessageId(terminalKey, 'dsh', 'bad-rejected') }).status, 'rejected');
  assert.equal(gateway.sessions.getTarget({ targetKey: target('bad-unknown'), messageId: subscriberMessageId(terminalKey, 'dsh', 'bad-unknown') }).status, 'unknown');
  const ownerStatus = gateway.sessions.getBindingStatus(origin);
  assert.equal(ownerStatus.blocked, false);
  assert.equal(gateway.sessions.summary().blockedOrigins, 0);

  await gateway.invoke('notification_unsubscribe', { originSessionId: origin, subscriptionId: (await gateway.invoke('notification_subscriptions', { originSessionId: origin, caseId: opened.caseId }) as { subscriptions: { subscriptionId: string; target: { sessionId?: string } }[] }).subscriptions.find(item => item.target.sessionId === 'observer-session')!.subscriptionId });

  const second = await gateway.invoke('execution_submit', {
    originSessionId: origin, targetId: 'legacy:remote', caseId: opened.caseId, purpose: 'make', title: '同一件事的下一单',
    input: { cwd: '/synthetic/project', prompt: 'Produce the inherited result', agentPreset: 'coding' },
  }) as { jobId: string; attemptId: string; error?: string };
  assert.equal(second.error, undefined, second.error);
  await until(async () => backend.runs.length, count => count >= 2);
  backend.runs[1]!.finish({ outcome: 'completed', text: 'Inherited result ready' });
  const secondKey = `terminal:${second.attemptId}:completed`;
  await accepted('healthy-session', secondKey);
  await accepted('coord-session', secondKey);
  assert.equal(pull('observer-session', secondKey), undefined);
  assert.equal(gateway.sessions.getTarget({ targetKey: target('bad-rejected'), messageId: subscriberMessageId(secondKey, 'dsh', 'bad-rejected') }).status, 'pending');
  assert.equal(gateway.sessions.getTarget({ targetKey: target('bad-rejected'), messageId: subscriberMessageId(secondKey, 'dsh', 'bad-rejected') }).attempts, 0);
  assert.equal(gateway.sessions.getTarget({ targetKey: target('bad-unknown'), messageId: subscriberMessageId(secondKey, 'dsh', 'bad-unknown') }).status, 'pending');
  assert.equal(gateway.sessions.getBindingStatus(origin).blocked, false);
  assert.equal(gateway.sessions.getTarget({ targetKey: target('healthy-session'), messageId: subscriberMessageId(secondKey, 'dsh', 'healthy-session') }).status, 'accepted');

  const done = await gateway.invoke('execution_get', { originSessionId: origin, jobId: first.jobId }) as { resultRevision: string; resultDigest: string; attemptId: string };
  const proposed = await gateway.invoke('handoff_propose', {
    originSessionId: origin, jobId: first.jobId, attemptId: done.attemptId, caseId: opened.caseId,
    toTargetId: 'legacy:other', purpose: 'review', artifactRevision: done.resultRevision, artifactDigest: done.resultDigest, reason: '交给复核',
  }) as { handoffId: string; status: string };
  assert.equal(proposed.status, 'proposed');
  await accepted('coord-session', `handoff:propose:${proposed.handoffId}`);
  await accepted('healthy-session', `handoff:propose:${proposed.handoffId}`);
  assert.equal(pull('observer-session', `handoff:propose:${proposed.handoffId}`), undefined);
  assert.equal(pull('filtered-purpose', `handoff:propose:${proposed.handoffId}`), undefined);
  assert.equal(pull('filtered-target', `handoff:propose:${proposed.handoffId}`), undefined);
  const decided = await gateway.invoke('handoff_decide', {
    originSessionId: origin, handoffId: proposed.handoffId, decision: 'accept',
    decidedBy: { kind: 'coach', agent: 'coach', sessionId: origin },
  }) as { status: string };
  assert.equal(decided.status, 'accepted');
  await accepted('healthy-session', `handoff:decide:${proposed.handoffId}:accepted`);
  const taken = await gateway.invoke('execution_submit', {
    originSessionId: origin, handoffId: proposed.handoffId, targetId: 'legacy:other',
    input: { cwd: '/synthetic/project', prompt: 'Continue from the handoff', agentPreset: 'coding' },
  }) as { jobId?: string; error?: string };
  assert.equal(taken.error, undefined, taken.error);
  await until(async () => backend.runs.length, count => count >= 3);
  backend.runs[2]!.finish({ outcome: 'completed', text: 'Handoff child done' });
  await accepted('coord-session', `handoff:taken:${proposed.handoffId}`);
  await accepted('healthy-session', `handoff:taken:${proposed.handoffId}`);
  assert.match(prompts.find(item => item.sessionId === 'healthy-session' && item.text.includes(proposed.handoffId) && item.text.includes('taken'))?.text ?? '', /接力任务/);
  assert.equal(gateway.sessions.getBindingStatus(origin).blocked, false);

  const spawned = await gateway.invoke('remote_agent_spawn', {
    originSessionId: origin, remote: 'remote', cwd: '/synthetic/project', prompt: 'Spawn with its own subscriber', agentPreset: 'coding',
    notifySessions: [{ scope: 'job', role: 'observer', target: { host: 'dsh', sessionId: 'spawn-session' } }],
  }) as { jobId: string; attemptId: string };
  await until(async () => backend.runs.length, count => count >= 4);
  backend.runs[3]!.finish({ outcome: 'completed', text: 'Spawned result' });
  await accepted('spawn-session', `terminal:${spawned.attemptId}:completed`);
  assert.equal(pull('healthy-session', `terminal:${spawned.attemptId}:completed`), undefined);
  const listed = await gateway.invoke('notification_subscriptions', { originSessionId: origin, jobId: spawned.jobId }) as { subscriptions: unknown[] };
  assert.equal(listed.subscriptions.length, 1);
  assert.equal(JSON.stringify(listed).includes('synthetic-dsh-token'), false);
  assert.equal(JSON.stringify(gateway.sessions.summary()).includes('synthetic-dsh-token'), false);
});

test('illegal notifySessions is rejected before a job, case, or remote dispatch is stored', { timeout: 20_000 }, async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'notify-atomic-'));
  const local = createServer((req, res) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }));
    })().catch(() => { if (!res.headersSent) { res.writeHead(400); res.end(); } });
  });
  const dshUrl = await listen(local);
  const backend = new Backend();
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const remoteServer = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') host.cardHandler(req, res);
    else void host.handler(req, res);
  });
  const remoteUrl = await listen(remoteServer);
  host = await createA2AServer({ backend, capacity: testCapacity(root), publicUrl: remoteUrl, stateDirectory: join(root, 'remote'), token: 'synthetic-remote-token', defaultAgentPreset: 'coding' });
  const gateway = new RemoteAgentGateway({
    stateDirectory: join(root, 'gateway'), port: 0,
    remotes: { remote: { url: remoteUrl, token: 'synthetic-remote-token' } },
    sessionHosts: {
      dsh: { kind: 'dsh', url: dshUrl, timeoutMs: 1000 },
      codex: { kind: 'codex', executable: 'codex' },
    },
    pollIntervalMs: 60_000,
  });
  t.after(async () => {
    await gateway.close();
    await host.close();
    await Promise.all([stop(remoteServer), stop(local)]);
    await rm(root, { recursive: true, force: true });
  });
  const origin = 'origin-atomic';
  const clientRequestId = 'same-request';
  const badBatch = [
    { role: 'downstream' as const, target: { host: 'dsh', sessionId: 'ok-session' } },
    { role: 'observer' as const, target: { host: 'codex', sessionId: 'not-a-uuid' } },
  ];
  await assert.rejects(gateway.invoke('execution_submit', {
    originSessionId: origin, targetId: 'legacy:remote', clientRequestId,
    input: { cwd: '/synthetic/project', prompt: 'must not be stored', agentPreset: 'coding' },
    notifySessions: badBatch,
  }), /UUID/);
  const empty = await gateway.invoke('execution_list', { originSessionId: origin }) as { total: number };
  const subs = async () => (await gateway.invoke('notification_subscriptions', { originSessionId: origin }) as { subscriptions: unknown[] }).subscriptions;
  assert.equal(empty.total, 0);
  assert.equal((await subs()).length, 0);
  assert.equal(backend.runs.length, 0);

  await assert.rejects(gateway.invoke('case_open', {
    originSessionId: origin, caseId: 'case-orphan', goal: 'must not stick',
    notifySessions: [
      { role: 'observer', target: { host: 'dsh', sessionId: 'ok-session' } },
      { role: 'observer', target: { host: 'missing-host', sessionId: 'x' } },
    ],
  }), /Unknown session host/);
  await assert.rejects(gateway.invoke('case_get', { originSessionId: origin, caseId: 'case-orphan' }), /No such case/);
  assert.equal((await subs()).length, 0);

  await assert.rejects(gateway.invoke('remote_agent_spawn', {
    originSessionId: origin, remote: 'remote', cwd: '/synthetic/project', prompt: 'must not reach the remote', agentPreset: 'coding',
    notifySessions: badBatch,
  }), /UUID/);
  assert.equal(backend.runs.length, 0);
  assert.equal((await gateway.invoke('execution_list', { originSessionId: origin }) as { total: number }).total, 0);
  assert.equal((await subs()).length, 0);

  const dispatched = await gateway.invoke('execution_submit', {
    originSessionId: origin, targetId: 'legacy:remote', clientRequestId,
    input: { cwd: '/synthetic/project', prompt: 'now dispatch for real', agentPreset: 'coding' },
    notifySessions: [{ role: 'downstream', target: { host: 'dsh', sessionId: 'ok-session' } }],
  }) as { jobId: string; attemptId: string; error?: string };
  assert.equal(dispatched.error, undefined, dispatched.error);
  await until(async () => backend.runs.length, count => count === 1);
  backend.runs[0]!.finish({ outcome: 'completed', text: 'dispatched after the bad batch was rejected' });
  assert.equal((await gateway.invoke('execution_list', { originSessionId: origin }) as { total: number }).total, 1);
  const recorded = await gateway.invoke('notification_subscriptions', { originSessionId: origin, jobId: dispatched.jobId }) as { subscriptions: { target: { sessionId?: string } }[] };
  assert.equal(recorded.subscriptions.length, 1);
  assert.equal(recorded.subscriptions[0]?.target.sessionId, 'ok-session');
});
