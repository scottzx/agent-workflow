import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { deliverSessionMessage, SessionDeliveryError, sessionHostSchema } from '../src/a2a/session-hosts.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const receiptId = '22222222-2222-4222-8222-222222222222';
const input = { sessionId: threadId, messageId: 'notice-fixed-id', text: '任务完成，请继续。' };
const confirmation = `Queued message ${receiptId} for thread ${threadId}.\n`;
const cliOptions = { skip: process.platform === 'win32' ? 'Executable script fixture requires a Unix host' : false };

async function fixtureCli(t: TestContext, source: (capture: string) => string) {
  const root = await mkdtemp(path.join(tmpdir(), 'session-host-cli-'));
  const executable = path.join(root, 'fake codex.mjs');
  const capture = path.join(root, 'capture.json');
  await writeFile(executable, `#!${process.execPath}\n${source(capture)}\n`);
  await chmod(executable, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, executable, capture };
}

async function deliveryError(operation: Promise<unknown>, retryable: boolean, outcomeUnknown: boolean) {
  try { await operation; assert.fail('Expected a delivery failure'); }
  catch (error) {
    assert.ok(error instanceof SessionDeliveryError);
    assert.equal(error.retryable, retryable);
    assert.equal(error.outcomeUnknown, outcomeUnknown);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(error.message, /secret|private diagnostic|raw business error/);
    return error;
  }
}

type Request = { url: string; headers: IncomingHttpHeaders; body: {
  type: string; rpcId: string; method: string;
  payload: { args: { request: { requestId: string; sessionId: string; mode: string; content: Array<{ type: string; text: string }> } } };
} };
function reply(response: ServerResponse, request: Request, result: unknown = { ok: true, value: { accepted: true } }) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ type: 'server-response', rpcId: request.body.rpcId, result }));
}
async function fixtureDsh(t: TestContext, handle?: (request: Request, response: ServerResponse, index: number) => void) {
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const recorded = { url: request.url!, headers: request.headers, body: JSON.parse(raw) as Request['body'] };
      requests.push(recorded);
      if (handle) handle(recorded, response, requests.length); else reply(response, recorded);
    })().catch(() => { response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(() => stop(server));
  return { url: `http://127.0.0.1:${address.port}`, requests };
}
async function stop(server: Server) {
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

test('host configuration validates origins, credentials references and bounded deadlines', () => {
  assert.deepEqual(sessionHostSchema.parse({ kind: 'codex' }), { kind: 'codex', executable: 'codex', timeoutMs: 15_000 });
  assert.equal(sessionHostSchema.parse({ kind: 'dsh', url: 'https://dsh.example/' }).timeoutMs, 15_000);
  assert.ok(sessionHostSchema.safeParse({ kind: 'codex', remote: 'unix://', remoteAuthTokenEnv: 'CODEX_REMOTE_TOKEN' }).success);
  for (const invalid of [
    { kind: 'codex', timeoutMs: 0 }, { kind: 'codex', timeoutMs: 300_001 },
    { kind: 'codex', cwd: 'relative' }, { kind: 'codex', remote: 'https://host' },
    { kind: 'codex', remote: 'ws://user:secret@host' },
    { kind: 'codex', remoteAuthTokenEnv: 'TOKEN' },
    { kind: 'codex', remote: 'ws://localhost', remoteAuthTokenEnv: 'TOKEN=secret' },
    { kind: 'dsh', url: 'https://host/api' }, { kind: 'dsh', url: 'https://host/?secret=token' },
    { kind: 'dsh', url: 'not-a-url' },
    { kind: 'dsh', url: 'https://user:secret@host' },
    { kind: 'dsh', url: 'http://host', headers: { Cookie: 'a\r\nb' } },
    { kind: 'dsh', url: 'http://host', headers: { 'Invalid Header': 'x' } },
  ]) assert.equal(sessionHostSchema.safeParse(invalid).success, false);
});

test('Codex preserves the exact message and passes remote auth by environment variable name without a shell', cliOptions, async t => {
  const f = await fixtureCli(t, capture => `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
    process.stderr.write('secret private diagnostic');
    process.stdout.write(${JSON.stringify(confirmation)});
  `);
  const marker = path.join(f.root, 'injection-would-create-this');
  const text = `--profile=bad\n中文原文 ' \\"; $(touch ${marker}); \`touch ${marker}\` $TOKEN`;
  const host = sessionHostSchema.parse({ kind: 'codex', executable: f.executable, cwd: f.root,
    remote: 'ws://127.0.0.1:1234', remoteAuthTokenEnv: 'SESSION_DELIVERY_TOKEN' });
  const receipt = await deliverSessionMessage(host, { ...input, text });
  assert.deepEqual(receipt, { hostReceiptId: receiptId });
  const captured = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.deepEqual(captured, { cwd: await realpath(f.root), argv: [
    'queue', `--thread=${threadId}`, `--message=${text}`, '--remote=ws://127.0.0.1:1234',
    '--remote-auth-token-env=SESSION_DELIVERY_TOKEN',
  ] });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(receipt), /secret/);
});

test('Codex startup failure is known not sent and may be retried', async () => {
  const host = sessionHostSchema.parse({ kind: 'codex', executable: path.join(tmpdir(), `missing-codex-${process.pid}-${Date.now()}`) });
  await deliveryError(deliverSessionMessage(host, input), true, false);
});

test('Codex rejects an operating-system argument limit before launch without an automatic retry loop', cliOptions, async t => {
  const f = await fixtureCli(t, capture => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(capture)}, 'started');`);
  await deliveryError(deliverSessionMessage(sessionHostSchema.parse({ kind: 'codex', executable: f.executable }), {
    ...input, text: 'x'.repeat(16 * 1024 * 1024),
  }), false, false);
  await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
});

test('Codex execution failures and uncorrelated confirmations remain unknown without exposing diagnostics', cliOptions, async t => {
  for (const [name, stdout, code] of [
    ['failed', '', 7], ['missing receipt', 'done', 0],
    ['wrong target', confirmation.replace(threadId, '00000000-0000-0000-0000-000000000000'), 0],
    ['duplicate receipt', confirmation + confirmation, 0],
  ] as const) {
    await t.test(name, async t => {
      const f = await fixtureCli(t, () => `process.stderr.write('secret private diagnostic'); process.stdout.write(${JSON.stringify(stdout)}); process.exitCode = ${code};`);
      await deliveryError(deliverSessionMessage(sessionHostSchema.parse({ kind: 'codex', executable: f.executable }), input), false, true);
    });
  }
});

test('Codex timeout after process creation is unknown and cannot be retried automatically', cliOptions, async t => {
  const f = await fixtureCli(t, () => 'setInterval(() => {}, 1000);');
  await deliveryError(deliverSessionMessage(sessionHostSchema.parse({ kind: 'codex', executable: f.executable, timeoutMs: 100 }), input), false, true);
});

test('cancellation before dispatch never launches a host command', cliOptions, async t => {
  const f = await fixtureCli(t, capture => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(capture)}, 'started');`);
  const controller = new AbortController(); controller.abort();
  await deliveryError(deliverSessionMessage(sessionHostSchema.parse({ kind: 'codex', executable: f.executable }), input, controller.signal), true, false);
  await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
});

test('a Codex session name cannot silently select a different thread', cliOptions, async t => {
  const f = await fixtureCli(t, capture => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(capture)}, 'started');`);
  await deliveryError(deliverSessionMessage(sessionHostSchema.parse({ kind: 'codex', executable: f.executable }), { ...input, sessionId: 'possibly duplicated chat title' }), false, false);
  await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
});

test('cancellation after Codex process creation remains unknown', cliOptions, async t => {
  const f = await fixtureCli(t, () => 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const delivery = deliverSessionMessage(sessionHostSchema.parse({ kind: 'codex', executable: f.executable }), input, controller.signal);
  controller.abort();
  await deliveryError(delivery, false, true);
});

test('DSH delivers through authenticated Web RPC and only returns its confirmed correlation identity', async t => {
  const f = await fixtureDsh(t);
  const text = '在iphone真机中安装，待会我们手动测试\n原文保持 "双引号" 与 $(字面值)';
  const receipt = await deliverSessionMessage(sessionHostSchema.parse({ kind: 'dsh', url: f.url,
    headers: { Authorization: 'Bearer secret-auth', Cookie: 'session=secret-cookie', 'content-type': 'text/plain' },
  }), { ...input, text });
  assert.deepEqual(receipt, { hostReceiptId: input.messageId });
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  assert.equal(request.url, '/api/session/prompt');
  assert.equal(request.headers.authorization, 'Bearer secret-auth');
  assert.equal(request.headers.cookie, 'session=secret-cookie');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.body, {
    type: 'client-request', rpcId: input.messageId, method: 'session/prompt',
    payload: { args: { request: { requestId: input.messageId, sessionId: threadId, mode: 'queue', content: [{ type: 'text', text }] } } },
  });
  assert.doesNotMatch(JSON.stringify(receipt), /secret|Cookie|Authorization/);
});

test('DSH business refusal and malformed acknowledgements never claim acceptance or reveal raw errors', async t => {
  for (const [name, send, unknown] of [
    ['business rejection', (request: Request, response: ServerResponse) => reply(response, request, { ok: false, error: { message: 'raw business error secret-auth' } }), false],
    ['accepted false', (request: Request, response: ServerResponse) => reply(response, request, { ok: true, value: { accepted: false } }), true],
    ['uncorrelated response', (_request: Request, response: ServerResponse) => response.end(JSON.stringify({ type: 'server-response', rpcId: 'other', result: { ok: true, value: { accepted: true } } })), true],
    ['invalid JSON', (_request: Request, response: ServerResponse) => response.end('secret invalid response'), true],
  ] as const) {
    await t.test(name, async t => {
      const f = await fixtureDsh(t, send);
      await deliveryError(deliverSessionMessage(sessionHostSchema.parse({ kind: 'dsh', url: f.url }), input), false, unknown);
    });
  }
});

test('DSH retries an explicit temporary rejection with the same request ID', async t => {
  const f = await fixtureDsh(t, (request, response, index) => {
    if (index === 1) { response.statusCode = 503; reply(response, request, { ok: false, error: { message: 'secret unavailable' } }); }
    else reply(response, request);
  });
  const host = sessionHostSchema.parse({ kind: 'dsh', url: f.url });
  await deliveryError(deliverSessionMessage(host, input), true, false);
  assert.deepEqual(await deliverSessionMessage(host, input), { hostReceiptId: input.messageId });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(request => request.body.payload.args.request.requestId), [input.messageId, input.messageId]);
  assert.deepEqual(f.requests[0]!.body, f.requests[1]!.body);
});

test('DSH only retries correlated RPC rejection and refuses redirects', async t => {
  for (const [status, structured, retryable, unknown] of [
    [429, true, true, false], [503, true, true, false], [401, true, false, false],
    [429, false, false, true], [503, false, false, true], [500, false, false, true], [302, false, false, true],
  ] as const) {
    await t.test(`${status} ${structured ? 'RPC rejection' : 'unstructured'}`, async t => {
      const f = await fixtureDsh(t, (request, response) => {
        response.statusCode = status; response.setHeader('Location', '/secret-redirect');
        if (structured) reply(response, request, { ok: false, error: { message: 'secret' } });
        else response.end('secret');
      });
      await deliveryError(deliverSessionMessage(sessionHostSchema.parse({ kind: 'dsh', url: f.url }), input), retryable, unknown);
      assert.equal(f.requests.length, 1);
    });
  }
});

test('DSH response loss and timeout are unknown and are not automatically retried', async t => {
  for (const [name, send] of [
    ['response loss', (_request: Request, response: ServerResponse) => response.destroy()],
    ['timeout', (_request: Request, _response: ServerResponse) => {}],
  ] as const) {
    await t.test(name, async t => {
      const f = await fixtureDsh(t, send);
      await deliveryError(deliverSessionMessage(sessionHostSchema.parse({ kind: 'dsh', url: f.url, timeoutMs: 100 }), input), false, true);
      assert.equal(f.requests.length, 1);
    });
  }
});

test('oversized DSH responses are bounded and cannot fabricate a receipt', async t => {
  const f = await fixtureDsh(t, (_request, response) => response.end('x'.repeat(70 * 1024)));
  await deliveryError(deliverSessionMessage(sessionHostSchema.parse({ kind: 'dsh', url: f.url }), input), false, true);
});

test('DSH forwards explicit steer delivery mode while Codex keeps queue CLI semantics', async t => {
  const f = await fixtureDsh(t);
  const receipt = await deliverSessionMessage(sessionHostSchema.parse({ kind: 'dsh', url: f.url }), { ...input, mode: 'steer' });
  assert.deepEqual(receipt, { hostReceiptId: input.messageId });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.body.payload.args.request.mode, 'steer');
});

test('DSH structured notice prefers /api/1agents-acp/session/deliver, falls back on plain 404, and does not fall back on structured RPC 404', async t => {
  const notice = { form: 'notice' as const, summary: 'A2A过程审批 · 工具「bash」等待批准' };
  const upgraded = await fixtureDsh(t);
  const receipt1 = await deliverSessionMessage(sessionHostSchema.parse({ kind: 'dsh', url: upgraded.url }), { ...input, mode: 'steer', notice });
  assert.deepEqual(receipt1, { hostReceiptId: input.messageId });
  assert.equal(upgraded.requests.length, 1);
  assert.equal(upgraded.requests[0]!.url, '/api/1agents-acp/session/deliver');
  assert.equal((upgraded.requests[0]!.body.payload.args.request as any).form, 'notice');
  assert.equal((upgraded.requests[0]!.body.payload.args.request as any).summary, notice.summary);

  const legacy = await fixtureDsh(t, (req, res) => {
    if (req.url === '/api/1agents-acp/session/deliver') { res.statusCode = 404; res.end('{}'); return; }
    reply(res, req);
  });
  const receipt2 = await deliverSessionMessage(sessionHostSchema.parse({ kind: 'dsh', url: legacy.url }), { ...input, mode: 'steer', notice });
  assert.deepEqual(receipt2, { hostReceiptId: input.messageId });
  assert.deepEqual(legacy.requests.map(r => r.url), ['/api/1agents-acp/session/deliver', '/api/session/prompt']);
  assert.equal(legacy.requests[1]!.body.payload.args.request.mode, 'steer');

  const missingSession = await fixtureDsh(t, (req, res) => {
    res.statusCode = 404;
    reply(res, req, { ok: false, error: { message: 'Session not found' } });
  });
  await deliveryError(deliverSessionMessage(sessionHostSchema.parse({ kind: 'dsh', url: missingSession.url }), { ...input, mode: 'steer', notice }), false, false);
  assert.equal(missingSession.requests.length, 1);
});
