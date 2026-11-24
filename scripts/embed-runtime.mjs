/** Include the upstream runtime in the service without publishing a third package. */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertServiceDeclaresRuntimeDeps, rewriteRuntimeSource, runtimeCopyEntries, runtimePublishManifest } from './package-embed.mjs';

export function embedRuntime(root = resolve(import.meta.dirname, '..')) {
  const runtime = join(root, 'packages/runtime');
  const service = join(root, 'packages/service');
  const manifest = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'));
  const serviceManifest = JSON.parse(readFileSync(join(service, 'package.json'), 'utf8'));
  assertServiceDeclaresRuntimeDeps(serviceManifest, manifest);
  const destination = join(service, 'vendor/runtime');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const entry of runtimeCopyEntries) cpSync(join(runtime, entry), join(destination, entry), { recursive: true });
  if (rewriteRuntimeModules(join(destination, 'dist')) !== 2) {
    throw new Error('Upstream flow resolver changed; update the embedded service flow alias');
  }
  writeFileSync(join(destination, 'package.json'), JSON.stringify(runtimePublishManifest(manifest), null, 2) + '\n');
  console.log(`Embedded runtime ${manifest.version} in ${serviceManifest.name}`);
}

function rewriteRuntimeModules(directory) {
  let flowHooks = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) flowHooks += rewriteRuntimeModules(file);
    else if (/\.(?:js|ts)$/.test(entry.name)) {
      const source = readFileSync(file, 'utf8');
      const rewritten = rewriteRuntimeSource(source);
      flowHooks += rewritten.flowHooks;
      if (rewritten.text !== source) writeFileSync(file, rewritten.text);
    }
  }
  return flowHooks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) embedRuntime();
