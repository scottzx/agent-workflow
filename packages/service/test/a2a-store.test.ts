import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ListTasksRequest, Message, Task, TaskPushNotificationConfig, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { FileA2AStore } from '../src/a2a/store.js';

function context(user = 'alice', tenant = 'team-a', requestedVersion = '1.0'): ServerCallContext {
  return new ServerCallContext({
    user: { isAuthenticated: true, userName: user }, tenant, requestedVersion,
  });
}

function task(id: string, options: { contextId?: string; state?: TaskState; timestamp?: string } = {}): Task {
  return Task.fromJSON({
    id,
    contextId: options.contextId ?? 'conversation-1',
    status: { state: options.state ?? TaskState.TASK_STATE_COMPLETED, timestamp: options.timestamp ?? '2026-10-01T10:00:00Z' },
    history: [0, 1, 2].map(index => Message.toJSON(Message.fromJSON({
      messageId: `${id}-message-${index}`, role: 'ROLE_USER', parts: [{ text: `message ${index}` }],
    }))),
    artifacts: [{ artifactId: `${id}-artifact`, parts: [{ text: 'output' }] }],
    metadata: { project: 'demo', nested: { enabled: true } },
  });
}

test('A2A store persists scoped tasks, targets and callback wire versions across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'a2a-store-'));
  let store = new FileA2AStore(directory);
  try {
    const own = context();
    const original = task('../../private-task');
    await store.taskStore.save(original, own);
    await store.taskStore.save(task('../../private-task', { contextId: 'other-user' }), context('bob'));
    await store.taskStore.save(task('../../private-task', { contextId: 'other-tenant' }), context('alice', 'team-b'));
    store.saveTarget('../../context', { sessionId: 'dsh-session', cwd: directory, agentPreset: 'code' }, own);
    const v1 = TaskPushNotificationConfig.fromJSON({ taskId: original.id, url: 'http://127.0.0.1:9001/callback', token: 'secret' });
    const legacy = TaskPushNotificationConfig.fromJSON({ taskId: original.id, url: 'https://example.com/callback' });
    await store.pushStore.save(original.id, own, v1);
    await store.pushStore.save(original.id, context('alice', 'team-a', '0.3'), legacy);
    assert.ok(v1.id);
    assert.ok(legacy.id);
    assert.notEqual(v1.id, legacy.id);
    const names = readdirSync(directory).filter(name => name.endsWith('.json'));
    assert.equal(names.length, 5);
    assert.ok(names.every(name => /^(task|push|target)-[a-f0-9]{64}\.json$/.test(name)));
    if (process.platform !== 'win32') {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.ok(names.every(name => (statSync(join(directory, name)).mode & 0o777) === 0o600));
    }
    const taskFile = names.find(name => name.startsWith('task-') && readFileSync(join(directory, name), 'utf8').includes('conversation-1'))!;
    assert.equal(JSON.parse(readFileSync(join(directory, taskFile), 'utf8')).value.status.state, 'TASK_STATE_COMPLETED');
    store.close();
    store = new FileA2AStore(directory);
    assert.deepEqual(await store.taskStore.load(original.id, own), original);
    assert.equal((await store.taskStore.load(original.id, context('bob')))?.contextId, 'other-user');
    assert.equal((await store.taskStore.load(original.id, context('alice', 'team-b')))?.contextId, 'other-tenant');
    assert.equal(await store.taskStore.load(original.id, context('mallory')), undefined);
    assert.deepEqual(store.loadTarget('../../context', own), { sessionId: 'dsh-session', cwd: directory, agentPreset: 'code' });
    assert.equal(store.loadTarget('../../context', context('bob')), undefined);
    assert.equal(store.loadTarget('../../context', context('alice', 'team-b')), undefined);
    const callbacks = await store.pushStore.loadWithMetadata!(original.id, own);
    assert.deepEqual(callbacks.map(entry => entry.wireVersion), ['1.0', '0.3']);
    assert.equal(callbacks[0].config.token, 'secret');
    assert.deepEqual(await store.pushStore.load(original.id, context('bob')), []);
    assert.deepEqual(await store.pushStore.load(original.id, context('alice', 'team-b')), []);
    callbacks[0].config.token = 'changed';
    assert.equal((await store.pushStore.load(original.id, own))[0].token, 'secret');
    await store.pushStore.delete(original.id, context('bob'), v1.id);
    assert.equal((await store.pushStore.load(original.id, own)).length, 2);
    await store.pushStore.delete(original.id, own, v1.id);
    store.close();
    store = new FileA2AStore(directory);
    assert.equal((await store.pushStore.load(original.id, own))[0].id, legacy.id);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('A2A list preserves SDK filtering, cursor pagination, artifact and history behavior', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'a2a-list-'));
  const store = new FileA2AStore(directory);
  try {
    const own = context();
    await store.taskStore.save(task('a', { timestamp: '2026-10-01T10:00:00Z' }), own);
    await store.taskStore.save(task('b', { timestamp: '2026-10-01T11:00:00Z' }), own);
    await store.taskStore.save(task('c', { timestamp: '2026-10-01T12:00:00Z', state: TaskState.TASK_STATE_WORKING }), own);
    await store.taskStore.save(task('d', { timestamp: '2026-10-01T13:00:00Z', contextId: 'conversation-2' }), own);
    await store.taskStore.save(task('hidden', { timestamp: '2026-10-01T15:00:00Z' }), context('bob'));
    const first = await store.taskStore.list(ListTasksRequest.fromJSON({ pageSize: 2, historyLength: 1 }), own);
    assert.deepEqual(first.tasks.map(item => item.id), ['d', 'c']);
    assert.equal(first.totalSize, 4);
    assert.ok(first.nextPageToken);
    assert.equal(first.tasks[0].history.length, 1);
    assert.equal(first.tasks[0].history[0].messageId, 'd-message-2');
    assert.deepEqual(first.tasks[0].artifacts, []);
    const next = await store.taskStore.list(ListTasksRequest.fromJSON({ pageSize: 2, pageToken: first.nextPageToken, historyLength: 0, includeArtifacts: true }), own);
    assert.deepEqual(next.tasks.map(item => item.id), ['b', 'a']);
    assert.equal(next.nextPageToken, '');
    assert.deepEqual(next.tasks[0].history, []);
    assert.equal(next.tasks[0].artifacts.length, 1);
    const filtered = await store.taskStore.list(ListTasksRequest.fromJSON({
      contextId: 'conversation-1', status: 'TASK_STATE_COMPLETED', statusTimestampAfter: '2026-10-01T10:30:00Z',
    }), own);
    assert.deepEqual(filtered.tasks.map(item => item.id), ['b']);
    assert.equal((await store.taskStore.load('b', own))?.history.length, 3);
    assert.equal((await store.taskStore.load('b', own))?.artifacts.length, 1);
    await assert.rejects(store.taskStore.list(ListTasksRequest.fromJSON({ historyLength: -1 }), own), /non-negative integer/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('A2A context retains a validated host preflight receipt across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'a2a-target-preflight-'));
  let store = new FileA2AStore(directory);
  try {
    const target = { sessionId: 'actual-session', cwd: directory,
      preflight: { ok: true, checkedAt: new Date().toISOString(), cwd: directory, jobDirectory: directory, checks: [{ id: 'cwd', ok: true }] } };
    store.saveTarget('context', target, context());
    store.close(); store = new FileA2AStore(directory);
    assert.deepEqual(store.loadTarget('context', context()), target);
    const copy = store.loadTarget('context', context())!;
    copy.preflight!.ok = false;
    assert.equal(store.loadTarget('context', context())!.preflight!.ok, true);
    assert.throws(() => store.saveTarget('invalid', { ...target, preflight: { ...target.preflight, ok: 'spoof' as unknown as boolean } }, context()));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('A2A restart marks every unfinished scoped execution failed and keeps terminal results', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'a2a-recovery-'));
  let store = new FileA2AStore(directory);
  try {
    const own = context();
    await store.taskStore.save(task('working', { state: TaskState.TASK_STATE_WORKING }), own);
    await store.taskStore.save(task('submitted', { state: TaskState.TASK_STATE_SUBMITTED }), context('bob'));
    await store.taskStore.save(task('input', { state: TaskState.TASK_STATE_INPUT_REQUIRED }), own);
    await store.taskStore.save(task('auth', { state: TaskState.TASK_STATE_AUTH_REQUIRED }), own);
    await store.taskStore.save(task('done'), own);
    await store.taskStore.save(task('cancelled', { state: TaskState.TASK_STATE_CANCELED }), own);
    await store.taskStore.save(task('rejected', { state: TaskState.TASK_STATE_REJECTED }), own);
    store.close();
    store = new FileA2AStore(directory);
    await store.recoverInterrupted();
    const failed = await store.taskStore.load('working', own);
    assert.equal(failed?.status?.state, TaskState.TASK_STATE_FAILED);
    assert.match(failed?.status?.message?.parts[0].content?.value as string, /service restart.*not restarted/);
    assert.equal(failed?.history.length, 4);
    assert.equal((await store.taskStore.load('submitted', context('bob')))?.status?.state, TaskState.TASK_STATE_FAILED);
    assert.equal((await store.taskStore.load('input', own))?.status?.state, TaskState.TASK_STATE_FAILED);
    assert.equal((await store.taskStore.load('auth', own))?.status?.state, TaskState.TASK_STATE_FAILED);
    assert.deepEqual(await store.taskStore.load('done', own), task('done'));
    assert.equal((await store.taskStore.load('cancelled', own))?.status?.state, TaskState.TASK_STATE_CANCELED);
    assert.equal((await store.taskStore.load('rejected', own))?.status?.state, TaskState.TASK_STATE_REJECTED);
    await store.recoverInterrupted();
    assert.equal((await store.taskStore.load('working', own))?.history.length, 4);
    store.close();
    store = new FileA2AStore(directory);
    assert.equal((await store.taskStore.load('working', own))?.status?.state, TaskState.TASK_STATE_FAILED);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a live owner keeps the lock while a follower reads and cannot write or recover', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'a2a-readonly-'));
  const owner = new FileA2AStore(directory);
  const own = context();
  await owner.taskStore.save(task('working', { state: TaskState.TASK_STATE_WORKING }), own);
  const follower = FileA2AStore.open(directory, { onConflict: 'readonly' });
  try {
    assert.equal(follower.mode, 'read-only');
    assert.equal((await follower.taskStore.load('working', own))?.status?.state, TaskState.TASK_STATE_WORKING);
    await assert.rejects(follower.taskStore.save(task('working', { state: TaskState.TASK_STATE_FAILED }), own), /read-only/);
    assert.throws(() => follower.saveTarget('conversation-1', { sessionId: 's', cwd: directory }, own), /read-only/);
    await follower.recoverInterrupted();
    assert.equal((await owner.taskStore.load('working', own))?.status?.state, TaskState.TASK_STATE_WORKING);
    follower.close();
    assert.equal((await owner.taskStore.load('working', own))?.id, 'working');
    assert.equal(readdirSync(join(directory, '.lock')).length, 1);
  } finally {
    follower.close();
    owner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('A2A store refuses concurrent instances and invalid callbacks, and fails closed on corrupt scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'a2a-validation-'));
  let store = new FileA2AStore(directory);
  try {
    assert.throws(() => new FileA2AStore(directory), /already in use/);
    const own = context();
    for (const url of ['file:///tmp/secrets', 'ftp://example.com/file', 'https://user:pass@example.com/callback']) {
      await assert.rejects(store.pushStore.save('t', own, TaskPushNotificationConfig.fromJSON({ url })), /HTTP\(S\)/);
    }
    await assert.rejects(store.pushStore.save('t', context('alice', 'team-a', '2.0'), TaskPushNotificationConfig.fromJSON({ url: 'https://example.com' })), /wire version/);
    assert.throws(() => store.saveTarget('c', { sessionId: 's', cwd: '../relative' }, own), /absolute path/);
    await store.taskStore.save(task('t'), own);
    store.close();
    // Legacy shared-name lock files must never be unlinked automatically.
    writeFileSync(join(directory, '.lock'), JSON.stringify({ pid: 2147483647, token: 'stale' }), { mode: 0o600 });
    assert.throws(() => new FileA2AStore(directory), /Legacy.*verify no instance/);
    assert.ok(statSync(join(directory, '.lock')).isFile());
    unlinkSync(join(directory, '.lock'));
    // A unique marker from a dead process is safely reclaimed on restart.
    mkdirSync(join(directory, '.lock'), { mode: 0o700 });
    writeFileSync(join(directory, '.lock', 'owner-2147483647-stale.json'), JSON.stringify({ pid: 2147483647, token: 'stale' }), { mode: 0o600 });
    store = new FileA2AStore(directory);
    assert.equal((await store.taskStore.load('t', own))?.id, 't');
    store.close();
    const file = readdirSync(directory).find(name => name.startsWith('task-'))!;
    const saved = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    saved.scope.owner = 'mallory';
    writeFileSync(join(directory, file), JSON.stringify(saved));
    assert.throws(() => new FileA2AStore(directory), /filename does not match its scope/);
    assert.ok(!readdirSync(directory).includes('.lock'));
    await assert.rejects(store.taskStore.load('t', own), /closed/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent dead-owner takeover cannot delete the new live owner marker', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'a2a-lock-race-'));
  const lockDirectory = join(directory, '.lock');
  mkdirSync(lockDirectory, { mode: 0o700 });
  writeFileSync(join(lockDirectory, 'owner-2147483647-stale.json'), JSON.stringify({ pid: 2147483647, token: 'stale' }));
  const script = `
    import { parentPort, workerData } from 'node:worker_threads';
    const control = new Int32Array(workerData.control);
    const actual = process.kill.bind(process);
    let inspected = false;
    process.kill = (pid, signal) => {
      try { return actual(pid, signal); } catch (error) {
        if (pid === 2147483647 && error.code === 'ESRCH' && !inspected) {
          inspected = true;
          parentPort.postMessage({ status: 'inspected-dead-owner' });
          Atomics.wait(control, 0, 0);
        }
        throw error;
      }
    };
    const { FileA2AStore } = await import(workerData.moduleUrl);
    let store;
    try {
      store = new FileA2AStore(workerData.directory);
      parentPort.postMessage({ status: 'acquired' });
      Atomics.wait(control, 1, 0);
    } catch (error) {
      parentPort.postMessage({ status: 'rejected', message: error.message });
    } finally { store?.close(); }
  `;
  const controls = [new SharedArrayBuffer(8), new SharedArrayBuffer(8)];
  const workers = controls.map(control => new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`), {
    workerData: { control, directory, moduleUrl: new URL('store.js', import.meta.resolve('@1agents/acp-service/a2a')).href },
    execArgv: [],
  }));
  const exited = workers.map(worker => once(worker, 'exit'));
  const release = (index: number, slot: number): void => {
    Atomics.store(new Int32Array(controls[index]), slot, 1);
    Atomics.notify(new Int32Array(controls[index]), slot);
  };
  try {
    const inspected = await Promise.all(workers.map(worker => once(worker, 'message')));
    assert.ok(inspected.every(([message]) => message.status === 'inspected-dead-owner'));
    const first = once(workers[0], 'message');
    release(0, 0);
    assert.equal((await first)[0].status, 'acquired');
    const newOwner = readdirSync(lockDirectory);
    assert.equal(newOwner.length, 1);
    assert.notEqual(newOwner[0], 'owner-2147483647-stale.json');
    // Both checked the same dead PID, but the delayed contender may only unlink
    // that dead owner's unique filename, never the first contender's new marker.
    const second = once(workers[1], 'message');
    release(1, 0);
    const rejected = (await second)[0];
    assert.equal(rejected.status, 'rejected');
    assert.match(rejected.message, /already in use/);
    assert.deepEqual(readdirSync(lockDirectory), newOwner);
  } finally {
    controls.forEach((_, index) => { release(index, 0); release(index, 1); });
    await Promise.all(exited);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a contender displaced between mkdir and marker creation cannot obtain a second lock', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'a2a-lock-gap-'));
  const script = `
    import { parentPort, workerData } from 'node:worker_threads';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { basename } from 'node:path';
    const control = new Int32Array(workerData.control);
    const actual = fs.openSync;
    let paused = false;
    fs.openSync = (...args) => {
      if (!paused && args[1] === 'wx' && basename(args[0]).startsWith('owner-')) {
        paused = true;
        parentPort.postMessage({ status: 'before-marker' });
        Atomics.wait(control, 0, 0);
      }
      return actual(...args);
    };
    syncBuiltinESMExports();
    const { FileA2AStore } = await import(workerData.moduleUrl);
    let store;
    try {
      store = new FileA2AStore(workerData.directory);
      parentPort.postMessage({ status: 'acquired' });
      Atomics.wait(control, 1, 0);
    } catch (error) {
      parentPort.postMessage({ status: 'rejected', message: error.message });
    } finally { store?.close(); }
  `;
  const controls = [new SharedArrayBuffer(8), new SharedArrayBuffer(8)];
  const workers: Worker[] = [];
  const exited: Promise<unknown[]>[] = [];
  const start = (index: number): Worker => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`), {
      workerData: { control: controls[index], directory, moduleUrl: new URL('store.js', import.meta.resolve('@1agents/acp-service/a2a')).href },
      execArgv: [],
    });
    workers.push(worker);
    exited.push(once(worker, 'exit'));
    return worker;
  };
  const release = (index: number, slot: number): void => {
    Atomics.store(new Int32Array(controls[index]), slot, 1);
    Atomics.notify(new Int32Array(controls[index]), slot);
  };
  try {
    const firstWorker = start(0);
    assert.equal((await once(firstWorker, 'message'))[0].status, 'before-marker');
    // The second contender removes and recreates the first's still-empty lock
    // directory, then both attempt to write distinct markers into that directory.
    const secondWorker = start(1);
    assert.equal((await once(secondWorker, 'message'))[0].status, 'before-marker');
    const first = once(firstWorker, 'message');
    release(0, 0);
    assert.equal((await first)[0].status, 'acquired');
    const marker = readdirSync(join(directory, '.lock'));
    const second = once(secondWorker, 'message');
    release(1, 0);
    assert.equal((await second)[0].status, 'rejected');
    assert.deepEqual(readdirSync(join(directory, '.lock')), marker);
  } finally {
    controls.forEach((_, index) => { release(index, 0); release(index, 1); });
    await Promise.all(exited);
    rmSync(directory, { recursive: true, force: true });
  }
});
