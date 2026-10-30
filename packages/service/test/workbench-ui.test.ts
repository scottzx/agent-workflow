import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { serveA2AGateway } from '../src/a2a/gateway.js';

const token = 'workbench-page-test-credential';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-ui-'));
  const host = await serveA2AGateway({ stateDirectory: join(root, 'state'), port: 0, remotes: {}, pollIntervalMs: 60_000,
    workbench: { token, reviewerId: 'local-owner' } }, { report: false });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${host.port}`;
  const browser = (cookie?: string, extra: Record<string, string> = {}) => ({
    'Sec-Fetch-Site': 'same-origin', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...extra,
  });
  return { base, browser };
}

test('the gateway serves its own workbench page with a hardened document', async t => {
  const { base } = await fixture(t);
  const page = await fetch(`${base}/workbench/ui/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.match(await page.text(), /\/workbench\/ui\/app\.js/);
  assert.equal((await fetch(`${base}/workbench/ui/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/workbench/ui/build.mjs`)).status, 404);
  // Only generated renderer chunks are served besides the entry files; names that merely look similar are not.
  assert.equal((await fetch(`${base}/workbench/ui/chunk-MISSING.js`)).status, 404);
  assert.equal((await fetch(`${base}/workbench/ui/chunk-..%2Fapp.js`)).status, 404);
  assert.equal((await fetch(`${base}/workbench/ui/chunk-x.css`)).status, 404);
  assert.equal((await fetch(`${base}/workbench/ui/index.html`)).status, 404);
});

test('page login uses an HttpOnly cookie, and page writes need a same-origin browser', async t => {
  const { base, browser } = await fixture(t);
  assert.equal((await fetch(`${base}/workbench/ui/api/tasks`)).status, 401);
  const wrong = await fetch(`${base}/workbench/ui/api/session`, { method: 'POST', headers: browser(), body: JSON.stringify({ token: 'nope' }) });
  assert.equal(wrong.status, 401);
  const crossSite = await fetch(`${base}/workbench/ui/api/session`, { method: 'POST',
    headers: { ...browser(), 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ token }) });
  assert.equal(crossSite.status, 403);
  const login = await fetch(`${base}/workbench/ui/api/session`, { method: 'POST', headers: browser(), body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/workbench\/ui/);
  assert.ok(!setCookie.includes(token), 'the cookie is a session id, not the workbench token');
  const cookie = setCookie.split(';')[0]!;

  const list = await fetch(`${base}/workbench/ui/api/tasks?filter=all`, { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  const bearer = await fetch(`${base}/workbench/tasks?filter=all`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await list.json(), await bearer.json());

  const draft = { name: 'Excel 求和', acpAgent: 'grok-build', targetId: 'legacy:iso', modeId: 'acceptEdits', options: [] };
  const forged = await fetch(`${base}/workbench/ui/api/agents`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(draft) });
  assert.equal(forged.status, 403);
  const agentTool = await fetch(`${base}/workbench/ui/api/agents`, { method: 'POST',
    headers: browser(cookie, { 'X-OneAgents-Origin': 'mcp' }), body: JSON.stringify(draft) });
  assert.equal(agentTool.status, 403);
  const created = await fetch(`${base}/workbench/ui/api/agents`, { method: 'POST', headers: browser(cookie), body: JSON.stringify(draft) });
  assert.equal(created.status, 200);
  const catalog = await created.json() as { draft: { agentId: string }; developing: unknown[] };
  assert.equal(catalog.developing.length, 1);

  const opened = await fetch(`${base}/workbench/ui/api/tasks/job-1/process-requests`, { method: 'POST', headers: browser(cookie), body: '{}' });
  assert.equal(opened.status, 403);

  const logout = await fetch(`${base}/workbench/ui/api/session`, { method: 'DELETE', headers: browser(cookie) });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${base}/workbench/ui/api/tasks`, { headers: { Cookie: cookie } })).status, 401);
});

test('the bearer workbench API still refuses browser origins', async t => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/workbench/tasks`, { headers: { Authorization: `Bearer ${token}`, Origin: base } });
  assert.equal(response.status, 403);
});

test('without a workbench token the page and API need no login, and page writes still need a same-origin browser', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-ui-open-'));
  const host = await serveA2AGateway({ stateDirectory: join(root, 'state'), port: 0, remotes: {}, pollIntervalMs: 60_000,
    workbench: { reviewerId: 'local-owner' } }, { report: false });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${host.port}`;
  assert.deepEqual(await (await fetch(`${base}/workbench/ui/api/session`)).json(), { authenticated: true, loginRequired: false });
  assert.equal((await fetch(`${base}/workbench/ui/api/tasks`)).status, 200);
  assert.equal((await fetch(`${base}/workbench/tasks?filter=all`)).status, 200);
  const draft = { name: 'Excel 求和', acpAgent: 'grok-build', targetId: 'legacy:iso', modeId: 'acceptEdits', options: [] };
  assert.equal((await fetch(`${base}/workbench/ui/api/agents`, { method: 'POST', body: JSON.stringify(draft) })).status, 403);
  const created = await fetch(`${base}/workbench/ui/api/agents`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', Origin: base }, body: JSON.stringify(draft) });
  assert.equal(created.status, 200);
});
