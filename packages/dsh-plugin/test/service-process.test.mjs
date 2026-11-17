import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { acquireService, resolveServiceOptions } from '../dist/service-process.js';

async function endpoint(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  t.after(close);
  return { url, close };
}
async function unused(t) { const fixture = await endpoint(t); await fixture.close(); return fixture.url; }
// Lifecycle tests exercise the legacy explicitly-owned mode. The production default is external.
const options = serviceUrl => resolveServiceOptions({ serviceUrl, serviceMode: 'auto' });
const health = url => fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });

test('owned service starts before discovery and survives until its last concurrent lease is released', { timeout: 20000 }, async t => {
  const url = await unused(t);
  const releases = await Promise.all([acquireService(options(url)), acquireService(options(url))]);
  t.after(async () => { for (const release of releases) await release(); });
  assert.equal((await (await health(url)).json()).service, 'acp-service');
  const inventory = await (await fetch(`${url}/agents`)).json();
  assert.ok(Array.isArray(inventory.agents));
  await releases[0](); await releases[0]();
  assert.equal((await health(url)).status, 200);
  await releases[1]();
  await assert.rejects(health(url));
  const release = await acquireService(options(url));
  try { assert.equal((await health(url)).status, 200); } finally { await release(); }
  await assert.rejects(health(url));
});

test('existing local service stays alive after plugin release', async t => {
  const fixture = await endpoint(t, (_req, res) => res.end(JSON.stringify({ service: 'acp-service', status: 'ok' })));
  const release = await acquireService(options(fixture.url));
  await release();
  assert.equal((await health(fixture.url)).status, 200);
});

test('remote and explicitly external endpoints never get a local process', async t => {
  const url = await unused(t);
  await (await acquireService(resolveServiceOptions({ serviceUrl: url, serviceMode: 'external' })))();
  await assert.rejects(health(url));
  await (await acquireService(options('https://example.invalid')))();
  await (await acquireService(options('http://example.invalid')))();
});

test('authentication, a foreign listener and a health timeout do not cause local startup', async t => {
  const denied = await endpoint(t, (_req, res) => { res.writeHead(401); res.end(); });
  await assert.rejects(acquireService(options(denied.url)), /HTTP 401/);
  const foreign = await endpoint(t, (_req, res) => res.end('{}'));
  await assert.rejects(acquireService(options(foreign.url)), /not a healthy ACP/);
  const hanging = await endpoint(t, () => {});
  await assert.rejects(acquireService({ ...options(hanging.url), serviceStartupTimeoutMs: 100 }), /health check failed/);
});

test('failed child initialization reports the cause and a retry starts a fresh process', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-invalid-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blocked = join(directory, 'file'); await writeFile(blocked, 'not a directory');
  const previous = process.env.ACP_STATE_DIR;
  const url = await unused(t);
  try {
    process.env.ACP_STATE_DIR = blocked;
    await assert.rejects(acquireService(options(url)), /EEXIST|ENOTDIR/);
  } finally {
    if (previous === undefined) delete process.env.ACP_STATE_DIR; else process.env.ACP_STATE_DIR = previous;
  }
  await assert.rejects(health(url));
  const release = await acquireService(options(url));
  await release();
  await assert.rejects(health(url));
});

test('managed worker exits when its DSH parent is killed', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-parent-exit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = await unused(t);
  const fixture = join(directory, 'parent.mjs');
  const moduleUrl = new URL('../dist/service-process.js', import.meta.url).href;
  await writeFile(fixture, `import {acquireService,resolveServiceOptions} from ${JSON.stringify(moduleUrl)};\nawait acquireService(resolveServiceOptions({serviceUrl:${JSON.stringify(url)},serviceMode:'auto'}));\nprocess.send('ready');\n`);
  const parent = fork(fixture, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const exited = once(parent, 'exit');
  t.after(async () => { parent.kill('SIGKILL'); await exited; });
  await Promise.race([once(parent, 'message'), exited.then(() => { throw new Error('Parent exited before readiness'); })]);
  assert.equal((await health(url)).status, 200);
  parent.kill('SIGKILL'); await exited;
  const deadline = Date.now() + 7000;
  while (true) {
    try { await health(url); } catch { break; }
    assert.ok(Date.now() < deadline, 'owned worker must not outlive its parent');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
});

test('invalid lifecycle configuration fails before acquiring a service', () => {
  for (const input of [{ serviceMode: 'bad' }, { serviceStartupTimeoutMs: 0 }, { serviceShutdownTimeoutMs: -1 }, { serviceStartupTimeoutMs: 2147483648 }, { serviceUrl: 'file:///tmp/acp' }, { serviceUrl: 'http://127.0.0.1:0' }]) {
    assert.throws(() => resolveServiceOptions(input));
  }
});

test('real Cordis startup failure releases the acquired service', { timeout: 20000 }, async t => {
  const { Context } = await import('@deepseek-ai/cordis');
  const plugin = await import('../dist/index.js');
  const url = await unused(t);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const name of plugin.inject) ctx.provide(name, {});
  ctx.set('llm', { registerAdapter: () => () => {} });
  ctx.set('webServer', { register: () => () => {} });
  ctx.set('agentPresets', { register: async () => { throw new Error('preset registration failed'); } });
  const fiber = ctx.plugin(plugin, { serviceUrl: url, agents: ['codex'] });
  await assert.rejects(fiber.await(), /preset registration failed/);
  await fiber.dispose();
  await assert.rejects(health(url));
});

const darwin = process.platform === 'darwin';
/** A launchd-managed daemon only exists on macOS; elsewhere these assertions cannot hold. */
const launchdTest = darwin ? test : test.skip;

launchdTest('launchd mode wakes a stopped manager and never owns the process', async () => {
  const release = await acquireService(resolveServiceOptions({ serviceUrl: 'http://127.0.0.1:36812', serviceMode: 'launchd' }));
  assert.equal(await fetch('http://127.0.0.1:36812/health').then(r => r.status), 200);
  await release();
  // The manager owns it, so releasing this host's lease must not stop the daemon.
  assert.equal(await fetch('http://127.0.0.1:36812/health').then(r => r.status), 200,
    'release must leave a manager-owned daemon running');
});

test('launchd mode accepts only a plain manager label', () => {
  assert.equal(resolveServiceOptions({ serviceUrl: 'http://127.0.0.1:36812', serviceMode: 'launchd' }).serviceManagerLabel,
    'com.1agents.acp-service');
  // The label reaches launchctl as an argument, so reject anything that is not a label.
  for (const label of ['../evil', 'com.1agents/acp', '', 'a b']) {
    assert.throws(() => resolveServiceOptions({ serviceUrl: 'http://127.0.0.1:36812', serviceMode: 'launchd', serviceManagerLabel: label }),
      /serviceManagerLabel/);
  }
});

test('external mode connects without waking anything', async () => {
  const release = await acquireService(resolveServiceOptions({ serviceUrl: 'http://127.0.0.1:36812', serviceMode: 'external' }));
  await release();
});
