import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  assertWorktreePath, createWorktree, dependencySetupCommand, inspectWorktree, mergeWorktree, removeWorktree, renderBranch,
} from '../src/rsi/worktree.js';

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();

async function repo(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-wt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  await writeFile(join(root, 'README.md'), 'base\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'base');
  return root;
}

test('worktree paths and branch templates cannot leave the repository', async t => {
  const root = await repo(t);
  assert.equal(renderBranch('rsi/${caseId}/${stage}', { caseId: 'case-1', stage: 'pr2' }), 'rsi/case-1/pr2');
  assert.throws(() => renderBranch('../outside', { caseId: 'c', stage: 's' }), /Unsafe branch/);
  assert.throws(() => assertWorktreePath(root, join(root, '..', 'outside')), /escapes/);
  assert.throws(() => assertWorktreePath(root, root), /repository root/);
  await assert.rejects(createWorktree({ repo: root, worktreePath: join(root, '..', 'outside'), branch: 'rsi/escape', baseRef: 'main' }), /escapes/);
  assert.deepEqual(dependencySetupCommand('pnpm_offline'), ['pnpm', 'install', '--offline', '--frozen-lockfile']);
  assert.equal(dependencySetupCommand('none'), undefined);
});

test('trial stays isolated, formal fast-forwards, a moved target merges, conflicts abort, then the worktree is removed', async t => {
  const root = await repo(t);
  const worktreePath = join(root, '.1agents', 'runtime', 'worktrees', 'case', 'pr2');
  const created = await createWorktree({ repo: root, worktreePath, branch: 'rsi/case/pr2', baseRef: 'main' });
  assert.equal(created.event.type, 'worktree.created');
  assert.equal(created.baseCommit, git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'rsi/case/pr2');
  await mkdir(join(worktreePath, 'src'), { recursive: true });
  await writeFile(join(worktreePath, 'src', 'hello.txt'), 'hello\n');
  const dirty = await inspectWorktree(worktreePath);
  assert.equal(dirty.dirty, true);
  assert.deepEqual(dirty.changedFiles, ['src/hello.txt']);
  const refused = await mergeWorktree({ repo: root, worktreePath, branch: 'rsi/case/pr2', mode: 'formal', targetBranch: 'main', baseBranch: 'main' });
  assert.equal(refused.merged, false);
  assert.match(refused.reason ?? '', /uncommitted/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), created.baseCommit);

  git(worktreePath, 'add', 'src/hello.txt');
  git(worktreePath, 'commit', '-qm', 'hello');
  const clean = await inspectWorktree(worktreePath);
  assert.equal(clean.dirty, false);
  assert.equal(clean.headCommit, git(worktreePath, 'rev-parse', 'HEAD'));
  const isolated = await mergeWorktree({ repo: root, worktreePath, branch: 'rsi/case/pr2', mode: 'trial', targetBranch: 'main', baseBranch: 'main' });
  assert.deepEqual({ action: isolated.action, head: isolated.headCommit, main: git(root, 'rev-parse', 'HEAD') },
    { action: 'kept_isolated', head: clean.headCommit, main: created.baseCommit });

  const blocked = await mergeWorktree({
    repo: root, worktreePath, branch: 'rsi/case/pr2', mode: 'formal', targetBranch: 'main', baseBranch: 'main',
    postMergeCheck: async () => ({ ok: false, reason: 'not yet' }),
  });
  assert.equal(blocked.merged, false);
  assert.equal(blocked.reason, 'not yet');
  assert.equal(git(root, 'rev-parse', 'HEAD'), created.baseCommit);

  let checks = 0;
  const forwarded = await mergeWorktree({
    repo: root, worktreePath, branch: 'rsi/case/pr2', mode: 'formal', targetBranch: 'main', baseBranch: 'main',
    postMergeCheck: async () => { checks += 1; return { ok: true }; },
  });
  assert.equal(checks, 1);
  assert.equal(forwarded.merged, true);
  assert.equal(forwarded.strategy, 'ff-only');
  assert.equal(forwarded.event?.type, 'worktree.merged');
  assert.equal(git(root, 'rev-parse', 'HEAD'), clean.headCommit);
  assert.equal(await readFile(join(root, 'src', 'hello.txt'), 'utf8'), 'hello\n');

  await writeFile(join(root, 'docs-side.txt'), 'side\n');
  git(root, 'add', 'docs-side.txt');
  git(root, 'commit', '-qm', 'side');
  const targetAdvanced = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(worktreePath, 'src', 'mine.txt'), 'mine\n');
  git(worktreePath, 'add', 'src/mine.txt');
  git(worktreePath, 'commit', '-qm', 'mine');
  const featureBeforeIntegrate = git(worktreePath, 'rev-parse', 'HEAD');
  let integrateChecks = 0;
  const held = await mergeWorktree({
    repo: root, worktreePath, branch: 'rsi/case/pr2', mode: 'formal', targetBranch: 'main', baseBranch: 'main',
    postMergeCheck: async () => {
      integrateChecks += 1;
      return integrateChecks === 1 ? { ok: true } : { ok: false, reason: 'post-merge tests failed' };
    },
  });
  assert.equal(held.merged, false);
  assert.equal(held.reason, 'post-merge tests failed');
  assert.equal(git(root, 'rev-parse', 'HEAD'), targetAdvanced, 'a failed post-merge check does not move the target');
  assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), featureBeforeIntegrate, 'the worktree merge is rolled back');
  assert.throws(() => execFileSync('git', ['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { stdio: 'ignore' }));

  const merged = await mergeWorktree({
    repo: root, worktreePath, branch: 'rsi/case/pr2', mode: 'formal', targetBranch: 'main', baseBranch: 'main',
    postMergeCheck: async () => ({ ok: true }),
  });
  assert.equal(merged.merged, true);
  assert.equal(merged.strategy, 'merge');
  assert.equal(merged.event?.type, 'worktree.merged');
  assert.equal(git(root, 'rev-parse', 'HEAD'), merged.mergedCommit);
  assert.equal(await readFile(join(root, 'src', 'mine.txt'), 'utf8'), 'mine\n');
  assert.equal(await readFile(join(root, 'docs-side.txt'), 'utf8'), 'side\n');
  const mergedTarget = git(root, 'rev-parse', 'HEAD');

  await writeFile(join(root, 'src', 'hello.txt'), 'from-main\n');
  git(root, 'add', 'src/hello.txt');
  git(root, 'commit', '-qm', 'main edit');
  const beforeConflict = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(worktreePath, 'src', 'hello.txt'), 'from-worktree\n');
  git(worktreePath, 'add', 'src/hello.txt');
  git(worktreePath, 'commit', '-qm', 'worktree edit');
  const conflict = await mergeWorktree({
    repo: root, worktreePath, branch: 'rsi/case/pr2', mode: 'formal', targetBranch: 'main', baseBranch: 'main',
    postMergeCheck: async () => ({ ok: true }),
  });
  assert.equal(conflict.merged, false);
  assert.equal(conflict.conflicted, true);
  assert.ok(conflict.conflictFiles?.includes('src/hello.txt'), JSON.stringify(conflict.conflictFiles));
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeConflict);
  assert.equal(await readFile(join(root, 'src', 'hello.txt'), 'utf8'), 'from-main\n');
  assert.throws(() => execFileSync('git', ['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { stdio: 'ignore' }));
  assert.notEqual(beforeConflict, mergedTarget);

  const removed = await removeWorktree({ repo: root, worktreePath, branch: 'rsi/case/pr2', deleteBranch: true });
  assert.equal(removed.removed, true);
  assert.equal(removed.event.type, 'worktree.removed');
  await assert.rejects(readFile(join(worktreePath, 'src', 'hello.txt')));
  assert.throws(() => git(root, 'rev-parse', '--verify', 'refs/heads/rsi/case/pr2'));
  assert.equal(await readFile(join(root, 'src', 'hello.txt'), 'utf8'), 'from-main\n');
});
