import assert from 'node:assert/strict';
import test from 'node:test';
import { capacityPendingOf, consumeProcessReady, noteProcessCapacity, noteProcessReady, noteSessionRestore, readProcessCapacity, readSessionRestore, requestWhenAdmitted } from '../src/process-admission.ts';

const pending = { code: -32010, message: 'CAPACITY_PENDING', data: { position: 2, waitedMs: 61_000 } };

test('pending probes retry without counting the wait as a handshake failure', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  let canceled = 0;
  const result = await requestWhenAdmitted({
    signal: new AbortController().signal,
    pollMs: 1,
    isPending: capacityPendingOf,
    onPending: value => noteProcessCapacity('session-1', value),
    cancel: async () => { canceled += 1; },
    sleep: async ms => { sleeps.push(ms); },
    request: async () => {
      calls += 1;
      if (calls < 3) throw pending;
      return 'admitted';
    },
  });
  assert.equal(result, 'admitted');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1, 1]);
  assert.equal(canceled, 0);
  assert.deepEqual(readProcessCapacity('session-1'), { position: 2, waitedMs: 61_000 });
  noteProcessReady('session-1');
  assert.equal(readProcessCapacity('session-1'), undefined);
  assert.equal(consumeProcessReady('session-1'), true);
  assert.equal(consumeProcessReady('session-1'), false);
  assert.equal(capacityPendingOf({ code: -32010, message: 'CAPACITY_PENDING', data: { position: 1.5, waitedMs: 0 } }), undefined);
});

test('a successful reattach records the restore method without relabeling other sessions', () => {
  noteSessionRestore('dsh-kept', 'session/resume');
  assert.equal(readSessionRestore('dsh-kept'), 'session/resume');
  assert.equal(readSessionRestore('other-session'), undefined);
});

test('abort during a pending wait cancels the queued admission', async () => {
  const controller = new AbortController();
  let canceled = 0;
  await assert.rejects(requestWhenAdmitted({
    signal: controller.signal,
    pollMs: 1,
    isPending: capacityPendingOf,
    cancel: async () => { canceled += 1; },
    sleep: async (_ms, signal) => { controller.abort(); signal.throwIfAborted(); },
    request: async () => { throw pending; },
  }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(canceled, 1);
});
