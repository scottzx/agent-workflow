import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const serviceRoot = new URL('../../service/', import.meta.url);
const pluginRoot = new URL('../../dsh-plugin/', import.meta.url);

test('A2A source is private, embedded into @1agents/acp-service, and has no dependency on the ACP plugin or SDK', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.private, true, 'dsh-a2a must be private and embedded into @1agents/acp-service');
  assert.equal(manifest.publishConfig, undefined);
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  assert.equal(dependencies['@1agents/dsh-acp'], undefined);
  assert.equal(dependencies['@agentclientprotocol/sdk'], undefined);
  assert.equal(dependencies['@1agents/acp-runtime-sdk'], undefined);
  for (const name of await readdir(new URL('src/', root))) {
    if (!name.endsWith('.js')) continue;
    const source = await readFile(new URL(`src/${name}`, root), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"]@1agents\/dsh-acp(?:\/|['"])/);
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"]@agentclientprotocol\//);
  }
});

test('built exports and CLI load without a DSH Host or ACP plugin', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  for (const [name, target] of Object.entries(manifest.exports)) {
    await access(new URL(target, root));
    if (name === './package.json' || !target.endsWith('.js')) continue;
    const exports = await import(new URL(target, root).href);
    // Host services this plugin row needs; it must not depend on the ACP plugin.
    if (name === '.') assert.deepEqual(exports.inject, ['webServer', 'connection']);
  }
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL(manifest.bin['dsh-a2a'], root)), '--help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Usage: dsh-a2a/);
});

test('unified @1agents/acp-service bundle declares dsh-a2a subpath export, bin, and independent patch row', async () => {
  const serviceManifest = JSON.parse(await readFile(new URL('package.json', serviceRoot), 'utf8'));
  assert.equal(serviceManifest.exports['./dsh-a2a'], './vendor/dsh-a2a/index.js');
  assert.equal(serviceManifest.exports['./dsh-a2a/server'], './vendor/dsh-a2a/server.js');
  assert.equal(serviceManifest.exports['./dsh-a2a/executor'], './vendor/dsh-a2a/executor.js');
  assert.equal(serviceManifest.bin['dsh-a2a'], 'vendor/dsh-a2a/cli.js');
  assert.equal(serviceManifest.dependencies['@1agents/dsh-a2a'], undefined);
  const patch = await readFile(new URL('cordis.patch.yml', pluginRoot), 'utf8');
  assert.match(patch, /id:\s*oneagents-acp/);
  assert.match(patch, /id:\s*oneagents-dsh-a2a/);
  assert.match(patch, /name:\s*'@1agents\/acp-service\/dsh-a2a'/);
});

test('unified browser client owns the workbench panel and stays inside @1agents/acp-service', async () => {
  const serviceManifest = JSON.parse(await readFile(new URL('package.json', serviceRoot), 'utf8'));
  assert.deepEqual(serviceManifest.dsh.client.platform, 'web');
  assert.ok(serviceManifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'));
  assert.ok(serviceManifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'));
  assert.ok(serviceManifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'));
  const workbenchPanel = await readFile(new URL('src/workbench-panel.js', pluginRoot), 'utf8');
  assert.match(workbenchPanel, /oneagents-a2a-workbench/);
  assert.match(workbenchPanel, /src:\s*'\/workbench\/ui\/'/);
  assert.doesNotMatch(workbenchPanel, /require\("node:/);
});

test('legacy ACP A2A export keeps a package-local compatible target', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', pluginRoot), 'utf8'));
  assert.deepEqual(manifest.exports['./a2a'], { types: './dist/a2a.d.ts', import: './dist/a2a.js' });
  assert.equal(manifest.dependencies['@1agents/dsh-a2a'], undefined);
});
