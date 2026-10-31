import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test from 'node:test';
import { a2aPreflightInputSchema, runA2APreflight } from '../src/a2a/preflight.js';

test('preflight resolves host paths, probes the job directory and checks declared runtime dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = await realpath(root), job = join(cwd, 'job'), input = join(cwd, 'input.md');
  await mkdir(job); await writeFile(input, 'immutable input');
  const report = await runA2APreflight({ cwd: root, jobDirectory: job, requiredFiles: [input],
    node: { executable: process.execPath, modules: ['fs'] } });
  assert.equal(report.ok, true);
  assert.equal(report.cwd, cwd);
  assert.equal(report.jobDirectory, job);
  assert.ok(report.checks.every(check => check.ok));
  assert.deepEqual(await readdir(job), [], 'the probe must not leave files behind');
});

test('missing inputs and runtime dependencies are reported before dispatch, without creating directories', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'a2a-preflight-fail-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const report = await runA2APreflight({ cwd, jobDirectory: join(cwd, 'missing-job'), requiredFiles: [join(cwd, 'missing-file')],
    node: { executable: process.execPath, modules: ['__a2a_intentionally_missing_module__'] } });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.filter(check => !check.ok).map(check => check.id), ['jobDirectory', 'requiredFile.0', 'node']);
  assert.deepEqual(await readdir(cwd), []);
  const missingCwd = await runA2APreflight({ cwd: join(cwd, 'missing-cwd') });
  assert.equal(missingCwd.ok, false);
});

test('writable paths outside DSH sandbox roots are rejected, including symlink escapes', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'a2a-preflight-scope-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // Pick an OS-writable directory outside this cwd and the platform temporary roots. The source tree
  // usually qualifies, but a checkout under /tmp does not, so fall back to the home directory.
  const temporaryRoots = (await Promise.all(['/tmp', tmpdir()].map(path => realpath(path).catch(() => undefined))))
    .filter((path): path is string => path !== undefined);
  const insideTemporary = (path: string) => temporaryRoots.some(root => path === root || path.startsWith(root + sep));
  const candidates = await Promise.all([dirname(import.meta.dirname), homedir()].map(path => realpath(path).catch(() => undefined)));
  const outside = candidates.find((path): path is string => path !== undefined && !insideTemporary(path));
  if (!outside) return t.skip('no writable directory outside the platform temporary roots');
  const link = join(cwd, 'escape'); await symlink(outside, link);
  const report = await runA2APreflight({ cwd, jobDirectory: link });
  assert.equal(report.ok, false);
  assert.match(report.checks.find(check => check.id === 'jobDirectory')!.detail!, /workspace-write roots/);
});

test('runtime checks distinguish a present Python from a missing required module', async t => {
  let executable: string;
  try { executable = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(); }
  catch { t.skip('No Python interpreter available'); return; }
  const cwd = await realpath(tmpdir());
  const good = await runA2APreflight({ cwd, python: { executable, modules: ['json'] } });
  assert.equal(good.ok, true);
  const bad = await runA2APreflight({ cwd, python: { executable, modules: ['__a2a_missing_module__'] } });
  assert.equal(bad.ok, false);
  assert.match(bad.checks.find(check => check.id === 'python')!.detail!, /Missing Python modules/);
});

test('preflight schema rejects unknown fields, relative paths and command-like module values', () => {
  for (const value of [
    { cwd: '.' }, { cwd: '/tmp', command: 'echo no' },
    { cwd: '/tmp', allowedDirectories: [] }, { cwd: '/tmp', allowedDirectories: ['relative'] },
    { cwd: '/tmp', python: { executable: '/usr/bin/python3', modules: ['json;anything'] } },
  ]) assert.equal(a2aPreflightInputSchema.safeParse(value).success, false);
});

test('explicit directory policy checks canonical roots and cwd on the executing host', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-preflight-allow-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, 'allowed'), project = join(allowed, 'project'), rootAlias = join(root, 'root-alias');
  await mkdir(project, { recursive: true }); await symlink(allowed, rootAlias);
  const report = await runA2APreflight({ cwd: join(rootAlias, 'project'), allowedDirectories: [rootAlias] });
  assert.equal(report.ok, true); assert.equal(report.cwd, project);
  assert.equal(report.checks.find(check => check.id === 'allowedDirectory.0')?.detail, allowed);
  assert.equal(report.checks.find(check => check.id === 'allowedDirectories')?.ok, true);
  assert.equal((await runA2APreflight({ cwd: allowed, allowedDirectories: [allowed] })).ok, true, 'the allowlist includes its root');
});

test('directory policy rejects symlink escapes and sibling prefixes before dependency or write probes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-preflight-escape-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, 'allowed'), outside = join(root, 'allowed-sibling'), escape = join(allowed, 'escape');
  await mkdir(allowed); await mkdir(outside); await symlink(outside, escape);
  for (const cwd of [outside, escape]) {
    const report = await runA2APreflight({ cwd, allowedDirectories: [allowed], jobDirectory: outside,
      node: { executable: process.execPath, modules: ['fs'] } });
    assert.equal(report.ok, false);
    assert.match(report.checks.find(check => check.id === 'allowedDirectories')!.detail!, /outside allowedDirectories/);
    assert.equal(report.checks.some(check => check.id === 'jobDirectory' || check.id === 'node'), false);
  }
  const defaultReport = await runA2APreflight({ cwd: outside });
  assert.equal(defaultReport.ok, true, 'no allowlist means no new directory policy is inferred');
  assert.equal(defaultReport.checks.some(check => check.id.startsWith('allowedDirector')), false);
});

test('every explicit allowlist root must exist, resolve to a directory and be accessible; nothing is created', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-preflight-invalid-root-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const regularFile = join(root, 'file'), missing = join(root, 'missing');
  await writeFile(regularFile, 'not a directory');
  for (const invalid of [regularFile, missing]) {
    const report = await runA2APreflight({ cwd: root, allowedDirectories: [root, invalid] });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find(check => check.id === 'allowedDirectory.0')?.ok, true);
    assert.equal(report.checks.find(check => check.id === 'allowedDirectory.1')?.ok, false);
  }
  assert.deepEqual(await readdir(root), ['file']);
});

test('directory policy verifies real root and cwd read/traverse permissions', async t => {
  if (process.getuid?.() === 0) { t.skip('Root may bypass filesystem permissions'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-preflight-permission-')));
  const inaccessible = join(root, 'blocked'); await mkdir(inaccessible); await chmod(inaccessible, 0);
  t.after(async () => { await chmod(inaccessible, 0o700); await rm(root, { recursive: true, force: true }); });
  const rootDenied = await runA2APreflight({ cwd: root, allowedDirectories: [root, inaccessible] });
  assert.equal(rootDenied.ok, false); assert.equal(rootDenied.checks.find(check => check.id === 'allowedDirectory.1')?.ok, false);
  const cwdDenied = await runA2APreflight({ cwd: inaccessible, allowedDirectories: [root] });
  assert.equal(cwdDenied.ok, false); assert.equal(cwdDenied.checks.find(check => check.id === 'cwd')?.ok, false);
});
