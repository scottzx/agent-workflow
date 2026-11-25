import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  boundNoticeSummary,
  createSessionDeliverHandler,
  NOTICE_SOURCE_KIND,
  SESSION_DELIVER_PATH,
} from '../dist/session-notice.js';

async function startServer(t, ctx) {
  const handler = createSessionDeliverHandler(ctx);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === SESSION_DELIVER_PATH && req.method === 'POST') {
      void handler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${address.port}`;
}

test('boundNoticeSummary collapses whitespace and caps at 120 characters', () => {
  assert.equal(boundNoticeSummary('  A2A过程审批\n\t工具「bash」  '), 'A2A过程审批 工具「bash」');
  const long = boundNoticeSummary('字'.repeat(150));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

test('deliver endpoint steers ContextFormed notice, deduplicates retries, supports relay queue, and enforces origin/session checks', async t => {
  const steered = [];
  const followed = [];
  let flushed = 0;
  const events = [];
  const agent = {
    id: 'session-origin',
    inbox: { nextTurn: [], nextStep: [] },
    session: { snapshotEvents: () => events },
    steer(msg) { steered.push(msg); agent.inbox.nextStep.push(msg); },
    followup(msg) { followed.push(msg); agent.inbox.nextTurn.push(msg); },
  };
  const ctx = {
    sessionController: {
      async resolveAgent(id) {
        return id === 'session-origin' ? { agent } : { error: { code: 'session/not-found', message: 'missing' } };
      },
    },
    sessionPersistence: { async flush() { flushed++; } },
  };
  const base = await startServer(t, ctx);
  const post = (body, headers = {}) => fetch(`${base}${SESSION_DELIVER_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  // 1. Notice via steer
  const noticeReq = {
    type: 'client-request',
    rpcId: 'req-notice-1',
    method: '1agents-acp/session/deliver',
    payload: { args: { request: {
      requestId: 'req-notice-1',
      sessionId: 'session-origin',
      mode: 'steer',
      text: '<system-reminder>approve bash</system-reminder>',
      form: 'notice',
      summary: 'A2A过程审批 · 工具「bash」等待批准',
    } } },
  };
  const res1 = await post(noticeReq);
  assert.equal(res1.status, 200);
  assert.deepEqual(await res1.json(), { type: 'server-response', rpcId: 'req-notice-1', result: { ok: true, value: { accepted: true } } });
  assert.equal(steered.length, 1);
  assert.equal(flushed, 1);
  assert.deepEqual(steered[0], {
    id: 'req-notice-1',
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>approve bash</system-reminder>' }],
    source: { kind: NOTICE_SOURCE_KIND, form: 'notice', summary: 'A2A过程审批 · 工具「bash」等待批准', rpcId: 'req-notice-1' },
  });

  // 2. Idempotent retry while pending in inbox does not duplicate
  const resReplay = await post(noticeReq);
  assert.equal(resReplay.status, 200);
  assert.equal(steered.length, 1);

  // 3. Idempotent retry after moved into persisted session events also does not duplicate
  agent.inbox.nextStep.length = 0;
  events.push({ type: 'user/message', data: steered[0] });
  const resHistoryReplay = await post(noticeReq);
  assert.equal(resHistoryReplay.status, 200);
  assert.equal(steered.length, 1);

  // 4. Relay via queue
  const resRelay = await post({
    type: 'client-request',
    rpcId: 'req-relay-1',
    method: '1agents-acp/session/deliver',
    payload: { args: { request: {
      requestId: 'req-relay-1',
      sessionId: 'session-origin',
      mode: 'queue',
      text: 'relay body',
      form: 'relay',
    } } },
  });
  assert.equal(resRelay.status, 200);
  assert.equal(followed.length, 1);
  assert.deepEqual(followed[0].source, { kind: NOTICE_SOURCE_KIND, form: 'relay', rpcId: 'req-relay-1' });

  // 5. Missing session returns structured 404 server-response
  const resMissing = await post({
    ...noticeReq,
    rpcId: 'req-missing',
    payload: { args: { request: { ...noticeReq.payload.args.request, requestId: 'req-missing', sessionId: 'no-such-session' } } },
  });
  assert.equal(resMissing.status, 404);
  const missingBody = await resMissing.json();
  assert.equal(missingBody.type, 'server-response');
  assert.equal(missingBody.rpcId, 'req-missing');
  assert.equal(missingBody.result.ok, false);

  // 6. Cross-origin rejected with 403
  const resCrossOrigin = await post(noticeReq, { Origin: 'https://evil.example' });
  assert.equal(resCrossOrigin.status, 403);
});
