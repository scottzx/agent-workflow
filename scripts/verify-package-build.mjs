/** Packing validates existing outputs; it must never build or rerun tests. */
import assert from 'node:assert/strict';
import { accessSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyPackageBuild(root = resolve(import.meta.dirname, '..')) {
  const service = join(root, 'packages/service');
  const manifest = JSON.parse(readFileSync(join(service, 'package.json'), 'utf8'));
  for (const target of Object.values(manifest.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value))) {
    accessSync(join(service, target));
  }
  for (const target of Object.values(manifest.bin)) accessSync(join(service, target));
  for (const target of ['vendor/runtime/package.json', 'vendor/dsh/service-worker.js', 'dist/workbench-ui/index.html', 'dist/workbench-ui/app.js']) accessSync(join(service, target));
  const patch = readFileSync(join(service, manifest.dsh.bundle.patch), 'utf8');
  assert.ok(patch.includes(`name: '${manifest.name}'`), 'DSH patch must load the package root so its client face is discovered');
  const client = readFileSync(join(service, manifest.exports['./client']), 'utf8');
  assert.ok(client.includes(`id:"${manifest.name}"`), 'Client registration must match the public package name');
  assert.ok(!manifest.dependencies['@1agents/dsh-acp'], 'DSH plugin must be embedded');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) verifyPackageBuild();
