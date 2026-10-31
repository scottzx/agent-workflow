import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { workbenchHandler } from '../dist/workbench.js';
import { REVIEW_SUBMIT_PATH, ReviewHandBack, SUBMIT_TOOL } from '../dist/review.js';

async function listen(t, handler) {
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A gateway bearer API that records what reached it. */
async function gateway(t) {
  const seen = [];
  const origin = await listen(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, relay: req.headers['x-workbench-page-relay'], cookie: req.headers.cookie, origin: req.headers.origin, body });
    if (req.url.includes('/artifacts/')) {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff', 'Set-Cookie': 'leak=1' });
      return res.end('# bytes');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
  });
  return { origin, seen };
}

test('DSH serves the workbench page framed by itself and forwards only owner browser calls with the gateway token', async t => {
  const gw = await gateway(t);
  const ctx = {
    connection: { admit: req => req.headers.cookie === 'dsh=owner' ? { peer: { principal: { kind: 'owner' } } }
      : req.headers.cookie === 'dsh=guest' ? { peer: { principal: { kind: 'remote' } } } : { rejection: 401 } },
    sessionController: { inspect: async id => id === 'local-session' ? { meta: { id } } : null },
  };
  const host = { taskSession: id => ({ 'local-task': 'local-session', 'gone-task': 'gone-session' })[id],
    sessionTask: id => id === 'local-session' ? { taskId: 'local-task', contextId: 'c', jobId: 'j', state: 'TASK_STATE_COMPLETED', running: false, resubmittable: true } : undefined };
  const dsh = await listen(t, workbenchHandler(ctx, { workbench: { url: `${gw.origin}/ignored-path`, token: 'gw-token', pageRelaySecret: 'page-relay-secret' }, host: () => host }));
  const owner = { cookie: 'dsh=owner' }, write = { ...owner, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

  const page = await fetch(`${dsh}/workbench/ui/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal((await fetch(`${dsh}/workbench/ui/api/tasks`)).status, 401, 'no DSH login, no API');
  assert.equal((await fetch(`${dsh}/workbench/ui/api/tasks`, { headers: { cookie: 'dsh=guest' } })).status, 403, 'only the owner reviews');
  assert.deepEqual(await (await fetch(`${dsh}/workbench/ui/api/session`, { headers: owner })).json(), { authenticated: true, loginRequired: false });

  const list = await fetch(`${dsh}/workbench/ui/api/tasks?filter=all`, { headers: owner });
  assert.equal(list.status, 200);
  assert.deepEqual(gw.seen.at(-1), { method: 'GET', url: '/workbench/tasks?filter=all', authorization: 'Bearer gw-token', relay: 'page-relay-secret', cookie: undefined, origin: undefined, body: '' });
  const decide = await fetch(`${dsh}/workbench/ui/api/tasks/j/reviews/r/decisions`, { method: 'POST', headers: write, body: '{"action":"approve"}' });
  assert.equal(decide.status, 200);
  assert.equal(gw.seen.at(-1).body, '{"action":"approve"}');
  assert.equal(gw.seen.at(-1).relay, 'page-relay-secret', 'the gateway accepts a decision only from a relayed page');
  const artifact = await fetch(`${dsh}/workbench/ui/api/tasks/j/artifacts/${'a'.repeat(64)}`, { headers: owner });
  assert.equal(await artifact.text(), '# bytes');
  assert.equal(artifact.headers.get('content-security-policy'), 'sandbox', 'the gateway sandbox reaches the browser');
  assert.equal(artifact.headers.get('set-cookie'), null);

  const before = gw.seen.length;
  assert.equal((await fetch(`${dsh}/workbench/ui/api/tasks/j/reviews/r/decisions`, { method: 'POST', headers: owner, body: '{}' })).status, 403, 'writes need a same-origin page');
  assert.equal((await fetch(`${dsh}/workbench/ui/api/tasks/j/process-requests`, { method: 'POST', headers: write, body: '{}' })).status, 403, 'only the host opens process requests');
  assert.equal((await fetch(`${dsh}/workbench/ui/api/tasks`, { headers: { ...owner, authorization: 'Bearer x' } })).status, 403, 'agents never act as the reviewer');
  assert.equal(gw.seen.length, before);

  assert.deepEqual(await (await fetch(`${dsh}/workbench/ui/api/dsh/tasks/local-task`, { headers: owner })).json(),
    { available: true, sessionId: 'local-session', task: host.sessionTask('local-session') });
  assert.deepEqual(await (await fetch(`${dsh}/workbench/ui/api/dsh/tasks/remote-task`, { headers: owner })).json(), { available: false }, 'another host ran it');
  assert.deepEqual(await (await fetch(`${dsh}/workbench/ui/api/dsh/tasks/gone-task`, { headers: owner })).json(), { available: false }, 'its session was deleted');
  assert.equal((await fetch(`${dsh}/workbench/ui/api/dsh/tasks/local-task`)).status, 401);
});

test('an ACP agent hands its session back through the stdio MCP server, bound to that session only', async t => {
  const gw = await gateway(t);
  const directory = await mkdtemp(join(tmpdir(), 'review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const review = await ReviewHandBack.open(join(directory, 'review.secret'), { url: gw.origin, token: 'gw-token' });
  assert.equal((await stat(join(directory, 'review.secret'))).mode & 0o777, 0o600);
  const submitted = [];
  review.host = { sessionTask: () => undefined, resubmit: async input => { submitted.push(input);
    return { taskId: 't', contextId: 'c', jobId: 'job-1', artifacts: [{ path: '/x/a.md', size: 1, sha256: 'a'.repeat(64) }], validation: 'passed', submittedAt: 'now' }; } };
  const dsh = await listen(t, (req, res) => req.url === REVIEW_SUBMIT_PATH ? review.handler(req, res) : (res.writeHead(404), res.end()));

  const server = review.mcpServer('session-1', dsh);
  const child = spawn(server.command, server.args, { env: Object.fromEntries(server.env.map(item => [item.name, item.value])), stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const rpc = async (id, method, params) => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return JSON.parse((await lines.next()).value); };
  assert.equal((await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result.protocolVersion, '2025-06-18');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  assert.deepEqual((await rpc(2, 'tools/list')).result.tools.map(tool => tool.name), [SUBMIT_TOOL]);
  const called = await rpc(3, 'tools/call', { name: SUBMIT_TOOL, arguments: { summary: '人工修订完成' } });
  assert.equal(called.result.isError, undefined);
  assert.match(called.result.content[0].text, /job-1/);
  assert.deepEqual(submitted, [{ sessionId: 'session-1', summary: '人工修订完成' }]);
  assert.deepEqual(gw.seen.map(item => [item.method, item.url, item.authorization]), [['POST', '/workbench/tasks/job-1/refresh', 'Bearer gw-token']]);

  // The token names one session; it cannot submit another one.
  const token = server.env.find(item => item.name === 'ONEAGENTS_REVIEW_TOKEN').value;
  const post = headers => fetch(`${dsh}${REVIEW_SUBMIT_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"summary":"x"}' });
  assert.equal((await post({ Authorization: `Bearer ${token}`, 'X-Oneagents-Session': 'session-2' })).status, 401);
  assert.equal((await post({ 'X-Oneagents-Session': 'session-1' })).status, 401);
  assert.equal((await post({ Authorization: `Bearer ${token}`, 'X-Oneagents-Session': 'session-1', Origin: 'http://evil.example' })).status, 403);
  review.host.resubmit = async () => { throw Object.assign(new Error('The A2A turn is still running'), { code: 'TASK_RUNNING' }); };
  const refused = await rpc(4, 'tools/call', { name: SUBMIT_TOOL, arguments: { summary: 'again' } });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /still running/);
  assert.equal(submitted.length, 1);
  // The secret survives a host restart, so a running agent's token stays valid.
  const reopened = await ReviewHandBack.open(join(directory, 'review.secret'));
  assert.equal(reopened.mcpServer('session-1', dsh).env.find(item => item.name === 'ONEAGENTS_REVIEW_TOKEN').value, token);
});
