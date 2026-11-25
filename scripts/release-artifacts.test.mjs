import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { validateArtifacts, validateManifest, digest } from './release-artifacts.mjs';

const source = JSON.parse(readFileSync(new URL('../packages/service/package.json', import.meta.url), 'utf8'));

test('unified package rejects split-package dependencies, changed entrypoints and private releases', () => {
  assert.doesNotThrow(() => validateManifest(source, source));
  for (const override of [
    { version: '0.4.0' }, { private: true }, { dsh: undefined }, { exports: { '.': './dist/src/index.js' } },
    { dependencies: { '@scottzx/1acp': '^0.16.0' } }, { dependencies: { '@1agents/dsh-acp': '^0.2.2' } },
    { dependencies: { '@1agents/dsh-a2a': '^0.2.6' } },
  ]) assert.throws(() => validateManifest({ ...source, ...override }, source));
  const leaked = { ...source, dependencies: { ...source.dependencies, other: 'workspace:*' } };
  assert.throws(() => validateManifest(leaked, leaked), /workspace/);
});

test('release validates commit, checksum and both installed entrypoints before publishing', t => {
  const root = mkdtempSync(join(tmpdir(), 'release-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  write('packages/service/package.json', JSON.stringify(source));
  const runtime = { name: '@scottzx/1acp', version: '0.16.0' };
  write('packages/runtime/package.json', JSON.stringify(runtime));
  write('package/package.json', JSON.stringify(source));
  const targets = [
    ...Object.values(source.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value)),
    ...Object.values(source.bin), './vendor/runtime/dist/cli.js', './vendor/dsh/service-worker.js',
  ];
  for (const target of targets) if (target !== './package.json') write(`package/${target.replace(/^\.\//, '')}`, 'fixture');
  write('package/vendor/runtime/package.json', JSON.stringify(runtime));
  write('package/vendor/dsh/cordis.patch.yml', `- name: '${source.name}'\n- name: '${source.name}/dsh-a2a'\n`);
  write('package/vendor/dsh/client.js', `load({id:"${source.name}"});`);
  const filename = `1agents-acp-service-${source.version}.tgz`;
  const archive = join(root, 'release', filename);
  mkdirSync(join(root, 'release'));
  const sha = 'a'.repeat(40);
  const receiptPath = join(root, 'release/service-manifest.json');
  const repack = () => {
    execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
    const receipt = { filename, sha, sha256: digest(readFileSync(archive)) };
    writeFileSync(receiptPath, JSON.stringify(receipt));
    return receipt;
  };
  const receipt = repack();
  assert.equal(validateArtifacts(sha, root).length, 1);
  assert.throws(() => validateArtifacts('b'.repeat(40), root), /another commit/);
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, sha256: 'bad' }));
  assert.throws(() => validateArtifacts(sha, root), /checksum/);
  write('package/vendor/dsh/cordis.patch.yml', "- name: '@1agents/acp-service/dsh'\n");
  repack();
  assert.throws(() => validateArtifacts(sha, root), /package root/);
  write('package/vendor/dsh/cordis.patch.yml', `- name: '${source.name}'\n`);
  repack();
  assert.throws(() => validateArtifacts(sha, root), /dsh-a2a/);
  write('package/vendor/dsh/cordis.patch.yml', `- name: '${source.name}'\n- name: '${source.name}/dsh-a2a'\n`);
  write('package/vendor/dsh/client.js', 'load({id:"@1agents/dsh-acp"});');
  repack();
  assert.throws(() => validateArtifacts(sha, root), /Browser registration/);
  write('package/vendor/dsh/client.js', `load({id:"${source.name}"});`);
  rmSync(join(root, 'package/vendor/dsh/service-worker.js'));
  repack();
  assert.throws(() => validateArtifacts(sha, root));
});
