import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CapacityError, CapacityGovernor, estimateCapacityLimits, parseMacOSAvailableMemory, type CapacityOptions, type CapacityKind } from '../src/capacity.js';

function fixture(t: TestContext, options: Partial<CapacityOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'acp-capacity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { directory, softLimit: 2, hardLimit: 3, memoryReserveBytes: 1, estimatedInstanceBytes: 1, ...options };
  return { directory, config, governor: new CapacityGovernor(config) };
}
const auto = (kind: CapacityKind, id: string) => ({ kind, source: 'automatic' as const, id });
const manual = (kind: CapacityKind, id: string) => ({ kind, source: 'interactive' as const, id });
const code = (expected: string) => (error: unknown) => error instanceof CapacityError && error.code === expected;

const workerScript = `
  const { CapacityGovernor } = await import(process.env.CAPACITY_MODULE);
  const governor = new CapacityGovernor(JSON.parse(process.env.CAPACITY_OPTIONS));
  let lease;
  process.on('message', async message => {
    if (message.action === 'exit') process.exit(0);
    if (message.action === 'release') { await lease?.release(); process.send({ released: true }); return; }
    try {
      lease = await governor.acquire(message.request);
      if (message.childPid) await lease.spawned(message.childPid);
      process.send({ ok: true });
    } catch (error) { process.send({ ok: false, code: error.code, message: error.message }); }
  });
  process.send({ ready: true });
`;
interface Reply { ready?: boolean; ok?: boolean; code?: string; message?: string; released?: boolean }
function message(child: ChildProcess, payload?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const onExit = () => { cleanup(); reject(new Error('Capacity test worker exited before replying')); };
    const onMessage = (reply: Reply) => { cleanup(); resolve(reply); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { child.off('exit', onExit); child.off('message', onMessage); child.off('error', onError); };
    child.once('message', onMessage); child.once('exit', onExit); child.once('error', onError);
    if (payload) child.send!(payload);
  });
}
async function worker(t: TestContext, options: CapacityOptions) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', workerScript], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, CAPACITY_MODULE: new URL('../src/capacity.ts', import.meta.url).href, CAPACITY_OPTIONS: JSON.stringify(options) },
  });
  let stderr = '';
  child.stderr?.on('data', data => { stderr += String(data); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const ready = await message(child).catch(error => { throw new Error(`${String(error)}: ${stderr}`); });
  assert.equal(ready.ready, true);
  return { child, exited };
}

test('automatic soft limit leaves interactive room until the hard limit', async t => {
  const { governor } = fixture(t);
  const one = await governor.acquire(auto('process', 'one'));
  const two = await governor.acquire(auto('process', 'two'));
  await assert.rejects(governor.acquire(auto('process', 'three')), code('ACP_CAPACITY_SOFT_LIMIT'));
  assert.deepEqual(await governor.snapshot('process').then(({ used, automatic, interactive, availableAutomatic, availableInteractive }) =>
    ({ used, automatic, interactive, availableAutomatic, availableInteractive })),
  { used: 2, automatic: 2, interactive: 0, availableAutomatic: 0, availableInteractive: 1 });
  const user = await governor.acquire(manual('process', 'user'));
  await assert.rejects(governor.acquire(manual('process', 'extra-user')), code('ACP_CAPACITY_HARD_LIMIT'));
  await assert.rejects(governor.acquire(auto('process', 'extra-auto')), code('ACP_CAPACITY_HARD_LIMIT'));
  await Promise.all([one.release(), two.release(), user.release()]);
  assert.equal((await governor.snapshot('process')).used, 0);
});

test('task and process occupancy is independent, and failed starts release capacity idempotently', async t => {
  const { governor } = fixture(t, { softLimit: 1, hardLimit: 2 });
  const processLease = await governor.acquire(auto('process', 'same-id'));
  const taskLease = await governor.acquire(auto('task', 'same-id'));
  assert.equal((await governor.snapshot('process')).used, 1);
  assert.equal((await governor.snapshot('task')).used, 1);
  // The caller's spawn/run failure must execute this same finally path.
  await assert.rejects((async () => { try { throw new Error('spawn failed'); } finally { await processLease.release(); } })(), /spawn failed/);
  await processLease.release();
  await assert.rejects(processLease.spawned(process.pid), /already been released/);
  const next = await governor.acquire(auto('process', 'replacement'));
  await Promise.all([next.release(), taskLease.release()]);
});

test('real concurrent host processes cannot over-allocate soft or hard capacity', { timeout: 30_000 }, async t => {
  const { config, governor } = fixture(t, { softLimit: 2, hardLimit: 4 });
  const workers = await Promise.all(Array.from({ length: 10 }, () => worker(t, config)));
  const automatic = await Promise.all(workers.map(({ child }, index) => message(child, {
    action: 'acquire', request: auto('process', `automatic-${index}`),
  })));
  assert.equal(automatic.filter(reply => reply.ok).length, 2);
  assert.ok(automatic.filter(reply => !reply.ok).every(reply => reply.code === 'ACP_CAPACITY_SOFT_LIMIT'));
  assert.equal((await governor.snapshot('process')).used, 2);
  const free = workers.filter((_, index) => !automatic[index].ok);
  const interactive = await Promise.all(free.map(({ child }, index) => message(child, {
    action: 'acquire', request: manual('process', `manual-${index}`),
  })));
  assert.equal(interactive.filter(reply => reply.ok).length, 2);
  assert.ok(interactive.filter(reply => !reply.ok).every(reply => reply.code === 'ACP_CAPACITY_HARD_LIMIT'));
  assert.equal((await governor.snapshot('process')).used, 4);
  for (let index = 0; index < workers.length; index++) {
    const manualIndex = free.findIndex(item => item === workers[index]);
    if (automatic[index].ok || (manualIndex >= 0 && interactive[manualIndex].ok)) {
      await message(workers[index].child, { action: 'release' });
    }
  }
  assert.equal((await governor.snapshot('process')).used, 0);
});

test('dead task owners reclaim, live children retain, and unknown spawn outcomes retain', { timeout: 15_000 }, async t => {
  const { governor, config } = fixture(t, { softLimit: 4, hardLimit: 5 });
  const taskOwner = await worker(t, config);
  assert.equal((await message(taskOwner.child, { action: 'acquire', request: auto('task', 'dead-task') })).ok, true);
  taskOwner.child.send!({ action: 'exit' }); await taskOwner.exited;
  assert.equal((await governor.snapshot('task')).used, 0);

  const processOwner = await worker(t, config);
  // The current test process represents a child that survives its owner.
  assert.equal((await message(processOwner.child, { action: 'acquire', request: auto('process', 'live-child'), childPid: process.pid })).ok, true);
  processOwner.child.send!({ action: 'exit' }); await processOwner.exited;
  assert.equal((await governor.snapshot('process')).used, 1);

  const unknownOwner = await worker(t, config);
  assert.equal((await message(unknownOwner.child, { action: 'acquire', request: auto('process', 'unknown-spawn') })).ok, true);
  unknownOwner.child.send!({ action: 'exit' }); await unknownOwner.exited;
  assert.equal((await governor.snapshot('process')).used, 2);

  const deadChildOwner = await worker(t, config);
  const deadChildPid = taskOwner.child.pid!;
  assert.equal((await message(deadChildOwner.child, { action: 'acquire', request: auto('process', 'dead-child'), childPid: deadChildPid })).ok, true);
  // A live owner prevents reclamation even when the registered child has exited.
  assert.equal((await governor.snapshot('process')).used, 3);
  deadChildOwner.child.send!({ action: 'exit' }); await deadChildOwner.exited;
  assert.equal((await governor.snapshot('process')).used, 2);
});

test('live memory is checked on every startup and reserves concurrent startup estimates', async t => {
  let availableBytes = 1000;
  const { governor } = fixture(t, { softLimit: 6, hardLimit: 8, memoryReserveBytes: 100, estimatedInstanceBytes: 300,
    memoryProvider: () => ({ totalBytes: 1000, availableBytes }) });
  const leases = await Promise.all(Array.from({ length: 3 }, (_, index) => governor.acquire(auto('process', String(index)))));
  const snapshot = await governor.snapshot('process');
  assert.equal(snapshot.memory.startupReservedBytes, 900);
  assert.equal(snapshot.availableAutomatic, 0);
  await assert.rejects(governor.acquire(manual('process', 'no-startup-budget')), code('ACP_CAPACITY_MEMORY_LIMIT'));
  await leases[0].release();
  assert.equal((await governor.snapshot('process')).availableInteractive, 1);
  availableBytes = 699;
  await assert.rejects(governor.acquire(auto('process', 'live-memory-shrank')), code('ACP_CAPACITY_MEMORY_LIMIT'));
  availableBytes = 1000;
  const replacement = await governor.acquire(auto('process', 'memory-returned'));
  await Promise.all([leases[1].release(), leases[2].release(), replacement.release()]);
});

test('recheck reads memory after preparation without counting its own startup estimate twice', async t => {
  let availableBytes = 400;
  const { governor } = fixture(t, { memoryReserveBytes: 100, estimatedInstanceBytes: 300,
    memoryProvider: () => ({ totalBytes: 1000, availableBytes }) });
  const lease = await governor.acquire(auto('task', 'prepare'));
  await lease.recheck();
  availableBytes = 399;
  await assert.rejects(lease.recheck(), code('ACP_CAPACITY_MEMORY_LIMIT'));
  assert.equal((await governor.snapshot('task')).used, 1);
  await lease.release();
  availableBytes = 400;
  const next = await governor.acquire(auto('task', 'retry'));
  await next.release();
});

test('startup estimates expire without expiring live leases or unknown pending process reservations', async t => {
  const { governor, directory } = fixture(t, { softLimit: 6, hardLimit: 8, memoryReserveBytes: 100, estimatedInstanceBytes: 100,
    memoryProvider: () => ({ totalBytes: 1000, availableBytes: 1000 }) });
  const taskLease = await governor.acquire(auto('task', 'task'));
  const spawned = await governor.acquire(auto('process', 'spawned'));
  await spawned.spawned(process.pid);
  const pending = await governor.acquire(auto('process', 'pending'));
  for (const name of readdirSync(directory).filter(name => name.startsWith('lease-'))) {
    const path = join(directory, name);
    const record = JSON.parse(readFileSync(path, 'utf8')); record.startupUntil = Date.now() - 1;
    writeFileSync(path, JSON.stringify(record));
  }
  assert.equal((await governor.snapshot('task')).used, 1);
  // Only the process that never registered a child keeps its startup estimate; the task holds none.
  assert.equal((await governor.snapshot('task')).memory.startupReservedBytes, 100);
  assert.equal((await governor.snapshot('process')).used, 2);
  assert.equal((await governor.snapshot('process')).memory.startupReservedBytes, 100);
  await Promise.all([taskLease.release(), spawned.release(), pending.release()]);
});

test('a task start holds no startup memory, so its ACP process is not charged twice', async t => {
  const { governor } = fixture(t, { softLimit: 4, hardLimit: 5, memoryReserveBytes: 100, estimatedInstanceBytes: 300,
    memoryProvider: () => ({ totalBytes: 1000, availableBytes: 400 }) });
  const task = await governor.acquire(auto('task', 'task'));
  assert.equal((await governor.snapshot('process')).memory.startupReservedBytes, 0);
  const child = await governor.acquire(auto('process', 'its-process'));
  assert.equal((await governor.snapshot('task')).memory.startupReservedBytes, 300);
  // Process starts still share one budget: a second start in the window has no memory left.
  await assert.rejects(governor.acquire(auto('process', 'another-process')), code('ACP_CAPACITY_MEMORY_LIMIT'));
  await assert.rejects(governor.acquire(auto('task', 'another-task')), code('ACP_CAPACITY_MEMORY_LIMIT'));
  await Promise.all([task.release(), child.release()]);
});

test('active host policy cannot be raised or changed by another governor and can change after draining', async t => {
  const { governor, config } = fixture(t);
  const first = await governor.acquire(auto('task', 'active'));
  for (const changed of [{ softLimit: 5, hardLimit: 6 }, { memoryReserveBytes: 2 }, { estimatedInstanceBytes: 2 }]) {
    const other = new CapacityGovernor({ ...config, ...changed });
    await assert.rejects(other.acquire(auto('process', 'conflicting-host')), /state is unavailable/);
    await assert.rejects(other.snapshot('task'), /state is unavailable/);
  }
  await first.release();
  const replacement = new CapacityGovernor({ ...config, softLimit: 5, hardLimit: 6 });
  const allowed = await replacement.acquire(auto('process', 'updated-host-policy'));
  assert.equal((await replacement.snapshot('process')).limits.soft, 5);
  await allowed.release();
});

test('macOS available memory parser counts reclaimable inactive cache without adding purgeable pages twice', () => {
  const report = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                10.
Pages active:                            9999.
Pages inactive:                            20.
Pages speculative:                         3.
Pages purgeable:                          999.
`;
  assert.equal(parseMacOSAvailableMemory(report, 10_000_000), 33 * 16384);
  assert.equal(parseMacOSAvailableMemory(report, 100), 100);
  assert.throws(() => parseMacOSAvailableMemory('broken private host diagnostic', 100));
  assert.throws(() => parseMacOSAvailableMemory(report.replace('Pages inactive:', 'Missing inactive:'), 10_000_000));
});

test('memory admission fails closed and does not expose invalid provider diagnostics', async t => {
  const { governor } = fixture(t, { memoryProvider: () => { throw new Error('/private/secret memory diagnostic'); } });
  await assert.rejects(governor.acquire(auto('task', 'bad-reader')), error => {
    assert.doesNotMatch(String(error), /private|secret|diagnostic/); return true;
  });
  const invalid = fixture(t, { memoryProvider: () => ({ totalBytes: 10, availableBytes: NaN }) }).governor;
  await assert.rejects(invalid.acquire(auto('task', 'bad-reading')), /state is unavailable/);
});

test('corrupt capacity records fail closed without exposing disk paths', async t => {
  const { governor, directory } = fixture(t);
  writeFileSync(join(directory, 'lease-00000000-0000-0000-0000-000000000000.json'), 'private raw invalid state');
  await assert.rejects(governor.acquire(auto('task', 'corrupt')), error => {
    assert.doesNotMatch(String(error), /private|raw|invalid|acp-capacity-/); return true;
  });
});

test('host configuration validates limits, preserves manual room and supports memory environment settings', async t => {
  const names = ['ACP_CAPACITY_DIRECTORY', 'ACP_CAPACITY_SOFT_LIMIT', 'ACP_CAPACITY_HARD_LIMIT',
    'ACP_CAPACITY_MEMORY_RESERVE_MB', 'ACP_CAPACITY_INSTANCE_MEMORY_MB'];
  const previous = names.map(name => process.env[name]);
  for (const name of names) delete process.env[name];
  t.after(() => names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }));
  const estimated = estimateCapacityLimits();
  assert.equal(estimated.basis, 'hardware-estimate'); assert.ok(estimated.soft >= 1); assert.ok(estimated.hard > estimated.soft);
  for (const options of [{ softLimit: 0 }, { softLimit: -1 }, { hardLimit: 1 }, { softLimit: 3, hardLimit: 3 },
    { hardLimit: 2.5 }, { softLimit: NaN }, { hardLimit: Infinity }, { softLimit: Number.MAX_SAFE_INTEGER },
    { memoryReserveBytes: -1 }, { estimatedInstanceBytes: 0 }, { directory: '' }]) {
    assert.throws(() => new CapacityGovernor(options));
  }
  const { directory } = fixture(t);
  Object.assign(process.env, { ACP_CAPACITY_DIRECTORY: directory, ACP_CAPACITY_SOFT_LIMIT: '1', ACP_CAPACITY_HARD_LIMIT: '2',
    ACP_CAPACITY_MEMORY_RESERVE_MB: '0.5', ACP_CAPACITY_INSTANCE_MEMORY_MB: '1' });
  const fromEnvironment = new CapacityGovernor({ memoryProvider: () => ({ totalBytes: 10 * 1024 ** 2, availableBytes: 10 * 1024 ** 2 }) });
  const state = await fromEnvironment.snapshot('task');
  assert.deepEqual(state.limits, { soft: 1, hard: 2, basis: 'configured' });
  assert.equal(state.memory.reserveBytes, 512 * 1024);
  assert.equal(state.memory.estimatedInstanceBytes, 1024 ** 2);
  process.env.ACP_CAPACITY_SOFT_LIMIT = 'invalid secret';
  assert.throws(() => new CapacityGovernor(), error => !String(error).includes('secret'));
  process.env.ACP_CAPACITY_SOFT_LIMIT = '1';
  process.env.ACP_CAPACITY_INSTANCE_MEMORY_MB = 'NaN';
  assert.throws(() => new CapacityGovernor());
});
