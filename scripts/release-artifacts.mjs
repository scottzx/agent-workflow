import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyPackageBuild } from './verify-package-build.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function packedManifest(archive, entry = 'package/package.json') {
  return JSON.parse(execFileSync('tar', ['-xOf', archive, entry], { encoding: 'utf8' }));
}

export function validateManifest(packed, source) {
  assert.equal(packed.name, '@1agents/acp-service');
  assert.equal(packed.name, source.name);
  assert.equal(packed.version, source.version);
  assert.ok(!packed.private, 'Cannot publish a private package');
  assert.ok(!packed.dependencies?.['@scottzx/1acp'], 'Runtime must be embedded');
  assert.ok(!packed.dependencies?.['@1agents/dsh-acp'], 'DSH plugin must be embedded');
  assert.ok(!packed.dependencies?.['@1agents/dsh-a2a'], 'DSH A2A plugin must be embedded');
  assert.deepEqual(packed.dependencies, source.dependencies, 'Packed dependencies differ from source');
  assert.ok(Object.values(packed.dependencies).every(range => !range.startsWith('workspace:')), 'Unresolved workspace dependency');
  for (const key of ['main', 'types', 'exports', 'bin', 'dsh']) {
    assert.deepEqual(packed[key], source[key], `Packed ${key} differs from source`);
  }
}

export function validateArtifacts(sha, root = process.cwd()) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  const source = JSON.parse(readFileSync(resolve(root, 'packages/service/package.json'), 'utf8'));
  const receipt = JSON.parse(readFileSync(resolve(root, 'release/service-manifest.json'), 'utf8'));
  assert.equal(receipt.sha, sha, 'Artifact belongs to another commit');
  assert.equal(receipt.filename, `${source.name.replace('@', '').replace('/', '-')}-${source.version}.tgz`);
  assert.equal(basename(receipt.filename), receipt.filename);
  const archive = resolve(root, 'release', receipt.filename);
  assert.equal(digest(readFileSync(archive)), receipt.sha256, 'Artifact checksum mismatch');
  const packed = packedManifest(archive);
  validateManifest(packed, source);
  const runtime = JSON.parse(readFileSync(resolve(root, 'packages/runtime/package.json'), 'utf8'));
  const embedded = packedManifest(archive, 'package/vendor/runtime/package.json');
  assert.equal(embedded.version, runtime.version);
  assert.equal(embedded.name, runtime.name);
  const targets = new Set([
    ...Object.values(packed.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value)),
    ...Object.values(packed.bin),
    './vendor/runtime/dist/cli.js', './vendor/dsh/service-worker.js',
  ]);
  for (const target of targets) execFileSync('tar', ['-xOf', archive, `package/${target.replace(/^\.\//, '')}`], { maxBuffer: 16 * 1024 * 1024 });
  const patch = execFileSync('tar', ['-xOf', archive, `package/${packed.dsh.bundle.patch.replace(/^\.\//, '')}`], { encoding: 'utf8' });
  assert.ok(patch.includes(`name: '${packed.name}'`), 'DSH patch must load the package root');
  assert.ok(patch.includes(`name: '${packed.name}/dsh-a2a'`), 'DSH patch must declare the embedded dsh-a2a subpath row');
  const client = execFileSync('tar', ['-xOf', archive, `package/${packed.exports['./client'].replace(/^\.\//, '')}`], { encoding: 'utf8' });
  assert.ok(client.includes(`id:"${packed.name}"`), 'Browser registration must match the package name');
  return [{ archive, packed }];
}

function main() {
  assert.equal(process.argv.length, 2, 'Only the unified acp-service package can be packed; use pnpm run pack from the root');
  const sha = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  verifyPackageBuild();
  mkdirSync('release', { recursive: true });
  const source = JSON.parse(readFileSync('packages/service/package.json', 'utf8'));
  execFileSync('pnpm', ['--filter', source.name, 'pack', '--pack-destination', resolve('release')], { stdio: 'inherit' });
  const filename = `${source.name.replace('@', '').replace('/', '-')}-${source.version}.tgz`;
  writeFileSync('release/service-manifest.json', JSON.stringify({ sha, filename, sha256: digest(readFileSync(`release/${filename}`)) }, null, 2) + '\n');
  validateArtifacts(sha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
