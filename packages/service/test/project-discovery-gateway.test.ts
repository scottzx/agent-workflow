import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { REMOTE_AGENT_METHODS, RemoteAgentGateway, serveA2AGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import { DISCOVERY_METHODS } from '../src/execution/project-discovery.js';

const post = (method: string, params: unknown = {}): RequestInit => ({ method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'discovery-gateway-')));
  const project = join(root, 'project'), roleDirectory = join(project, '.1agents', 'roles', 'designer');
  await mkdir(roleDirectory, { recursive: true });
  await writeFile(join(roleDirectory, 'profile.json'), JSON.stringify({ id: 'designer', version: '1.0.0',
    skills: [{ key: 'slides', name: 'Slides' }] }));
  const output = join(root, 'reader-output.json'), calls = join(root, 'reader-calls.jsonl'), pid = join(root, 'reader.pid');
  const behavior = join(root, 'reader-behavior.txt'), reader = join(root, 'fake-reader.cjs');
  await writeFile(output, JSON.stringify({ projects: [{ workspace: project }], hasMore: false }));
  await writeFile(behavior, 'complete');
  await writeFile(reader, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
const behavior = fs.readFileSync(${JSON.stringify(behavior)}, 'utf8');
if (behavior === 'hold') setInterval(() => {}, 1000);
else if (behavior === 'fail') { process.stderr.write('fixture Reader unavailable'); process.exitCode = 2; }
else process.stdout.write(fs.readFileSync(${JSON.stringify(output)}));
`);
  await chmod(reader, 0o700);
  const config: A2AGatewayConfig = { stateDirectory: join(root, 'state'), port: 0, remotes: {}, pollIntervalMs: 50,
    projectDiscovery: { readerExecutable: reader, allowedRoots: [root], timeoutMs: 5000 } };
  const hosts = new Set<Awaited<ReturnType<typeof serveA2AGateway>>>();
  t.after(async () => { for (const host of hosts) await host.close(); await rm(root, { recursive: true, force: true }); });
  const open = async (overrides: Partial<A2AGatewayConfig> = {}) => {
    const host = await serveA2AGateway({ ...config, ...overrides }, { report: false }); hosts.add(host); return host;
  };
  return { root, project, roleDirectory, reader, calls, pid, behavior, config, open,
    request: (host: Awaited<ReturnType<typeof serveA2AGateway>>, path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${host.port}${path}`, init),
  };
}

test('discovery methods are explicitly disabled without trusted configuration while ordinary gateway APIs remain available', async t => {
  const f = await fixture(t), host = await f.open({ projectDiscovery: undefined });
  for (const method of Object.keys(DISCOVERY_METHODS)) {
    assert.ok(Object.hasOwn(REMOTE_AGENT_METHODS, method));
    const response = await f.request(host, '/invoke', post(method));
    assert.equal(response.status, 400); assert.match((await response.json() as any).error, /discovery is disabled/i);
  }
  assert.equal((await f.request(host, '/health')).status, 200);
  assert.deepEqual(await host.gateway.invoke('execution_target_list', {}), { targets: [] });
  await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
});

test('manual discovery only caches project role candidates and preserves settings across gateway restart', async t => {
  const f = await fixture(t); let host = await f.open();
  assert.deepEqual(await host.gateway.invoke('execution_discovery_config_get', {}), { mode: 'manual' });
  const initial = await host.gateway.invoke('execution_project_list', {}) as any;
  assert.equal(initial.snapshot.status, 'idle'); assert.deepEqual(initial.snapshot.candidates, []);
  // Several ordinary job-reconcile ticks must not cause a Reader scan.
  await new Promise(resolve => setTimeout(resolve, 120));
  await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
  const ledger = host.gateway.ledger.snapshot(), targets = await host.gateway.invoke('execution_target_list', {});
  const response = await f.request(host, '/invoke', post('execution_project_scan'));
  assert.equal(response.status, 200);
  const scanned = await response.json() as any;
  assert.equal(scanned.snapshot.status, 'complete'); assert.equal(scanned.snapshot.candidates.length, 1);
  const candidate = scanned.snapshot.candidates[0];
  assert.equal(candidate.projectRoot, f.project); assert.equal(candidate.profilePath, join(f.roleDirectory, 'profile.json'));
  assert.equal(candidate.roleId, 'designer'); assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.ready, undefined); assert.equal(candidate.registered, undefined);
  assert.deepEqual(host.gateway.ledger.snapshot(), ledger);
  assert.deepEqual(await host.gateway.invoke('execution_target_list', {}), targets);
  assert.deepEqual(await host.gateway.invoke('execution_inbox', { originSessionId: 'root' }), { notices: [] });
  assert.deepEqual((await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    [['projects', '--scope', f.root, '--page', '1', '--limit', '50', '--json']]);
  assert.deepEqual(await host.gateway.invoke('execution_project_list', {}), scanned);
  await host.gateway.invoke('execution_discovery_config_update', { mode: 'interval', intervalMs: 60_000 });
  await host.close(); host = await f.open();
  assert.deepEqual(await host.gateway.invoke('execution_discovery_config_get', {}), { mode: 'interval', intervalMs: 60_000 });
  assert.deepEqual((await host.gateway.invoke('execution_project_list', {}) as any).snapshot, scanned.snapshot);
  assert.equal((await readFile(f.calls, 'utf8')).trim().split('\n').length, 1);
  const persistent = JSON.parse(await readFile(join(f.config.stateDirectory, 'project-discovery', 'discovery.json'), 'utf8'));
  assert.equal(persistent.config.mode, 'interval');
  await host.gateway.invoke('execution_discovery_config_update', { mode: 'manual' });
  assert.deepEqual(await host.gateway.invoke('execution_discovery_config_get', {}), { mode: 'manual' });
});

test('discovery cannot be managed through browser origins, workbench or untrusted parameter overrides', async t => {
  const f = await fixture(t), host = await f.open({ workbench: { token: 'workbench-only-token' } });
  for (const method of Object.keys(DISCOVERY_METHODS)) {
    const request = post(method, method === 'execution_discovery_config_update' ? { mode: 'manual' } : {});
    const response = await f.request(host, '/invoke', { ...request, headers: { ...request.headers, Origin: 'http://localhost' } });
    assert.equal(response.status, 403);
    const workbench = await f.request(host, `/workbench/${method}`, { ...request, headers: { ...request.headers, Authorization: 'Bearer workbench-only-token' } });
    assert.equal(workbench.status, 404);
  }
  for (const params of [{ mode: 'interval' }, { mode: 'interval', intervalMs: 50 }, { mode: 'manual', readerExecutable: '/untrusted' },
    { mode: 'manual', allowedRoots: ['/'] }, { mode: 'manual', pollIntervalMs: 50 }]) {
    assert.equal((await f.request(host, '/invoke', post('execution_discovery_config_update', params))).status, 400);
  }
  assert.equal((await f.request(host, '/invoke', post('execution_project_scan', { projectRoot: '/' }))).status, 400);
  await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
  assert.deepEqual(await host.gateway.invoke('execution_discovery_config_get', {}), { mode: 'manual' });
});

test('gateway shutdown cancels an in-flight Reader before draining its HTTP scan request', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await writeFile(f.behavior, 'hold');
  const host = await f.open({ projectDiscovery: { ...f.config.projectDiscovery!, timeoutMs: 30_000 } });
  const pending = f.request(host, '/invoke', post('execution_project_scan')).then(response => response.json());
  const deadline = Date.now() + 3000;
  let pid: number | undefined;
  while (pid === undefined) {
    try { pid = Number(await readFile(f.pid, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (Date.now() > deadline) throw new Error('Fixture Reader did not start');
    if (pid === undefined) await new Promise(resolve => setTimeout(resolve, 10));
  }
  const started = Date.now();
  await host.close();
  assert.ok(Date.now() - started < 5000, 'shutdown must cancel the Reader instead of awaiting its 30-second timeout');
  await pending;
  assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  assert.deepEqual(host.gateway.targets.listTargets(), []); assert.deepEqual(host.gateway.ledger.snapshot().jobs, {});
});

test('a discovery constructor failure releases the gateway lease for a corrected restart', async t => {
  const f = await fixture(t), directory = join(f.config.stateDirectory, 'project-discovery');
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'discovery.json'), 'invalid-json');
  assert.throws(() => new RemoteAgentGateway(f.config));
  await rm(join(directory, 'discovery.json'));
  const host = await f.open();
  assert.deepEqual(await host.gateway.invoke('execution_discovery_config_get', {}), { mode: 'manual' });
});
