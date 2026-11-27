import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(pluginRoot, '..', '..');
const dist = join(pluginRoot, 'dist');

function sourceOf(name) {
  return readFileSync(join(dist, name), 'utf8');
}

function javascriptFiles(directory) {
  const files = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.js')) files.push(next);
    }
  };
  walk(directory);
  return files;
}

function topLevelHostImport(source) {
  return source.split('\n').some(line => {
    const trimmed = line.trim();
    return /^import\s+(?!type\b).*from\s+['"]@deepseek-ai\//.test(trimmed)
      || /^export\s+.*from\s+['"]@deepseek-ai\//.test(trimmed);
  });
}

function runScenario(scenario) {
  const runner = join(pluginRoot, 'test/helpers/hot-reload-run.mjs');
  const result = spawnSync(process.execPath, [runner, scenario], {
    cwd: pluginRoot,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('compiled plugin entry is a static ESM bridge with no top-level host imports', () => {
  const entry = sourceOf('package-entry.js');
  const index = sourceOf('index.js');
  assert.match(entry, /export \* from ['"]@1agents\/acp-service\/service['"]/);
  assert.match(entry, /export \{[^}]*\bname\b[^}]*\binject\b[^}]*\bapply\b[^}]*\} from ['"]\.\/index\.js['"]/);
  assert.doesNotMatch(entry, /await import\(/);
  assert.doesNotMatch(index, /await import\([^)]*vendor\/dsh/);
  assert.match(index, /export const name = ['"]oneagents-acp['"]/);
  assert.match(index, /export async function apply\b/);
  assert.match(index, /from ['"]\.\/host-runtime\.js['"]/);
  const offenders = javascriptFiles(dist).filter(file => topLevelHostImport(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('package entry imports in plain Node and does not resolve @deepseek-ai/*', () => {
  const trace = join(mkdtempSync(join(tmpdir(), 'acp-hmr-trace-')), 'seen.txt');
  writeFileSync(trace, '');
  const entry = join(dist, 'package-entry.js');
  const runner = join(pluginRoot, 'test/helpers/hot-reload-static-run.mjs');
  const result = spawnSync(process.execPath, [runner, entry], {
    cwd: pluginRoot,
    env: { ...process.env, HOT_RELOAD_TRACE_FILE: trace },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const reported = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(reported.name, 'oneagents-acp');
  assert.equal(reported.serve, 'function');
  assert.equal(reported.apply, 'function');
  assert.ok(reported.inject.includes('webServer') && reported.inject.includes('tools'));
  assert.equal(readFileSync(trace, 'utf8'), '');
  rmSync(join(trace, '..'), { recursive: true, force: true });
});

test('unmounting the plugin releases both directory leases before the next mount', () => {
  const report = runScenario('remount');
  assert.equal(report.ok, true);
  assert.deepEqual(report.afterDispose.routes, []);
  assert.deepEqual(report.afterDispose.tools, []);
  assert.deepEqual(report.afterDispose.presets, []);
  assert.equal(report.afterDispose.diagnosticsLocked, false);
  assert.equal(report.afterDispose.a2aLocked, false);
  assert.equal(report.remount.mounted, true);
  assert.equal(report.remount.readOnlyWarning, false);
});

test('a failed start after the A2A mount releases every route and both directory leases', () => {
  const report = runScenario('inactive-effect');
  assert.equal(report.ok, true);
  assert.match(report.error, /INACTIVE_EFFECT/);
  // The failed start must not leave the A2A routes behind: they would answer
  // requests for a plugin that is already gone.
  assert.deepEqual(report.afterFailure.routes, []);
  assert.deepEqual(report.afterFailure.tools, []);
  assert.deepEqual(report.afterFailure.presets, []);
  assert.equal(report.afterFailure.a2aHostCurrent, undefined);
  assert.equal(report.afterFailure.diagnosticsLocked, false, 'diagnostics lease survived the failed start');
  assert.equal(report.afterFailure.a2aLocked, false, 'a2a lease survived the failed start');
  assert.equal(report.failureReadOnlyWarning, false);
  // The next hot reload has to take both directories read-write again.
  assert.equal(report.remount.mounted, true);
  assert.equal(report.remount.readOnlyWarning, false);
  assert.equal(report.remount.snapshot.diagnosticsLocked, true);
  assert.equal(report.remount.snapshot.a2aLocked, true);
  assert.equal(report.remount.snapshot.a2aHostCurrent, 'set');
});

test('a failing route disposer does not skip the rest of the unload', () => {
  const report = runScenario('throwing-route');
  assert.equal(report.ok, true);
  assert.match(report.error, /route disposer failed/);
  // Every route is unregistered even though one disposer threw.
  assert.deepEqual(report.afterFailure.routes, []);
  assert.deepEqual(report.afterFailure.tools, []);
  assert.deepEqual(report.afterFailure.presets, []);
  assert.equal(report.afterFailure.a2aHostCurrent, undefined);
  // server.close() still ran, so the A2A storage lease is gone.
  assert.equal(report.afterFailure.diagnosticsLocked, false, 'diagnostics lease survived the faulty unload');
  assert.equal(report.afterFailure.a2aLocked, false, 'a2a lease survived the faulty unload');
  // The next hot reload has to take both directories read-write again.
  assert.equal(report.remount.mounted, true);
  assert.equal(report.remount.readOnlyWarning, false);
  assert.equal(report.remount.snapshot.diagnosticsLocked, true);
  assert.equal(report.remount.snapshot.a2aLocked, true);
  assert.equal(report.remount.snapshot.a2aHostCurrent, 'set');
});

test('the package root keeps one name and inject contract', async () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages/service/package.json'), 'utf8'));
  assert.equal(manifest.main, './vendor/dsh/package-entry.js');
  assert.equal(manifest.exports['.'].import, './vendor/dsh/package-entry.js');
  assert.equal(manifest.exports['.'].types, './dist/src/package.d.ts');

  const plugin = await import(pathToFileURL(join(dist, 'index.js')).href);
  // The service keeps the same contract in its own module. The compiled copy is
  // used when it exists; the source is the fallback for a checkout without a build.
  const serviceBuild = join(repoRoot, 'packages/service/dist/src/dsh.js');
  const service = existsSync(serviceBuild)
    ? await import(pathToFileURL(serviceBuild).href)
    : parseDshConstants(readFileSync(join(repoRoot, 'packages/service/src/dsh.ts'), 'utf8'));
  assert.equal(plugin.name, service.name);
  assert.deepEqual([...plugin.inject], [...service.inject]);

  // The published artifact repeats the contract. It only exists after
  // scripts/embed-dsh.mjs has staged the plugin into the service package.
  const vendorEntry = join(repoRoot, 'packages/service/vendor/dsh/package-entry.js');
  if (!existsSync(vendorEntry)) return;
  const vendor = await import(pathToFileURL(vendorEntry).href);
  assert.equal(vendor.name, service.name);
  assert.deepEqual([...vendor.inject], [...service.inject]);
  assert.equal(typeof vendor.serveAcpService, 'function');
  assert.equal(typeof vendor.apply, 'function');
});

function parseDshConstants(source) {
  const name = /export const name = '([^']+)'/.exec(source)?.[1];
  const raw = /export const inject = \[([^\]]*)\]/.exec(source)?.[1];
  const inject = raw ? raw.split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean) : undefined;
  if (!name || !inject) throw new Error('Cannot read the name/inject contract from packages/service/src/dsh.ts');
  return { name, inject };
}
