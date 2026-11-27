import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
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
  const runner = join(pluginRoot, 'test/helpers/hot-reload-run.mjs');
  const result = spawnSync(process.execPath, [runner], {
    cwd: pluginRoot,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).ok, true);
});
