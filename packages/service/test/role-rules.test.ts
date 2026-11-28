import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { assertAllowedRoleProjectPath, readRoleRules, resolveProjectRootFromCwd, type RoleRules } from '../src/roles/index.js';

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../..');
const roleDir = join(repoRoot, '.1agents/roles/pr-delivery');
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'role-rules-test',
  GIT_AUTHOR_EMAIL: 'role-rules-test@example.com',
  GIT_COMMITTER_NAME: 'role-rules-test',
  GIT_COMMITTER_EMAIL: 'role-rules-test@example.com',
};

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd, env: gitEnv });
}

function demoProfile(id: string): string {
  return JSON.stringify({ id, version: '0.0.1', skills: [{ key: 'only', name: 'only-skill' }] });
}

test('readRoleRules loads the tracked pr-delivery role and isolates phases', async () => {
  const all = await readRoleRules({ projectRoot: repoRoot, roleId: 'pr-delivery' });
  assert.equal(all.roleId, 'pr-delivery');
  assert.equal(all.roleVersion, '1.0.0');
  assert.equal(all.phase, 'all');
  assert.equal(all.roleDir, await realpath(roleDir));
  assert.match(all.roleInstructions ?? '', /你在隔离 git worktree/);
  assert.match(all.qaInstructions ?? '', /异模型审查者/);
  assert.match(all.agentsLocalTemplate ?? '', /AUTO-GENERATED FROM \.1agents\/roles\/pr-delivery/);
  assert.equal(all.workflow?.entry, 'implement');
  assert.equal(all.checklist?.roleId, 'pr-delivery');
  assert.equal(all.routing?.schemaVersion, 2);
  if (all.routing?.schemaVersion === 2) {
    assert.equal(all.routing.reviewer.primary.model, 'minimax-cn/MiniMax-M3.1-Flash');
    assert.equal(all.routing.worker.primary.deliveryMode, 'workspace_files');
    assert.ok(all.routing.worker.fallbacks.length >= 1);
    assert.ok(all.routing.reviewer.fallbacks.length >= 1);
  }
  assert.match(all.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(all.files, [...all.files].sort());
  for (const name of ['AGENTS.local.template.md', 'QA.md', 'ROLE.md', 'checklist.json', 'profile.json', 'routing.json', 'workflow.json']) {
    assert.ok(all.files.includes(name), name);
  }
  const again = await readRoleRules({ projectRoot: repoRoot, roleId: 'pr-delivery', phase: 'all' });
  assert.equal(again.digest, all.digest);

  const implement = await readRoleRules({ projectRoot: repoRoot, roleId: 'pr-delivery', phase: 'implement' });
  assert.equal('qaInstructions' in implement, false);
  assert.equal('routing' in implement, false);
  assert.match(implement.roleInstructions ?? '', /你在隔离 git worktree/);
  assert.equal(JSON.stringify(implement).includes('异模型审查者'), false);
  assert.equal(implement.files.includes('QA.md'), false);
  assert.equal(implement.files.includes('ROLE.md'), true);
  assert.ok(implement.checklist);
  assert.ok(implement.workflow);
  assert.notEqual(implement.digest, all.digest);

  const review = await readRoleRules({ projectRoot: repoRoot, roleId: 'pr-delivery', phase: 'review' });
  assert.equal('roleInstructions' in review, false);
  assert.equal('workflow' in review, false);
  assert.equal('agentsLocalTemplate' in review, false);
  assert.match(review.qaInstructions ?? '', /异模型审查者/);
  assert.equal(JSON.stringify(review).includes('你在隔离 git worktree'), false);
  assert.equal(JSON.stringify(review).includes('AUTO-GENERATED FROM .1agents/roles/pr-delivery'), false);
  assert.ok(review.checklist);
  assert.ok(review.routing);
  assert.equal(review.files.includes('ROLE.md'), false);
  assert.equal(review.files.includes('QA.md'), true);

  const gate = await readRoleRules({ projectRoot: repoRoot, roleId: 'pr-delivery', phase: 'gate' });
  assert.equal('roleInstructions' in gate, false);
  assert.equal('qaInstructions' in gate, false);
  assert.equal('agentsLocalTemplate' in gate, false);
  assert.equal(JSON.stringify(gate).includes('异模型审查者'), false);
  assert.equal(JSON.stringify(gate).includes('你在隔离 git worktree'), false);
  assert.ok(gate.profile && gate.checklist && gate.workflow && gate.routing);
  assert.deepEqual(gate.files, ['checklist.json', 'profile.json', 'routing.json', 'workflow.json']);

  const coach = await readRoleRules({ projectRoot: repoRoot, roleId: 'pr-delivery', phase: 'coach' });
  assert.equal(coach.digest, all.digest);
  assert.match(coach.roleInstructions ?? '', /你在隔离 git worktree/);
  assert.match(coach.qaInstructions ?? '', /异模型审查者/);
});

test('readRoleRules sees disk edits on the next call and keeps phase digests disjoint', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'role-rules-hot-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const copy = join(parent, '.1agents/roles/pr-delivery');
  await mkdir(join(parent, '.1agents/roles'), { recursive: true });
  await cp(roleDir, copy, { recursive: true });
  const before = await readRoleRules({ projectRoot: parent, roleId: 'pr-delivery', phase: 'all' });
  const roleMd = join(copy, 'ROLE.md');
  await writeFile(roleMd, `${await readFile(roleMd, 'utf8')}\nHOT-ROLE\n`);
  const afterRole = await readRoleRules({ projectRoot: parent, roleId: 'pr-delivery', phase: 'all' });
  assert.match(afterRole.roleInstructions ?? '', /HOT-ROLE/);
  assert.notEqual(afterRole.digest, before.digest);
  const implement = await readRoleRules({ projectRoot: parent, roleId: 'pr-delivery', phase: 'implement' });
  assert.match(implement.roleInstructions ?? '', /HOT-ROLE/);
  const qaMd = join(copy, 'QA.md');
  await writeFile(qaMd, `${await readFile(qaMd, 'utf8')}\nHOT-QA\n`);
  const implementAfterQa = await readRoleRules({ projectRoot: parent, roleId: 'pr-delivery', phase: 'implement' });
  assert.equal(implementAfterQa.digest, implement.digest);
  assert.equal(JSON.stringify(implementAfterQa).includes('HOT-QA'), false);
  const review = await readRoleRules({ projectRoot: parent, roleId: 'pr-delivery', phase: 'review' });
  assert.match(review.qaInstructions ?? '', /HOT-QA/);
  assert.equal(JSON.stringify(review).includes('HOT-ROLE'), false);
  const reviewDigest = review.digest;
  const checklistPath = join(copy, 'checklist.json');
  const checklist = JSON.parse(await readFile(checklistPath, 'utf8')) as { items: Record<string, unknown>[] };
  checklist.items.push({ id: 'qa_only_note', kind: 'self', severity: 'should', locked: false, rule: 'ONLY-REVIEW-CHECKLIST' });
  checklist.items[0]!.rule = `${checklist.items[0]!.rule} HOT-CHECK`;
  await writeFile(checklistPath, JSON.stringify(checklist));
  const reviewAfter = await readRoleRules({ projectRoot: parent, roleId: 'pr-delivery', phase: 'review' });
  assert.notEqual(reviewAfter.digest, reviewDigest);
  assert.equal(reviewAfter.checklist?.items.some(item => item.id === 'qa_only_note'), true);
  assert.match(reviewAfter.checklist?.items[0]?.rule ?? '', /HOT-CHECK/);
  const implementAfter = await readRoleRules({ projectRoot: parent, roleId: 'pr-delivery', phase: 'implement' });
  assert.equal(implementAfter.checklist?.items.some(item => item.id === 'qa_only_note' && item.locked === false && item.kind === 'self'), true);
  assert.match(implementAfter.checklist?.items[0]?.rule ?? '', /HOT-CHECK/);
  assert.notEqual(implementAfter.digest, implement.digest);
  await writeFile(join(copy, 'workflow.json'), '{ broken');
  const reviewDespiteWorkflow = await readRoleRules({ projectRoot: parent, roleId: 'pr-delivery', phase: 'review' });
  assert.equal('workflow' in reviewDespiteWorkflow, false);
  assert.match(reviewDespiteWorkflow.qaInstructions ?? '', /HOT-QA/);
  await assert.rejects(readRoleRules({ projectRoot: parent, roleId: 'pr-delivery', phase: 'implement' }), /JSON|workflow/i);
});

test('readRoleRules rejects roleId traversal and symlink escapes', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'role-rules-escape-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'proj');
  const outside = join(parent, 'outside');
  await mkdir(join(root, '.1agents/roles/demo'), { recursive: true });
  await mkdir(join(outside, 'secret-role'), { recursive: true });
  await writeFile(join(outside, 'secret-role/ROLE.md'), 'SECRET-BYTES\n');
  await writeFile(join(outside, 'secret-role/profile.json'), demoProfile('linked'));
  await writeFile(join(root, '.1agents/roles/demo/profile.json'), demoProfile('demo'));
  for (const roleId of ['../demo', '..', 'a/b', 'a\\b', 'a..b', 'demo/../../outside']) {
    await assert.rejects(readRoleRules({ projectRoot: root, roleId }), /Unsafe roleId/);
  }
  await assert.rejects(readRoleRules({ projectRoot: root, roleId: '' }), /roleId|Too small|at least/);
  await symlink(join(outside, 'secret-role'), join(root, '.1agents/roles/linked'));
  await assert.rejects(readRoleRules({ projectRoot: root, roleId: 'linked' }), /escapes \.1agents\/roles/);
  await symlink(join(outside, 'secret-role/ROLE.md'), join(root, '.1agents/roles/demo/ROLE.md'));
  await assert.rejects(readRoleRules({ projectRoot: root, roleId: 'demo', phase: 'implement' }), /escapes \.1agents\/roles/);
  const escapedRoot = join(parent, 'linked-root');
  await mkdir(join(outside, '.1agents/roles/demo'), { recursive: true });
  await writeFile(join(outside, '.1agents/roles/demo/profile.json'), demoProfile('demo'));
  await writeFile(join(outside, '.1agents/roles/demo/ROLE.md'), 'SECRET-BYTES\n');
  await mkdir(escapedRoot);
  await symlink(join(outside, '.1agents'), join(escapedRoot, '.1agents'));
  await assert.rejects(readRoleRules({ projectRoot: escapedRoot, roleId: 'demo' }), (error: Error) => {
    assert.match(error.message, /escapes the project root/);
    assert.equal(error.message.includes('SECRET-BYTES'), false);
    return true;
  });
  const missing = await readFile(join(outside, 'secret-role/ROLE.md'), 'utf8');
  assert.equal(missing, 'SECRET-BYTES\n');
});

test('resolveProjectRootFromCwd stops at a git boundary and accepts a worktree', async t => {
  assert.equal(await resolveProjectRootFromCwd(join(repoRoot, 'packages/service')), await realpath(repoRoot));
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'role-rules-root-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, '.1agents/roles'), { recursive: true });
  const child = join(parent, 'repo');
  await mkdir(join(child, 'nested/deep'), { recursive: true });
  await git(child, ['init', '-b', 'main']);
  assert.equal(await resolveProjectRootFromCwd(join(child, 'nested/deep')), undefined);
  await mkdir(join(child, '.1agents/roles/demo'), { recursive: true });
  await writeFile(join(child, '.1agents/roles/demo/profile.json'), demoProfile('demo'));
  await writeFile(join(child, 'README.md'), 'anchor\n');
  await git(child, ['add', 'README.md', '.1agents/roles/demo/profile.json']);
  await git(child, ['commit', '--no-gpg-sign', '-m', 'init']);
  assert.equal(await resolveProjectRootFromCwd(join(child, 'nested/deep')), child);
  const worktree = join(parent, 'wt');
  await git(child, ['worktree', 'add', '-b', 'delivery', worktree]);
  assert.equal((await lstat(join(worktree, '.git'))).isFile(), true);
  await mkdir(join(worktree, 'sub'));
  assert.equal(await resolveProjectRootFromCwd(join(worktree, 'sub')), await realpath(worktree));
  const allowed = await assertAllowedRoleProjectPath(join(worktree, 'sub'), child);
  assert.equal(allowed, await realpath(join(worktree, 'sub')));
  const other = join(parent, 'other');
  await mkdir(join(other, '.1agents/roles/demo'), { recursive: true });
  await git(other, ['init', '-b', 'main']);
  await assert.rejects(assertAllowedRoleProjectPath(other, child), /outside the allowed project/);
  const pinnedGit = await realpath(join(child, '.git'));
  const wtGitdir = (await readFile(join(worktree, '.git'), 'utf8')).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(wtGitdir);
  const forgedLink = join(parent, 'forged-link');
  const forgedMain = join(parent, 'forged-main');
  const forgedWt = join(parent, 'forged-wt');
  await mkdir(forgedLink);
  await mkdir(forgedMain);
  await mkdir(forgedWt);
  await symlink(pinnedGit, join(forgedLink, '.git'));
  await writeFile(join(forgedMain, '.git'), `gitdir: ${pinnedGit}\n`);
  await writeFile(join(forgedWt, '.git'), `gitdir: ${wtGitdir}\n`);
  await assert.rejects(assertAllowedRoleProjectPath(forgedLink, child), /outside the allowed project/);
  await assert.rejects(assertAllowedRoleProjectPath(forgedMain, child), /outside the allowed project/);
  await assert.rejects(assertAllowedRoleProjectPath(forgedWt, child), /outside the allowed project/);
  const second = join(parent, 'wt-b');
  await git(child, ['worktree', 'add', '-b', 'delivery-b', second]);
  assert.equal(await assertAllowedRoleProjectPath(child, worktree), await realpath(child));
  assert.equal(await assertAllowedRoleProjectPath(second, worktree), await realpath(second));
  await mkdir(join(second, 'inside'));
  assert.equal(await assertAllowedRoleProjectPath(join(second, 'inside'), worktree), await realpath(join(second, 'inside')));
  const fileAsDir = join(parent, 'not-dir');
  await writeFile(fileAsDir, 'x\n');
  assert.equal(await resolveProjectRootFromCwd(join(fileAsDir, 'child')), undefined);
  const fileRoot = join(parent, 'file-root');
  await mkdir(fileRoot);
  await git(fileRoot, ['init', '-b', 'main']);
  await writeFile(join(fileRoot, '.1agents'), 'not-a-directory\n');
  assert.equal(await resolveProjectRootFromCwd(fileRoot), undefined);
});
