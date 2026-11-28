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

/** Mirrors DSH: queued messages and their content blocks are deep-frozen, so mutation throws. */
function freezeMessage(message) {
  const content = Array.isArray(message.content)
    ? Object.freeze(message.content.map(block => Object.freeze({ ...block })))
    : message.content;
  return Object.freeze({
    ...message,
    ...(content === undefined ? {} : { content }),
    ...(message.source && typeof message.source === 'object' ? { source: Object.freeze({ ...message.source }) } : {}),
  });
}

function noticeContext(t, options = {}) {
  const steered = [];
  const followed = [];
  const events = [];
  const state = { flushed: 0, replaced: [] };
  const replaceMode = options.replace ?? 'accept';
  const agent = {
    id: 'session-origin',
    inbox: {
      nextTurn: [],
      nextStep: [],
      ...(replaceMode === 'missing' ? {} : {
        replace(messageId, next) {
          if (replaceMode === 'reject') return false;
          const index = agent.inbox.nextTurn.findIndex(item => item.id === messageId);
          if (index < 0) return false;
          agent.inbox.nextTurn[index] = freezeMessage(next);
          state.replaced.push({ messageId, next });
          return true;
        },
      }),
    },
    session: { snapshotEvents: () => events },
    steer(msg) { steered.push(msg); agent.inbox.nextStep.push(freezeMessage(msg)); },
    followup(msg) { followed.push(msg); agent.inbox.nextTurn.push(freezeMessage(msg)); },
  };
  const ctx = {
    sessionController: { async resolveAgent(id) { return id === 'session-origin' ? { agent } : { error: { code: 'session/not-found', message: 'missing' } }; } },
    sessionPersistence: { async flush() { state.flushed += 1; } },
  };
  return { agent, steered, followed, events, state, ctx };
}

function deliveryEnvelope(requestId, request) {
  return {
    type: 'client-request',
    rpcId: requestId,
    method: '1agents-acp/session/deliver',
    payload: { args: { request: { requestId, sessionId: 'session-origin', ...request } } },
  };
}

const textOf = message => (Array.isArray(message.content) ? message.content : [])
  .map(block => (block && typeof block.text === 'string' ? block.text : '')).filter(Boolean).join('\n');

test('queue deliveries merge into the pending 1agents-acp inbox tail instead of waking the session twice', async t => {
  const { agent, steered, followed, state, ctx } = noticeContext(t);
  const base = await startServer(t, ctx);
  const post = body => fetch(`${base}${SESSION_DELIVER_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const first = deliveryEnvelope('queue-req-1', {
    mode: 'queue', form: 'notice', text: '第一条队列通知', summary: '任务一完成', fromSessionId: 'sender-a',
  });
  assert.equal((await post(first)).status, 200);
  assert.equal(followed.length, 1, 'the first queue message still uses agent.followup');
  assert.equal(state.flushed, 1);
  assert.equal(agent.inbox.nextTurn.length, 1);
  const original = agent.inbox.nextTurn[0];
  assert.ok(Object.isFrozen(original) && Object.isFrozen(original.content), 'the host queue is deep-frozen');
  const originalText = textOf(original);

  const second = deliveryEnvelope('queue-req-2', {
    mode: 'queue', form: 'notice', text: '第二条队列通知', summary: '任务二完成', fromSessionId: 'sender-b',
  });
  assert.equal((await post(second)).status, 200);
  assert.equal(followed.length, 1, 'the second queue message must not schedule another wakeup');
  assert.equal(state.flushed, 2, 'the merged message is persisted');
  assert.equal(agent.inbox.nextTurn.length, 1);

  const merged = agent.inbox.nextTurn[0];
  assert.notEqual(merged, original, 'the host message is replaced through inbox.replace, never mutated');
  assert.equal(state.replaced.length, 1, 'exactly one host replace call performed the merge');
  assert.equal(state.replaced[0].messageId, 'queue-req-1');
  assert.equal(textOf(original), originalText, 'the original frozen message is untouched');
  assert.equal(merged.id, 'queue-req-1');
  const mergedText = textOf(merged);
  assert.match(mergedText, /^\[队列合并 · 共 2 条消息\]/);
  assert.match(mergedText, /第一条队列通知/);
  assert.match(mergedText, /第二条队列通知/);
  assert.match(mergedText, /—— 第 2 条 ——/);
  assert.equal(merged.source.kind, NOTICE_SOURCE_KIND);
  assert.equal(merged.source.form, 'notice');
  assert.equal(merged.source.rpcId, 'queue-req-1');
  assert.deepEqual(merged.source.rpcIds, ['queue-req-1', 'queue-req-2']);
  assert.match(merged.source.summary, /任务一完成/);
  assert.match(merged.source.summary, /任务二完成/);

  // Every original request id keeps its own idempotency, including the one that only lives in rpcIds.
  for (const envelope of [second, first]) {
    assert.equal((await post(envelope)).status, 200);
    assert.equal(followed.length, 1);
    assert.equal(steered.length, 0);
    assert.equal(agent.inbox.nextTurn.length, 1);
    assert.deepEqual(agent.inbox.nextTurn[0].source.rpcIds, ['queue-req-1', 'queue-req-2']);
  }

  // steer never merges: it goes straight to agent.steer and leaves the queued tail untouched.
  const steer = deliveryEnvelope('steer-req-1', { mode: 'steer', form: 'notice', text: 'steer 通知', summary: '过程审批' });
  assert.equal((await post(steer)).status, 200);
  assert.equal(steered.length, 1);
  assert.equal(steered[0].id, 'steer-req-1');
  assert.equal(textOf(steered[0]), 'steer 通知');
  assert.equal(followed.length, 1);
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(agent.inbox.nextStep.length, 1);
});

test('a queue delivery does not merge when the inbox tail is not an a2a notice', async t => {
  const { agent, followed, ctx } = noticeContext(t);
  agent.inbox.nextTurn.push({ id: 'human-1', role: 'user', content: [{ type: 'text', text: '人类消息' }], source: { kind: 'user' } });
  const base = await startServer(t, ctx);
  const post = body => fetch(`${base}${SESSION_DELIVER_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post(deliveryEnvelope('relay-req-1', { mode: 'queue', form: 'relay', text: 'relay 正文' }))).status, 200);
  assert.equal(followed.length, 1);
  assert.equal(agent.inbox.nextTurn.length, 2);
  assert.equal(agent.inbox.nextTurn[1].id, 'relay-req-1');
  assert.equal(agent.inbox.nextTurn[1].source.rpcId, 'relay-req-1');
  assert.equal(agent.inbox.nextTurn[1].source.rpcIds, undefined, 'an unmerged source keeps the old shape');
});

test('an invalid fromSessionId is rejected before the delivery reaches the agent', async t => {
  const { agent, followed, steered, ctx } = noticeContext(t);
  const base = await startServer(t, ctx);
  const response = await fetch(`${base}${SESSION_DELIVER_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deliveryEnvelope('bad-sender-1', { mode: 'queue', form: 'relay', text: '正文', fromSessionId: '   ' })),
  });
  assert.equal(response.status, 400);
  assert.equal(followed.length, 0);
  assert.equal(steered.length, 0);
  assert.equal(agent.inbox.nextTurn.length, 0);
});

test('a rejected inbox.replace falls back to agent.followup instead of losing the queued message', async t => {
  const { agent, followed, state, ctx } = noticeContext(t, { replace: 'reject' });
  const base = await startServer(t, ctx);
  const post = body => fetch(`${base}${SESSION_DELIVER_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post(deliveryEnvelope('reject-req-1', { mode: 'queue', form: 'relay', text: '第一条' }))).status, 200);
  const first = agent.inbox.nextTurn[0];
  assert.equal((await post(deliveryEnvelope('reject-req-2', { mode: 'queue', form: 'relay', text: '第二条' }))).status, 200);
  assert.equal(state.replaced.length, 0, 'a refused swap must not report a merge');
  assert.equal(followed.length, 2, 'the new message is queued as its own turn');
  assert.equal(agent.inbox.nextTurn.length, 2);
  assert.equal(textOf(agent.inbox.nextTurn[0]), '第一条');
  assert.equal(agent.inbox.nextTurn[0], first, 'the consumed or rejected tail is left untouched');
  assert.equal(agent.inbox.nextTurn[1].id, 'reject-req-2');
});

test('an inbox without replace keeps the old followup path', async t => {
  const { agent, followed, ctx } = noticeContext(t, { replace: 'missing' });
  assert.equal(typeof agent.inbox.replace, 'undefined');
  const base = await startServer(t, ctx);
  const post = body => fetch(`${base}${SESSION_DELIVER_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await post(deliveryEnvelope('old-req-1', { mode: 'queue', form: 'relay', text: '第一条' }));
  await post(deliveryEnvelope('old-req-2', { mode: 'queue', form: 'relay', text: '第二条' }));
  assert.equal(followed.length, 2);
  assert.equal(agent.inbox.nextTurn.length, 2);
});

test('a merge that would exceed MAX_TEXT_BYTES is refused: the tail stays intact and the new message is queued separately', async t => {
  const { agent, followed, state, ctx } = noticeContext(t);
  const base = await startServer(t, ctx);
  const post = body => fetch(`${base}${SESSION_DELIVER_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const big = 'a'.repeat(200 * 1024);
  assert.equal((await post(deliveryEnvelope('big-req-1', { mode: 'queue', form: 'notice', text: big, summary: '大消息 1' }))).status, 200);
  const tail = agent.inbox.nextTurn[0];
  const tailText = textOf(tail);
  assert.equal(tailText.length, big.length);
  assert.equal((await post(deliveryEnvelope('big-req-2', { mode: 'queue', form: 'notice', text: big, summary: '大消息 2' }))).status, 200);
  assert.equal(state.replaced.length, 0, 'an over-limit merge must not reach inbox.replace');
  assert.equal(followed.length, 2, 'the over-limit message becomes its own queued turn');
  assert.equal(agent.inbox.nextTurn.length, 2);
  assert.equal(agent.inbox.nextTurn[0], tail, 'the pending tail is unchanged');
  assert.equal(textOf(agent.inbox.nextTurn[0]), tailText);
  assert.equal(agent.inbox.nextTurn[1].id, 'big-req-2');
  assert.equal(textOf(agent.inbox.nextTurn[1]).length, big.length);
});
