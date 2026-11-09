import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { DISCOVERY_METHODS, ProjectRoleDiscovery, projectDiscoveryConfigSchema } from '../src/execution/project-discovery.js';

const profile = { id: 'ppt', version: '1', instructionsPath: 'ROLE.md',
  skills: [{ key: 'slides', name: 'presentations' }] };
const call = async (discovery: ProjectRoleDiscovery, method: string, params: unknown = {}): Promise<any> => discovery.invoke(method, params);
async function role(project: string, name = 'ppt', value: unknown = profile) {
  const directory = path.join(project, '.1agents', 'roles', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'profile.json'), JSON.stringify(value));
  // Discovery must not open this symlink or try resolving role instructions.
  await symlink('/nonexistent/private/ROLE.md', path.join(directory, 'ROLE.md'));
  return directory;
}
async function fixture(t: TestContext, extra: Record<string, unknown> = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'project-discovery-'))), root = path.join(base, 'approved');
  await mkdir(root);
  const control = path.join(base, 'control.json'), log = path.join(base, 'calls.jsonl'), executable = path.join(base, 'fake-reader');
  await writeFile(control, JSON.stringify({ projects: [] }));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), config = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (config.fail) { process.stderr.write('token=DO_NOT_EXPOSE secret stderr'); process.exit(3); }
if (config.hang) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
const limit = Number(args[args.indexOf('--limit') + 1]), page = Number(args[args.indexOf('--page') + 1]);
const projects = config.projects || [], start = (page - 1) * limit;
const output = config.invalid ? 'not json' : JSON.stringify({projects:projects.slice(start,start+limit),hasMore:start+limit<projects.length,nextPage:page+1});
setTimeout(() => process.stdout.write(output), config.delay || 0);
`);
  await chmod(executable, 0o700);
  const stateDirectory = path.join(base, 'state'), config = { readerExecutable: executable, allowedRoots: [root], ...extra };
  const discovery = new ProjectRoleDiscovery({ stateDirectory, config: config as any });
  t.after(async () => { await discovery.close(); await rm(base, { recursive: true, force: true }); });
  const controlReader = (value: unknown) => writeFile(control, JSON.stringify(value));
  const calls = async () => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(value => JSON.parse(value)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  return { base, root, config, discovery, stateDirectory, controlReader, calls };
}
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for fake reader');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test('manual defaults and list/get are cache-only, with strict bounded configuration', async t => {
  const { discovery, calls, root, stateDirectory } = await fixture(t);
  assert.equal(projectDiscoveryConfigSchema.parse({ allowedRoots: [root] }).readerExecutable, '1session');
  assert.equal(projectDiscoveryConfigSchema.parse({ allowedRoots: [root] }).timeoutMs, 15_000);
  assert.throws(() => projectDiscoveryConfigSchema.parse({ allowedRoots: ['relative'] }));
  assert.throws(() => projectDiscoveryConfigSchema.parse({ allowedRoots: [] }));
  assert.equal(Object.keys(DISCOVERY_METHODS).length, 4);
  discovery.start(); discovery.start();
  assert.deepEqual(await call(discovery, 'execution_discovery_config_get'), { mode: 'manual' });
  assert.equal((await call(discovery, 'execution_project_list')).snapshot.status, 'idle');
  assert.deepEqual(await calls(), []);
  await assert.rejects(call(discovery, 'execution_discovery_config_update', { mode: 'interval' }));
  await assert.rejects(call(discovery, 'execution_discovery_config_update', { mode: 'interval', intervalMs: 59_999 }));
  await assert.rejects(call(discovery, 'execution_project_scan', { cwd: root }));
  assert.deepEqual(await readdir(stateDirectory), []);
});

test('Reader workspace aliases and ancestors discover only fixed role profiles, without merging worktrees or executing roles', async t => {
  const { root, discovery, calls, controlReader, stateDirectory } = await fixture(t);
  const first = path.join(root, 'clone-a'), second = path.join(root, 'clone-b');
  await role(first); await role(second);
  await mkdir(path.join(first, 'src', 'nested'), { recursive: true });
  await role(path.join(first, '.1agents', 'cache', 'roles', 'snapshot'), 'cached');
  await symlink(first, path.join(root, 'alias'));
  await symlink(path.join(first, '.1agents', 'cache', 'roles', 'snapshot'), path.join(root, 'cache-alias'));
  await controlReader({ projects: [{ id: 'same-git-origin', workspace: path.join(first, 'src', 'nested'),
    workspaces: [second, first, path.join(root, 'alias'), path.join(root, 'cache-alias'), path.join(first, '.1agents', 'cache', 'roles', 'snapshot')] }] });
  const result = await call(discovery, 'execution_project_scan');
  assert.equal(result.snapshot.status, 'complete');
  assert.deepEqual(result.snapshot.candidates.map((item: any) => item.projectRoot).sort(), [first, second].sort());
  assert.equal(new Set(result.snapshot.candidates.map((item: any) => item.key)).size, 2);
  assert.ok(result.snapshot.candidates.every((item: any) => item.status === 'candidate'));
  assert.ok(result.snapshot.candidates.every((item: any) => !('ready' in item) && !('registered' in item)));
  assert.deepEqual((await calls())[0], ['projects', '--scope', root, '--page', '1', '--limit', '50', '--json']);
  assert.deepEqual(await readdir(stateDirectory), ['discovery.json']);
  await call(discovery, 'execution_project_list'); await call(discovery, 'execution_discovery_config_get');
  assert.equal((await calls()).length, 1);
});

test('outside realpaths, unsafe role links and invalid/missing profiles stay diagnostics, never callable targets', async t => {
  const { root, base, discovery, controlReader } = await fixture(t);
  const safe = path.join(root, 'safe'), outside = path.join(base, 'outside');
  await role(safe); await role(outside);
  await symlink(outside, path.join(root, 'escape'));
  const roles = path.join(safe, '.1agents', 'roles');
  await mkdir(path.join(roles, 'missing'));
  await mkdir(path.join(roles, 'invalid'));
  await writeFile(path.join(roles, 'invalid', 'profile.json'), '{bad');
  await symlink(path.join(outside, '.1agents', 'roles', 'ppt'), path.join(roles, 'linked-role'));
  await mkdir(path.join(roles, 'linked-profile'));
  await symlink(path.join(outside, '.1agents', 'roles', 'ppt', 'profile.json'), path.join(roles, 'linked-profile', 'profile.json'));
  await mkdir(path.join(roles, 'fifo-profile'));
  execFileSync('mkfifo', [path.join(roles, 'fifo-profile', 'profile.json')]);
  await controlReader({ projects: [{ workspace: outside, workspaces: [safe, path.join(root, 'escape'), path.join(root, 'deleted')] }] });
  const result = await call(discovery, 'execution_project_scan');
  assert.equal(result.snapshot.candidates.length, 6);
  assert.ok(result.snapshot.candidates.every((item: any) => item.projectRoot === safe));
  assert.equal(result.snapshot.candidates.filter((item: any) => item.status === 'candidate').length, 1);
  assert.equal(result.snapshot.candidates.filter((item: any) => item.status === 'invalid').length, 4);
  assert.equal(result.snapshot.candidates.filter((item: any) => item.status === 'missing').length, 1);
  assert.ok(result.snapshot.diagnostics.some((item: any) => item.code === 'outside_allowed_roots'));
  assert.ok(result.snapshot.diagnostics.some((item: any) => item.code === 'project_missing'));
});

test('a shared project budget marks skipped allowed roots as partial even when the last page itself has no more results', async t => {
  const { root, base, config, controlReader } = await fixture(t);
  const second = path.join(base, 'second'); await mkdir(second);
  await controlReader({ projects: [{ workspace: root }] });
  const discovery = new ProjectRoleDiscovery({ stateDirectory: path.join(base, 'two-roots-state'),
    config: { ...config, allowedRoots: [root, second], maxProjects: 1 } as any });
  t.after(() => discovery.close());
  const result = await call(discovery, 'execution_project_scan');
  assert.equal(result.snapshot.status, 'partial');
  assert.ok(result.snapshot.diagnostics.some((item: any) => item.code === 'project_limit'));
});

test('individually valid large profiles cannot overflow persistence and preserve the complete earlier snapshot', async t => {
  const { root, discovery, controlReader, stateDirectory, config } = await fixture(t);
  const project = path.join(root, 'project'); await role(project);
  await controlReader({ projects: [{ workspace: project }] });
  const first = await call(discovery, 'execution_project_scan');
  const largeSkills = Array.from({ length: 100 }, (_, index) => ({ key: `skill${index}`, name: '大'.repeat(700) }));
  for (let index = 0; index < 45; index++) await role(project, `large${index}`, { ...profile, id: `large${index}`, skills: largeSkills });
  const result = await call(discovery, 'execution_project_scan');
  assert.equal(result.snapshot.status, 'partial');
  assert.ok(result.snapshot.diagnostics.some((item: any) => item.code === 'snapshot_limit'));
  assert.equal(result.snapshot.candidates.length, first.snapshot.candidates.length);
  assert.deepEqual(result.snapshot.candidates[0], { ...first.snapshot.candidates[0], status: 'stale' });
  assert.ok((await readFile(path.join(stateDirectory, 'discovery.json'))).length < 16 * 1024 * 1024);
  const restored = new ProjectRoleDiscovery({ stateDirectory, config: config as any });
  t.after(() => restored.close());
  assert.deepEqual(await call(restored, 'execution_project_list'), result);
});

test('Reader failures preserve old snapshots as stale and still inspect explicit roots; successful absence is missing', async t => {
  const { root, discovery, controlReader, stateDirectory, config } = await fixture(t);
  const project = path.join(root, 'project'); await role(project);
  await controlReader({ projects: [{ workspace: project }] });
  await call(discovery, 'execution_project_scan');
  await controlReader({ fail: true });
  const failed = await call(discovery, 'execution_project_scan');
  assert.equal(failed.snapshot.status, 'partial');
  assert.equal(failed.snapshot.candidates[0].status, 'stale');
  assert.ok(!JSON.stringify(failed).includes('DO_NOT_EXPOSE'));
  const explicit = new ProjectRoleDiscovery({ stateDirectory, config: { ...config, explicitRoots: [project] } as any });
  t.after(() => explicit.close());
  assert.equal((await call(explicit, 'execution_project_scan')).snapshot.candidates[0].status, 'candidate');
  await controlReader({ projects: [] });
  const missing = await call(discovery, 'execution_project_scan');
  assert.equal(missing.snapshot.status, 'complete');
  assert.equal(missing.snapshot.candidates[0].status, 'missing');
});

test('simultaneous scans coalesce, bounded pages do not drop prior candidates, and timeout/close kill Reader processes', async t => {
  const { root, discovery, calls, controlReader, config, stateDirectory } = await fixture(t, { maxProjects: 1, timeoutMs: 500 });
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  await role(first); await role(second);
  await controlReader({ projects: [{ workspace: first }, { workspace: second }], delay: 20 });
  const [a, b] = await Promise.all([call(discovery, 'execution_project_scan'), call(discovery, 'execution_project_scan')]);
  assert.deepEqual(a, b); assert.equal((await calls()).length, 1);
  assert.equal(a.snapshot.status, 'partial');
  assert.ok(a.snapshot.diagnostics.some((item: any) => item.code === 'project_limit'));
  await controlReader({ hang: true });
  const timed = await call(discovery, 'execution_project_scan');
  assert.equal(timed.snapshot.candidates[0].status, 'stale');
  const closing = new ProjectRoleDiscovery({ stateDirectory, config: { ...config, timeoutMs: 10_000 } as any });
  const pending = call(closing, 'execution_project_scan');
  await until(async () => (await calls()).length === 3);
  const before = performance.now(); await closing.close();
  assert.ok(performance.now() - before < 1000);
  assert.ok((await pending).snapshot.diagnostics.some((item: any) => item.code === 'scan_cancelled'));
  await assert.rejects(call(closing, 'execution_project_scan'), /closed/);
});

test('interval settings persist, background scans advance only after their interval, close stops them and failures stay contained', async t => {
  const { discovery, calls, controlReader, config, stateDirectory } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  discovery.start();
  t.mock.timers.tick(60_000); assert.equal((await calls()).length, 0);
  await call(discovery, 'execution_discovery_config_update', { mode: 'interval', intervalMs: 60_000 });
  t.mock.timers.tick(59_999); assert.equal((await calls()).length, 0);
  t.mock.timers.tick(1);
  await until(async () => (await call(discovery, 'execution_project_list')).snapshot.status === 'complete');
  assert.equal((await calls()).length, 1);
  await controlReader({ fail: true });
  t.mock.timers.tick(60_000);
  await until(async () => (await call(discovery, 'execution_project_list')).snapshot.status === 'partial');
  assert.equal((await calls()).length, 2);
  await discovery.close();
  t.mock.timers.tick(180_000); assert.equal((await calls()).length, 2);
  const restored = new ProjectRoleDiscovery({ stateDirectory, config: config as any });
  t.after(() => restored.close());
  assert.deepEqual(await call(restored, 'execution_discovery_config_get'), { mode: 'interval', intervalMs: 60_000 });
  await call(restored, 'execution_discovery_config_update', { mode: 'manual' });
  restored.start(); t.mock.timers.tick(180_000);
  assert.equal((await calls()).length, 2);
  t.mock.timers.reset();
});
