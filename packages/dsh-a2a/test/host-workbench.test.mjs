import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHostWorkbench, WORKBENCH_UI_PATH } from '../src/host-workbench.js';

async function listen(t, handler) {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A gateway bearer API that records what reached it. */
async function gateway(t) {
  const seen = [];
  const origin = await listen(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, relay: req.headers['x-workbench-page-relay'], body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks: [] }));
  });
  return { origin, seen };
}

test('host workbench serves a frameable page and its assets from the host origin', async t => {
  const handler = createHostWorkbench({ workbench: { url: 'http://127.0.0.1:1' } });
  const origin = await listen(t, handler);

  const page = await fetch(`${origin}${WORKBENCH_UI_PATH}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  // The sidebar embeds the page in an iframe, so the host must allow itself as a frame ancestor.
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);

  assert.equal((await fetch(`${origin}${WORKBENCH_UI_PATH}/app.js`)).status, 200);
  assert.equal((await fetch(`${origin}${WORKBENCH_UI_PATH}/app.css`)).status, 200);
});

test('host workbench answers the page session as the host login and never asks for a second token', async t => {
  const handler = createHostWorkbench({ workbench: { url: 'http://127.0.0.1:1' } });
  const origin = await listen(t, handler);

  const session = await fetch(`${origin}${WORKBENCH_UI_PATH}/api/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true, loginRequired: false });
});

test('host workbench rejects agent and cross-site page writes', async t => {
  const { origin: gatewayOrigin, seen } = await gateway(t);
  const handler = createHostWorkbench({ workbench: { url: gatewayOrigin, token: 'private', pageRelaySecret: 'relay-private' } });
  const origin = await listen(t, handler);
  const api = `${origin}${WORKBENCH_UI_PATH}/api`;

  // Tools reach the workbench through the bearer API, never the person's browser session.
  const agent = await fetch(`${api}/tasks/abc/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-1agents-agent': '1' }, body: '{}',
  });
  assert.equal(agent.status, 403);
  assert.equal((await agent.json()).error, 'browser_action_required');

  const crossSite = await fetch(`${api}/tasks/abc/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}',
  });
  assert.equal(crossSite.status, 403);

  assert.equal(seen.length, 0, 'a rejected browser action must never reach the gateway');
});

test('host workbench relays page calls with the gateway credentials and hides them from the browser', async t => {
  const { origin: gatewayOrigin, seen } = await gateway(t);
  const handler = createHostWorkbench({ workbench: { url: gatewayOrigin, token: 'gateway-private', pageRelaySecret: 'relay-private' } });
  const origin = await listen(t, handler);
  const api = `${origin}${WORKBENCH_UI_PATH}/api`;

  const list = await fetch(`${api}/tasks`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { tasks: [] });

  const answer = await fetch(`${api}/tasks/abc/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ answer: 'yes' }),
  });
  assert.equal(answer.status, 200);

  assert.deepEqual(seen.map(call => `${call.method} ${call.url}`), [
    'GET /workbench/tasks',
    'POST /workbench/tasks/abc/answer',
  ]);
  // The browser holds neither the bearer token nor the relay secret.
  for (const call of seen) {
    assert.equal(call.authorization, 'Bearer gateway-private');
    assert.equal(call.relay, 'relay-private');
  }
  assert.equal(answer.headers.get('authorization'), null);
});

test('host workbench reports headless tasks as not openable instead of offering a takeover', async t => {
  const handler = createHostWorkbench({ workbench: { url: 'http://127.0.0.1:1' } });
  const origin = await listen(t, handler);

  const task = await fetch(`${origin}${WORKBENCH_UI_PATH}/api/dsh/tasks/task-1`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(task.status, 200);
  assert.deepEqual(await task.json(), { available: false, reason: 'headless_runtime' });
});

test('host workbench refuses process requests from the page and reports a missing gateway', async t => {
  const { origin: gatewayOrigin, seen } = await gateway(t);
  const configured = createHostWorkbench({ workbench: { url: gatewayOrigin, token: 'private' } });
  const origin = await listen(t, configured);

  const process = await fetch(`${origin}${WORKBENCH_UI_PATH}/api/tasks/abc/process-requests`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}',
  });
  assert.equal(process.status, 403);
  assert.equal(seen.length, 0, 'only the execution host opens process requests');

  const unconfigured = createHostWorkbench({});
  const bare = await listen(t, unconfigured);
  const relay = await fetch(`${bare}${WORKBENCH_UI_PATH}/api/tasks`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(relay.status, 503);
  assert.equal((await relay.json()).error, 'workbench_not_configured');
});

test('host workbench honours the host browser admission before doing any work', async t => {
  const handler = createHostWorkbench({
    workbench: { url: 'http://127.0.0.1:1' },
    admit: () => ({ rejection: 401 }),
  });
  const origin = await listen(t, handler);

  const api = await fetch(`${origin}${WORKBENCH_UI_PATH}/api/tasks`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error, 'login_required');

  // The page itself still loads so the host can render its own login prompt.
  assert.equal((await fetch(`${origin}${WORKBENCH_UI_PATH}/`)).status, 200);
});
