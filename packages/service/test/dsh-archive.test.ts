import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planArchive, runArchive, DAY_MS, type ArchivePlanOptions, type DshArchiveClient, type DshSessionSummary } from '../src/dsh-archive.js';
import { readSessionFileMtimes } from '../src/dsh-session-files.js';
import { readRegistryFile, staleArchiveIds } from '../src/dsh-registry-file.js';
import { mintSessionCookie, readBrowserSessionSecret } from '../src/dsh-host-client.js';
import { parseArchiveArgs, resolveDshHome } from '../bin/dsh.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

function session(id: string, updatedAt: number, extra: Partial<DshSessionSummary> = {}): DshSessionSummary {
  return { sessionId: id, updatedAt, ...extra };
}

function host(sessions: DshSessionSummary[], archived: string[] = [], pinned: string[] = []) {
  const calls: { sessionId: string; stopActivity: boolean }[] = [];
  const client: DshArchiveClient = {
    listSessions: async () => sessions,
    readRegistry: async () => ({ archivedSessionIds: archived, pinnedSessionIds: pinned }),
    archiveSession: async (sessionId, options) => { calls.push({ sessionId, stopActivity: options.stopActivity }); },
  };
  return { client, calls };
}

function options(overrides: Partial<ArchivePlanOptions> = {}): ArchivePlanOptions {
  return { inactivityMs: 7 * DAY_MS, now: NOW, ...overrides };
}

test('plan selects sessions silent past the threshold and leaves the rest', async () => {
  const { client } = host([
    session('old', NOW - 8 * DAY_MS, { projections: { values: { title: '旧会话' } } }),
    session('recent', NOW - 1 * DAY_MS),
    session('edge', NOW - 7 * DAY_MS),
  ]);
  const plan = await planArchive(client, options());
  assert.deepEqual(plan.candidates.map(candidate => candidate.sessionId), ['old']);
  assert.equal(plan.candidates[0].idleDays, 8);
  assert.equal(plan.candidates[0].title, '旧会话');
  assert.equal(plan.totalSessions, 3);
});

test('a pinned session is exempt unless the caller opts in', async () => {
  const sessions = [session('pinned-old', NOW - 30 * DAY_MS), session('plain-old', NOW - 30 * DAY_MS)];
  const { client } = host(sessions, [], ['pinned-old']);
  const plan = await planArchive(client, options());
  assert.deepEqual(plan.candidates.map(candidate => candidate.sessionId), ['plain-old']);
  assert.deepEqual(plan.skipped.map(skip => [skip.sessionId, skip.reason]), [['pinned-old', 'pinned']]);

  const opted = await planArchive(client, options({ includePinned: true }));
  assert.deepEqual(opted.candidates.map(candidate => candidate.sessionId).sort(), ['pinned-old', 'plain-old']);
  assert.deepEqual(opted.skipped, []);
});

test('already archived and running sessions are not archived again', async () => {
  const { client } = host([
    session('archived', NOW - 30 * DAY_MS),
    session('running', NOW - 30 * DAY_MS, { running: true }),
    session('plain', NOW - 30 * DAY_MS),
  ], ['archived']);
  const plan = await planArchive(client, options());
  assert.deepEqual(plan.candidates.map(candidate => candidate.sessionId), ['plain']);
  assert.deepEqual(plan.skipped.map(skip => [skip.sessionId, skip.reason]), [['running', 'running']]);
  assert.equal(plan.alreadyArchived, 1);
});

test('a durable file newer than the last message keeps a session out of the plan', async () => {
  const { client } = host([session('cold', NOW - 30 * DAY_MS)]);
  const mtimes = new Map([['cold', NOW - 1 * DAY_MS]]);
  const plan = await planArchive(client, options({ fileMtimes: mtimes }));
  assert.deepEqual(plan.candidates, []);
});

test('a durable file older than the last message does not hide a session', async () => {
  const { client } = host([session('s', NOW - 30 * DAY_MS)]);
  const mtimes = new Map([['s', NOW - 40 * DAY_MS]]);
  const plan = await planArchive(client, options({ fileMtimes: mtimes }));
  assert.deepEqual(plan.candidates.map(candidate => candidate.sessionId), ['s']);
  assert.equal(plan.candidates[0].fromFile, false);
});

test('runArchive archives each candidate and reports failures separately', async () => {
  const { client, calls } = host([
    session('a', NOW - 10 * DAY_MS),
    session('b', NOW - 10 * DAY_MS),
    session('c', NOW - 10 * DAY_MS),
  ]);
  const failing: DshArchiveClient = { ...client, archiveSession: async (sessionId, options) => {
    if (sessionId === 'c') throw new Error('session-active');
    calls.push({ sessionId, stopActivity: options.stopActivity });
  } };
  const plan = await planArchive(failing, options());
  const result = await runArchive(failing, plan);
  assert.deepEqual(result.archived, ['a', 'b']);
  assert.deepEqual(result.failed, [{ sessionId: 'c', error: 'session-active' }]);
  assert.equal(calls.every(call => call.stopActivity === false), true);
});

test('runArchive only stops running work when the caller allows it', async () => {
  const { client, calls } = host([session('a', NOW - 10 * DAY_MS)]);
  const plan = await planArchive(client, options());
  await runArchive(client, plan, { stopActivity: true });
  assert.deepEqual(calls, [{ sessionId: 'a', stopActivity: true }]);
});

test('plan rejects a threshold or clock that cannot mean anything', async () => {
  const { client } = host([]);
  await assert.rejects(() => planArchive(client, options({ inactivityMs: 0 })), /positive integer/);
  await assert.rejects(() => planArchive(client, options({ now: -1 })), /non-negative safe integer/);
});

test('readSessionFileMtimes reports the newest log per session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-archive-files-'));
  try {
    const dir = join(root, '--workspace--', 'session-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x');
    const old = new Date(NOW - 10 * DAY_MS);
    utimesSync(join(dir, 'session.v4.jsonl.zstd'), old, old);
    writeFileSync(join(dir, 'session.lock'), '');
    const mtimes = await readSessionFileMtimes(root);
    assert.equal(mtimes.get('session-1'), old.getTime());
    // A missing root yields no times instead of throwing.
    assert.equal((await readSessionFileMtimes(join(root, 'missing'))).size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readBrowserSessionSecret reads the secret and mintSessionCookie signs it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-archive-cred-'));
  try {
    const file = join(root, '.credentials.yaml');
    const secret = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64url');
    writeFileSync(file, `version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secret}\n`);
    const loaded = readBrowserSessionSecret(file);
    assert.equal(loaded.toString('utf8'), '0123456789abcdef0123456789abcdef');
    const cookie = mintSessionCookie(loaded, '127.0.0.1:51971');
    assert.match(cookie, /^dsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // A different authority must not reuse the same cookie payload.
    assert.notEqual(mintSessionCookie(loaded, '127.0.0.1:1234'), cookie);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseArchiveArgs defaults to seven days and rejects impossible values', () => {
  const parsed = parseArchiveArgs([]);
  assert.equal(parsed.days, 7);
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.includePinned, false);
  assert.equal(parseArchiveArgs(['--days', '14']).days, 14);
  assert.equal(parseArchiveArgs(['--dry-run']).dryRun, true);
  assert.equal(parseArchiveArgs(['--include-pinned']).includePinned, true);
  assert.throws(() => parseArchiveArgs(['--days', '0']), /positive number of days/);
  assert.throws(() => parseArchiveArgs(['--days', 'soon']), /positive number of days/);
  assert.throws(() => parseArchiveArgs(['--url', 'not-a-url']), /absolute origin/);
  assert.throws(() => parseArchiveArgs(['--url', 'ftp://example.com']), /http or https/);
});

test('resolveDshHome honours DSH_HOME and falls back to the home directory', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home');
  assert.match(resolveDshHome({}), /\.dsh$/);
});

test('readRegistryFile reads the durable sets and tolerates a missing document', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-registry-file-'));
  try {
    mkdirSync(join(root, 'storages'), { recursive: true });
    writeFileSync(join(root, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { archivedSessionIds: ['a', 'b'], pinnedSessionIds: ['p'] },
      tables: {},
    }));
    const state = await readRegistryFile(root);
    assert.equal(state.found, true);
    assert.deepEqual(state.archivedSessionIds, ['a', 'b']);
    assert.deepEqual(state.pinnedSessionIds, ['p']);
    const missing = await readRegistryFile(join(root, 'nowhere'));
    assert.deepEqual(missing, { archivedSessionIds: [], pinnedSessionIds: [], found: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staleArchiveIds names exactly what a Host is missing', () => {
  assert.deepEqual(staleArchiveIds(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(staleArchiveIds(['a'], ['a', 'b', 'c']), ['b', 'c']);
  assert.deepEqual(staleArchiveIds([], ['x']), ['x']);
  // A Host holding more than the document is not stale; only its own copy is ahead.
  assert.deepEqual(staleArchiveIds(['a', 'b', 'c'], ['a']), []);
});
