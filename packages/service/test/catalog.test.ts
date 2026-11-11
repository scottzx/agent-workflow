import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAcpRuntime, createRuntimeStore, type AcpProcessLaunch } from '@1agents/acp-service/runtime';
import { createServiceAgentRegistry, discoverAgents, findAgentBinary, type DiscoveryOptions } from '../src/catalog.js';

function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'acp-discovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options: DiscoveryOptions = { home, env: { PATH: join(home, 'bin') }, packageRoots: [home], platform: 'linux' };
  const executable = (relative: string, contents = '#!/bin/sh\n') => {
    const file = join(home, relative); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents, { mode: 0o755 }); return file;
  };
  return { home, options, executable, scan: () => new Map(discoverAgents(options).map(agent => [agent.id, agent])) };
}

test('discovers native harnesses in PATH and user directories without mistaking runners for harnesses', t => {
  const f = fixture(t);
  f.executable('bin/npx'); f.executable('bin/uvx');
  assert.ok([...f.scan().values()].every(agent => !agent.chat_ready));
  const grok = f.executable('.grok/bin/grok');
  f.executable('.local/bin/claude');
  f.executable('bin/agy');
  const statuses = f.scan();
  assert.equal(statuses.get('grok-build')?.path, grok);
  assert.deepEqual(createServiceAgentRegistry(f.options).resolve('grok-build'), [grok, 'agent', 'stdio']);
  assert.equal(statuses.get('grok-build')?.chat_ready, true);
  assert.equal(statuses.get('claude')?.type, 'claudecode');
  assert.equal(statuses.get('claude')?.chat_ready, true);
  assert.equal(statuses.get('antigravity')?.installed, false);
  assert.equal(statuses.get('antigravity')?.acp_capable, true);
  assert.equal(statuses.get('antigravity')?.integrated, true);
  assert.equal(statuses.get('antigravity')?.cc_transport, 'acp');
  assert.equal(statuses.get('antigravity')?.binary, 'agy_acp_server.par');
  assert.equal(statuses.get('antigravity')?.chat_ready, false);
  const server = f.executable('bin/agy_acp_server.par');
  const ready = f.scan().get('antigravity');
  assert.equal(ready?.installed, true);
  assert.equal(ready?.path, server);
  assert.equal(ready?.chat_ready, true);
  const launch = createServiceAgentRegistry(f.options).resolve('antigravity');
  assert.ok(Array.isArray(launch));
  assert.equal(launch[0], server);
  assert.deepEqual(launch.slice(1), process.platform === 'linux' ? ['--uid='] : []);
  chmodSync(grok, 0o644);
  assert.equal(f.scan().get('grok-build')?.chat_ready, false);
});

test('installed adapter is ready without native CLI, but missing package entry is not', t => {
  const f = fixture(t);
  const folder = join(f.home, 'node_modules/@agentclientprotocol/codex-acp');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', bin: { 'codex-acp': 'cli.js' } }));
  assert.equal(f.scan().get('codex')?.chat_ready, false);
  writeFileSync(join(folder, 'cli.js'), '#!/usr/bin/env node\n');
  assert.deepEqual(createServiceAgentRegistry(f.options).resolve('codex'), [process.execPath, join(folder, 'cli.js')]);
  assert.equal(f.scan().get('codex')?.installed, false);
  assert.equal(f.scan().get('codex')?.chat_ready, true);
});

test('installed Codex adapter bypasses npx even without a native CLI or runner', t => {
  const f = fixture(t);
  const adapter = f.executable('bin/codex-acp');
  assert.deepEqual(createServiceAgentRegistry(f.options).resolve('codex'), [adapter]);
  assert.equal(f.scan().get('codex')?.chat_ready, true);
  assert.equal(f.scan().get('codex')?.installed, false);
  chmodSync(adapter, 0o644);
  assert.equal(f.scan().get('codex')?.chat_ready, false);
});

test('Node adapter on PATH runs with the service interpreter when node is absent from PATH', t => {
  const f = fixture(t);
  const adapter = f.executable('bin/claude-agent-acp', '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  const argv = createServiceAgentRegistry(f.options).resolve('claudecode');
  assert.deepEqual(argv, [process.execPath, adapter]);
  assert.ok(Array.isArray(argv));
  const result = execFileSync(argv[0], [...argv.slice(1), 'argument with spaces'], {
    encoding: 'utf8', env: { PATH: f.options.env!.PATH },
  });
  assert.deepEqual(JSON.parse(result), ['argument with spaces']);
  assert.equal(f.scan().get('claude')?.chat_ready, true);
});

test('workspace adapter package retains precedence over a global adapter', t => {
  const f = fixture(t);
  f.executable('bin/codex-acp');
  const folder = join(f.home, 'node_modules/@agentclientprotocol/codex-acp');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', bin: { 'codex-acp': 'cli.js' } }));
  writeFileSync(join(folder, 'cli.js'), '#!/usr/bin/env node\n');
  assert.deepEqual(createServiceAgentRegistry(f.options).resolve('codex'), [process.execPath, join(folder, 'cli.js')]);
});

test('Windows adapter wrappers traverse the embedded runtime batch launch policy', async t => {
  const f = fixture(t);
  const adapter = f.executable('bin/codex-acp.CMD', '@echo off\r\n');
  const options = { ...f.options, platform: 'win32' as const, env: { PATH: join(f.home, 'bin'), PATHEXT: '.EXE;.CMD' } };
  assert.deepEqual(createServiceAgentRegistry(options).resolve('codex'), [adapter]);
  const comspec = 'C:\\Windows\\System32\\cmd.exe';
  let launch: AcpProcessLaunch | undefined;
  const runtime = createAcpRuntime({
    cwd: f.home,
    sessionStore: createRuntimeStore({ stateDir: join(f.home, 'state') }),
    agentRegistry: createServiceAgentRegistry(options),
    permissionMode: 'deny-all',
    agentProcessEnv: { COMSPEC: comspec },
    processLifecycle: {
      onBeforeSpawn: event => {
        launch = event;
        throw new Error('fixture refuses OS spawn after recording Windows launch');
      },
      onSpawned: () => assert.fail('fixture must stop before spawning'),
    },
  });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const report = await runtime.doctor();
    assert.equal(report.ok, false);
    assert.ok(report.details?.some(detail => detail.includes('fixture refuses OS spawn')));
    assert.ok(launch);
    assert.equal(launch.command, comspec);
    assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(launch.args[3] ?? '', /codex-acp\.CMD/);
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
    await runtime.shutdown?.();
  }
});

test('installed adapters retain their registry arguments exactly once', t => {
  const f = fixture(t);
  const adapter = f.executable('bin/opencode');
  assert.deepEqual(createServiceAgentRegistry(f.options).resolve('opencode'), [adapter, 'acp']);
  assert.equal(f.scan().get('opencode')?.chat_ready, true);
  const mux = f.executable('bin/mux');
  assert.deepEqual(createServiceAgentRegistry(f.options).resolve('mux'), [mux, 'acp']);
  assert.equal(f.scan().get('mux')?.chat_ready, true);
});

test('native ACP discovery checks the launch binary, not only a display CLI alias', t => {
  const f = fixture(t);
  f.executable('bin/agent');
  assert.equal(f.scan().get('cursor')?.installed, true);
  assert.equal(f.scan().get('cursor')?.chat_ready, false);
  f.executable('bin/cursor-agent');
  assert.equal(f.scan().get('cursor')?.chat_ready, true);
});

test('Windows lookup handles PATHEXT and PATH separators', t => {
  const f = fixture(t);
  const target = f.executable('bin/gemini.CMD');
  const win = { ...f.options, platform: 'win32' as const, env: { PATH: `${f.home}/missing;${f.home}/bin`, PATHEXT: '.EXE;.CMD' } };
  assert.equal(findAgentBinary('gemini', win), target);
  f.executable('bin/agy');
  assert.equal(discoverAgents(win).find(agent => agent.id === 'antigravity')?.installed, false);
  const exe = f.executable('bin/agy_acp_server.exe');
  const antigravity = discoverAgents(win).find(agent => agent.id === 'antigravity');
  assert.equal(antigravity?.binary, 'agy_acp_server.exe');
  assert.equal(antigravity?.installed, true);
  assert.equal(antigravity?.path, exe);
});

test('service launch registry preserves unknown commands and runtime aliases', () => {
  const registry = createServiceAgentRegistry();
  assert.deepEqual(registry.resolve('claudecode'), registry.resolve('claude'));
  assert.equal(registry.resolve('custom-harness'), 'custom-harness');
});


test('adapter fallback launches the npx found outside PATH without advertising absent harnesses', t => {
  const f = fixture(t);
  const runner = f.executable('.local/bin/npx');
  assert.equal(f.scan().get('codex')?.chat_ready, false);
  f.executable('.local/bin/codex');
  assert.equal(f.scan().get('codex')?.chat_ready, true);
  const command = createServiceAgentRegistry(f.options).resolve('codex');
  assert.ok(Array.isArray(command));
  assert.equal(command[0], runner);
  assert.ok(command.some(value => value.startsWith('@agentclientprotocol/codex-acp')));
});
