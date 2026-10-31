/** Local, immutable deployment receipts. Never publishes, restarts hosts or edits profile/config/state. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyPackageBuild } from './verify-package-build.mjs';
import { validateManifest } from './release-artifacts.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const forbidden = path => /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|credentials(?:\.[^/]*)?|[^/]*\.(?:key|pem))$/.test(path);
const ownPackage = '@1agents/acp-service';
const withoutOwnPackage = path => path !== ownPackage && !path.startsWith(`${ownPackage}/`) && !forbidden(path);
const canonical = value => JSON.stringify(value);
export const inventoryHash = inventory => sha256(canonical(inventory));

/** Hash regular files and safe relative symlinks; never follow a link outside the captured root. */
export function fileInventory(root, filter = () => true) {
  root = realpathSync(resolve(root));
  const entries = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), rel = relative(root, path).split(sep).join('/');
      if (!filter(rel)) continue;
      const info = lstatSync(path);
      if (info.isDirectory()) visit(path);
      else if (info.isSymbolicLink()) {
        const target = readlinkSync(path);
        assert.ok(!isAbsolute(target) && inside(root, resolve(dirname(path), target)), `External symlink rejected: ${rel}`);
        // Check chains as well as the immediate lexical target.
        if (existsSync(path)) assert.ok(inside(root, realpathSync(path)), `External symlink chain rejected: ${rel}`);
        entries.push({ path: rel, kind: 'symlink', target });
      } else {
        assert.ok(info.isFile(), `Unsupported filesystem entry: ${rel}`);
        entries.push({ path: rel, kind: 'file', bytes: info.size, executable: Boolean(info.mode & 0o111), sha256: sha256(readFileSync(path)) });
      }
    }
  }
  visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

/** The lock currently uses exact and caret/tilde ranges; unknown syntax fails closed. */
export function versionSatisfies(version, range) {
  if (range.startsWith('npm:')) range = range.slice(range.lastIndexOf('@') + 1);
  const parsed = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!parsed || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const a = version.split('.').map(Number), b = parsed.slice(2).map(Number);
  const compare = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  if (!parsed[1]) return compare(a, b) === 0;
  if (compare(a, b) < 0) return false;
  const upper = parsed[1] === '~' ? [b[0], b[1] + 1, 0] : b[0] ? [b[0] + 1, 0, 0] : b[1] ? [0, b[1] + 1, 0] : [0, 0, b[2] + 1];
  return compare(a, upper) < 0;
}
export function verifyDependencies(dependencyRoot, manifest) {
  return Object.entries(manifest.dependencies ?? {}).sort().map(([name, range]) => {
    const installed = json(join(dependencyRoot, name, 'package.json'));
    const expectedName = range.startsWith('npm:') ? range.slice(4, range.lastIndexOf('@')) : name;
    assert.equal(installed.name, expectedName, `Wrong dependency alias: ${name}`);
    assert.ok(versionSatisfies(installed.version, range), `Dependency ${name}@${installed.version} does not satisfy ${range}`);
    return { name, installedName: installed.name, version: installed.version, range };
  });
}
export function verifyInstalledPackage(packageDirectory) {
  const manifest = json(join(packageDirectory, 'package.json'));
  assert.equal(manifest.name, ownPackage);
  assert.ok(!manifest.dependencies?.['@scottzx/1acp'] && !manifest.dependencies?.['@1agents/dsh-acp'], 'Split packages must be embedded');
  const targets = [...Object.values(manifest.exports).flatMap(v => typeof v === 'string' ? [v] : Object.values(v)), ...Object.values(manifest.bin), 'vendor/runtime/package.json', 'vendor/dsh/service-worker.js'];
  for (const target of targets) {
    const path = resolve(packageDirectory, target);
    assert.ok(inside(packageDirectory, path) && statSync(path).isFile(), `Missing installed entrypoint: ${target}`);
  }
  const patch = readFileSync(join(packageDirectory, manifest.dsh.bundle.patch), 'utf8');
  assert.ok(patch.includes(`name: '${manifest.name}'`), 'DSH patch must load the package root');
  const client = readFileSync(join(packageDirectory, manifest.exports['./client']), 'utf8');
  assert.ok(client.includes(`id:"${manifest.name}"`), 'Client registration must match package name');
  return manifest;
}
export function sourceFiles(root) {
  const tracked = new Set(execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root }).toString().split('\0').filter(Boolean));
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean)
    // .1agents mixes source definitions and private live data: only explicitly
    // tracked role definitions, the guide and the public config examples belong in a release.
    .filter(path => path.startsWith('.1agents/')
      ? tracked.has(path) && /^\.1agents\/(?:README\.md|roles\/[A-Za-z0-9][A-Za-z0-9._:-]*\/(?:profile\.json|role\.example\.json|ROLE\.md)|config\/(?:role-skills|project-discovery|wechat-stock)\.example\.json)$/.test(path)
      : /^(?:packages\/|scripts\/|examples\/(?:ppt-beautifier|activepieces\/wechat-stock)\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.gitignore$|README\.md$)/.test(path))
    .filter(path => !/(?:^|\/)(?:node_modules|dist|dist-test|coverage|vendor|\.git)(?:\/|$)/.test(path) && !forbidden(path)).sort();
}
function snapshotSources(root, destination) {
  for (const path of sourceFiles(root)) {
    const original = join(root, path);
    if (!existsSync(original)) continue; // tracked deletions are captured by their absence and git status.
    assert.ok(!lstatSync(original).isSymbolicLink(), `Source symlinks need explicit review: ${path}`);
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    cpSync(original, join(destination, path));
  }
  return fileInventory(destination);
}
function tarCreate(path, directory, entries = ['.']) {
  execFileSync('tar', ['-czf', path, '-C', directory, ...entries]);
}
function tarExtract(path, directory) {
  const names = execFileSync('tar', ['-tzf', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\n').filter(Boolean);
  for (const name of names) assert.ok(!isAbsolute(name) && !name.split('/').includes('..'), `Unsafe archive entry: ${name}`);
  mkdirSync(directory, { recursive: true });
  execFileSync('tar', ['-xzf', path, '-C', directory]);
}
function checkedFile(release, artifact) {
  assert.equal(basename(artifact.filename), artifact.filename, 'Artifact must be a local filename');
  const path = join(release, artifact.filename);
  assert.equal(sha256(readFileSync(path)), artifact.sha256, `Artifact checksum mismatch: ${artifact.filename}`);
  return path;
}

/** Capture already-built outputs. Build/test remain explicit upstream steps, never hidden in pack. */
export function captureRelease({ root, output, dependencyRoot }) {
  root = resolve(root); output = resolve(output); dependencyRoot = resolve(dependencyRoot);
  assert.ok(!existsSync(output), 'Release output already exists; choose an immutable new directory');
  verifyPackageBuild(root);
  const sourceManifest = json(join(root, 'packages/service/package.json'));
  verifyDependencies(dependencyRoot, sourceManifest);
  const scratch = mkdtempSync(join(tmpdir(), '1acp-local-release-'));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  try {
    const sourceDirectory = join(scratch, 'source'); mkdirSync(sourceDirectory);
    const sourceInventory = snapshotSources(root, sourceDirectory);
    const sourceSha256 = inventoryHash(sourceInventory);
    const sourceArchive = join(output, 'source.tar.gz'); tarCreate(sourceArchive, sourceDirectory);
    execFileSync('pnpm', ['--filter', sourceManifest.name, 'pack', '--pack-destination', output], { cwd: root, stdio: 'inherit' });
    const packageFilename = `${sourceManifest.name.replace('@', '').replace('/', '-')}-${sourceManifest.version}.tgz`;
    const packageArchive = join(output, packageFilename);
    const unpacked = join(scratch, 'unpacked'); tarExtract(packageArchive, unpacked);
    const packedManifest = verifyInstalledPackage(join(unpacked, 'package'));
    validateManifest(packedManifest, sourceManifest); // pnpm resolves workspace devDependencies when packing.
    const packageInventory = fileInventory(join(unpacked, 'package'));
    const dependenciesDirectory = join(scratch, 'dependencies'); mkdirSync(dependenciesDirectory);
    fileInventory(dependencyRoot, withoutOwnPackage); // Reject external links before copying.
    cpSync(dependencyRoot, dependenciesDirectory, { recursive: true, dereference: false, verbatimSymlinks: true,
      filter: path => { const rel = relative(dependencyRoot, path).split(sep).join('/'); return !rel || withoutOwnPackage(rel); } });
    const dependencyInventory = fileInventory(dependenciesDirectory);
    const dependenciesArchive = join(output, 'dependencies.tar.gz'); tarCreate(dependenciesArchive, dependenciesDirectory);
    const afterDirectory = join(scratch, 'source-after'); mkdirSync(afterDirectory);
    assert.equal(inventoryHash(snapshotSources(root, afterDirectory)), sourceSha256, 'Sources changed during capture; retry after edits stop');
    const packageSha256 = sha256(readFileSync(packageArchive));
    const manifest = {
      schemaVersion: 1, releaseId: `${sourceManifest.version}-local.${sourceSha256.slice(0, 12)}.${packageSha256.slice(0, 12)}`,
      createdAt: new Date().toISOString(), package: { name: sourceManifest.name, version: sourceManifest.version, filename: packageFilename, sha256: packageSha256, inventory: packageInventory, inventorySha256: inventoryHash(packageInventory) },
      source: { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
        gitStatus: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
        filename: 'source.tar.gz', sha256: sha256(readFileSync(sourceArchive)), inventory: sourceInventory, inventorySha256: sourceSha256,
        lockSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))) },
      dependencies: { filename: 'dependencies.tar.gz', sha256: sha256(readFileSync(dependenciesArchive)), inventory: dependencyInventory, inventorySha256: inventoryHash(dependencyInventory), direct: verifyDependencies(dependenciesDirectory, sourceManifest) },
      toolchain: { node: process.version, platform: process.platform, arch: process.arch, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim() },
      rebuild: { commands: ['tar -xzf source.tar.gz -C SOURCE', 'cd SOURCE', 'pnpm install --frozen-lockfile', 'pnpm link:dsh', 'pnpm build', 'pnpm test:integration'],
        prerequisite: 'Matching Node/pnpm and the target native DSH SDK checkout used by link:dsh; dependency installation may require its registry/cache. Source reconstruction and artifact deployment are separate checks.',
        sourceRebuildVerified: false, byteForByteSourceRebuildClaimed: false },
    };
    writeJSON(join(output, 'release-manifest.json'), manifest);
    return manifest;
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
export function verifyRelease(release) {
  release = resolve(release);
  const manifest = json(join(release, 'release-manifest.json'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.package.name, ownPackage);
  for (const artifact of [manifest.package, manifest.source, manifest.dependencies]) {
    checkedFile(release, artifact);
    assert.equal(inventoryHash(artifact.inventory), artifact.inventorySha256, 'Inventory checksum mismatch');
  }
  return manifest;
}
/** Entire runtime installation is restored offline. No npm lifecycle scripts or config/state writes. */
export function stageRelease({ release, target }) {
  release = resolve(release); target = resolve(target);
  assert.ok(!existsSync(target), 'Stage target already exists');
  const manifest = verifyRelease(release);
  assert.equal(process.platform, manifest.toolchain.platform, 'Dependency image platform mismatch');
  assert.equal(process.arch, manifest.toolchain.arch, 'Dependency image architecture mismatch');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    const dependencyRoot = join(target, 'node_modules');
    tarExtract(checkedFile(release, manifest.dependencies), dependencyRoot);
    assert.equal(inventoryHash(fileInventory(dependencyRoot)), manifest.dependencies.inventorySha256, 'Dependency image differs after extraction');
    const unpacked = join(target, '.unpack'); tarExtract(checkedFile(release, manifest.package), unpacked);
    const packageDirectory = join(dependencyRoot, ownPackage); mkdirSync(dirname(packageDirectory), { recursive: true });
    renameSync(join(unpacked, 'package'), packageDirectory); rmSync(unpacked, { recursive: true });
    verifyInstalledPackage(packageDirectory);
    assert.equal(inventoryHash(fileInventory(packageDirectory)), manifest.package.inventorySha256, 'Installed package differs from tarball');
    verifyDependencies(dependencyRoot, json(join(packageDirectory, 'package.json')));
    writeJSON(join(target, 'package.json'), { name: '1acp-immutable-local-deployment', private: true, type: 'module', dependencies: { [ownPackage]: `file:${join(release, manifest.package.filename)}` } });
    const receipt = { schemaVersion: 1, releaseId: manifest.releaseId, release: resolve(release), stagedAt: new Date().toISOString(), packageDirectory, packageSha256: manifest.package.sha256, packageInventorySha256: manifest.package.inventorySha256, dependenciesInventorySha256: manifest.dependencies.inventorySha256, offline: true };
    writeJSON(join(target, 'deployment-receipt.json'), receipt);
    return receipt;
  } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
}
export function verifyStage(target) {
  target = resolve(target);
  const receipt = json(join(target, 'deployment-receipt.json'));
  const manifest = verifyRelease(receipt.release);
  assert.equal(receipt.releaseId, manifest.releaseId);
  assert.equal(receipt.packageDirectory, join(target, 'node_modules', ownPackage));
  verifyInstalledPackage(receipt.packageDirectory);
  assert.equal(inventoryHash(fileInventory(receipt.packageDirectory)), manifest.package.inventorySha256, 'Staged package checksum mismatch');
  const dependencies = fileInventory(join(target, 'node_modules'), withoutOwnPackage);
  assert.equal(inventoryHash(dependencies), manifest.dependencies.inventorySha256, 'Staged dependencies checksum mismatch');
  verifyDependencies(join(target, 'node_modules'), json(join(receipt.packageDirectory, 'package.json')));
  return receipt;
}
/** Caller must first stop the idle host. Only the explicit package slot is changed. */
export function activateStage({ stage, target, receiptPath, mode = 'symlink' }) {
  assert.ok(mode === 'symlink' || mode === 'copy', 'Activation mode must be symlink or copy');
  const staged = verifyStage(stage); target = resolve(target); receiptPath = resolve(receiptPath);
  assert.ok(!existsSync(receiptPath), 'Activation receipt already exists');
  const backup = `${target}.before-${randomUUID()}`, temporary = `${target}.stage-${randomUUID()}`;
  const hadPrevious = existsSync(target) || (() => { try { return lstatSync(target).isSymbolicLink(); } catch { return false; } })();
  // Build the complete replacement beside the destination before moving the old slot.
  if (mode === 'copy') {
    try {
      cpSync(staged.packageDirectory, temporary, { recursive: true, dereference: false, verbatimSymlinks: true });
      const dependencyRoot = join(resolve(stage), 'node_modules');
      cpSync(dependencyRoot, join(temporary, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true,
        filter: path => { const rel = relative(dependencyRoot, path).split(sep).join('/'); return !rel || withoutOwnPackage(rel); } });
      verifyInstalledPackage(temporary);
      verifyDependencies(join(temporary, 'node_modules'), json(join(temporary, 'package.json')));
    } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
  }
  if (hadPrevious) renameSync(target, backup);
  try {
    if (mode === 'copy') renameSync(temporary, target);
    else symlinkSync(staged.packageDirectory, target, 'dir');
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
    const receipt = { schemaVersion: 1, activatedAt: new Date().toISOString(), releaseId: staged.releaseId, activationMode: mode,
      target, previous: hadPrevious ? backup : null, installedPackage: staged.packageDirectory,
      packageInventorySha256: staged.packageInventorySha256,
      installedInventorySha256: inventoryHash(fileInventory(target)),
      dependenciesInventorySha256: staged.dependenciesInventorySha256,
      nativePeers: mode === 'copy' ? 'Provided by the destination host/profile; excluded from the frozen runtime dependency image' : undefined };
    writeJSON(receiptPath, receipt); return receipt;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
    if (hadPrevious) renameSync(backup, target); throw error;
  }
}
export function rollbackActivation(receiptPath) {
  const receipt = json(resolve(receiptPath));
  const mode = receipt.activationMode ?? 'symlink';
  if (mode === 'copy') {
    assert.ok(lstatSync(receipt.target).isDirectory() && !lstatSync(receipt.target).isSymbolicLink(), 'Active package changed since deployment; refusing rollback');
    assert.equal(inventoryHash(fileInventory(receipt.target)), receipt.installedInventorySha256, 'Active installation contents changed since deployment; refusing rollback');
  } else {
    assert.ok(lstatSync(receipt.target).isSymbolicLink() && readlinkSync(receipt.target) === receipt.installedPackage, 'Active package changed since deployment; refusing rollback');
    if (receipt.installedInventorySha256) assert.equal(inventoryHash(fileInventory(receipt.target)), receipt.installedInventorySha256, 'Active installation contents changed since deployment; refusing rollback');
  }
  if (receipt.previous) assert.ok(existsSync(receipt.previous), 'Previous package is missing');
  if (mode === 'copy') rmSync(receipt.target, { recursive: true });
  else unlinkSync(receipt.target);
  if (receipt.previous) renameSync(receipt.previous, receipt.target);
  writeJSON(`${resolve(receiptPath)}.rollback.json`, { rolledBackAt: new Date().toISOString(), releaseId: receipt.releaseId, activationMode: mode, target: receipt.target, previous: receipt.previous });
  return { rolledBack: true, target: receipt.target };
}

export const environments = ['dev', 'test'];
/**
 * Fixed dev/test environments: <base>/<env>/runtime is replaced in place and no per-deploy release directory is kept.
 * Reuses capture/stage/verify through a scratch directory. Caller stops the host first and restarts it afterwards.
 * Version pinning lives in Git, not in local snapshots.
 */
export function deployEnvironment({ env, root, base = join(homedir(), '.local/share/1agents/a2a-gateway'), dependencyRoot }) {
  assert.ok(environments.includes(env), `Environment must be one of ${environments.join(', ')}`);
  root = resolve(root); base = resolve(base);
  const target = join(base, env, 'runtime');
  dependencyRoot = resolve(dependencyRoot ?? join(target, 'node_modules'));
  assert.ok(existsSync(dependencyRoot), `Missing dependency image ${dependencyRoot}; pass --dependency-root on the first deploy`);
  mkdirSync(join(base, env), { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(base, env, '.deploy-'));
  try {
    const release = join(scratch, 'release'), stage = join(scratch, 'stage'), previous = join(scratch, 'previous');
    const manifest = captureRelease({ root, output: release, dependencyRoot });
    stageRelease({ release, target: stage });
    verifyStage(stage);
    if (existsSync(target)) renameSync(target, previous);
    try { renameSync(stage, target); } catch (error) { if (existsSync(previous)) renameSync(previous, target); throw error; }
    rmSync(join(target, 'deployment-receipt.json'), { force: true }); // points at the scratch release, which is deleted below
    if (env === 'test') { // stable entry used by the launchd service
      const link = join(base, 'current.new'); rmSync(link, { force: true });
      symlinkSync(target, link, 'dir'); renameSync(link, join(base, 'current'));
    }
    return { env, target, releaseId: manifest.releaseId, dirty: manifest.source.dirty };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function main() {
  const [command, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) { assert.ok(args[i].startsWith('--') && args[i + 1], 'Expected --key value'); options[args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[i + 1]; }
  const required = names => { for (const name of names) assert.ok(options[name], `Missing --${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`); };
  let result;
  if (command === 'capture') { required(['root', 'output', 'dependencyRoot']); result = captureRelease(options); }
  else if (command === 'stage') { required(['release', 'target']); result = stageRelease(options); }
  else if (command === 'verify') { required(['target']); result = verifyStage(options.target); }
  else if (command === 'verify-release') { required(['release']); result = { releaseId: verifyRelease(options.release).releaseId, verified: true }; }
  else if (command === 'activate') { required(['stage', 'target', 'receiptPath']); result = activateStage(options); }
  else if (command === 'deploy') { required(['env', 'root']); result = deployEnvironment(options); }
  else if (command === 'rollback') { required(['receiptPath']); result = rollbackActivation(options.receiptPath); }
  else throw new Error('Use capture, stage, verify, verify-release, activate, deploy or rollback');
  // Inventories can be large; the saved manifest is authoritative.
  console.log(JSON.stringify(command === 'capture' ? { releaseId: result.releaseId, output: resolve(options.output), packageSha256: result.package.sha256, sourceInventorySha256: result.source.inventorySha256, dirty: result.source.dirty } : result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
