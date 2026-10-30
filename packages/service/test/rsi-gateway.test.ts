import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { serveA2AGateway } from '../src/a2a/gateway.js';

const ROLE = resolve(import.meta.dirname, '../../../.1agents/roles/product-intro-outline');
const relaySecret = 'page-relay-secret-for-rsi-gateway-tests-001';
const evaluation = { evaluatedAt: '2026-10-31T00:00:00.000Z', results: [
  { caseId: 'xingjian-showroom', kind: 'original', passed: true, rounds: 1, failedItems: [] },
  { caseId: 'dreammate-network', kind: 'variant', passed: false, rounds: 0, failedItems: ['features-unconfirmed'] },
] };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gateway-'));
  const role = join(root, 'role');
  await cp(ROLE, role, { recursive: true });
  const host = await serveA2AGateway({ stateDirectory: join(root, 'state'), port: 0, remotes: {}, pollIntervalMs: 60_000,
    workbench: { reviewerId: 'local-owner', reviewerName: 'Scott', pageRelaySecret: relaySecret },
    rsi: { roles: { 'product-intro-outline': { directory: role, preset: 'standard' } }, snapshotRoot: join(root, 'snapshots') } }, { report: false });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${host.port}`;
  const invoke = async (method: string, params: unknown) => {
    const response = await fetch(`${base}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    return { status: response.status, body: await response.json() as any };
  };
  const page = (path: string, body?: unknown, relay = true) => fetch(`${base}/workbench${path}`, body === undefined ? {} : { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(relay ? { 'X-Workbench-Page-Relay': relaySecret } : {}) }, body: JSON.stringify(body) });
  return { role, invoke, page };
}

test('a coach proposes through the CLI methods; only an evaluated version goes live, and only from the page', async t => {
  const f = await fixture(t);
  const v1 = await f.invoke('rsi_version_propose', { roleId: 'product-intro-outline', summary: '初始版本' });
  assert.equal(v1.status, 200); assert.equal(v1.body.version, 'v1');
  assert.equal((await f.invoke('rsi_version_evaluation', { roleId: 'product-intro-outline', version: 'v1', evaluation })).status, 200);
  assert.equal((await f.page('/rsi/roles/product-intro-outline/versions/v1/publish', {})).status, 200);

  await writeFile(join(f.role, 'ROLE.md'), `${await readFile(join(f.role, 'ROLE.md'), 'utf8')}\n先读 README 的功能表，再看 src 入口。\n`);
  const v2 = await f.invoke('rsi_version_propose', { roleId: 'product-intro-outline', summary: '补充读仓库的顺序' });
  assert.equal(v2.body.parent, 'v1'); assert.deepEqual(v2.body.changes.modified, ['ROLE.md']);

  const gate = await (await f.page('/rsi')).json() as any;
  assert.equal(gate.roles[0].published, 'v1');
  assert.deepEqual(gate.roles[0].versions.map((item: any) => [item.version, item.status]), [['v2', 'proposed'], ['v1', 'published']]);
  const diff = await (await f.page('/rsi/roles/product-intro-outline/versions/v2/diff')).json() as any;
  assert.match(diff.diff, /^\+先读 README 的功能表，再看 src 入口。$/m);
  assert.match(diff.diff, /a\/v1\/ROLE\.md b\/v2\/ROLE\.md/);

  assert.equal((await f.page('/rsi/roles/product-intro-outline/versions/v2/publish', {}, false)).status, 403, 'bearer callers cannot publish');
  assert.ok(!('rsi_version_publish' in (await f.invoke('rsi_version_list', { roleId: 'product-intro-outline' })).body), 'no publish method for agents');
  const early = await f.page('/rsi/roles/product-intro-outline/versions/v2/publish', {});
  assert.equal(early.status, 409); assert.match((await early.json() as any).message, /no evaluation results/);
  await f.invoke('rsi_version_evaluation', { roleId: 'product-intro-outline', version: 'v2', evaluation });
  const live = await (await f.page('/rsi/roles/product-intro-outline/versions/v2/publish', { note: '看过 diff，变体题还没跑，先上' })).json() as any;
  assert.equal(live.published.status, 'published'); assert.equal(live.published.decision.displayName, 'Scott');
  assert.equal(live.roles[0].published, 'v2');
});

test('a proposal that loosens a locked check is refused over the CLI methods', async t => {
  const f = await fixture(t);
  await f.invoke('rsi_version_propose', { roleId: 'product-intro-outline', summary: '初始版本' });
  await f.invoke('rsi_version_evaluation', { roleId: 'product-intro-outline', version: 'v1', evaluation });
  await f.page('/rsi/roles/product-intro-outline/versions/v1/publish', {});
  const checklist = join(f.role, 'checklist.json');
  await writeFile(checklist, (await readFile(checklist, 'utf8')).replace('"rule": "四档字号都是整数"', '"rule": "字号随意"'));
  const refused = await f.invoke('rsi_version_propose', { roleId: 'product-intro-outline', summary: '放宽字号' });
  assert.equal(refused.status, 400); assert.match(refused.body.error, /P3 is locked/);
});
