/** Shared embed transforms. Verification replays these; it must not invent a second copy. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sdkAlias = '@1agents/acp-runtime-sdk';
export const flowOriginal = 'new Set(["acpx/flows", "@scottzx/1acp/flows"])';
export const flowReplacement = 'new Set(["acpx/flows", "@scottzx/1acp/flows", "@1agents/acp-service/flows"])';
export const runtimeCopyEntries = ['dist', 'skills', 'LICENSE', 'README.md'];
export const dshSidecarFiles = ['cordis.patch.yml', 'README.md', 'LICENSE'];
export const dshA2ASidecarFiles = ['README.md'];

export function rewriteRuntimeSource(source) {
  const flowHooks = source.split(flowOriginal).length - 1;
  const text = source.replaceAll('@agentclientprotocol/sdk', sdkAlias).replaceAll(flowOriginal, flowReplacement);
  return { text, flowHooks };
}

export function runtimePublishManifest(manifest) {
  const { scripts, devDependencies, ...published } = manifest;
  published.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).map(([name, range]) =>
    name === '@agentclientprotocol/sdk' ? [sdkAlias, `npm:${name}@${range}`] : [name, range]));
  return published;
}

export function assertServiceDeclaresRuntimeDeps(serviceManifest, runtimeManifest) {
  for (const [name, range] of Object.entries(runtimeManifest.dependencies)) {
    const key = name === '@agentclientprotocol/sdk' ? sdkAlias : name;
    const expected = name === '@agentclientprotocol/sdk' ? `npm:${name}@${range}` : range;
    if (serviceManifest.dependencies[key] !== expected) {
      throw new Error(`Service must declare runtime dependency ${key}: ${expected}`);
    }
  }
}

export function assertPluginDepsDeclared(pluginManifest, serviceManifest) {
  if (pluginManifest.private !== true) throw new Error('DSH source package must not be published');
  for (const [name, range] of Object.entries(pluginManifest.dependencies)) {
    if (name === serviceManifest.name) continue;
    if (serviceManifest.dependencies[name] !== range) {
      throw new Error(`Unified package must declare DSH dependency ${name}`);
    }
  }
}

export function listFiles(directory) {
  const files = [];
  const walk = relative => {
    const current = relative ? join(directory, relative) : directory;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Embed tree contains a symlink: ${rel}`);
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.push(rel);
      else throw new Error(`Embed tree contains an unsupported entry: ${rel}`);
    }
  };
  walk('');
  return files.sort();
}

export function expectedRuntimeFiles(runtimeRoot) {
  const files = new Map();
  let flowHooks = 0;
  for (const entry of runtimeCopyEntries) {
    const source = join(runtimeRoot, entry);
    let listed;
    try {
      listed = listFiles(source);
    } catch (error) {
      if (error?.code !== 'ENOTDIR') throw error;
      files.set(entry, readFileSync(source));
      continue;
    }
    for (const rel of listed) {
      const destination = `${entry}/${rel}`;
      if (entry === 'dist' && /\.(?:js|ts)$/.test(rel)) {
        const rewritten = rewriteRuntimeSource(readFileSync(join(source, rel), 'utf8'));
        flowHooks += rewritten.flowHooks;
        files.set(destination, Buffer.from(rewritten.text));
      } else {
        files.set(destination, readFileSync(join(source, rel)));
      }
    }
  }
  if (flowHooks !== 2) throw new Error('Upstream flow resolver changed; update the embedded service flow alias');
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8'));
  files.set('package.json', Buffer.from(JSON.stringify(runtimePublishManifest(manifest), null, 2) + '\n'));
  return files;
}

/** Dist is copied first; the sidecar files then overlay the plugin root, matching embed-dsh. */
export function expectedDshFiles(pluginRoot) {
  const files = new Map();
  for (const rel of listFiles(join(pluginRoot, 'dist'))) files.set(rel, readFileSync(join(pluginRoot, 'dist', rel)));
  for (const name of dshSidecarFiles) files.set(name, readFileSync(join(pluginRoot, name)));
  return files;
}

/** Built DSH A2A modules and docs staged into `packages/service/vendor/dsh-a2a`. */
export function expectedDshA2AFiles(pluginRoot) {
  const files = new Map();
  for (const rel of listFiles(join(pluginRoot, 'dist'))) files.set(rel, readFileSync(join(pluginRoot, 'dist', rel)));
  for (const name of dshA2ASidecarFiles) files.set(name, readFileSync(join(pluginRoot, name)));
  return files;
}

export function assertSameFiles(expected, actualDirectory, label) {
  const actual = listFiles(actualDirectory);
  const wanted = [...expected.keys()].sort();
  const missing = wanted.filter(rel => !actual.includes(rel));
  const extra = actual.filter(rel => !wanted.includes(rel));
  if (missing.length || extra.length) {
    throw new Error(`${label} file list mismatch; missing ${missing.slice(0, 5).join(', ') || 'none'}; extra ${extra.slice(0, 5).join(', ') || 'none'}`);
  }
  for (const rel of wanted) {
    const found = readFileSync(join(actualDirectory, rel));
    const target = expected.get(rel);
    if (!found.equals(Buffer.isBuffer(target) ? target : Buffer.from(target))) {
      throw new Error(`${label} content mismatch: ${rel}`);
    }
  }
}
