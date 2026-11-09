import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TargetDirectory, TARGET_METHODS, type ExecutionTargetSnapshot, type TargetHealth } from '../src/execution/targets.js';

const remotes = { local: { url: 'http://127.0.0.1:3080', token: 'private-never-copy-this' }, backup: { url: 'http://127.0.0.1:3081', token: 'private-backup' } };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'execution-targets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = new TargetDirectory(root, remotes);
  directory.invoke('execution_connection_create', { connectionId: 'local', remote: 'local' });
  return { root, directory };
}
const host = { targetId: 'host', kind: 'agent_host', name: 'Local DSH', connectionId: 'local', binding: { allowedDirectories: ['/work/projects'], allowedPresets: ['standard', 'ppt'] } };
const resident = { targetId: 'ppt', kind: 'resident_agent', name: 'PPT', connectionId: 'local', binding: { cwd: '/work/ppt', roleId: 'ppt-beautifier', agentPreset: 'ppt' } };
function probe(snapshot: ExecutionTargetSnapshot): TargetHealth {
  return { targetId: snapshot.target.targetId, configVersion: snapshot.configVersion, connectionId: snapshot.connection.connectionId,
    connectionVersion: snapshot.connectionVersion, connectionStatus: 'reachable', targetStatus: 'ready',
    checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(), checkedScope: ['agent_card'], failureCount: 0 };
}

test('persistent versioned configuration never copies credentials; snapshots are immutable across updates', async t => {
  const { root, directory } = await fixture(t);
  directory.invoke('execution_target_create', resident);
  const snapshot = directory.resolve('ppt', { prompt: 'Make a deck' });
  assert.equal(snapshot.cwd, '/work/ppt'); assert.equal(snapshot.agentPreset, 'ppt');
  directory.invoke('execution_target_update', { targetId: 'ppt', expectedConfigVersion: 1, patch: { name: 'PPT v2', binding: { ...resident.binding, cwd: '/work/ppt-v2' } } });
  assert.equal(snapshot.cwd, '/work/ppt'); assert.equal(snapshot.target.configVersion, 1);
  assert.equal(directory.resolve('ppt', { prompt: 'Make another deck' }).configVersion, 2);
  assert.throws(() => directory.invoke('execution_target_update', { targetId: 'ppt', expectedConfigVersion: 1, patch: { name: 'stale' } }), /version conflict/);
  const again = new TargetDirectory(root, remotes);
  assert.equal(again.getTarget('ppt').name, 'PPT v2'); assert.equal(again.getTarget('ppt').configVersion, 2);
  const disk = await readFile(join(root, 'targets.json'), 'utf8');
  assert.ok(!disk.includes('private-never-copy-this')); assert.ok(disk.includes('http://127.0.0.1:3080/'));
  const serialized = JSON.stringify({ snapshot, targets: again.invoke('execution_target_list', {}), connections: again.listConnections() });
  assert.ok(!serialized.includes('private-never-copy-this')); assert.equal(snapshot.endpoint, 'http://127.0.0.1:3080/');
  snapshot.target.binding.cwd = '/tamper'; assert.equal(directory.getTarget('ppt').binding.cwd, '/work/ppt-v2');
});

test('target/connection deletion retains ID tombstones and does not permit deleting referenced connections', async t => {
  const { root, directory } = await fixture(t);
  directory.invoke('execution_target_create', resident);
  assert.throws(() => directory.invoke('execution_connection_delete', { connectionId: 'local' }), /referenced/);
  directory.invoke('execution_target_delete', { targetId: 'ppt', expectedConfigVersion: 1 });
  assert.throws(() => directory.invoke('execution_target_create', resident), /cannot be reused/);
  directory.invoke('execution_connection_delete', { connectionId: 'local' });
  assert.throws(() => directory.invoke('execution_connection_create', { connectionId: 'local', remote: 'local' }), /cannot be reused/);
  const restored = new TargetDirectory(root, remotes);
  assert.throws(() => restored.invoke('execution_target_create', resident), /cannot be reused/);
  assert.deepEqual(restored.listConnections(), []); assert.deepEqual(restored.listTargets(), []);
});

test('host cwd and preset are per task; resident bindings cannot be overridden; directory bounds are lexical plus executor requirement', async t => {
  const { directory } = await fixture(t);
  directory.invoke('execution_target_create', host); directory.invoke('execution_target_create', resident);
  const first = directory.resolve('host', { cwd: '/work/projects/a', agentPreset: 'standard', prompt: 'A' });
  const second = directory.resolve('host', { cwd: '/work/projects/b', agentPreset: 'ppt', prompt: 'B' });
  assert.notEqual(first.cwd, second.cwd); assert.notEqual(first.agentPreset, second.agentPreset);
  assert.equal(first.directoryPolicy?.executorVerificationRequired, true);
  for (const cwd of ['/work/projects-sibling', '/work/projects/../secret', 'relative'])
    assert.throws(() => directory.resolve('host', { cwd, prompt: 'A' }));
  assert.throws(() => directory.resolve('host', { cwd: '/work/projects/a', prompt: 'A', agentPreset: 'unsafe' }), /allowedPresets/);
  assert.throws(() => directory.resolve('host', { cwd: '/work/projects/a', prompt: 'A' }), /explicit preset/);
  for (const override of [{ cwd: '/work/ppt' }, { agentPreset: 'ppt' }, { remote: 'backup' }, { roleId: 'ppt-beautifier' }, { driver: 'ppt_delivery' }])
    assert.throws(() => directory.resolve('ppt', { prompt: 'Make deck', ...override }), /override/);
  assert.throws(() => directory.invoke('execution_target_create', { ...resident, targetId: 'invalid', binding: {} }), /fixed cwd/);
  assert.throws(() => directory.invoke('execution_target_create', { ...host, targetId: 'invalid', binding: { cwd: '/fixed' } }), /per task/);
  assert.throws(() => directory.resolve('host', { cwd: '/work/projects/a', prompt: '   ' }));
  assert.doesNotThrow(() => directory.resolve('host', { cwd: '/work/projects/a', agentPreset: 'standard', prompt: 'x'.repeat(10_000) }));
});

test('disabled targets or connections block new work without removing historical snapshots', async t => {
  const { directory } = await fixture(t);
  directory.invoke('execution_target_create', resident);
  const snapshot = directory.resolve('ppt', { prompt: 'accepted before disable' });
  directory.invoke('execution_target_update', { targetId: 'ppt', patch: { enabled: false } });
  assert.throws(() => directory.resolve('ppt', { prompt: 'new' }), /disabled/);
  assert.equal(snapshot.target.enabled, true);
  directory.invoke('execution_target_update', { targetId: 'ppt', patch: { enabled: true } });
  directory.invoke('execution_connection_update', { connectionId: 'local', patch: { enabled: false } });
  assert.throws(() => directory.resolve('ppt', { prompt: 'new' }), /disabled/);
  assert.equal(directory.getTarget('ppt').enabled, true);
  assert.equal(snapshot.connection.enabled, true);
});

test('health is a separate ephemeral versioned view; stale/out-of-order probes cannot replace valid state', async t => {
  const { root, directory } = await fixture(t);
  directory.invoke('execution_target_create', resident);
  const v1 = directory.resolve('ppt', { prompt: 'A' }), healthy = probe(v1);
  assert.equal(directory.recordProbe(healthy), true);
  assert.equal(directory.getHealth('ppt')?.targetStatus, 'ready');
  assert.equal(directory.getTarget('ppt').configVersion, 1);
  assert.equal(directory.recordProbe({ ...healthy, checkedAt: new Date(Date.now() - 100_000).toISOString(), targetStatus: 'unavailable' }), false);
  directory.invoke('execution_target_update', { targetId: 'ppt', patch: { description: 'new config' } });
  assert.equal(directory.getHealth('ppt'), undefined); assert.equal(directory.recordProbe(healthy), false);
  const v2 = directory.resolve('ppt', { prompt: 'B' });
  assert.equal(directory.recordProbe(probe(v2)), true);
  directory.invoke('execution_connection_update', { connectionId: 'local', patch: { description: 'new connection config' } });
  assert.equal(directory.recordProbe(probe(v2)), false); assert.equal(directory.getHealth('ppt'), undefined);
  const v3 = directory.resolve('ppt', { prompt: 'C' });
  assert.equal(directory.recordProbe({ ...probe(v3), targetStatus: 'unavailable', reasonCode: 'missing_fixed_preset' }), true);
  assert.throws(() => directory.resolve('ppt', { prompt: 'D' }), /unavailable/);
  assert.equal(new TargetDirectory(root, remotes).getHealth('ppt'), undefined);
});

test('read-only probe descriptor creates no job and cannot claim unperformed checks or readiness', async t => {
  const { directory } = await fixture(t);
  directory.invoke('execution_target_create', resident);
  const result = directory.invoke('execution_target_probe', { targetId: 'ppt' }) as any;
  assert.equal(result.performed, false); assert.equal(result.probeRequired, true);
  assert.equal(result.health.targetStatus, 'unknown'); assert.deepEqual(result.health.checkedScope, []);
  assert.throws(() => directory.recordProbe({ ...probe(directory.resolve('ppt', { prompt: 'A' })), checkedScope: [] }), /explicit checked scope/);
  assert.equal(Object.keys(TARGET_METHODS).length, 12);
});

test('workflow registration works independently but P1 execution is explicitly unsupported', async t => {
  const { directory } = await fixture(t);
  directory.invoke('execution_connection_create', { connectionId: 'ap', provider: 'activepieces', remote: 'future-ap-connection' });
  directory.invoke('execution_target_create', { targetId: 'flow', kind: 'workflow', name: 'Future flow', connectionId: 'ap', binding: { flowId: 'flow-123' } });
  const description = directory.invoke('execution_target_get', { targetId: 'flow' }) as any;
  assert.equal(description.providerSupported, false);
  assert.throws(() => directory.resolve('flow', { input: { value: 1 } }), /unsupported_provider/);
  assert.throws(() => directory.invoke('execution_target_create', { targetId: 'invalid', kind: 'workflow', name: 'Invalid', connectionId: 'ap', binding: { flowId: 'x', cwd: '/work' } }), /cannot bind/);
  assert.throws(() => directory.invoke('execution_connection_create', { connectionId: 'bad', remote: 'unknown' }), /Unknown configured remote/);
});

test('legacy remote import is explicit, idempotent, credential-free and never resurrects deleted IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = new TargetDirectory(root, remotes);
  const initial = directory.ensureLegacyRemotes();
  assert.deepEqual(initial.importedTargets.sort(), ['legacy:backup', 'legacy:local']);
  assert.deepEqual(directory.ensureLegacyRemotes(), { importedConnections: [], importedTargets: [] });
  assert.equal(directory.resolve('legacy:local', { cwd: '/anything', agentPreset: 'standard', prompt: 'A' }).remote, 'local');
  directory.invoke('execution_target_delete', { targetId: 'legacy:local' });
  directory.invoke('execution_connection_delete', { connectionId: 'remote:local' });
  const restored = new TargetDirectory(root, remotes); restored.ensureLegacyRemotes();
  assert.throws(() => restored.getTarget('legacy:local'), /not found/);
  assert.throws(() => restored.getConnection('remote:local'), /not found/);
  assert.equal(restored.listTargets().length, 1);
});

test('remote endpoint changes on restart increment connection versions without changing target identity or old snapshots', async t => {
  const { root, directory } = await fixture(t);
  directory.invoke('execution_target_create', resident);
  const original = directory.resolve('ppt', { prompt: 'A' });
  assert.equal(directory.recordProbe(probe(original)), true);
  const movedRemotes = { ...remotes, local: { url: 'https://dsh.example.test:3082/a2a', token: 'new-token-never-store' } };
  const moved = new TargetDirectory(root, movedRemotes);
  const current = moved.resolve('ppt', { prompt: 'B' });
  assert.equal(current.connectionVersion, original.connectionVersion + 1);
  assert.equal(current.configVersion, original.configVersion);
  assert.equal(current.target.targetId, original.target.targetId);
  assert.equal(current.endpoint, movedRemotes.local.url);
  assert.equal(original.endpoint, 'http://127.0.0.1:3080/');
  assert.notEqual(current.connection.endpointFingerprint, original.connection.endpointFingerprint);
  assert.equal(moved.getHealth('ppt'), undefined);
  assert.equal(moved.recordProbe(probe(original)), false, 'late probes from the previous endpoint cannot mark the new endpoint ready');
  assert.equal(new TargetDirectory(root, movedRemotes).getConnection('local').connectionVersion, current.connectionVersion);
  const changedSecretOnly = { ...movedRemotes, local: { url: movedRemotes.local.url, get token(): string { throw new Error('Directory must not read credentials'); } } };
  const rotated = new TargetDirectory(root, changedSecretOnly);
  assert.equal(rotated.getConnection('local').connectionVersion, current.connectionVersion, 'endpoint fingerprint does not depend on credentials');
  const disk = await readFile(join(root, 'targets.json'), 'utf8');
  assert.ok(!disk.includes('private-never-copy-this')); assert.ok(!disk.includes('new-token-never-store'));
  assert.throws(() => moved.invoke('execution_connection_create', { connectionId: 'spoof', remote: 'local', endpoint: 'https://caller.invalid' }), /Unrecognized key/);
});

test('controlled remote endpoint reload invalidates health and does not re-enable disabled configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-endpoint-reload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mutableRemotes = { local: { url: 'http://127.0.0.1:3080', token: 'never-store' } };
  const directory = new TargetDirectory(root, mutableRemotes);
  directory.invoke('execution_connection_create', { connectionId: 'local', remote: 'local' });
  directory.invoke('execution_target_create', resident);
  const initial = directory.resolve('ppt', { prompt: 'A' }); directory.recordProbe(probe(initial));
  mutableRemotes.local.url = 'http://127.0.0.1:3081';
  assert.deepEqual(directory.reloadRemoteEndpoints(), ['local']);
  assert.equal(directory.getHealth('ppt'), undefined);
  assert.equal(directory.resolve('ppt', { prompt: 'B' }).endpoint, 'http://127.0.0.1:3081/');
  directory.invoke('execution_connection_update', { connectionId: 'local', patch: { enabled: false } });
  mutableRemotes.local.url = 'http://127.0.0.1:3082';
  directory.reloadRemoteEndpoints();
  assert.equal(directory.getConnection('local').enabled, false);
  assert.equal(directory.getTarget('ppt').configVersion, 1);
});

test('a fixed role without a preset runs on standard, may name a default model and lets each task pick another', async t => {
  const { directory } = await fixture(t);
  const created = directory.invoke('execution_target_create', { targetId: 'plain', kind: 'resident_agent', name: 'Plain', connectionId: 'local',
    binding: { cwd: '/work/ppt', roleId: 'ppt-maker' } }) as any;
  assert.equal(created.binding.agentPreset, 'standard');
  assert.equal(directory.resolve('plain', { prompt: 'x' }).agentPreset, 'standard');
  directory.invoke('execution_target_create', { targetId: 'routed', kind: 'resident_agent', name: 'Routed', connectionId: 'local',
    binding: { cwd: '/work/ppt', roleId: 'ppt-maker', provider: 'minimax-cn', model: 'MiniMax-M3' } });
  assert.deepEqual(directory.resolve('routed', { prompt: 'x', provider: 'deepseek-account', model: 'deepseek-flash' }).input,
    { prompt: 'x', provider: 'deepseek-account', model: 'deepseek-flash' });
  assert.throws(() => directory.invoke('execution_target_create', { targetId: 'half', kind: 'resident_agent', name: 'Half', connectionId: 'local',
    binding: { cwd: '/work/ppt', roleId: 'ppt-maker', provider: 'minimax-cn' } }), /set together/);
  assert.throws(() => directory.invoke('execution_target_create', { targetId: 'acp', kind: 'resident_agent', name: 'ACP', connectionId: 'local',
    binding: { cwd: '/work/ppt', roleId: 'ppt-maker', agentPreset: 'oneagents-acp-grok-build', provider: 'minimax-cn', model: 'MiniMax-M3' } }), /DSH-native/);
  assert.throws(() => directory.invoke('execution_target_create', { ...host, targetId: 'host-model', binding: { provider: 'a', model: 'b' } }), /path agent or a fixed role/);
});

test('fork copies a target under a new ID with only the changed binding fields, leaving the original alone', async t => {
  const { directory } = await fixture(t);
  directory.invoke('execution_target_create', resident);
  const fork = directory.invoke('execution_target_fork', { targetId: 'ppt', newTargetId: 'ppt-grok',
    patch: { name: 'PPT on Grok', binding: { agentPreset: 'oneagents-acp-grok-build' } } }) as any;
  assert.equal(fork.targetId, 'ppt-grok'); assert.equal(fork.configVersion, 1); assert.equal(fork.name, 'PPT on Grok');
  assert.deepEqual(fork.binding, { ...resident.binding, agentPreset: 'oneagents-acp-grok-build' });
  assert.equal((directory.invoke('execution_target_get', { targetId: 'ppt' }) as any).binding.agentPreset, 'ppt');
  assert.throws(() => directory.invoke('execution_target_fork', { targetId: 'ppt', newTargetId: 'ppt-grok' }), /already used/);
  assert.throws(() => directory.invoke('execution_target_fork', { targetId: 'ppt', newTargetId: 'ppt-bad', patch: { binding: { roleId: undefined, cwd: undefined } } }), /cwd and roleId/);
  assert.ok(Object.hasOwn(TARGET_METHODS, 'execution_target_fork'));
});
