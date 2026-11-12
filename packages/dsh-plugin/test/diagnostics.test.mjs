import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { diagnosticsFixture, identity, mountStorage } from './helpers/diagnostics.mjs';
import { Diagnostics, openDiagnostics } from '../dist/diagnostics.js';
import { Context } from '@deepseek-ai/cordis';
import { toSafeError } from '@1agents/acp-service/runtime';
const run = promisify(execFile);
const quota = () => toSafeError({ data: { codexErrorInfo: 'usageLimitExceeded', token: 'SYNTHETIC_SECRET_CANARY_NOT_REAL' } }, { origin: 'acp' });
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'acp-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('diagnostics persist only bounded fields and match exact session/request/turn/start identity', async t => {
  const root = await directory(t), { diagnostics } = await diagnosticsFixture(t, root);
  const id = await diagnostics.begin(identity()); await diagnostics.submitted(id); await diagnostics.settle(id, quota());
  const value = diagnostics.find('test-session', 'request-1', 1, 0);
  assert.equal(value.category, 'quota'); assert.equal(value.providerCode, 'usageLimitExceeded');
  assert.equal(value.origin, 'acp'); assert.equal(value.operationId, 'request-1');
  for (const args of [['other-session', 'request-1'], ['test-session', 'other'], ['test-session', 'request-1', 2], ['test-session', 'request-1', 1, 9]]) {
    assert.equal(diagnostics.find(...args), undefined);
  }
  const file = join(root, 'oneagents_acp_diagnostics.json'), raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('SYNTHETIC_SECRET')); assert.ok(!raw.includes('token'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(diagnostics.submitted(id), /confirmed/);
  await assert.rejects(diagnostics.settle(id, quota()), /settled/);
});
test('a new pending attempt for the same request never borrows the older quota or a later different request', async t => {
  const { diagnostics } = await diagnosticsFixture(t, await directory(t));
  const old = await diagnostics.begin(identity()); await diagnostics.settle(old, quota());
  const current = await diagnostics.begin(identity()); await diagnostics.submitted(current);
  const other = await diagnostics.begin(identity({ requestIds: ['unrelated-request'] })); await diagnostics.settle(other, quota());
  assert.equal(diagnostics.find('test-session', 'request-1').category, 'unknown');
  assert.equal(diagnostics.find('test-session', 'request-1').outcomeUnknown, true);
  await diagnostics.confirmed(current);
  assert.equal(diagnostics.find('test-session', 'request-1').outcomeUnknown, false);
  await diagnostics.settle(current, toSafeError(new DOMException('SYNTHETIC_CANCEL_SECRET_NOT_REAL', 'AbortError'), { origin: 'acp' }));
  assert.equal(diagnostics.find('test-session', 'request-1').category, 'cancelled');
});
for (const [phase, category, outcomeUnknown] of [['prepared', 'unknown', false], ['submitted', 'unknown', true], ['confirmed', 'unknown', false], ['failed', 'quota', false]]) {
  test(`cold process restart after SIGKILL retains ${phase} diagnostics without executing again`, { timeout: 10000 }, async t => {
    const root = await directory(t), path = new URL('./helpers/diagnostic-process.mjs', import.meta.url);
    const child = fork(path, [root, phase], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const result = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
    assert.equal(result[0].durable, true);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
    const output = await run(process.execPath, [fileURLToPath(path), root, 'read']);
    const error = JSON.parse(output.stdout); assert.equal(error.category, category); assert.equal(error.outcomeUnknown, outcomeUnknown);
    assert.equal(error.operationId, 'request-1'); assert.ok(!output.stdout.includes('SYNTHETIC_SECRET'));
  });
}
for (const kind of ['version', 'record', 'identity']) {
  test(`invalid ${kind} diagnostic data refuses open instead of silently deleting evidence`, async t => {
    const root = await directory(t), ctx = new Context(); await mountStorage(ctx, root);
    const store = await Diagnostics.open(ctx.storageDomain); const id = await store.begin(identity()); await store.close(); await ctx.fiber.dispose();
    const file = join(root, 'oneagents_acp_diagnostics.json'), raw = JSON.parse(await readFile(file, 'utf8'));
    if (kind === 'version') raw.unit.version = 9;
    else {
      const records = raw.tables.attempts;
      if (kind === 'record') records[id].identity.turn = -1;
      else records[id].id = '00000000-0000-4000-8000-000000000000';
    }
    const bytes = JSON.stringify(raw); await writeFile(file, bytes);
    const restarted = new Context(); t.after(() => restarted.fiber.dispose()); await mountStorage(restarted, root);
    await assert.rejects(Diagnostics.open(restarted.storageDomain), /diagnostic storage/);
    assert.equal(await readFile(file, 'utf8'), bytes);
  });
}
test('diagnostic writes cannot acknowledge a backend failure or publish uncommitted memory', async t => {
  const root = await directory(t), { diagnostics } = await diagnosticsFixture(t, root);
  const file = join(root, 'oneagents_acp_diagnostics.json');
  // The real storage backend cannot rename its next document over a directory.
  const id = await diagnostics.begin(identity());
  await rm(file); const { mkdir } = await import('node:fs/promises'); await mkdir(file);
  await assert.rejects(diagnostics.submitted(id));
  assert.equal(diagnostics.find('test-session', 'request-1').outcomeUnknown, false);
});

test('a follower keeps diagnostics in memory and does not take or release the owner lock', async t => {
  const root = await directory(t), first = await openDiagnostics(root);
  t.after(() => first.close());
  const id = await first.diagnostics.begin(identity()); await first.diagnostics.settle(id, quota());
  const follower = await openDiagnostics(root, { onConflict: 'readonly' });
  t.after(() => follower.close());
  assert.equal(follower.mode, 'read-only');
  assert.equal(follower.diagnostics.find('test-session', 'request-1'), undefined);
  const local = await follower.diagnostics.begin(identity());
  await follower.diagnostics.settle(local, quota());
  assert.equal(follower.diagnostics.find('test-session', 'request-1').category, 'quota');
  await follower.close();
  assert.equal(first.diagnostics.find('test-session', 'request-1').category, 'quota');
  const names = await import('node:fs/promises').then(fs => fs.readdir(join(root, '.lock')));
  assert.equal(names.length, 1);
});

test('diagnostic owner rejects a concurrent writer and releases the lease after close', async t => {
  const root = await directory(t), first = await openDiagnostics(root);
  t.after(() => first.close());
  const id = await first.diagnostics.begin(identity()); await first.diagnostics.settle(id, quota());
  await assert.rejects(openDiagnostics(root), /already in use/);
  await first.close();
  const reopened = await openDiagnostics(root); t.after(() => reopened.close());
  assert.equal(reopened.diagnostics.find('test-session', 'request-1').category, 'quota');
});

test('diagnostic identity lengths and batch sizes are bounded without truncation or partial writes', async t => {
  const { diagnostics } = await diagnosticsFixture(t, await directory(t));
  for (const change of [ { sessionId: 's'.repeat(257) }, { messageIds: ['m'.repeat(257)] },
    { requestIds: ['r'.repeat(257)] }, { messageIds: Array.from({ length: 129 }, (_, i) => 'm' + i) },
    { requestIds: Array.from({ length: 129 }, (_, i) => 'r' + i) } ]) {
    await assert.rejects(async () => diagnostics.begin(identity(change)));
  }
  assert.equal(diagnostics.find('test-session', 'request-1'), undefined);
});
