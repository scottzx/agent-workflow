/** Mount, unload, and immediately remount the real plugin on one mock Cordis host. */
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

await register(new URL('./hot-reload-host-hooks.mjs', import.meta.url));
const [{ apply }, { acquireService }] = await Promise.all([
  import('../../dist/index.js'),
  import('../../dist/service-process.js'),
]);

const serviceSource = readFileSync(new URL('../../dist/service-process.js', import.meta.url), 'utf8');
assert.match(serviceSource, /serviceMode === ["']external["'] \|\| !local\)\s*return async \(\) => \{ \}/);
assert.match(serviceSource, /serviceMode === ["']launchd["'] \? wake/);
const externalRelease = await acquireService({
  serviceMode: 'external', serviceUrl: 'http://127.0.0.1:9/',
  serviceStartupTimeoutMs: 1000, serviceShutdownTimeoutMs: 1000, serviceManagerLabel: 'com.1agents.acp-service',
});
await externalRelease();
const launchdRelease = await acquireService({
  serviceMode: 'launchd', serviceUrl: 'http://10.1.2.3:36812/',
  serviceStartupTimeoutMs: 1000, serviceShutdownTimeoutMs: 1000, serviceManagerLabel: 'com.1agents.acp-service',
});
await launchdRelease();

function createHost() {
  const effects = [];
  const routes = new Map();
  const tools = new Map();
  const presets = new Map();
  const ctx = {
    get() { return undefined; },
    provide(key, value) { ctx[key] = value; },
    on() { return () => {}; },
    effect(run) {
      const result = run();
      if (typeof result === 'function') effects.push(result);
      else if (result && typeof result.then === 'function') {
        effects.push(async () => {
          const disposer = await result;
          if (typeof disposer === 'function') await disposer();
        });
      }
    },
    llm: { registerAdapter() { return () => {}; } },
    webServer: {
      port: 9,
      protocol: 'http:',
      register(route) {
        const key = `${route.kind}:${route.path}`;
        if (routes.has(key)) throw new Error(`duplicate route ${key}`);
        routes.set(key, route);
        return () => { routes.delete(key); };
      },
    },
    tools: {
      register(tool) {
        if (!tool?.name) throw new Error('tool has no name');
        if (tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
        tools.set(tool.name, tool);
        return () => { tools.delete(tool.name); };
      },
    },
    agentPresets: {
      async register(definition) {
        presets.set(definition.id, definition);
        return () => { presets.delete(definition.id); };
      },
    },
    sessionController: { async resolveAgent() { return { error: new Error('unused') }; } },
  };
  return {
    ctx, routes, tools, presets,
    async dispose() {
      await Promise.all([...effects].reverse().map(async disposeEffect => {
        await Promise.resolve();
        await disposeEffect();
      }));
      effects.length = 0;
    },
  };
}

async function locked(directory) {
  try { await access(join(directory, '.lock')); return true; }
  catch { return false; }
}

async function invoke(route, request) {
  let status = 200;
  let body = '';
  const res = {
    statusCode: 200, headersSent: false, destroyed: false,
    setHeader() {},
    writeHead(code) { status = code; this.statusCode = code; },
    end(data) { body = data == null ? '' : String(data); },
    once() {}, off() {}, destroy() { this.destroyed = true; },
  };
  await route.handler({ headers: {}, method: 'GET', url: route.path, ...request }, res);
  return { status: res.statusCode || status, body };
}

const root = await mkdtemp(join(tmpdir(), 'acp-hot-reload-'));
process.env.DSH_HOME = join(root, 'dsh-home');
process.env.DSH_ACP_ARCHIVE_SWEEP_MS = '0';
process.env.ACP_SERVICE_SKIP_GLOBAL_SYNC = '1';
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); originalWarn(...args); };
try {
  const stateDirectory = join(root, 'sessions');
  const diagnosticsDirectory = join(root, 'diagnostics');
  const a2aDirectory = join(root, 'a2a');
  const host = createHost();
  const input = {
    serviceMode: 'external',
    serviceUrl: 'http://127.0.0.1:9/',
    agents: ['codex'],
    stateDirectory,
    diagnosticsDirectory,
    a2a: {
      token: 'hot-reload-token',
      stateDirectory: a2aDirectory,
      publicUrl: 'http://127.0.0.1:9',
      workbench: { url: 'http://127.0.0.1:9/workbench' },
    },
  };
  const assertMounted = async (label) => {
    assert.equal(await locked(diagnosticsDirectory), true, `${label} diagnostics lock`);
    assert.equal(await locked(a2aDirectory), true, `${label} a2a lock`);
    assert.equal(warnings.some(line => /read-only/.test(line)), false, `${label} degraded to read-only: ${warnings.join(' | ')}`);
    for (const path of ['/1agents-acp/role-rules', '/.well-known/agent-card.json', '/a2a']) {
      assert.equal([...host.routes.values()].some(route => route.path === path), true, `${label} missing ${path}`);
    }
    const card = [...host.routes.values()].find(route => route.path === '/.well-known/agent-card.json');
    const cardResponse = await invoke(card, { method: 'GET', url: '/.well-known/agent-card.json' });
    assert.equal(cardResponse.status, 200, cardResponse.body);
    assert.match(cardResponse.body, /"protocolBinding":"JSONRPC"/);
    const a2a = [...host.routes.values()].find(route => route.path === '/a2a');
    const denied = await invoke(a2a, { method: 'POST', url: '/a2a' });
    assert.equal(denied.status, 401);
    for (const name of ['submit_to_review', 'ticket_show', 'handoff_propose']) {
      assert.equal(typeof host.tools.get(name)?.execute, 'function', `${label} missing ${name}`);
    }
    await assert.rejects(host.tools.get('ticket_show').execute({}, {}), /owning agent session/);
    assert.equal(host.presets.has('oneagents-acp-codex'), true);
    assert.equal(host.ctx.oneagentsA2aHost?.current == null, false);
  };
  await apply(host.ctx, input);
  await assertMounted('first');
  await host.dispose();
  assert.equal(host.routes.size, 0);
  assert.equal(host.tools.size, 0);
  assert.equal(host.presets.size, 0);
  assert.equal(host.ctx.oneagentsA2aHost.current, undefined);
  assert.equal(await locked(diagnosticsDirectory), false, 'diagnostics lease survived dispose');
  assert.equal(await locked(a2aDirectory), false, 'a2a lease survived dispose');
  warnings.length = 0;
  await apply(host.ctx, input);
  await assertMounted('second');
  await host.dispose();
  assert.equal(await locked(diagnosticsDirectory), false);
  assert.equal(await locked(a2aDirectory), false);
  console.log(JSON.stringify({ ok: true }));
} finally {
  console.warn = originalWarn;
  await rm(root, { recursive: true, force: true });
}
