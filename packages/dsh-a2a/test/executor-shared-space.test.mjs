import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessDshBackend } from '../dist/executor.js';

/** The preflight report names the directories the host admitted beyond cwd. */
const report = (extra = {}) => ({ ok: true, checkedAt: new Date().toISOString(), cwd: '/work', checks: [], ...extra });

test('the work directory defaults to the task directory the gateway created', () => {
  const job = '/work/.1agents/jobs/job-1';
  assert.equal(HeadlessDshBackend.workDirectory(report({ jobDirectory: job }), '/work'), job);
});

test('a caller may name another work directory, and it is granted alongside the shared space', () => {
  const shared = '/shared/one-thing';
  const granted = HeadlessDshBackend.grantedDirectories(report({ jobDirectory: '/work/.1agents/jobs/job-1', artifactSpace: shared }), '/work');
  assert.deepEqual(granted, ['/work/.1agents/jobs/job-1', shared]);
});

test('without a declared work directory the role path is granted, and duplicates collapse', () => {
  assert.deepEqual(HeadlessDshBackend.grantedDirectories(report(), '/work'), ['/work']);
  assert.deepEqual(HeadlessDshBackend.grantedDirectories(undefined, '/work'), ['/work']);
  assert.deepEqual(HeadlessDshBackend.grantedDirectories(report({ jobDirectory: '/work', artifactSpace: '/work' }), '/work'), ['/work']);
});

test('the role publication directory is granted too', () => {
  assert.deepEqual(HeadlessDshBackend.grantedDirectories(report({ rolePublication: '/work/.1agents/roles/a/published' }), '/work'),
    ['/work', '/work/.1agents/roles/a/published']);
});

test('pwd stays the role path even when the work directory is elsewhere', async () => {
  // The runtime is launched with cwd = the role path; only --add-dir names the others.
  const role = '/roles/writer';
  const shared = '/cases/one-thing';
  const work = '/cases/one-thing/.1agents/jobs/job-9';
  const granted = HeadlessDshBackend.grantedDirectories(report({ jobDirectory: work, artifactSpace: shared }), role);
  assert.deepEqual(granted, [work, shared]);
  assert.equal(granted.includes(role), false, 'the role path is the working directory, never an added root');
});

test('a caller-declared work directory replaces the default task directory', () => {
  const declared = '/cases/one-thing/shared';
  assert.equal(HeadlessDshBackend.workDirectory(report({ jobDirectory: declared }), '/roles/writer'), declared);
  assert.deepEqual(HeadlessDshBackend.grantedDirectories(report({ jobDirectory: declared }), '/roles/writer'), [declared]);
});
