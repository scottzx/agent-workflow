import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RoleVersionRegistry, VersionLockError } from '../src/rsi/versions.js';

const ROLE = resolve(import.meta.dirname, '../../../.1agents/roles/product-intro-outline');
const evaluation = { evaluatedAt: '2026-10-31T00:00:00.000Z', results: [{ caseId: 'xingjian-showroom', kind: 'original' as const, passed: true, rounds: 1, failedItems: [] }] };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const role = join(root, 'role');
  await cp(ROLE, role, { recursive: true });
  const open = () => new RoleVersionRegistry(join(root, 'rsi-versions.json'), join(root, 'snapshots'), { 'product-intro-outline': { directory: role, preset: 'standard' } });
  const edit = async (file: string, change: (text: string) => string) => writeFile(join(role, file), change(await readFile(join(role, file), 'utf8')));
  return { root, role, open, edit };
}

/** The first version is the baseline a person publishes; later proposals are checked against it. */
async function published(f: Awaited<ReturnType<typeof fixture>>) {
  const registry = f.open(), v1 = await registry.propose('product-intro-outline', '初始版本');
  registry.evaluate('product-intro-outline', v1.version, evaluation);
  registry.publish('product-intro-outline', v1.version, { id: 'local-owner' });
  return registry;
}

test('a proposal freezes the role directory read-only, diffs it against the live version and survives a restart', async t => {
  const f = await fixture(t), registry = await published(f);
  await assert.rejects(registry.propose('product-intro-outline', '没改'), /Nothing changed/);
  await f.edit('ROLE.md', text => `${text}\n## 新经验\n\n先读 README 的功能表。\n`);
  const v2 = await registry.propose('product-intro-outline', '补充读 README 的做法');
  assert.equal(v2.version, 'v2'); assert.equal(v2.parent, 'v1'); assert.equal(v2.status, 'proposed');
  assert.deepEqual(v2.changes, { added: [], modified: ['ROLE.md'], removed: [] });
  assert.equal(v2.checklistChanged, false);
  assert.deepEqual(v2.preset, { id: 'standard', locked: true });
  assert.equal((await stat(join(v2.snapshot.directory, 'ROLE.md'))).mode & 0o222, 0, 'the snapshot is read-only');
  assert.match(await readFile(join(v2.snapshot.directory, 'ROLE.md'), 'utf8'), /新经验/);
  const reopened = f.open();
  assert.equal(reopened.published('product-intro-outline')!.version, 'v1');
  assert.equal(reopened.list('product-intro-outline').length, 2);
});

test('changing a locked item is refused and leaves no version behind', async t => {
  const f = await fixture(t), registry = await published(f);
  await f.edit('checklist.json', text => text.replace('"rule": "字体是微软雅黑"', '"rule": "字体随意"'));
  await f.edit('checks/check_outline.py', text => text.replace("family == '微软雅黑'", "family != ''"));
  await f.edit('cases/xingjian-showroom/case.json', text => text.replace('"locked": true', '"locked": false'));
  const error = await registry.propose('product-intro-outline', '放宽字体').then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof VersionLockError);
  assert.deepEqual(error.violations.sort(), [
    'cases/xingjian-showroom/case.json: cases are kept by people',
    'checklist.json: P2 is locked',
    'checks/check_outline.py: program checks are locked',
  ]);
  assert.deepEqual(registry.list('product-intro-outline').map(v => v.version), ['v1']);
  await assert.rejects(stat(join(f.root, 'snapshots', 'product-intro-outline', 'v2')), 'a refused proposal keeps no snapshot');
});

test('a new unlocked checklist item is allowed and flagged for the release gate', async t => {
  const f = await fixture(t), registry = await published(f);
  await f.edit('checklist.json', text => {
    const checklist = JSON.parse(text);
    checklist.items.push({ id: 'A3', type: 'agent', source: 'task', severity: 'warn', locked: false, rule: '截图章节引用的图片确实存在于项目里' });
    return JSON.stringify(checklist, null, 2);
  });
  const v2 = await registry.propose('product-intro-outline', '加一条截图检查');
  assert.equal(v2.checklistChanged, true);
  assert.deepEqual(v2.changes.modified, ['checklist.json']);
});

test('only an evaluated proposal can go live, and a newer proposal replaces one still waiting', async t => {
  const f = await fixture(t), registry = await published(f);
  await f.edit('ROLE.md', text => `${text}\n第一次修改\n`);
  const v2 = await registry.propose('product-intro-outline', '第一次');
  assert.throws(() => registry.publish('product-intro-outline', v2.version, { id: 'local-owner' }), /no evaluation results/);
  await f.edit('ROLE.md', text => `${text}\n第二次修改\n`);
  const v3 = await registry.propose('product-intro-outline', '第二次');
  assert.equal(registry.get('product-intro-outline', 'v2').status, 'superseded');
  assert.throws(() => registry.evaluate('product-intro-outline', 'v2', evaluation), /Only a proposed version/);
  registry.evaluate('product-intro-outline', v3.version, evaluation);
  const live = registry.publish('product-intro-outline', v3.version, { id: 'local-owner', displayName: 'Scott' }, '看过 diff 和复验');
  assert.equal(live.status, 'published'); assert.equal(live.decision!.displayName, 'Scott');
  assert.equal(registry.get('product-intro-outline', 'v1').status, 'superseded');
  assert.equal(registry.published('product-intro-outline')!.version, 'v3');
});
