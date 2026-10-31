/** Copied into the isolated npm installation by smoke-service-package.mjs. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as api from '@1agents/acp-service';

const dsh = resolve(process.argv[2]);
const installAnchor = join(dsh, 'apps/cli/package.json');
const require = createRequire(import.meta.url);
const hostRequire = createRequire(join(dsh, 'packages/client/modules/package.json'));
const loadHost = name => import(pathToFileURL(hostRequire.resolve(name)).href);
const [{ Context }, { default: Loader }, { ClientModuleRegistry }] = await Promise.all([
  loadHost('@deepseek-ai/cordis'), loadHost('@deepseek-ai/cordis-plugin-loader'), loadHost('@deepseek-ai/dsh-client-modules'),
]);
const { loadProfileDirectory, createRuntimeResolution, PluginPackages } = await import(pathToFileURL(join(dsh, 'packages/boot/app-boot/lib/index.js')).href);
assert.equal(typeof api.serveAcpService, 'function');
assert.equal(typeof api.apply, 'function');
assert.equal(api.default, undefined, 'Cordis must see the namespace and its inject metadata');
assert.throws(() => require.resolve('@1agents/dsh-acp'), 'No separately installed plugin');
assert.throws(() => require.resolve('@deepseek-ai/cordis'), 'DSH must not be an installed package dependency');

// Exercise the same profile metadata/patch reader used by `dsh plugin add`.
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
manifest.dsh = { profile: { bundles: ['@1agents/acp-service'] } };
writeFileSync('package.json', JSON.stringify(manifest));
const profile = loadProfileDirectory('dsh', process.cwd(), installAnchor, { userLayer: false });
assert.deepEqual(profile.skippedBundles, []);
assert.equal(profile.layers.length, 1);
const patch = profile.layers[0].patches;
const row = patch.flatMap(value => value.insert ?? []).find(value => value.id === 'oneagents-acp');
assert.equal(row.name, '@1agents/acp-service');
assert.ok(patch.some(value => value.id === 'ui-model-selection' && value.disabled));

// Activate the installed package root through DSH's real Cordis Loader.
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const serviceUrl = `http://127.0.0.1:${port}`;
const ctx = new Context();
const presets = new Map();
const routes = new Map();
class MemoryLoader extends Loader { write() {} }
try {
  // Use the official profile package resolver before loading Host imports.
  await ctx.plugin(PluginPackages, { resolution: await createRuntimeResolution({
    installAnchor, profile, home: join(process.cwd(), 'dsh-home'),
  }) });
  const [plugin, preset, { NativeSessions }] = await Promise.all([
    import('@1agents/acp-service/dsh'), import('@1agents/acp-service/dsh/preset'),
    import('@1agents/acp-service/dsh/imports'),
  ]);
  assert.equal(typeof preset.apply, 'function');
  assert.equal(typeof NativeSessions, 'function');
  assert.equal(api.name, plugin.name);
  assert.deepEqual(api.inject, plugin.inject);
  for (const name of api.inject) ctx.provide(name, {});
  ctx.set('llm', { registerAdapter: () => () => {} });
  // The plugin registers its submit_to_review tool through the host tools service.
  ctx.set('tools', { register: () => () => {} });
  ctx.set('webServer', { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } });
  ctx.set('agentPresets', { register: async definition => {
    presets.set(definition.id, definition);
    return () => presets.delete(definition.id);
  } });
  await ctx.plugin(MemoryLoader, { baseUrl: pathToFileURL(process.cwd()).href + '/' });
  const id = await ctx.loader.create({ name: row.name, config: { ...row.config, serviceUrl, agents: ['codex'], stateDirectory: join(process.cwd(), 'plugin-state'),
    a2a: { token: 'package-smoke-token', publicUrl: 'http://127.0.0.1:3080', stateDirectory: join(process.cwd(), 'a2a-state') } } });
  const fiber = ctx.loader.resolve(id).fiber;
  assert.ok(fiber);
  await fiber.await();
  assert.equal((await (await fetch(`${serviceUrl}/health`)).json()).service, 'acp-service');
  assert.equal(presets.get('oneagents-acp-codex').plugins[1].name, '@1agents/acp-service/dsh/preset');
  assert.equal(typeof ctx.oneagentsAcpSessions.importSession, 'function');
  assert.equal(typeof routes.get('/.well-known/agent-card.json')?.handler, 'function');
  assert.equal(typeof routes.get('/a2a')?.handler, 'function');

  // Verify DSH discovers, serves and registers this same package's client face.
  await ctx.plugin(ClientModuleRegistry);
  const entry = ctx.clientModules.graph().entries.find(value => value.id === '@1agents/acp-service');
  assert.ok(entry, 'Package root must contribute a browser row');
  const response = await ctx.clientModules.fetchBundle(new Request(new URL(entry.url, 'http://localhost/')));
  assert.equal(response.status, 200);
  const registrations = [];
  runInNewContext(await response.text(), { window: { __ModuleLoader__: { load: value => registrations.push(value) } } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, '@1agents/acp-service');
  const browser = registrations[0].factory(name => { assert.equal(name, 'react'); return {}; });
  assert.equal(typeof browser.apply, 'function');
  assert.equal(browser.choices({ options: [{ value: 'fast', name: 'Fast' }] })[0].value, 'fast');
} finally {
  await ctx.fiber.dispose();
}
assert.equal(presets.size, 0);
assert.equal(routes.size, 0);
await assert.rejects(fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(3000) }));
console.log('Installed unified package passed DSH profile, Loader, browser and service lifecycle smoke tests');
