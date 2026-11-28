/**
 * BL-001: queue coalescing at the gateway ledger and DSH host boundary, plus the cross-session
 * message RPC/MCP tool/CLI. Every case asserts observable host requests or durable receipts, and
 * a failure here must reproduce when the coalescing/validation code is reverted.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createA2AApprovalMcpHandler } from '../src/a2a/approval-mcp.js';
import { RemoteAgentGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import { formatMergedBatchText, MAX_BATCH_BYTES, SessionDelivery } from '../src/a2a/session-delivery.js';
import { sessionHostSchema } from '../src/a2a/session-hosts.js';

interface HostCall {
  url: string;
  rpcId: string;
  mode?: string;
  text: string;
  form?: string;
  summary?: string;
  fromSessionId?: string;
}

/** A local DSH stand-in that accepts both the structured notice route and the plain prompt route. */
async function recordingHost(t: TestContext): Promise<{ calls: HostCall[]; url: string }> {
  const calls: HostCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as { rpcId?: string; payload?: { args?: { request?: Record<string, unknown> } } };
      const request = body.payload?.args?.request ?? {};
      const content = request.content as Array<{ text?: string }> | undefined;
      calls.push({
        url: req.url ?? '',
        rpcId: String(body.rpcId ?? ''),
        mode: typeof request.mode === 'string' ? request.mode : undefined,
        text: String(request.text ?? content?.[0]?.text ?? ''),
        form: typeof request.form === 'string' ? request.form : undefined,
        summary: typeof request.summary === 'string' ? request.summary : undefined,
        fromSessionId: typeof request.fromSessionId === 'string' ? request.fromSessionId : undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }));
    })().catch(() => { if (!res.headersSent) { res.writeHead(400); res.end(); } });
  });
  await listen(server);
  t.after(() => stop(server));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { calls, url: `http://127.0.0.1:${address.port}` };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
}
async function stop(server: Server): Promise<void> {
  const done = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await done;
}
function hostMessageId(scopeId: string, ...messageIds: string[]): string {
  return `1agents-session:${createHash('sha256').update(JSON.stringify([scopeId, ...messageIds])).digest('hex')}`;
}

test('gateway ledger merges queued cross-session messages and A2A notices into one deterministic host delivery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-coalesce-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await recordingHost(t);
  const sessions = new SessionDelivery(root, { dsh: sessionHostSchema.parse({ kind: 'dsh', url: host.url }) });
  t.after(() => sessions.close());
  const origin = 'owner-origin';
  sessions.bind({ originSessionId: origin, host: 'dsh', sessionId: 'owner-session' });
  // Cross-session留言 and both A2A notice namespaces share one owner FIFO and must merge.
  sessions.enqueue({ originSessionId: origin, messageId: 'a2a-notice:notice-1', notice: { form: 'notice', summary: '任务完成' }, text: '[A2A任务通知]\n任务完成 body' });
  sessions.enqueue({
    originSessionId: origin, messageId: 'session-msg:m-1', fromSessionId: 'sender-a',
    notice: { form: 'notice', summary: '来自 sender-a 的留言' }, text: '[跨会话留言]\nmsg_from_session_id: sender-a\n---\n第一条留言',
  });
  sessions.enqueue({ originSessionId: origin, messageId: 'execution-notice:exec-1', notice: { form: 'notice', summary: '交付通知' }, text: '[A2A交付通知]\n交付 body' });
  await sessions.reconcile();

  assert.equal(host.calls.length, 1, 'one adapter admission carries the whole mergeable batch');
  const call = host.calls[0]!;
  const expected = hostMessageId(origin, 'a2a-notice:notice-1', 'session-msg:m-1', 'execution-notice:exec-1');
  assert.equal(call.rpcId, expected);
  assert.equal(call.url, '/api/1agents-acp/session/deliver');
  assert.equal(call.form, 'notice');
  assert.ok(call.summary && call.summary.length <= 240);
  assert.match(call.summary, /共 3 条消息/);
  assert.match(call.text, /^\[队列合并 · 共 3 条消息\]/);
  assert.match(call.text, /第 1\/3 条/);
  assert.match(call.text, /msg_from_session_id: sender-a/);
  assert.match(call.text, /第一条留言/);
  assert.match(call.text, /任务完成 body/);
  assert.match(call.text, /交付 body/);
  assert.match(call.text, /第 3\/3 条/);
  // Display order follows the FIFO, not the enqueue order of one namespace.
  assert.ok(call.text.indexOf('任务完成 body') < call.text.indexOf('第一条留言'));
  assert.ok(call.text.indexOf('第一条留言') < call.text.indexOf('交付 body'));
  for (const messageId of ['a2a-notice:notice-1', 'session-msg:m-1', 'execution-notice:exec-1']) {
    const receipt = sessions.get({ originSessionId: origin, messageId });
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.attempts, 1);
    assert.equal(receipt.hostReceiptId, expected, 'the whole batch shares one deterministic host receipt');
  }
  assert.equal(sessions.get({ originSessionId: origin, messageId: 'session-msg:m-1' }).fromSessionId, 'sender-a');
  // Retry safety: the same batch keeps the same host message ID and is never re-sent.
  await sessions.reconcile();
  assert.equal(host.calls.length, 1);
});

test('steer is never merged and splits the queue into separate batches around it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-coalesce-steer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await recordingHost(t);
  const sessions = new SessionDelivery(root, { dsh: sessionHostSchema.parse({ kind: 'dsh', url: host.url }) });
  t.after(() => sessions.close());
  const origin = 'owner-origin';
  sessions.bind({ originSessionId: origin, host: 'dsh', sessionId: 'owner-session' });
  sessions.enqueue({ originSessionId: origin, messageId: 'queue-1', text: '第一条 queue' });
  sessions.enqueue({ originSessionId: origin, messageId: 'steer-1', mode: 'steer', text: '一条 steer' });
  sessions.enqueue({ originSessionId: origin, messageId: 'queue-2', text: '第二条 queue' });
  for (let index = 0; index < 3; index++) await sessions.reconcile();
  for (let index = 0; index < 20 && host.calls.length < 3; index++) await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(host.calls.map(call => [call.mode, call.text]), [
    ['queue', '第一条 queue'],
    ['steer', '一条 steer'],
    ['queue', '第二条 queue'],
  ]);
  assert.deepEqual(host.calls.map(call => call.rpcId), [
    hostMessageId(origin, 'queue-1'),
    hostMessageId(origin, 'steer-1'),
    hostMessageId(origin, 'queue-2'),
  ]);
  assert.equal(host.calls.some(call => call.text.includes('队列合并')), false, 'steer must never enter a merged body');
  assert.equal(sessions.get({ originSessionId: origin, messageId: 'queue-2' }).status, 'accepted');
});

test('an unknown queue head blocks later messages and is never merged with them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-coalesce-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await recordingHost(t);
  const origin = 'owner-origin';
  const initial = new SessionDelivery(root, { dsh: sessionHostSchema.parse({ kind: 'dsh', url: host.url }) });
  initial.bind({ originSessionId: origin, host: 'dsh', sessionId: 'owner-session' });
  for (const messageId of ['blocked', 'later-1', 'later-2']) {
    initial.enqueue({ originSessionId: origin, messageId, text: `正文 ${messageId}` });
  }
  await initial.close();
  const file = join(root, 'session-delivery.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.deliveries.find((delivery: { messageId: string }) => delivery.messageId === 'blocked').status = 'unknown';
  await writeFile(file, JSON.stringify(stored));

  const sessions = new SessionDelivery(root, { dsh: sessionHostSchema.parse({ kind: 'dsh', url: host.url }) });
  t.after(() => sessions.close());
  await sessions.reconcile();
  assert.equal(host.calls.length, 0, 'a blocked FIFO head must stop the whole owner queue');
  assert.equal(sessions.get({ originSessionId: origin, messageId: 'later-1' }).attempts, 0);
  assert.equal(sessions.get({ originSessionId: origin, messageId: 'later-2' }).status, 'pending');

  sessions.resolve({ originSessionId: origin, messageId: 'blocked', accepted: true, note: 'Synthetic host confirmed the first admission' });
  await sessions.reconcile();
  assert.equal(host.calls.length, 1);
  const merged = host.calls[0]!;
  assert.equal(merged.rpcId, hostMessageId(origin, 'later-1', 'later-2'));
  assert.match(merged.text, /^\[队列合并 · 共 2 条消息\]/);
  assert.match(merged.text, /正文 later-1/);
  assert.match(merged.text, /正文 later-2/);
  assert.doesNotMatch(merged.text, /正文 blocked/);
  assert.equal(sessions.get({ originSessionId: origin, messageId: 'later-1' }).hostReceiptId, merged.rpcId);
  assert.equal(sessions.get({ originSessionId: origin, messageId: 'later-2' }).hostReceiptId, merged.rpcId);
});

test('merge budget is the exact formatted UTF-8 size, so long attribution fields cannot slip an over-limit batch through', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-coalesce-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await recordingHost(t);
  const sessions = new SessionDelivery(root, { dsh: sessionHostSchema.parse({ kind: 'dsh', url: host.url }) });
  t.after(() => sessions.close());
  const origin = 'owner-origin';
  sessions.bind({ originSessionId: origin, host: 'dsh', sessionId: 'owner-session' });
  // Sender/message IDs at their legal maximum make framing hundreds of bytes per segment.
  const from = 's'.repeat(512);
  const messageIds = Array.from({ length: 4 }, (_, index) => `${'m'.repeat(510)}${index}`);
  const text = 'a'.repeat(50_800);
  for (const messageId of messageIds) sessions.enqueue({ originSessionId: origin, messageId, fromSessionId: from, text });
  const createdAt = new Date().toISOString();
  const entries = messageIds.map(messageId => ({ messageId, fromSessionId: from, createdAt, text }));
  // The removed fixed 320-byte-per-message estimate would have allowed one merged body…
  assert.ok(Buffer.byteLength(text, 'utf8') * entries.length + 320 * entries.length <= MAX_BATCH_BYTES, 'the old estimate stays under the cap');
  // …while the real formatted body is over it, so the batch must stop before the last message.
  assert.ok(Buffer.byteLength(formatMergedBatchText(entries), 'utf8') > MAX_BATCH_BYTES, 'the real formatted body exceeds the cap');
  for (let index = 0; index < 3; index++) await sessions.reconcile();
  assert.equal(host.calls.length, 2, 'the over-limit body is split across two admissions');
  for (const call of host.calls) {
    assert.ok(Buffer.byteLength(call.text, 'utf8') <= MAX_BATCH_BYTES, 'no admission may exceed the merge budget');
    assert.doesNotMatch(call.text, /共 4 条消息/);
  }
  assert.match(host.calls[0]!.text, /^\[队列合并 · 共 3 条消息\]/);
  assert.equal(host.calls[1]!.text, text);
  const delivered = host.calls.map(call => call.rpcId);
  for (const messageId of messageIds) {
    const receipt = sessions.get({ originSessionId: origin, messageId });
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.attempts, 1);
    assert.ok(delivered.includes(receipt.hostReceiptId!), 'every message is delivered once');
  }
});

function gatewayConfig(root: string): A2AGatewayConfig {
  return {
    stateDirectory: root, port: 0, remotes: {}, pollIntervalMs: 60_000,
    sessionHosts: {
      'dsh-local': { kind: 'dsh', url: 'http://127.0.0.1:9', timeoutMs: 500 },
      'dsh-alt': { kind: 'dsh', url: 'http://127.0.0.1:9', timeoutMs: 500 },
      codex: { kind: 'codex', executable: 'codex', timeoutMs: 500 },
    },
  };
}

test('session_message_send queues on the owner FIFO when bound, on its own target when not, and fails closed with zero dirty records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-message-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = new RemoteAgentGateway(gatewayConfig(root));
  t.after(() => gateway.close());
  await gateway.invoke('session_bind', { originSessionId: 'owner-origin', host: 'dsh-local', sessionId: 'owner-session' });

  const totalOwned = () => gateway.sessions.summary().deliveries.total;
  const total = (): number => {
    const summary = gateway.sessions.summary();
    return summary.deliveries.total + summary.subscriberDeliveries.total;
  };
  const owned = await gateway.invoke('session_message_send', {
    fromSessionId: 'sender-a', toSessionId: 'owner-session', text: 'owner bound message', summary: '来自 sender-a',
  }) as any;
  assert.equal(owned.queuedOn, 'owner');
  assert.equal(owned.toHost, 'dsh-local');
  assert.equal(owned.toSessionId, 'owner-session');
  assert.equal(owned.mode, 'queue');
  assert.equal(owned.messageId, `session-msg:${owned.messageId.slice('session-msg:'.length)}`);
  assert.match(owned.messageId, /^session-msg:[0-9a-f-]{36}$/);
  assert.equal(gateway.sessions.hasDelivery('owner-origin', owned.messageId), true, 'a bound target joins its owner FIFO');
  const ownerReceipt = gateway.sessions.get({ originSessionId: 'owner-origin', messageId: owned.messageId });
  assert.equal(ownerReceipt.fromSessionId, 'sender-a');
  const stored = JSON.parse(await readFile(join(root, 'session-delivery.json'), 'utf8'));
  const storedOwner = stored.deliveries.find((delivery: { messageId: string }) => delivery.messageId === owned.messageId);
  assert.match(storedOwner.text, /^\[跨会话留言\]\nmsg_from_session_id: sender-a\n---\nowner bound message$/);
  assert.deepEqual(storedOwner.notice, { form: 'notice', summary: '来自 sender-a' });

  const targeted = await gateway.invoke('session_message_send', {
    fromSessionId: 'sender-b', toSessionId: 'unbound-session', text: 'unbound message',
  }) as any;
  assert.equal(targeted.queuedOn, 'target');
  const targetKey = 'session-msg:dsh-local:unbound-session';
  assert.equal(gateway.sessions.getTarget({ targetKey, messageId: targeted.messageId }).fromSessionId, 'sender-b');
  const storedTargeted = (JSON.parse(await readFile(join(root, 'session-delivery.json'), 'utf8')).targetDeliveries as Array<{ targetKey: string; messageId: string; text: string; notice: unknown }>)
    .find(delivery => delivery.targetKey === targetKey && delivery.messageId === targeted.messageId);
  assert.match(storedTargeted!.text, /msg_from_session_id: sender-b/);
  assert.deepEqual(storedTargeted!.notice, { form: 'notice', summary: '来自 sender-b 的留言' });

  const beforeAmbiguity = totalOwned();
  const beforeAmbiguous = total();
  await gateway.invoke('session_bind', { originSessionId: 'shared-a', host: 'dsh-local', sessionId: 'shared-session' });
  await gateway.invoke('session_bind', { originSessionId: 'shared-b', host: 'dsh-alt', sessionId: 'shared-session' });
  await assert.rejects(
    gateway.invoke('session_message_send', { fromSessionId: 'sender-c', toSessionId: 'shared-session', text: 'ambiguous target' }),
    /multiple session hosts/,
    'an ambiguous target must fail closed instead of silently picking dsh-local',
  );
  assert.equal(total(), beforeAmbiguous, 'the ambiguous-host rejection leaves zero dirty records');
  const explicitHost = await gateway.invoke('session_message_send', {
    fromSessionId: 'sender-c', toSessionId: 'shared-session', toHost: 'dsh-alt', text: 'explicit host',
  }) as any;
  assert.equal(explicitHost.queuedOn, 'owner');
  assert.equal(explicitHost.toHost, 'dsh-alt');
  assert.equal(gateway.sessions.hasDelivery('shared-b', explicitHost.messageId), true);
  assert.equal(totalOwned(), beforeAmbiguity + 1);

  const before = total();
  const rejections: Array<[string, Error | RegExp]> = [
    ['unknown host', /Unknown session host/],
    ['codex target must be a UUID', /UUID/],
    ['reserved a2a notice namespace', /reserved/],
    ['reserved execution notice namespace', /reserved/],
    ['reserved process request namespace', /reserved/],
    ['reserved subscriber notice namespace', /reserved/],
    ['blank text', /./],
    ['blank sender', /./],
  ];
  const attempts: Array<Record<string, unknown>> = [
    { fromSessionId: 'sender-a', toSessionId: 'owner-session', toHost: 'missing', text: 'x' },
    { fromSessionId: 'sender-a', toSessionId: 'not-a-uuid', toHost: 'codex', text: 'x' },
    { fromSessionId: 'sender-a', toSessionId: 'owner-session', messageId: 'a2a-notice:forged', text: 'x' },
    { fromSessionId: 'sender-a', toSessionId: 'owner-session', messageId: 'execution-notice:forged', text: 'x' },
    { fromSessionId: 'sender-a', toSessionId: 'owner-session', messageId: 'process-request:forged', text: 'x' },
    { fromSessionId: 'sender-a', toSessionId: 'owner-session', messageId: 'sub-notice:forged', text: 'x' },
    { fromSessionId: 'sender-a', toSessionId: 'owner-session', text: '   ' },
    { fromSessionId: '   ', toSessionId: 'owner-session', text: 'x' },
  ];
  for (const [index, params] of attempts.entries()) {
    await assert.rejects(gateway.invoke('session_message_send', params), rejections[index]![1] as RegExp, rejections[index]![0]);
  }
  assert.equal(total(), before, 'every rejected parameter fails closed before anything is persisted');
  assert.equal(gateway.sessions.hasDelivery('owner-origin', 'a2a-notice:forged'), false);
  assert.equal(gateway.sessions.hasDelivery('owner-origin', 'process-request:forged'), false);
});

test('a2a_session_message_send stamps the MCP session identity and refuses forged or missing senders', async t => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fetchFn = async (_url: unknown, init?: { body?: unknown }) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ messageId: 'session-msg:stub', status: 'pending', queuedOn: 'owner' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const mcp = createA2AApprovalMcpHandler({
    gatewayUrl: 'http://127.0.0.1:1', defaultHostSessionId: 'mcp-bound-session', fetch: fetchFn as unknown as typeof fetch,
  });
  const send = (args: Record<string, unknown>) => mcp.handleJsonRpc({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a2a_session_message_send', arguments: args },
  });

  const ok = await send({ toSessionId: 'target-session', text: '你好', mode: 'queue', summary: '来自 MCP' }) as any;
  assert.equal(ok.result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'session_message_send');
  assert.equal(calls[0]!.params.fromSessionId, 'mcp-bound-session');
  assert.equal(calls[0]!.params.toSessionId, 'target-session');
  assert.equal(calls[0]!.params.text, '你好');
  assert.equal(calls[0]!.params.summary, '来自 MCP');

  const forged = await send({ toSessionId: 'target-session', text: '你好', fromSessionId: 'victim-session' }) as any;
  assert.equal(forged.result.isError, true, 'a caller-supplied sender must be rejected, not forwarded');
  assert.equal(calls.length, 1);

  const restoredHost = process.env.A2A_DEFAULT_HOST_SESSION_ID;
  const restoredOrigin = process.env.A2A_DEFAULT_ORIGIN_SESSION_ID;
  delete process.env.A2A_DEFAULT_HOST_SESSION_ID;
  delete process.env.A2A_DEFAULT_ORIGIN_SESSION_ID;
  t.after(() => {
    if (restoredHost === undefined) delete process.env.A2A_DEFAULT_HOST_SESSION_ID;
    else process.env.A2A_DEFAULT_HOST_SESSION_ID = restoredHost;
    if (restoredOrigin === undefined) delete process.env.A2A_DEFAULT_ORIGIN_SESSION_ID;
    else process.env.A2A_DEFAULT_ORIGIN_SESSION_ID = restoredOrigin;
  });
  const anonymousCalls: unknown[] = [];
  const anonymous = createA2AApprovalMcpHandler({
    gatewayUrl: 'http://127.0.0.1:1',
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      anonymousCalls.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  const anonymousResult = await anonymous.handleJsonRpc({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'a2a_session_message_send', arguments: { toSessionId: 'target-session', text: '你好' } },
  }) as any;
  assert.equal(anonymousResult.result.isError, true, 'no bound identity must fail closed');
  assert.match(anonymousResult.result.content[0].text, /A2A_DEFAULT_HOST_SESSION_ID/);
  assert.equal(anonymousCalls.length, 0);
});

interface CliResult { code: number; stdout: string; stderr: string }

function runSessionCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', 'tsx', 'bin/acp-service.ts', 'session', ...args], { cwd, env, timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

test('acp-service session send delivers with an explicit or environment sender and fails closed without one', async t => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as { method: string; params: Record<string, unknown> };
      requests.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messageId: body.params.messageId ?? 'session-msg:cli-generated', fromSessionId: body.params.fromSessionId,
        toHost: 'dsh-local', toSessionId: body.params.toSessionId, mode: body.params.mode ?? 'queue', status: 'pending', queuedOn: 'owner' }));
    })().catch(() => { if (!res.headersSent) { res.writeHead(400); res.end(); } });
  });
  await listen(server);
  t.after(() => stop(server));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const baseEnv = { ...process.env, DSH_SESSION_ID: '', ONEAGENTS_SESSION_ID: '' };

  const explicit = await runSessionCli(['send', '--to', 'target-session', '--from', 'cli-sender', '--url', url, '--json', 'hello', 'cli'], baseEnv);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, 'session_message_send');
  assert.equal(requests[0]!.params.fromSessionId, 'cli-sender');
  assert.equal(requests[0]!.params.toSessionId, 'target-session');
  assert.equal(requests[0]!.params.text, 'hello cli');
  assert.equal(JSON.parse(explicit.stdout).messageId, 'session-msg:cli-generated');

  const fromEnv = await runSessionCli(['send', '--to', 'target-session', '--url', url, '--json', '--text', 'env body'],
    { ...baseEnv, DSH_SESSION_ID: 'env-sender' });
  assert.equal(fromEnv.code, 0, fromEnv.stderr);
  assert.equal(requests[1]!.params.fromSessionId, 'env-sender');
  assert.equal(requests[1]!.params.text, 'env body');

  const anonymous = await runSessionCli(['send', '--to', 'target-session', '--url', url, 'no sender'], baseEnv);
  assert.equal(anonymous.code, 1, 'a message without a sender identity must never be sent');
  assert.match(anonymous.stderr, /发件方/);
  assert.equal(requests.length, 2);

  for (const reservedId of ['a2a-notice:forged', 'sub-notice:forged']) {
    const reserved = await runSessionCli(['send', '--to', 'target-session', '--from', 'cli-sender', '--url', url,
      '--message-id', reservedId, 'x'], baseEnv);
    assert.equal(reserved.code, 1);
    assert.match(reserved.stderr, /保留前缀/);
  }
  assert.equal(requests.length, 2);
});
