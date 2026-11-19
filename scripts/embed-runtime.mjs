/** Include the upstream runtime in the service without publishing a third package. */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runtime = join(root, 'packages/runtime');
const service = join(root, 'packages/service');
const manifest = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'));
const serviceManifest = JSON.parse(readFileSync(join(service, 'package.json'), 'utf8'));
const sdkAlias = '@1agents/acp-runtime-sdk';
for (const [name, range] of Object.entries(manifest.dependencies)) {
  const key = name === '@agentclientprotocol/sdk' ? sdkAlias : name;
  const expected = name === '@agentclientprotocol/sdk' ? `npm:${name}@${range}` : range;
  if (serviceManifest.dependencies[key] !== expected) {
    throw new Error(`Service must declare runtime dependency ${key}: ${expected}`);
  }
}
const destination = join(service, 'vendor/runtime');
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const entry of ['dist', 'skills', 'LICENSE', 'README.md']) {
  cpSync(join(runtime, entry), join(destination, entry), { recursive: true });
}
// Preserve the runtime's package boundary, version, CLI-relative resources and
// flow self-imports. Route the runtime's SDK through an alias so it keeps SDK
// 1.9 alongside the service's SDK 1.4, and add the service flow entrypoint.
function rewriteRuntimeModules(directory) {
  let flowHooks = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) flowHooks += rewriteRuntimeModules(file);
    else if (/\.(?:js|ts)$/.test(entry.name)) {
      const source = readFileSync(file, 'utf8');
      const original = 'new Set(["acpx/flows", "@scottzx/1acp/flows"])';
      flowHooks += source.split(original).length - 1;
      writeFileSync(file, source.replaceAll('@agentclientprotocol/sdk', sdkAlias)
        .replaceAll(original, 'new Set(["acpx/flows", "@scottzx/1acp/flows", "@1agents/acp-service/flows"])'));
    }
  }
  return flowHooks;
}
if (rewriteRuntimeModules(join(destination, 'dist')) !== 2) {
  throw new Error('Upstream flow resolver changed; update the embedded service flow alias');
}
const { scripts, devDependencies, ...published } = manifest;
published.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).map(([name, range]) =>
  name === '@agentclientprotocol/sdk' ? [sdkAlias, `npm:${name}@${range}`] : [name, range]));
writeFileSync(join(destination, 'package.json'), JSON.stringify(published, null, 2) + '\n');
console.log(`Embedded runtime ${manifest.version} in ${serviceManifest.name}`);
