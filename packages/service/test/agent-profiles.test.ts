import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverAgents } from '../src/catalog.js';
import {
  defaultAgentProfilesFile,
  loadAgentProfiles,
  loadAgentProfilesSafe,
  profileEnvironment,
  resolveAgentLaunch,
  resolveAgentLaunchSafe,
  resolveAgentProfile,
  resolveAgentProfileSafe,
} from '../src/agent-profiles.js';
import { createAcpServer } from '../src/server.js';

const AGENTS = ['antigravity', 'codex'];

function workspace(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'acp-profiles-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'profiles.json');
  const write = (body: unknown) => writeFileSync(file, JSON.stringify(body));
  const load = () => loadAgentProfiles({ file, env: { HOME: home }, agents: AGENTS });
  return { home, file, write, load };
}

test('a missing profile file is an empty set, not an error', t => {
  const f = workspace(t);
  const set = f.load();
  assert.equal(set.file, f.file);
  assert.deepEqual(set.profiles, []);
  assert.equal(set.byId.size, 0);
});

test('a profile wraps a built-in Agent with its own home and credential environment', t => {
  const f = workspace(t);
  f.write({
    profiles: {
      agy2: {
        agent: 'antigravity',
        label: 'Antigravity · 账号2',
        home: '~/accounts/agy2',
        env: { JETSKI_APP_DATA_DIR: '~/accounts/agy2/appdata' },
      },
    },
  });
  const set = f.load();
  assert.equal(set.profiles.length, 1);
  const profile = set.byId.get('agy2');
  assert.ok(profile);
  assert.equal(profile.agent, 'antigravity');
  assert.equal(profile.label, 'Antigravity · 账号2');
  assert.equal(profile.home, join(f.home, 'accounts', 'agy2'));
  // HOME is the account boundary and wins over every other entry.
  assert.deepEqual(profileEnvironment(profile), {
    HOME: join(f.home, 'accounts', 'agy2'),
    JETSKI_APP_DATA_DIR: join(f.home, 'accounts', 'agy2', 'appdata'),
  });
});

test('the default label names both the Agent and the profile', t => {
  const f = workspace(t);
  f.write({ profiles: { codex2: { agent: 'codex' } } });
  assert.equal(f.load().byId.get('codex2')?.label, 'codex · codex2');
});

test('invalid profiles fail loudly instead of silently degrading', t => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['bad id', { profiles: { Agy2: { agent: 'antigravity' } } }, /not a valid Agent id/],
    ['unknown agent', { profiles: { agy2: { agent: 'nope' } } }, /is not a known Agent/],
    ['shadowing', { profiles: { antigravity: { agent: 'antigravity' } } }, /would shadow/],
    ['unknown field', { profiles: { agy2: { agent: 'antigravity', argv: ['agy'] } } }, /not a supported field/],
    ['path override', { profiles: { agy2: { agent: 'antigravity', env: { PATH: '/tmp' } } } }, /not an allowed variable/],
    ['relative home', { profiles: { agy2: { agent: 'antigravity', home: 'relative/dir' } } }, /home must be absolute/],
    ['relative env.HOME', { profiles: { agy2: { agent: 'antigravity', env: { HOME: 'relative/dir' } } } }, /env\.HOME must be absolute/],
    ['home conflict', { profiles: { agy2: { agent: 'antigravity', home: '/a', env: { HOME: '/b' } } } }, /different values/],
    ['bad root', { profiles: [] }, /"profiles" must be an object/],
    ['unknown top level', { agents: {} }, /not a supported top-level field/],
  ];
  for (const [name, body, expected] of cases) {
    const f = workspace(t);
    f.write(body);
    assert.throws(() => f.load(), expected, name);
  }
});

test('discovery advertises a profile beside its underlying Agent', t => {
  const home = mkdtempSync(join(tmpdir(), 'acp-profiles-discovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'agy'), '#!/bin/sh\n', { mode: 0o755 });
  const profiles = [{
    id: 'agy2',
    agent: 'antigravity',
    label: 'Antigravity · 账号2',
    home: join(home, 'accounts', 'agy2'),
    env: {},
  }];
  const agents = new Map(discoverAgents({
    home,
    env: { PATH: bin },
    packageRoots: [home],
    platform: 'linux',
    profiles,
  }).map(agent => [agent.id, agent]));

  const underlying = agents.get('antigravity');
  const profile = agents.get('agy2');
  assert.ok(underlying);
  assert.ok(profile);
  assert.equal(profile.underlying_agent, 'antigravity');
  assert.equal(profile.label, 'Antigravity · 账号2');
  assert.equal(profile.type, underlying.type);
  assert.equal(profile.binary, underlying.binary);
  assert.equal(profile.chat_ready, underlying.chat_ready);
  assert.equal(profile.chat_ready, true);
});

test('a session reaches the underlying Agent with the profile environment merged last', t => {
  const f = workspace(t);
  f.write({ profiles: { agy2: { agent: 'antigravity', home: '~/h2' } } });
  const options = { file: f.file, env: { HOME: f.home }, agents: AGENTS };
  assert.deepEqual(
    resolveAgentLaunch('agy2', { HOME: '/client/home', CUSTOM_FLAG: '1' }, options),
    { agent: 'antigravity', env: { HOME: join(f.home, 'h2'), CUSTOM_FLAG: '1' } },
  );
  // A built-in id passes through untouched, so the session keeps its own environment.
  assert.deepEqual(resolveAgentLaunch('antigravity', { HOME: '/client/home' }, options), {
    agent: 'antigravity',
  });
});

test('lookups follow the profile file when it changes', t => {
  const f = workspace(t);
  f.write({ profiles: { agy2: { agent: 'antigravity', label: 'first' } } });
  assert.equal(resolveAgentProfile('agy2', { file: f.file, env: { HOME: f.home }, agents: AGENTS })?.label, 'first');
  f.write({ profiles: { agy2: { agent: 'antigravity', label: 'second profile label' } } });
  assert.equal(resolveAgentProfile('agy2', { file: f.file, env: { HOME: f.home }, agents: AGENTS })?.label, 'second profile label');
  assert.equal(resolveAgentProfile('missing', { file: f.file, env: { HOME: f.home }, agents: AGENTS }), undefined);
});

test('the default location lives in the DSH plugin state directory', () => {
  assert.equal(
    defaultAgentProfilesFile({ DSH_HOME: '/dsh', HOME: '/home/user' }),
    join('/dsh', 'plugins', '1agents-acp', 'profiles.json'),
  );
  assert.equal(
    defaultAgentProfilesFile({ HOME: '/home/user' }),
    join('/home/user', '.dsh', 'plugins', '1agents-acp', 'profiles.json'),
  );
  assert.equal(defaultAgentProfilesFile({ ACP_PROFILES_FILE: '/tmp/p.json', HOME: '/home/user' }), '/tmp/p.json');
});

test('malformed profiles.json degrades safely on live /agents, launch, and profile lookup paths', async t => {
  const f = workspace(t);
  writeFileSync(f.file, '{not valid json');
  const warnings: unknown[] = [];
  const onError = (err: unknown) => warnings.push(err);
  const safeSet = loadAgentProfilesSafe({ file: f.file, env: { HOME: f.home }, agents: AGENTS }, onError);
  assert.deepEqual(safeSet.profiles, []);
  assert.equal(resolveAgentProfileSafe('antigravity', { file: f.file, env: { HOME: f.home }, agents: AGENTS }, onError), undefined);
  assert.deepEqual(
    resolveAgentLaunchSafe('antigravity', { CUSTOM: '1' }, { file: f.file, env: { HOME: f.home }, agents: AGENTS }, onError),
    { agent: 'antigravity' },
  );
  assert.ok(warnings.length >= 3);

  const prev = process.env.ACP_PROFILES_FILE;
  process.env.ACP_PROFILES_FILE = f.file;
  const { server } = createAcpServer();
  t.after(async () => {
    if (prev === undefined) delete process.env.ACP_PROFILES_FILE;
    else process.env.ACP_PROFILES_FILE = prev;
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const res = await fetch(`http://127.0.0.1:${address.port}/agents`);
  assert.equal(res.status, 200);
  const body = await res.json() as { agents: Array<{ id: string }> };
  assert.ok(Array.isArray(body.agents) && body.agents.length > 0);
});
