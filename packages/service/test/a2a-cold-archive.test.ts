import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteAgentGateway } from '../src/a2a/gateway.js';

test('cold state archiving: archives terminal jobs and notices older than 7 days, retains hot jobs, and looks up archived jobs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-archive-test-'));
  try {
    const stateFile = path.join(dir, 'gateway.json');
    const archiveFile = path.join(dir, 'gateway-archive.json');
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 24 * 3600 * 1000).toISOString();
    const twoDaysAgo = new Date(now - 2 * 24 * 3600 * 1000).toISOString();

    const oldJob = {
      remote: 'test-remote',
      originSessionId: 'sess-old',
      taskId: 'task-old',
      contextId: 'ctx-old',
      cwd: '/workspace',
      task: { id: 'task-old', status: { state: 'TASK_STATE_COMPLETED' } },
      checkedAt: tenDaysAgo,
      closedAt: tenDaysAgo,
    };
    const hotJob = {
      remote: 'test-remote',
      originSessionId: 'sess-hot',
      taskId: 'task-hot',
      contextId: 'ctx-hot',
      cwd: '/workspace',
      task: { id: 'task-hot', status: { state: 'TASK_STATE_COMPLETED' } },
      checkedAt: twoDaysAgo,
      closedAt: twoDaysAgo,
    };
    const workingJob = {
      remote: 'test-remote',
      originSessionId: 'sess-working',
      taskId: 'task-working',
      contextId: 'ctx-working',
      cwd: '/workspace',
      task: { id: 'task-working', status: { state: 'TASK_STATE_WORKING' } },
      checkedAt: tenDaysAgo,
    };
    const oldNotice = {
      notice: {
        noticeId: 'notice-old',
        originSessionId: 'sess-old',
        remote: 'test-remote',
        taskId: 'task-old',
        contextId: 'ctx-old',
        cwd: '/workspace',
        state: 'TASK_STATE_COMPLETED',
        result: 'done',
        createdAt: tenDaysAgo,
      },
      acknowledged: true,
      delivered: true,
    };

    const initial = {
      version: 2,
      jobs: [oldJob, hotJob, workingJob],
      notices: [oldNotice],
      ledger: {
        version: 1, sourceId: 'src-1', jobs: {}, attempts: {}, requests: {}, events: [],
        nextSequence: 1, acceptances: {}, tickets: {}, handoffs: [], conventions: [],
        artifactSpaces: [], cases: {}, receipts: [], facts: []
      },
    };
    writeFileSync(stateFile, JSON.stringify(initial), 'utf8');

    const gateway = new RemoteAgentGateway({
      stateDirectory: dir,
      remotes: { 'test-remote': { url: 'http://127.0.0.1:3000', token: 'dummy-token' } },
      coldRetentionDays: 7,
    }, { now: () => now });

    assert.ok(existsSync(archiveFile), 'gateway-archive.json should be created');
    const archive = JSON.parse(readFileSync(archiveFile, 'utf8'));
    assert.equal(archive.jobs.length, 1);
    assert.equal(archive.jobs[0].taskId, 'task-old');
    assert.equal(archive.notices.length, 1);
    assert.equal(archive.notices[0].notice.noticeId, 'notice-old');

    // Check active state
    const active = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(active.jobs.length, 2);
    assert.ok(active.jobs.some((j: any) => j.taskId === 'task-hot'));
    assert.ok(active.jobs.some((j: any) => j.taskId === 'task-working'));
    assert.ok(!active.jobs.some((j: any) => j.taskId === 'task-old'));
    assert.equal(active.notices.length, 0);

    // Check that remote_agent_get can still find the archived job
    const archivedView = await gateway.invoke('remote_agent_get', {
      remote: 'test-remote',
      taskId: 'task-old',
      originSessionId: 'sess-old',
    });
    assert.ok(archivedView);
    assert.equal((archivedView as any).taskId, 'task-old');

    await gateway.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
