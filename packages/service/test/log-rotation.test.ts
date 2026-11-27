import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDailyLogRotation, pruneExpiredLogs } from '../src/log-rotation.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-log-rotation-'));
}

test('installDailyLogRotation rotates across midnight and updates symlinks', async () => {
  const dir = makeTmpDir();
  let current = new Date(2026, 10, 25, 23, 59, 0);
  const handle = installDailyLogRotation({
    logDir: dir,
    retainDays: 30,
    now: () => current,
  });

  try {
    console.log('day1-stdout');
    console.error('day1-stderr');

    current = new Date(2026, 10, 26, 0, 1, 0);
    console.log('day2-stdout');
    console.error('day2-stderr');

    await handle.close();

    const day1Out = fs.readFileSync(path.join(dir, 'acp-service-2026-11-25.log'), 'utf8');
    const day1Err = fs.readFileSync(path.join(dir, 'acp-service-2026-11-25.err.log'), 'utf8');
    const day2Out = fs.readFileSync(path.join(dir, 'acp-service-2026-11-26.log'), 'utf8');
    const day2Err = fs.readFileSync(path.join(dir, 'acp-service-2026-11-26.err.log'), 'utf8');

    assert.match(day1Out, /day1-stdout/);
    assert.doesNotMatch(day1Out, /day2-stdout/);
    assert.match(day1Err, /day1-stderr/);
    assert.match(day2Out, /day2-stdout/);
    assert.match(day2Err, /day2-stderr/);

    assert.equal(fs.readlinkSync(path.join(dir, 'acp-service.log')), 'acp-service-2026-11-26.log');
    assert.equal(fs.readlinkSync(path.join(dir, 'acp-service.err.log')), 'acp-service-2026-11-26.err.log');
  } finally {
    await handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installDailyLogRotation archives pre-existing regular log files and prunes logs >= 30 days old', async () => {
  const dir = makeTmpDir();
  try {
    const legacyOut = path.join(dir, 'acp-service.log');
    fs.writeFileSync(legacyOut, 'legacy-content\n', 'utf8');
    const legacyTime = new Date(2026, 10, 20, 12, 0, 0);
    fs.utimesSync(legacyOut, legacyTime, legacyTime);

    // 30 days old relative to 2026-11-26 -> 2026-10-27 (should be pruned)
    fs.writeFileSync(path.join(dir, 'acp-service-2026-10-27.log'), 'expired-30d\n');
    fs.writeFileSync(path.join(dir, 'acp-service-2026-10-27.err.log'), 'expired-err-30d\n');
    // 29 days old -> 2026-10-28 (should be retained)
    fs.writeFileSync(path.join(dir, 'acp-service-2026-10-28.log'), 'keep-29d\n');

    const handle = installDailyLogRotation({
      logDir: dir,
      retainDays: 30,
      now: () => new Date(2026, 10, 26, 8, 0, 0),
    });
    await handle.close();

    assert.equal(fs.readFileSync(path.join(dir, 'acp-service-2026-11-20.log'), 'utf8'), 'legacy-content\n');
    assert.equal(fs.existsSync(path.join(dir, 'acp-service-2026-10-27.log')), false);
    assert.equal(fs.existsSync(path.join(dir, 'acp-service-2026-10-27.err.log')), false);
    assert.equal(fs.existsSync(path.join(dir, 'acp-service-2026-10-28.log')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneExpiredLogs removes files older than retainDays', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'acp-service-2026-10-01.log'), 'old');
    fs.writeFileSync(path.join(dir, 'acp-service-2026-11-25.log'), 'recent');
    const removed = pruneExpiredLogs(dir, 'acp-service', 30, '2026-11-26');
    assert.deepEqual(removed, ['acp-service-2026-10-01.log']);
    assert.equal(fs.existsSync(path.join(dir, 'acp-service-2026-11-25.log')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
