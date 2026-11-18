import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AUTO_ARCHIVE,
  findSilentSessions,
  installAutoArchiveTimer,
  resolveAutoArchiveConfig,
  sweepAutoArchive,
} from '../dist/auto-archive.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function host(overrides = {}) {
  return {
    listSummaries: async () => [],
    listStored: async () => [],
    pinnedSessionIds: () => [],
    archivedSessionIds: () => [],
    archive: async () => {},
    log: () => {},
    ...overrides,
  };
}

test('resolveAutoArchiveConfig keeps 7-day default and validates overrides', () => {
  assert.deepEqual(resolveAutoArchiveConfig(undefined), DEFAULT_AUTO_ARCHIVE);
  assert.equal(DEFAULT_AUTO_ARCHIVE.inactivityMs, 7 * DAY);
  assert.equal(DEFAULT_AUTO_ARCHIVE.enabled, false);
  const custom = resolveAutoArchiveConfig({ enabled: true, inactivityMs: 1000 });
  assert.equal(custom.enabled, true);
  assert.equal(custom.inactivityMs, 1000);
  // Unspecified fields still get shipped defaults.
  assert.equal(custom.scanIntervalMs, DEFAULT_AUTO_ARCHIVE.scanIntervalMs);
  assert.throws(() => resolveAutoArchiveConfig({ inactivityMs: 0 }), /positive integer/);
  assert.throws(() => resolveAutoArchiveConfig({ enabled: 1 }), /boolean/);
});

test('findSilentSessions archives sessions quiet past the threshold', async () => {
  const h = host({
    listSummaries: async () => [
      { sessionId: 'old', updatedAt: NOW - 8 * DAY },
      { sessionId: 'recent', updatedAt: NOW - 1 * DAY },
      { sessionId: 'exact', updatedAt: NOW - 7 * DAY },
    ],
  });
  const result = await findSilentSessions(h, NOW, 7 * DAY);
  assert.deepEqual(result.map(c => c.sessionId), ['old']);
  assert.equal(result[0].lastActiveAt, NOW - 8 * DAY);
});

test('pinned sessions are exempt from automatic archiving', async () => {
  const h = host({
    listSummaries: async () => [
      { sessionId: 'pinned-old', updatedAt: NOW - 30 * DAY },
      { sessionId: 'normal-old', updatedAt: NOW - 30 * DAY },
    ],
    pinnedSessionIds: () => ['pinned-old'],
  });
  const result = await findSilentSessions(h, NOW, 7 * DAY);
  assert.deepEqual(result.map(c => c.sessionId), ['normal-old']);
});

test('already archived sessions are not returned again', async () => {
  const h = host({
    listSummaries: async () => [
      { sessionId: 'archived', updatedAt: NOW - 30 * DAY },
      { sessionId: 'fresh', updatedAt: NOW - 30 * DAY },
    ],
    archivedSessionIds: () => ['archived'],
  });
  assert.deepEqual((await findSilentSessions(h, NOW, 7 * DAY)).map(c => c.sessionId), ['fresh']);
});

test('durable file mtime counts as last activity for cold sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-archive-test-'));
  try {
    const oldFile = join(dir, 'old.session');
    const newFile = join(dir, 'new.session');
    await writeFile(oldFile, 'x');
    await writeFile(newFile, 'x');
    const oldTime = new Date(NOW - 10 * DAY);
    const newTime = new Date(NOW - 2 * DAY);
    await utimes(oldFile, oldTime, oldTime);
    await utimes(newFile, newTime, newTime);
    const h = host({
      listStored: async () => [
        { header: { id: 'cold-old', createdAt: NOW - 30 * DAY }, location: { path: oldFile } },
        { header: { id: 'cold-new', createdAt: NOW - 30 * DAY }, location: { path: newFile } },
      ],
    });
    const result = await findSilentSessions(h, NOW, 7 * DAY);
    assert.deepEqual(result.map(c => c.sessionId), ['cold-old']);
    assert.equal(result[0].lastActiveAt, oldTime.getTime());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file mtime newer than header recency keeps a session active', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-archive-test-'));
  try {
    const file = join(dir, 'session');
    await writeFile(file, 'x');
    const mtime = new Date(NOW - 1 * DAY);
    await utimes(file, mtime, mtime);
    const h = host({
      listSummaries: async () => [{ sessionId: 's', updatedAt: NOW - 30 * DAY }],
      listStored: async () => [{ header: { id: 's', createdAt: NOW - 30 * DAY }, location: { path: file } }],
    });
    assert.deepEqual(await findSilentSessions(h, NOW, 7 * DAY), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sweep skips sessions that became active and reports failures', async () => {
  const archived = [];
  const h = host({
    listSummaries: async () => [
      { sessionId: 'a', updatedAt: NOW - 10 * DAY },
      { sessionId: 'b', updatedAt: NOW - 10 * DAY },
      { sessionId: 'c', updatedAt: NOW - 10 * DAY },
    ],
    isActive: id => id === 'b',
    archive: async id => {
      if (id === 'c') throw new Error('active work');
      archived.push(id);
    },
  });
  const result = await sweepAutoArchive(h, NOW, 7 * DAY);
  assert.deepEqual(result.archived, ['a']);
  assert.deepEqual(result.failed, ['c']);
  assert.equal(result.candidates, 3);
});

test('installAutoArchiveTimer is inert when disabled and keeps timers alive until disposal', () => {
  let intervalCallback;
  let timeoutCallback;
  let effectCleanup;
  const disposed = [];
  const ctx = {
    interval: (cb, ms) => { assert.equal(ms, DEFAULT_AUTO_ARCHIVE.scanIntervalMs); intervalCallback = cb; return () => disposed.push('interval'); },
    timeout: (cb, ms) => { assert.equal(ms, DEFAULT_AUTO_ARCHIVE.initialDelayMs); timeoutCallback = cb; return () => disposed.push('timeout'); },
    // Cordis calls the effect body immediately; its RETURN VALUE is the cleanup.
    effect: cb => { effectCleanup = cb(); },
    logger: { warn: () => {} },
  };
  const disabled = installAutoArchiveTimer(ctx, { ...DEFAULT_AUTO_ARCHIVE, enabled: false }, () => {});
  assert.equal(timeoutCallback, undefined);
  disabled();

  let ticks = 0;
  const dispose = installAutoArchiveTimer(ctx, { ...DEFAULT_AUTO_ARCHIVE, enabled: true }, () => { ticks++; });
  // The effect body must not have disposed the timers at installation time.
  assert.deepEqual(disposed, []);
  assert.equal(typeof effectCleanup, 'function');
  assert.equal(typeof timeoutCallback, 'function');
  assert.equal(intervalCallback, undefined);
  timeoutCallback(); // starts the interval and runs the first sweep
  assert.equal(ticks, 1);
  assert.equal(typeof intervalCallback, 'function');
  intervalCallback();
  assert.equal(ticks, 2);
  // Only the explicit disposer or the fiber cleanup clears the timers.
  assert.deepEqual(disposed, []);
  dispose();
  assert.deepEqual(disposed, ['timeout', 'interval']);
  // The fiber cleanup is idempotent.
  effectCleanup();
  assert.deepEqual(disposed, ['timeout', 'interval']);
});
