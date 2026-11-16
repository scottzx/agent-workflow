import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startA2AService } from '../src/server.js';

test('standalone workbench serves assets, authenticates, relays human actions and hides gateway credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'a2a-page-'));
  const calls = [];
  const gateway = createServer((req, res) => {
    calls.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ tasks: [] }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const service = await startA2AService({ port: 0, publicUrl: 'http://127.0.0.1:3080', token: 'page-token', stateDirectory: dir,
    workbench: { url: `http://127.0.0.1:${gateway.address().port}`, token: 'gateway-private', pageRelaySecret: 'relay-private' } });
  t.after(async () => { await service.close(); await new Promise(resolve => gateway.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${service.server.address().port}`, api = `${origin}/workbench/ui/api`;
  const page = await fetch(`${origin}/workbench/ui`);
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${origin}/workbench/ui/app.js`)).status, 200);
  assert.equal((await fetch(`${api}/tasks`)).status, 401);
  assert.equal((await fetch(`${api}/session`, { method: 'POST', body: JSON.stringify({ token: 'page-token' }) })).status, 403);
  const login = await fetch(`${api}/session`, { method: 'POST', headers: { Origin: origin, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ token: 'page-token' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const result = await fetch(`${api}/tasks?limit=2`, { headers: { Cookie: cookie } });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { tasks: [] });
  assert.equal(calls[0].url, '/workbench/tasks?limit=2');
  assert.equal(calls[0].headers.authorization, 'Bearer gateway-private');
  assert.equal(calls[0].headers.cookie, undefined);
  assert.equal((await fetch(`${api}/tasks/job/review`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'sec-fetch-site': 'same-origin' }, body: '{}' })).status, 200);
  assert.equal(calls[1].headers['x-workbench-page-relay'], 'relay-private');
  assert.equal((await fetch(`${api}/tasks`, { headers: { Cookie: cookie, Authorization: 'Bearer page-token' } })).status, 403);
  assert.equal((await (await fetch(`${api}/dsh/tasks/task`, { headers: { Cookie: cookie } })).json()).available, false);
});
