import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { CapacityGovernor, type CapacityKind, type CapacityLease, type CapacityOptions } from '../src/capacity.js';
import { CapacityQueue, type CapacityPendingAdmission } from '../src/capacity-queue.js';

const automatic = (id: string, kind: CapacityKind = 'task') => ({ id, kind, source: 'automatic' as const });
const interactive = (id: string, kind: CapacityKind = 'task') => ({ id, kind, source: 'interactive' as const });
function fixture(t: TestContext, options: CapacityOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'acp-capacity-queue-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config: CapacityOptions = { directory, softLimit: 1, hardLimit: 2,
    memoryReserveBytes: 100, estimatedInstanceBytes: 100,
    memoryProvider: () => ({ totalBytes: 100_000, availableBytes: 100_000 }), ...options };
  return { directory, config, governor: new CapacityGovernor(config), queue: new CapacityQueue(config, { pollIntervalMs: 10 }) };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function abortOnCleanup(t: TestContext): AbortController {
  const controller = new AbortController();
  t.after(() => controller.abort());
  return controller;
}
function entries(directory: string) {
  return readdirSync(join(directory, 'queue')).filter(name => name.startsWith('entry-'))
    .map(name => JSON.parse(readFileSync(join(directory, 'queue', name), 'utf8')))
    .sort((a, b) => a.sequence - b.sequence);
}

interface Reply { event: string; id?: string; error?: string }
const workerScript = `
  const { CapacityQueue } = await import(process.env.CAPACITY_QUEUE_MODULE);
  const options = JSON.parse(process.env.CAPACITY_QUEUE_OPTIONS);
  options.memoryProvider = () => ({ totalBytes: 100000, availableBytes: 100000 });
  const queue = new CapacityQueue(options, { pollIntervalMs: 10 });
  const leases = new Map();
  process.on('message', async message => {
    try {
      if (message.action === 'release') {
        await leases.get(message.id)?.release(); leases.delete(message.id);
        process.send({ event: 'released', id: message.id }); return;
      }
      const lease = await queue.acquire({ kind: 'task', source: 'automatic', id: message.id }, {
        onPending: () => process.send({ event: 'pending', id: message.id }),
      });
      leases.set(message.id, lease);
      process.send({ event: 'acquired', id: message.id });
    } catch (error) { process.send({ event: 'error', id: message.id, error: error.message }); }
  });
  process.send({ event: 'ready' });
`;
async function worker(t: TestContext, options: CapacityOptions) {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', workerScript], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, CAPACITY_QUEUE_MODULE: new URL('../src/capacity-queue.ts', import.meta.url).href,
      CAPACITY_QUEUE_OPTIONS: JSON.stringify(options) },
  });
  let stderr = '';
  child.stderr?.on('data', data => { stderr += String(data); });
  const received: Reply[] = [];
  const waiters = new Set<{ event: string; resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const waiter of waiters) waiter.reject(error); waiters.clear(); };
  child.on('message', (reply: Reply) => {
    const waiter = [...waiters].find(item => item.event === reply.event || reply.event === 'error');
    if (!waiter) { received.push(reply); return; }
    waiters.delete(waiter);
    if (reply.event === 'error') waiter.reject(new Error(reply.error));
    else waiter.resolve(reply);
  });
  child.on('error', fail);
  const exited = new Promise<void>(resolve => child.once('exit', () => {
    fail(new Error(`Queue test worker exited: ${stderr}`)); resolve();
  }));
  const event = (name: string): Promise<Reply> => {
    const index = received.findIndex(reply => reply.event === name || reply.event === 'error');
    if (index >= 0) {
      const [reply] = received.splice(index, 1);
      return reply.event === 'error' ? Promise.reject(new Error(reply.error)) : Promise.resolve(reply);
    }
    return new Promise((resolve, reject) => {
      const waiter = { event: name, resolve: (reply: Reply) => { clearTimeout(timer); resolve(reply); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out waiting for ${name}: ${stderr}`)); }, 10_000);
      waiters.add(waiter);
    });
  };
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await event('ready');
  return { child, exited, event, received };
}

test('separate queue instances preserve FIFO and pending work consumes no capacity', { timeout: 10_000 }, async t => {
  const { governor, queue, config, directory } = fixture(t);
  const occupied = await governor.acquire(automatic('occupied'));
  const secondQueue = new CapacityQueue(config, { pollIntervalMs: 10 });
  const firstPending = deferred(); const secondPending = deferred();
  const first = queue.acquire(automatic('first'), { signal: abortOnCleanup(t).signal, onPending: firstPending.resolve });
  await firstPending.promise;
  const second = secondQueue.acquire(automatic('second'), { signal: abortOnCleanup(t).signal, onPending: secondPending.resolve });
  await secondPending.promise;
  assert.equal((await governor.snapshot('task')).used, 1);
  assert.deepEqual(entries(directory).map(item => item.id), ['first', 'second']);
  await occupied.release();
  const firstLease = await first;
  assert.equal((await governor.snapshot('task')).used, 1);
  assert.deepEqual(entries(directory).map(item => item.id), ['second']);
  await firstLease.release();
  const secondLease = await second;
  await secondLease.release();
  assert.equal((await governor.snapshot('task')).used, 0);
  assert.equal(entries(directory).length, 0);
});

test('real independent host processes execute in durable FIFO order', { timeout: 30_000 }, async t => {
  const { governor, config, directory } = fixture(t);
  const occupied = await governor.acquire(automatic('occupied'));
  const first = await worker(t, config); const second = await worker(t, config);
  first.child.send!({ action: 'acquire', id: 'first-host' });
  await first.event('pending');
  second.child.send!({ action: 'acquire', id: 'second-host' });
  await second.event('pending');
  assert.deepEqual(entries(directory).map(item => item.id), ['first-host', 'second-host']);
  await occupied.release();
  assert.equal((await first.event('acquired')).id, 'first-host');
  assert.deepEqual(entries(directory).map(item => item.id), ['second-host']);
  first.child.send!({ action: 'release', id: 'first-host' }); await first.event('released');
  assert.equal((await second.event('acquired')).id, 'second-host');
  second.child.send!({ action: 'release', id: 'second-host' }); await second.event('released');
  assert.equal((await governor.snapshot('task')).used, 0);
});

test('the queue polls live memory and starts automatically after memory becomes available', { timeout: 5000 }, async t => {
  let availableBytes = 199; let notifications = 0;
  const { governor, queue, directory } = fixture(t, { memoryProvider: () => ({ totalBytes: 1000, availableBytes }) });
  const pending = deferred();
  const acquisition = queue.acquire(automatic('waiting-for-memory'), { signal: abortOnCleanup(t).signal,
    onPending: () => { notifications++; pending.resolve(); } });
  await pending.promise;
  await delay(40);
  assert.equal((await governor.snapshot('task')).used, 0);
  assert.equal(entries(directory).length, 1);
  assert.equal(notifications, 1);
  availableBytes = 200;
  const lease = await acquisition;
  assert.equal((await governor.snapshot('task')).used, 1);
  assert.equal(notifications, 1);
  await lease.release();
});

test('canceling the head removes it atomically and permits the following task to start', { timeout: 5000 }, async t => {
  const { governor, queue, directory } = fixture(t);
  const occupied = await governor.acquire(automatic('occupied'));
  const headController = abortOnCleanup(t);
  const headPending = deferred(); const nextPending = deferred();
  const head = queue.acquire(automatic('canceled-head'), { signal: headController.signal, onPending: headPending.resolve });
  const canceled = assert.rejects(head, { name: 'AbortError' });
  await headPending.promise;
  const next = queue.acquire(automatic('next'), { signal: abortOnCleanup(t).signal, onPending: nextPending.resolve });
  await nextPending.promise;
  headController.abort(); await canceled;
  assert.deepEqual(entries(directory).map(item => item.id), ['next']);
  assert.equal((await governor.snapshot('task')).used, 1);
  await occupied.release();
  const lease = await next; await lease.release();
  assert.equal(entries(directory).length, 0);
});

test('dead waiting host owners are removed before selecting the next FIFO head', { timeout: 30_000 }, async t => {
  const { governor, config, queue, directory } = fixture(t);
  const occupied = await governor.acquire(automatic('occupied'));
  const dead = await worker(t, config);
  dead.child.send!({ action: 'acquire', id: 'dead-head' }); await dead.event('pending');
  dead.child.kill('SIGKILL'); await dead.exited;
  const pending = deferred();
  const next = queue.acquire(automatic('survivor'), { signal: abortOnCleanup(t).signal, onPending: pending.resolve });
  await pending.promise;
  assert.deepEqual(entries(directory).map(item => item.id), ['survivor']);
  await occupied.release();
  const lease = await next; await lease.release();
});

test('manual work retains its reserved room while automatic work is pending', { timeout: 5000 }, async t => {
  const { governor, queue, directory } = fixture(t);
  const occupied = await governor.acquire(automatic('occupied'));
  const controller = abortOnCleanup(t); const pending = deferred();
  const automaticWait = queue.acquire(automatic('automatic-wait'), { signal: controller.signal, onPending: pending.resolve });
  const canceled = assert.rejects(automaticWait, { name: 'AbortError' });
  await pending.promise;
  const manual = await queue.acquire(interactive('user-start'));
  assert.equal((await governor.snapshot('task')).used, 2);
  assert.deepEqual(entries(directory).map(item => item.id), ['automatic-wait']);
  controller.abort(); await canceled;
  await Promise.all([manual.release(), occupied.release()]);
});

test('task and process FIFO heads can progress independently', { timeout: 5000 }, async t => {
  const { governor, queue, directory } = fixture(t);
  const occupiedTask = await governor.acquire(automatic('occupied-task'));
  const controller = abortOnCleanup(t); const pending = deferred();
  const task = queue.acquire(automatic('waiting-task'), { signal: controller.signal, onPending: pending.resolve });
  const canceled = assert.rejects(task, { name: 'AbortError' });
  await pending.promise;
  const processLease = await queue.acquire(automatic('child-process', 'process'));
  assert.equal((await governor.snapshot('process')).used, 1);
  assert.deepEqual(entries(directory).map(item => item.id), ['waiting-task']);
  controller.abort(); await canceled;
  await Promise.all([processLease.release(), occupiedTask.release()]);
});

test('a pre-aborted request writes no queue or reservation records', async t => {
  const { queue, directory, governor } = fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(queue.acquire(automatic('already-canceled'), { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(queue.acquire(interactive('already-canceled-manual'), { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(readdirSync(directory), []);
  assert.equal((await governor.snapshot('task')).used, 0);
});

test('an abort during admission releases the just-acquired slot before returning', async t => {
  const controller = new AbortController();
  const { queue, directory, governor } = fixture(t, { memoryProvider: () => {
    controller.abort(); return { totalBytes: 1000, availableBytes: 1000 };
  } });
  await assert.rejects(queue.acquire(automatic('abort-at-admission'), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(entries(directory).length, 0);
  assert.equal((await governor.snapshot('task')).used, 0);
});

test('queue corruption fails closed without including raw record contents', async t => {
  const { queue, directory, governor } = fixture(t);
  mkdirSync(join(directory, 'queue'));
  writeFileSync(join(directory, 'queue', 'entry-00000000-0000-0000-0000-000000000000.json'), 'private malformed queue diagnostic');
  await assert.rejects(queue.acquire(automatic('bad-queue')), error => {
    assert.match(String(error), /queue state is unavailable/);
    assert.doesNotMatch(String(error), /private|malformed|diagnostic|acp-capacity-queue-/); return true;
  });
  assert.equal((await governor.snapshot('task')).used, 0);
});

test('an immediately admitted request does not report pending', async t => {
  const { queue, directory } = fixture(t);
  let reported = false;
  const lease = await queue.acquire(automatic('immediate'), { onPending: () => { reported = true; } });
  assert.equal(reported, false);
  assert.equal(entries(directory).length, 0);
  const { lastSequence } = JSON.parse(readFileSync(join(directory, 'queue', 'counter.json'), 'utf8'));
  assert.equal(lastSequence, 1);
  await lease.release();
});

function isPending(value: CapacityLease | CapacityPendingAdmission): value is CapacityPendingAdmission {
  return 'pending' in value && value.pending === true;
}

test('tryAdmit keeps a full process slot queued and reports elapsed wait without sleeping', async t => {
  const { governor, queue, directory } = fixture(t);
  const occupied = await governor.acquire(automatic('occupied', 'process'));
  const waiting = await queue.tryAdmit(automatic('waiting', 'process'));
  assert.equal(isPending(waiting), true);
  if (!isPending(waiting)) return;
  assert.equal(waiting.position, 1);
  assert.equal((await governor.snapshot('process')).used, 1);
  const queued = entries(directory);
  assert.equal(queued.length, 1);
  const names = readdirSync(join(directory, 'queue')).filter(name => name.startsWith('entry-'));
  const path = join(directory, 'queue', names[0]!);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.enqueuedAt = Date.now() - 61_000;
  writeFileSync(path, JSON.stringify(record));
  const again = await queue.tryAdmit(automatic('waiting', 'process'));
  assert.equal(isPending(again), true);
  if (!isPending(again)) return;
  assert.ok(again.waitedMs >= 60_000);
  assert.equal(entries(directory).length, 1);
  assert.equal(await queue.cancel({ id: 'waiting', kind: 'process' }), true);
  assert.equal(entries(directory).length, 0);
  assert.equal((await governor.snapshot('process')).used, 1);
  assert.equal(await queue.cancel({ id: 'waiting', kind: 'process' }), false);
  await occupied.release();
});

test('process lease origins stay in separate groups and unlabeled leases stay unlabeled', async t => {
  const { governor, queue, directory } = fixture(t, { softLimit: 4, hardLimit: 5 });
  await governor.acquire({ ...automatic('job-1', 'process'), origin: 'job' });
  await governor.acquire({ ...automatic('warm-1', 'process'), origin: 'prewarm' });
  await governor.acquire({ ...automatic('user-1', 'process'), origin: 'user-opened' });
  await governor.acquire(automatic('old-1', 'process'));
  const waiting = await queue.tryAdmit(automatic('waiting', 'process'));
  assert.equal(isPending(waiting), true);
  const names = readdirSync(join(directory, 'queue')).filter(name => name.startsWith('entry-'));
  assert.equal(names.length, 1);
  const path = join(directory, 'queue', names[0]!);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.enqueuedAt = Date.now() - 61_000;
  writeFileSync(path, JSON.stringify(record));
  const report = await governor.inspect();
  const ids = (origin: 'prewarm' | 'job' | 'user-opened' | 'unlabeled') => report.sessions[origin].map(item => item.id).sort();
  assert.deepEqual(ids('job'), ['job-1']);
  assert.deepEqual(ids('prewarm'), ['warm-1']);
  assert.deepEqual(ids('user-opened'), ['user-1']);
  assert.deepEqual(ids('unlabeled'), ['old-1']);
  assert.equal(report.taskSlot.used, 0);
  assert.ok(report.taskSlot.used < report.taskSlot.limit);
  assert.equal(report.processSlot.used, report.processSlot.limit);
  assert.ok(await queue.headWaitMs('process') >= 60_000);
  assert.deepEqual((await governor.inspect()).sessions.unlabeled.map(item => item.id), ['old-1']);
  await queue.cancel({ id: 'waiting', kind: 'process' });
});

test('tryAdmit acquires a free process slot and cancel does not release that lease', async t => {
  const { governor, queue, directory } = fixture(t);
  const admitted = await queue.tryAdmit(automatic('free', 'process'));
  assert.equal(isPending(admitted), false);
  assert.equal(entries(directory).length, 0);
  assert.equal(await queue.cancel({ id: 'free', kind: 'process' }), false);
  assert.equal((await governor.snapshot('process')).used, 1);
  if (!isPending(admitted)) await admitted.release();
  assert.equal((await governor.snapshot('process')).used, 0);
});
