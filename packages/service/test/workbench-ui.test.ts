import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serveA2AGateway } from '../src/a2a/gateway.js';

const uiDir = fileURLToPath(new URL('../dist/workbench-ui/', import.meta.url));

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
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /frame-ancestors 'none'/);
  // The page carries its own inline SVG icon, so the browser never asks for /favicon.ico; data: images stay allowed.
  assert.match(csp, /img-src 'self' data:/);
  const html = await page.text();
  assert.match(html, /\/workbench\/ui\/app\.js/);
  assert.match(html, /<link rel="icon"[^>]*data:image\/svg\+xml/i);
  assert.doesNotMatch(html, /favicon\.ico/);
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

test('the workbench entry is code-split and only hashed chunks are immutable', async t => {
  const { base } = await fixture(t);
  const names = await readdir(uiDir);
  const chunks = names.filter(name => /^chunk-[A-Za-z0-9_-]+\.js$/.test(name));
  assert.ok(chunks.length >= 2, `expected module chunks, got ${names.join(', ')}`);
  const entry = await readFile(join(uiDir, 'app.js'), 'utf8');
  const entryStat = await stat(join(uiDir, 'app.js'));
  assert.ok(entryStat.size < 60 * 1024, `app.js is ${entryStat.size} bytes; expected a slim shell under 60KB`);
  assert.match(entry, /import\(/, 'the shell should lazy-load module chunks');
  assert.ok(chunks.some(name => entry.includes(name) || entry.includes('chunk-')), 'the shell should reference a split chunk');

  const page = await fetch(`${base}/workbench/ui/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const app = await fetch(`${base}/workbench/ui/app.js`);
  assert.equal(app.status, 200);
  assert.equal(app.headers.get('cache-control'), 'no-store');
  const css = await fetch(`${base}/workbench/ui/app.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('cache-control'), 'no-store');
  // Mobile filter chips keep their label on one line and let the bar scroll instead of stacking glyphs.
  const cssText = await readFile(join(uiDir, 'app.css'), 'utf8');
  assert.match(cssText, /\.acp-workbench-views button[^}]*flex: 0 0 auto/);
  assert.match(cssText, /\.acp-workbench-views button[^}]*white-space: nowrap/);
  assert.match(cssText, /\.acp-header-actions[^}]*flex: 0 0 auto/);
  // All four desktop split-pane tabs (approvals, cases, tasks, agents) lock to viewport height with independent pane scrolling.
  assert.match(cssText, /\.acp-workbench:not\(\.is-full-detail\)\s*\{[^}]*height:\s*100dvh;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/);
  assert.match(cssText, /\.acp-workbench:not\(\.is-full-detail\)\s*>\s*\.acp-approvals,\s*\.acp-workbench:not\(\.is-full-detail\)\s*>\s*\.acp-agent-module\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/);
  assert.match(cssText, /\.acp-workbench:not\(\.is-full-detail\)\s+\.acp-workbench-body,\s*\.acp-workbench:not\(\.is-full-detail\)\s+\.acp-approvals-split,\s*\.acp-workbench:not\(\.is-full-detail\)\s+\.acp-agent-layout\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/);
  for (const pane of ['.acp-workbench-table', '.acp-detail', '.acp-approval-queue', '.acp-approval-detail', '.acp-agent-list', '.acp-agent-detail']) {
    assert.match(cssText, new RegExp(`\\.acp-workbench:not\\(\\.is-full-detail\\)\\s+\\${pane}[^{]*\\{[^}]*min-height:\\s*0;[^}]*overflow-y:\\s*auto;[^}]*overscroll-behavior:\\s*contain;`));
  }
  assert.match(cssText, /@media \(max-width: 768px\)\s*\{[\s\S]*\.acp-workbench:not\(\.is-full-detail\)\s*\{[^}]*height:\s*auto;[^}]*display:\s*block;[^}]*overflow:\s*visible;/);
  const session = await fetch(`${base}/workbench/ui/api/session`);
  assert.equal(session.headers.get('cache-control'), 'no-store');

  const chunk = await fetch(`${base}/workbench/ui/${chunks[0]}`);
  assert.equal(chunk.status, 200);
  assert.equal(chunk.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await fetch(`${base}/workbench/ui/chunk-MISSING.js`)).status, 404);
  assert.equal((await fetch(`${base}/workbench/ui/chunk-..%2Fapp.js`)).status, 404);
  assert.equal((await fetch(`${base}/workbench/ui/chunk-x.css`)).status, 404);
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
