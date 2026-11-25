import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { activateStage, fileInventory, inventoryHash, rollbackActivation, sha256, sourceFiles, stageRelease, verifyDependencies, verifyInstalledPackage, verifyRelease, verifyStage, versionSatisfies } from './local-deployment.mjs';
const sourceManifest = JSON.parse(readFileSync(new URL('../packages/service/package.json', import.meta.url), 'utf8'));
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const saveJSON = (path, value) => save(path, JSON.stringify(value));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), '1acp-local-deploy-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'release'), packageDirectory = join(root, 'packed/package'), dependencies = join(root, 'deps');
  mkdirSync(release); mkdirSync(dependencies);
  const manifest = { ...sourceManifest, dependencies: { sample: '^1.2.3' } };
  const targets = [...Object.values(manifest.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value)), ...Object.values(manifest.bin), 'vendor/runtime/package.json', 'vendor/dsh/service-worker.js'];
  for (const target of targets) save(join(packageDirectory, target), 'fixture\n');
  saveJSON(join(packageDirectory, 'package.json'), manifest);
  save(join(packageDirectory, manifest.dsh.bundle.patch), `- name: '${manifest.name}'\n- name: '${manifest.name}/dsh-a2a'\n`);
  save(join(packageDirectory, manifest.exports['./client']), `load({id:"${manifest.name}"});\n`);
  saveJSON(join(dependencies, 'sample/package.json'), { name: 'sample', version: '1.3.0' });
  save(join(dependencies, 'sample/index.js'), 'module.exports = {};\n');
  const source = join(root, 'source'); save(join(source, 'package.json'), '{"private":true}');
  for (const [name, directory, entries] of [['package.tgz', join(root, 'packed'), ['package']], ['source.tar.gz', source, ['.']], ['dependencies.tar.gz', dependencies, ['.']]]) {
    execFileSync('tar', ['-czf', join(release, name), '-C', directory, ...entries]);
  }
  const artifact = (filename, directory) => { const inventory = fileInventory(directory); return { filename, sha256: sha256(readFileSync(join(release, filename))), inventory, inventorySha256: inventoryHash(inventory) }; };
  const receipt = { schemaVersion: 1, releaseId: '0.8.1-local.fixture', package: { name: manifest.name, version: manifest.version, ...artifact('package.tgz', packageDirectory) }, source: artifact('source.tar.gz', source), dependencies: artifact('dependencies.tar.gz', dependencies), toolchain: { platform: process.platform, arch: process.arch } };
  saveJSON(join(release, 'release-manifest.json'), receipt);
  return { root, release, packageDirectory, dependencies, receipt };
}
test('direct dependency ranges reject mismatches and unknown syntax, including npm aliases', t => {
  for (const [v, range, expected] of [['1.9.0','^1.2.3',true],['2.0.0','^1.2.3',false],['0.2.9','^0.2.1',true],['0.3.0','^0.2.1',false],['0.0.2','^0.0.1',false],['1.3.0','~1.2.3',false],['1.2.4','~1.2.3',true],['1.3.0','npm:sample@^1.2.3',true],['1.3.0','*',false]]) assert.equal(versionSatisfies(v,range),expected,`${v} ${range}`);
  const f = fixture(t);
  assert.equal(verifyDependencies(f.dependencies, { dependencies: { sample: '^1.2.3' } })[0].version, '1.3.0');
  assert.throws(() => verifyDependencies(f.dependencies, { dependencies: { sample: '^2.0.0' } }), /does not satisfy/);
  assert.throws(() => verifyDependencies(f.dependencies, { dependencies: { sample: 'npm:other@^1.2.3' } }), /alias/);
});
test('source capture includes tracked .1agents definitions and excludes private live data even when tracked', t => {
  const root = mkdtempSync(join(tmpdir(), '1acp-project-role-source-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const definitions = ['.1agents/README.md', '.1agents/roles/ppt-beautifier/profile.json', '.1agents/roles/ppt-beautifier/ROLE.md', '.1agents/config/role-skills.example.json', '.1agents/config/project-discovery.example.json', '.1agents/config/wechat-stock.example.json', '.1agents/roles/wechat-stock-replenisher/role.example.json', 'examples/activepieces/wechat-stock/bridge.mjs'];
  const privateFiles = ['.1agents/config/role-skills.local.json', '.1agents/config/project-discovery.local.json', '.1agents/config/credentials.json', '.1agents/cache/roles/locks/task.json', '.1agents/state/a2a-gateway/targets.json', '.1agents/state/a2a-gateway/project-discovery/discovery.json', '.1agents/workspaces/ppt-beautifier/artifacts/final.pptx', '.1agents/roles/ppt-beautifier/.env'];
  for (const path of [...definitions, ...privateFiles]) save(join(root, path), 'fixture');
  const legacyRole = 'roles/ppt-beautifier/profile.json';
  save(join(root, legacyRole), 'legacy source before directory migration');
  execFileSync('git', ['add', '--', ...definitions, ...privateFiles, legacyRole], { cwd: root });
  rmSync(join(root, 'roles'), { recursive: true });
  symlinkSync('.1agents/roles', join(root, 'roles'), 'dir');
  save(join(root, '.1agents/roles/untracked/profile.json'), 'not yet reviewed source');
  save(join(root, 'scripts/entry.mjs'), 'source');
  assert.deepEqual(sourceFiles(root), [...definitions, 'scripts/entry.mjs'].sort());
});
test('input fingerprints reflect file bytes and executable bits, reject external symlinks and chains', t => {
  const f=fixture(t), directory=join(f.root,'fingerprint'); save(join(directory,'input.txt'),'original');
  const before=inventoryHash(fileInventory(directory));
  assert.equal(inventoryHash(fileInventory(directory)),before);
  save(join(directory,'input.txt'),'modified'); assert.notEqual(inventoryHash(fileInventory(directory)),before);
  const textHash=inventoryHash(fileInventory(directory)); chmodSync(join(directory,'input.txt'),0o755); assert.notEqual(inventoryHash(fileInventory(directory)),textHash);
  symlinkSync('/etc/passwd',join(directory,'external')); assert.throws(()=>fileInventory(directory),/External symlink/);
});
test('one immutable tarball restores two complete installations offline with identical inventories', t => {
  const f=fixture(t), first=join(f.root,'first'), second=join(f.root,'second');
  const a=stageRelease({release:f.release,target:first}), b=stageRelease({release:f.release,target:second});
  assert.equal(a.offline,true); assert.equal(a.packageSha256,b.packageSha256); assert.equal(a.packageInventorySha256,b.packageInventorySha256);
  assert.equal(inventoryHash(fileInventory(join(first,'node_modules'))),inventoryHash(fileInventory(join(second,'node_modules'))));
  assert.equal(verifyStage(first).releaseId,f.receipt.releaseId); assert.equal(verifyStage(second).releaseId,f.receipt.releaseId);
  save(join(first,'node_modules/@1agents/acp-service/dist/src/a2a/index.js'),'tampered'); assert.throws(()=>verifyStage(first),/checksum/);
});
test('archive checksum corruption is rejected before staging or activation', t => {
  const f=fixture(t); save(join(f.release,'package.tgz'),'tampered');
  assert.throws(()=>verifyRelease(f.release),/checksum/);
  const target=join(f.root,'not-created'); assert.throws(()=>stageRelease({release:f.release,target}),/checksum/); assert.equal(existsSync(target),false);
});
test('both package faces and root-loading DSH patch must be present', t => {
  const f=fixture(t); assert.equal(verifyInstalledPackage(f.packageDirectory).name,sourceManifest.name);
  save(join(f.packageDirectory,sourceManifest.dsh.bundle.patch),"- name: '@1agents/acp-service/dsh'\n"); assert.throws(()=>verifyInstalledPackage(f.packageDirectory),/package root/);
  save(join(f.packageDirectory,sourceManifest.dsh.bundle.patch),`- name: '${sourceManifest.name}'\n- name: '${sourceManifest.name}/dsh-a2a'\n`);
  save(join(f.packageDirectory,sourceManifest.exports['./client']),'load({id:"wrong"});'); assert.throws(()=>verifyInstalledPackage(f.packageDirectory),/Client registration/);
});
test('activation and rollback replace only the package slot and preserve unrelated profile/config state', t => {
  const f=fixture(t), stage=join(f.root,'stage'); stageRelease({release:f.release,target:stage});
  const target=join(f.root,'profile/node_modules/@1agents/acp-service'), config=join(f.root,'profile/settings.json'), receiptPath=join(f.root,'activation.json');
  save(join(target,'old.txt'),'old installation'); save(config,'unchanged private settings');
  const activation=activateStage({stage,target,receiptPath}); assert.equal(activation.releaseId,f.receipt.releaseId); assert.equal(verifyInstalledPackage(target).name,sourceManifest.name);
  assert.equal(readFileSync(config,'utf8'),'unchanged private settings');
  assert.equal(rollbackActivation(receiptPath).rolledBack,true); assert.equal(readFileSync(join(target,'old.txt'),'utf8'),'old installation'); assert.equal(readFileSync(config,'utf8'),'unchanged private settings');
});

test('dependency capture preserves relative .bin symlinks instead of rewriting absolute targets', t => {
  const f=fixture(t), base=join(f.root,'base'), copied=join(f.root,'copied');
  save(join(base,'example/bin.js'),'executable'); mkdirSync(join(base,'.bin')); symlinkSync('../example/bin.js',join(base,'.bin/example'));
  const before=inventoryHash(fileInventory(base));
  cpSync(base,copied,{recursive:true,dereference:false,verbatimSymlinks:true});
  assert.equal(inventoryHash(fileInventory(copied)),before);
  assert.equal(fileInventory(copied).find(entry=>entry.path==='.bin/example').target,'../example/bin.js');
});

test('copy activation retains frozen dependencies at the host slot, resolves native host peers and rolls back', t => {
  const f=fixture(t), stage=join(f.root,'copy-stage'); stageRelease({release:f.release,target:stage});
  const target=join(f.root,'copy-profile/node_modules/@1agents/acp-service'), receiptPath=join(f.root,'copy-activation.json');
  save(join(target,'old.txt'),'old installation');
  saveJSON(join(f.root,'copy-profile/node_modules/native-peer/package.json'),{name:'native-peer',version:'1.0.0',main:'index.js'});
  save(join(f.root,'copy-profile/node_modules/native-peer/index.js'),'module.exports = "host peer";');
  const activation=activateStage({stage,target,receiptPath,mode:'copy'});
  assert.equal(activation.activationMode,'copy');
  assert.equal(verifyDependencies(join(target,'node_modules'),{dependencies:{sample:'^1.2.3'}})[0].version,'1.3.0');
  const nativePeer=execFileSync(process.execPath,['-e','process.stdout.write(require(require("node:module").createRequire(process.argv[1]).resolve("native-peer")))',join(target,'package.json')],{encoding:'utf8'});
  assert.equal(nativePeer,'host peer');
  assert.equal(inventoryHash(fileInventory(target)),activation.installedInventorySha256);
  assert.equal(rollbackActivation(receiptPath).rolledBack,true); assert.equal(readFileSync(join(target,'old.txt'),'utf8'),'old installation');
});
test('copy rollback refuses a modified installation without removing the active package or its backup', t => {
  const f=fixture(t), stage=join(f.root,'copy-stage-changed'); stageRelease({release:f.release,target:stage});
  const target=join(f.root,'copy-profile-changed/node_modules/@1agents/acp-service'), receiptPath=join(f.root,'copy-changed.json');
  save(join(target,'old.txt'),'old installation');
  const activation=activateStage({stage,target,receiptPath,mode:'copy'});
  save(join(target,'dist/src/a2a/index.js'),'changed after activation');
  assert.throws(()=>rollbackActivation(receiptPath),/contents changed/);
  assert.equal(readFileSync(join(target,'dist/src/a2a/index.js'),'utf8'),'changed after activation');
  assert.equal(readFileSync(join(activation.previous,'old.txt'),'utf8'),'old installation');
});
