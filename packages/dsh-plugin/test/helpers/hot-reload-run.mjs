/** Mount, unload and remount the real plugin on one mock Cordis host. */
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

/**
 * A mock Cordis host. `failNextEffect` makes the next ctx.effect() registration
 * fail the way Cordis fails on an inactive fiber, and `failRouteDispose` makes the
 * disposer of a matching route throw.
 */
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
      if (host.failNextEffect) {
        host.failNextEffect = false;
        throw new Error('INACTIVE_EFFECT: the plugin fiber is no longer active');
      }
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
        return () => {
          routes.delete(key);
          if (host.failRouteDispose?.(route.path)) throw new Error(`route disposer failed for ${route.path}`);
        };
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
  const host = {
    ctx, routes, tools, presets,
    failNextEffect: false,
    failRouteDispose: undefined,
    async dispose() {
      try {
        await Promise.all([...effects].reverse().map(async disposeEffect => {
          await Promise.resolve();
          await disposeEffect();
        }));
      } finally { effects.length = 0; }
    },
  };
  return host;
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
const scenario = process.argv[2] ?? 'remount';
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
  const readOnlyWarning = () => warnings.some(line => /read-only/.test(line));
  const snapshot = async () => ({
    routes: [...host.routes.keys()].sort(),
    tools: [...host.tools.keys()].sort(),
    presets: [...host.presets.keys()].sort(),
    a2aHostCurrent: host.ctx.oneagentsA2aHost?.current === undefined ? undefined : 'set',
    diagnosticsLocked: await locked(diagnosticsDirectory),
    a2aLocked: await locked(a2aDirectory),
  });
  const assertMounted = async (label) => {
    assert.equal(await locked(diagnosticsDirectory), true, `${label} diagnostics lock`);
    assert.equal(await locked(a2aDirectory), true, `${label} a2a lock`);
    assert.equal(readOnlyWarning(), false, `${label} degraded to read-only: ${warnings.join(' | ')}`);
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
  const assertReleased = async (label) => {
    assert.equal(host.routes.size, 0, `${label} routes survived`);
    assert.equal(host.tools.size, 0, `${label} tools survived`);
    assert.equal(host.presets.size, 0, `${label} presets survived`);
    assert.equal(host.ctx.oneagentsA2aHost?.current, undefined, `${label} a2a host survived`);
    assert.equal(await locked(diagnosticsDirectory), false, `${label} diagnostics lease survived`);
    assert.equal(await locked(a2aDirectory), false, `${label} a2a lease survived`);
  };

  const report = { scenario, ok: true };

  if (scenario === 'remount') {
    await apply(host.ctx, input);
    await assertMounted('first');
    await host.dispose();
    await assertReleased('dispose');
    warnings.length = 0;
    await apply(host.ctx, input);
    await assertMounted('second');
    await host.dispose();
    await assertReleased('second dispose');
    report.afterDispose = await snapshot();
    report.remount = { mounted: true, readOnlyWarning: readOnlyWarning() };
  } else if (scenario === 'inactive-effect') {
    // The fiber dies after the A2A mount and before the disposer is registered.
    host.failNextEffect = true;
    let failure = '';
    await assert.rejects(apply(host.ctx, input), error => { failure = error.message; return /INACTIVE_EFFECT/.test(error.message); });
    report.error = failure;
    report.afterFailure = await snapshot();
    report.failureReadOnlyWarning = readOnlyWarning();
    await assertReleased('failed start');
    // The next hot reload must find both directories free and take them read-write.
    warnings.length = 0;
    await apply(host.ctx, input);
    await assertMounted('after failed start');
    report.remount = { mounted: true, readOnlyWarning: readOnlyWarning(), snapshot: await snapshot() };
    await host.dispose();
    await assertReleased('dispose after remount');
  } else if (scenario === 'throwing-route') {
    // One A2A route disposer throws while the plugin unloads.
    host.failRouteDispose = path => path === '/a2a';
    await apply(host.ctx, input);
    await assertMounted('first');
    let failure = '';
    await assert.rejects(host.dispose(), error => { failure = error.message; return /route disposer failed/.test(error.message); });
    report.error = failure;
    report.afterFailure = await snapshot();
    await assertReleased('faulty dispose');
    host.failRouteDispose = undefined;
    warnings.length = 0;
    await apply(host.ctx, input);
    await assertMounted('after faulty dispose');
    report.remount = { mounted: true, readOnlyWarning: readOnlyWarning(), snapshot: await snapshot() };
    await host.dispose();
    await assertReleased('dispose after remount');
  } else {
    throw new Error(`Unknown hot reload scenario: ${scenario}`);
  }

  console.log(JSON.stringify(report));
} finally {
  console.warn = originalWarn;
  await rm(root, { recursive: true, force: true });
}
