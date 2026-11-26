import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { deliveryInstructions, defaultJobDirectory, isDefaultJobDirectory, isManagedJobDirectory, resolveDefaultJobDirectory, spaceInstructions } from '../src/a2a/job-directory.js';
import { runA2APreflight } from '../src/a2a/preflight.js';
import { a2aResultContractSchema, createA2AResultMetadata } from '../src/a2a/result-metadata.js';

const git = promisify(execFile);
async function project() { return realpath(await mkdtemp(join(tmpdir(), 'delivery-mode-'))); }
const identity = { taskId: 't', contextId: 'c', requestId: 'r', startedAt: new Date().toISOString() };

test('resolveDefaultJobDirectory parks worktree jobs outside the checkout', () => {
  assert.equal(resolveDefaultJobDirectory('/p', 'j1'), '/p/.1agents/jobs/j1');
  assert.equal(defaultJobDirectory('/p', 'j1'), '/p/.1agents/jobs/j1');
  assert.equal(isDefaultJobDirectory('/p', '/p/.1agents/jobs/j1'), true);
  assert.equal(isManagedJobDirectory('/p', '/p/.1agents/jobs/j1'), true);
  assert.equal(resolveDefaultJobDirectory('/repo/.1agents/worktrees/demo', 'j1'), '/repo/.1agents/runtime/jobs/j1');
  assert.equal(resolveDefaultJobDirectory('/repo/.1agents/worktrees/demo/packages/service', 'j1'), '/repo/.1agents/runtime/jobs/j1');
  assert.equal(resolveDefaultJobDirectory('/repo/.1agents/runtime/worktrees/session/wt', 'j1'), '/repo/.1agents/runtime/jobs/j1');
  assert.equal(isManagedJobDirectory('/repo/.1agents/worktrees/demo', '/repo/.1agents/runtime/jobs/j1'), true);
  assert.equal(isManagedJobDirectory('/repo/.1agents/runtime/worktrees/session/wt', '/repo/.1agents/runtime/jobs/j1/extra'), true);
  assert.equal(isManagedJobDirectory('/repo/.1agents/worktrees/demo', '/repo/.1agents/runtime/jobs'), false);
  assert.equal(isManagedJobDirectory('/repo/.1agents/worktrees/demo', '/repo/.1agents/worktrees/demo/.1agents/jobs/j1'), false);
  assert.equal(isManagedJobDirectory('/repo/.1agents/worktrees/demo', '/etc/passwd'), false);
  assert.equal(isManagedJobDirectory('/repo/.1agents/worktrees/demo', '/repo/.1agents/runtime/jobs/../../secret'), false);
});

test('preflight creates a managed worktree job directory and refuses symlink escapes', async () => {
  const repo = await project();
  const cwd = join(repo, '.1agents', 'worktrees', 'wt');
  await mkdir(cwd, { recursive: true });
  const directory = resolveDefaultJobDirectory(cwd, 'job-1');
  assert.equal(directory, join(repo, '.1agents', 'runtime', 'jobs', 'job-1'));
  const report = await runA2APreflight({ cwd, jobDirectory: directory });
  assert.equal(report.ok, true, report.checks.filter(check => !check.ok).map(check => check.detail).join('; '));
  assert.equal(report.jobDirectory, await realpath(directory));

  const runtimeCwd = join(repo, '.1agents', 'runtime', 'worktrees', 'session');
  await mkdir(runtimeCwd, { recursive: true });
  const runtimeJob = resolveDefaultJobDirectory(runtimeCwd, 'job-rt');
  assert.equal(runtimeJob, join(repo, '.1agents', 'runtime', 'jobs', 'job-rt'));
  const runtimeReport = await runA2APreflight({ cwd: runtimeCwd, jobDirectory: runtimeJob });
  assert.equal(runtimeReport.ok, true, runtimeReport.checks.filter(check => !check.ok).map(check => check.detail).join('; '));
  assert.equal(runtimeReport.jobDirectory, await realpath(runtimeJob));

  const escapedRepo = await project();
  const escapedCwd = join(escapedRepo, '.1agents', 'worktrees', 'wt');
  await mkdir(escapedCwd, { recursive: true });
  await mkdir(join(escapedRepo, '.1agents'), { recursive: true });
  const outside = await project();
  await symlink(outside, join(escapedRepo, '.1agents', 'runtime'));
  const escaped = await runA2APreflight({ cwd: escapedCwd, jobDirectory: resolveDefaultJobDirectory(escapedCwd, 'evil') });
  assert.equal(escaped.ok, false);
  assert.match(escaped.checks.find(check => check.id === 'jobDirectory')?.detail ?? '', /symbolic links/);

  const stray = await runA2APreflight({ cwd, jobDirectory: join(repo, 'not-a-job') });
  assert.equal(stray.ok, false);
});

test('delivery prompts stay quiet for none and do not leak originSessionId', () => {
  const secret = 'session-secret-origin';
  assert.equal(deliveryInstructions('none', '/p/.1agents/jobs/j', '/p/.1agents/jobs/j/manifest.json'), '');
  assert.equal(spaceInstructions({ originSessionId: secret, jobId: 'job', attemptId: 'attempt', caseId: 'case-1', deliveryMode: 'none' }), '');
  assert.equal(spaceInstructions({ originSessionId: secret, jobId: 'job', attemptId: 'attempt', deliveryMode: 'none' }), '');
  const ticket = spaceInstructions({ originSessionId: secret, jobId: 'job', attemptId: 'attempt', deliveryMode: 'none', hasTicket: true });
  assert.match(ticket, /ticket_show/);
  assert.match(ticket, /ticket_self_check/);
  assert.match(ticket, /ticket_submit/);
  assert.doesNotMatch(ticket, new RegExp(secret));

  const gitText = deliveryInstructions('workspace_git');
  assert.match(gitText, /\[代码交付约定\]/);
  assert.match(gitText, /干净的 commit/);
  assert.match(gitText, /无需手工创建 manifest\.json/);
  assert.doesNotMatch(gitText, /\[产物约定\]/);

  const files = deliveryInstructions('workspace_files', '/job', '/job/manifest-a.json');
  assert.match(files, /\[项目文档交付约定\]/);
  assert.match(files, /\/job\/manifest-a\.json/);
  assert.match(files, /无需复制副本/);
  assert.doesNotMatch(files, /\[产物约定\]/);

  const artifacts = deliveryInstructions('artifacts', '/p/.1agents/jobs/j1', '/p/.1agents/jobs/j1/manifest-a1.json');
  assert.match(artifacts, /\[产物约定\]/);
  assert.match(artifacts, /manifest-a1\.json/);

  const space = spaceInstructions({ originSessionId: secret, jobId: 'job-9', attemptId: 'attempt-9', caseId: 'case-9', artifactSpace: '/work/shared' });
  assert.match(space, /\[空间\]/);
  assert.match(space, /case-9/);
  assert.match(space, /handoff_propose/);
  assert.match(space, /jobId=job-9/);
  assert.match(space, /只提议，不派下一单/);
  assert.match(space, /\/work\/shared\//);
  assert.doesNotMatch(space, new RegExp(secret));
  assert.doesNotMatch(space, /originSessionId/);
});

test('a relocated manifest is still an optional implicit manifest', async () => {
  const repo = await project();
  const cwd = join(repo, '.1agents', 'worktrees', 'wt');
  await mkdir(cwd, { recursive: true });
  const directory = resolveDefaultJobDirectory(cwd, 'job-i');
  const manifest = join(directory, 'manifest-a.json');
  const preflight = await runA2APreflight({ cwd, jobDirectory: directory });
  assert.equal(preflight.ok, true);
  const metadata = await createA2AResultMetadata({ ...identity, outcome: 'completed',
    target: { sessionId: 's', cwd, preflight } as any,
    contract: { jobId: 'job-i', artifactManifestPath: manifest } });
  assert.equal(metadata.validation.status, 'not-requested');
  assert.deepEqual(metadata.artifacts, []);
  assert.equal(metadata.gitDelivery, undefined);
});

test('workspace_files verifies files in cwd and still rejects symlinks, directories, and paths outside cwd', async () => {
  const cwd = await project();
  const job = join(cwd, 'declared');
  await mkdir(join(cwd, 'docs'), { recursive: true });
  await mkdir(job);
  const preflight = await runA2APreflight({ cwd, jobDirectory: job });
  assert.equal(preflight.ok, true);
  const manifest = join(job, 'manifest.json');
  const file = join(cwd, 'docs', 'guide.md');
  const body = 'hello project\n';
  await writeFile(file, body);
  const target = { sessionId: 's', cwd, preflight } as any;
  const check = (deliveryMode?: 'workspace_files') => createA2AResultMetadata({ ...identity, outcome: 'completed', target,
    contract: { jobId: 'j', artifactManifestPath: manifest, ...(deliveryMode ? { deliveryMode } : {}) } });

  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: file, mediaType: 'text/markdown' }] }));
  await assert.rejects(check(), /artifact-outside-job-directory/);
  const admitted = await check('workspace_files');
  assert.equal(admitted.validation.status, 'passed');
  assert.equal(admitted.artifacts[0]?.path, await realpath(file));
  assert.equal(admitted.artifacts[0]?.size, Buffer.byteLength(body));
  assert.equal(admitted.artifacts[0]?.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(admitted.artifacts[0]?.mediaType, 'text/markdown');

  const link = join(cwd, 'docs', 'link.md');
  await symlink(file, link);
  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: link }] }));
  await assert.rejects(check('workspace_files'), /artifact-symlink/);

  const outside = await project();
  const secret = join(outside, 'secret.txt');
  await writeFile(secret, 'nope');
  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: secret }] }));
  await assert.rejects(check('workspace_files'), /artifact-outside-job-directory/);

  const escaped = `${cwd}/docs/../../delivery-mode-escaped-secret.txt`;
  await writeFile(escaped, 'nope');
  try {
    await writeFile(manifest, JSON.stringify({ artifacts: [{ path: escaped }] }));
    await assert.rejects(check('workspace_files'), /artifact-outside-job-directory/);
  } finally { await unlink(escaped).catch(() => {}); }

  await writeFile(manifest, JSON.stringify({ artifacts: [{ path: join(cwd, 'docs') }] }));
  await assert.rejects(check('workspace_files'), /artifact-is-not-a-file/);
});

test('workspace_git samples the checkout and ignores a directory that is not a git repo', async () => {
  const cwd = await project();
  await git('git', ['init', '-b', 'feature'], { cwd });
  await git('git', ['config', 'user.email', 'delivery-mode@example.com'], { cwd });
  await git('git', ['config', 'user.name', 'Delivery Mode'], { cwd });
  await git('git', ['config', 'commit.gpgsign', 'false'], { cwd });
  await git('git', ['config', 'core.autocrlf', 'false'], { cwd });
  await writeFile(join(cwd, 'notes.txt'), 'hello\n');
  await git('git', ['add', 'notes.txt'], { cwd });
  await git('git', ['commit', '-m', 'add notes'], { cwd });
  const head = String((await git('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })).stdout).trim();
  const contract = { jobId: 'git-job', deliveryMode: 'workspace_git' as const };
  const target = { sessionId: 's', cwd };
  const clean = await createA2AResultMetadata({ ...identity, outcome: 'completed', target, contract });
  assert.equal(clean.gitDelivery?.branch, 'feature');
  assert.equal(clean.gitDelivery?.headCommit, head);
  assert.equal(clean.gitDelivery?.clean, true);
  assert.equal(clean.gitDelivery?.dirtyCount, 0);
  assert.match(clean.gitDelivery?.diffStat ?? '', /notes\.txt/);
  assert.ok(Buffer.byteLength(clean.gitDelivery?.diffStat ?? '') <= 4096);

  await writeFile(join(cwd, 'notes.txt'), 'changed\n');
  const dirty = await createA2AResultMetadata({ ...identity, outcome: 'completed', target, contract });
  assert.equal(dirty.gitDelivery?.branch, 'feature');
  assert.equal(dirty.gitDelivery?.headCommit, head);
  assert.equal(dirty.gitDelivery?.clean, false);
  assert.equal(dirty.gitDelivery?.dirtyCount, 1);

  const failed = await createA2AResultMetadata({ ...identity, outcome: 'failed', target, contract });
  assert.equal(failed.gitDelivery, undefined);

  const plain = await project();
  const skipped = await createA2AResultMetadata({ ...identity, outcome: 'completed', target: { sessionId: 's', cwd: plain }, contract });
  assert.equal(skipped.outcome, 'completed');
  assert.equal(skipped.gitDelivery, undefined);
  assert.equal(a2aResultContractSchema.safeParse({ jobId: 'x', deliveryMode: 'workspace_git' }).success, true);
  assert.equal(a2aResultContractSchema.safeParse({ jobId: 'x', deliveryMode: 'sideways' }).success, false);
  assert.equal(a2aResultContractSchema.safeParse({ jobId: 'x' }).success, true);
});
