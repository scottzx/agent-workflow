import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
test('A2A source and manifest have no dependency on the ACP plugin or SDK', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  assert.equal(dependencies['@1agents/dsh-acp'], undefined);
  assert.equal(manifest.dependencies['@1agents/acp-service'], undefined);
  assert.equal(dependencies['@agentclientprotocol/sdk'], undefined);
  assert.equal(dependencies['@1agents/acp-runtime-sdk'], undefined);
  for (const name of await readdir(new URL('src/', root))) {
    if (!name.endsWith('.js')) continue;
    const source = await readFile(new URL(`src/${name}`, root), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"]@1agents\/dsh-acp(?:\/|['"])/);
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"]@agentclientprotocol\//);
    // The source uses the narrow standalone entry only for local bundling; published dist must be self-contained.
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"]@1agents\/dsh-acp/);
  }
});
test('built exports and CLI load without a DSH Host or ACP plugin', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  for (const [name, target] of Object.entries(manifest.exports)) {
    await access(new URL(target, root));
    if (name === './package.json' || !target.endsWith('.js')) continue;
    // The client half is browser code for the host's module loader, not a Node module.
    if (name === './client') continue;
    const exports = await import(new URL(target, root).href);
    // Host services this bundle needs; it must not depend on the ACP plugin.
    if (name === '.') assert.deepEqual(exports.inject, ['webServer', 'connection']);
  }
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL(manifest.bin['dsh-a2a'], root)), '--help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /Usage: dsh-a2a/);
});
test('client half loads through the host module loader and owns the workbench panel', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.deepEqual(manifest.dsh.client.platform, 'web');
  const source = await readFile(new URL(manifest.exports['./client'], root), 'utf8');
  // The host hands this file to its own loader; a bare import would break the page.
  assert.match(source, /window\.__ModuleLoader__\.load\(\{id:"@1agents\/dsh-a2a"/);
  assert.match(source, /oneagents-a2a-workbench/);
  // The panel frames the page this plugin's host half serves, on the GUI's own origin.
  assert.match(source, /src:\s*"\/workbench\/ui\/"/);
  // Browser code must not pull Node built-ins or the DSH host packages into the bundle.
  assert.doesNotMatch(source, /require\("node:/);
});
test('client half depends on nothing from the ACP plugin', async () => {
  const source = await readFile(new URL('src/client.js', root), 'utf8');
  assert.doesNotMatch(source, /@1agents\/acp-service|@1agents\/dsh-acp/);
});
test('legacy ACP A2A export keeps a package-local compatible target', async () => {
  const url = new URL('../dsh-plugin/package.json', root);
  const manifest = JSON.parse(await readFile(url, 'utf8'));
  assert.deepEqual(manifest.exports['./a2a'], { types: './dist/a2a.d.ts', import: './dist/a2a.js' });
  assert.equal(manifest.dependencies['@1agents/dsh-a2a'], undefined);
});
