/** Packing validates existing outputs; it must never build or rerun tests. */
import assert from 'node:assert/strict';
import { accessSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertPluginDepsDeclared,
  assertSameFiles,
  assertServiceDeclaresRuntimeDeps,
  expectedDshA2AFiles,
  expectedDshFiles,
  expectedRuntimeFiles,
} from './package-embed.mjs';

export function verifyPackageBuild(root = resolve(import.meta.dirname, '..')) {
  const service = join(root, 'packages/service');
  const manifest = JSON.parse(readFileSync(join(service, 'package.json'), 'utf8'));
  const runtimeManifest = JSON.parse(readFileSync(join(root, 'packages/runtime/package.json'), 'utf8'));
  const pluginManifest = JSON.parse(readFileSync(join(root, 'packages/dsh-plugin/package.json'), 'utf8'));
  const dshA2AManifest = JSON.parse(readFileSync(join(root, 'packages/dsh-a2a/package.json'), 'utf8'));
  for (const target of Object.values(manifest.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value))) {
    accessSync(join(service, target));
  }
  for (const target of Object.values(manifest.bin)) accessSync(join(service, target));
  for (const target of ['vendor/runtime/package.json', 'vendor/dsh/service-worker.js', 'vendor/dsh-a2a/index.js', 'vendor/dsh-a2a/cli.js', 'dist/workbench-ui/index.html', 'dist/workbench-ui/app.js']) {
    accessSync(join(service, target));
  }
  const patch = readFileSync(join(service, manifest.dsh.bundle.patch), 'utf8');
  assert.ok(patch.includes(`name: '${manifest.name}'`), 'DSH patch must load the package root so its client face is discovered');
  assert.ok(patch.includes(`name: '${manifest.name}/dsh-a2a'`), 'DSH patch must declare the embedded dsh-a2a subpath row');
  const client = readFileSync(join(service, manifest.exports['./client']), 'utf8');
  assert.ok(client.includes(`id:"${manifest.name}"`), 'Client registration must match the public package name');
  assert.ok(!manifest.dependencies['@1agents/dsh-acp'], 'DSH plugin must be embedded');
  assert.ok(!manifest.dependencies['@1agents/dsh-a2a'], 'DSH A2A plugin must be embedded');
  assertServiceDeclaresRuntimeDeps(manifest, runtimeManifest);
  assertPluginDepsDeclared(pluginManifest, manifest);
  assertPluginDepsDeclared(dshA2AManifest, manifest);
  assertSameFiles(expectedRuntimeFiles(join(root, 'packages/runtime')), join(service, 'vendor/runtime'), 'vendor/runtime');
  assertSameFiles(expectedDshFiles(join(root, 'packages/dsh-plugin')), join(service, 'vendor/dsh'), 'vendor/dsh');
  assertSameFiles(expectedDshA2AFiles(join(root, 'packages/dsh-a2a')), join(service, 'vendor/dsh-a2a'), 'vendor/dsh-a2a');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) verifyPackageBuild();
