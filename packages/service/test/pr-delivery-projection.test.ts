import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { roleSkillProfileSchema } from '../src/roles/skills.js';
import { AGENTS_LOCAL_GENERATED_HEADER, projectRoleToWorktree, validateSkillFrontmatter } from '../src/roles/index.js';

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../..');
const roleDir = join(repoRoot, '.1agents/roles/pr-delivery');
const gate = join(roleDir, 'checks/l1-gate.mjs');
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'projection-test',
  GIT_AUTHOR_EMAIL: 'projection-test@example.com',
  GIT_COMMITTER_NAME: 'projection-test',
  GIT_COMMITTER_EMAIL: 'projection-test@example.com',
};
const ignoreRules = ['**/.agents/', '**/.claude/', '**/AGENTS.local.md', '**/CLAUDE.local.md'];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd, env: gitEnv });
  return result.stdout;
}

async function initRepo(): Promise<{ parent: string; root: string; worktree: string }> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-proj-')));
  const root = join(parent, 'repo');
  const worktree = join(parent, 'wt');
  await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  await writeFile(join(root, '.gitignore'), `${ignoreRules.join('\n')}\n`);
  await writeFile(join(root, 'AGENTS.md'), 'SENTINEL\n');
  await writeFile(join(root, 'README.md'), 'anchor\n');
  await git(root, ['add', '.gitignore', 'AGENTS.md', 'README.md']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'init']);
  await git(root, ['worktree', 'add', '-b', 'delivery', worktree]);
  return { parent, root, worktree };
}

async function runGate(worktree: string, extra: string[] = []): Promise<{ status: number; body: { ok: boolean; checks: { id: string; ok: boolean; detail?: string }[] } }> {
  try {
    const result = await exec(process.execPath, [gate, '--worktree', worktree, ...extra], { encoding: 'utf8' });
    return { status: 0, body: JSON.parse(result.stdout) };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { status: typeof failed.code === 'number' ? failed.code : 1, body: JSON.parse(failed.stdout ?? '') };
  }
}

test('the tracked pr-delivery role matches the schema, workflow, checklist and skill frontmatter', async () => {
  const profile = roleSkillProfileSchema.parse(JSON.parse(await readFile(join(roleDir, 'profile.json'), 'utf8')));
  assert.equal(profile.id, 'pr-delivery');
  assert.equal(profile.version, '1.0.0');
  assert.equal(profile.instructionsPath, 'ROLE.md');
  assert.equal(profile.entrySkill, 'three-green');
  assert.deepEqual(profile.skills, [{ key: 'three-green', name: 'pr-three-green-delivery' }]);

  const workflow = JSON.parse(await readFile(join(roleDir, 'workflow.json'), 'utf8'));
  assert.equal(workflow.schemaVersion, 1);
  assert.deepEqual(workflow.nodes.map((node: { id: string }) => node.id),
    ['implement', 'l1_gate', 'draft_pr', 'cross_model_cr', 'rework_loop', 'ready_for_human']);
  assert.equal(workflow.routing.worker.provider, 'magpie-responses');
  assert.equal(workflow.routing.worker.model, 'grok/grok-4.7@500k');
  assert.equal(workflow.routing.worker.deliveryMode, 'workspace_git');
  assert.equal(workflow.routing.reviewer.provider, 'magpie');
  assert.equal(workflow.routing.reviewer.model, 'group/deepseek-v4.1');
  assert.equal(workflow.routing.reviewer.readOnly, true);
  assert.equal(workflow.routing.reviewer.deliveryMode, 'none');
  assert.equal(typeof workflow.policies.trial, 'object');
  assert.equal(typeof workflow.policies.formal, 'object');

  const checklist = JSON.parse(await readFile(join(roleDir, 'checklist.json'), 'utf8'));
  const ids = checklist.items.map((item: { id: string }) => item.id);
  for (const id of ['self_check', 'l1_deterministic', 'cross_model_cr', 'ci_status', 'proj_git_anchor', 'proj_skill_frontmatter', 'proj_claude_symlink', 'proj_agents_local_header', 'proj_no_hooks']) {
    assert.ok(ids.includes(id), id);
  }
  const review = checklist.items.find((item: { id: string }) => item.id === 'cross_model_cr');
  assert.equal(review.provider, 'magpie');
  assert.equal(review.model, 'group/deepseek-v4.1');
  assert.equal(review.readOnly, true);

  const skill = await readFile(join(roleDir, 'skills/pr-three-green-delivery/SKILL.md'), 'utf8');
  assert.deepEqual(validateSkillFrontmatter(skill, 'pr-three-green-delivery'), {
    name: 'pr-three-green-delivery',
    description: skill.match(/^description:\s*(.+)$/m)?.[1],
  });
  assert.match(skill, /^when-to-use: /m);
  assert.match(skill, /^whenToUse: /m);
  assert.match(skill, /^disable-model-invocation: false$/m);
  assert.match(skill, /^user-invocable: true$/m);
  const frontmatter = skill.split(/^---$/m)[1] ?? '';
  assert.doesNotMatch(frontmatter, /^(disableModelInvocation|modelInvocable|userInvocable)\s*:/m);
  const template = await readFile(join(roleDir, 'AGENTS.local.template.md'), 'utf8');
  assert.equal(template.split(/\r?\n/, 1)[0], AGENTS_LOCAL_GENERATED_HEADER);
  const gitignore = await readFile(join(repoRoot, '.gitignore'), 'utf8');
  for (const rule of ignoreRules) assert.ok(gitignore.includes(rule), rule);
});

test('projectRoleToWorktree fills a real git worktree and leaves status clean', async t => {
  const repo = await initRepo();
  t.after(() => rm(repo.parent, { recursive: true, force: true }));
  assert.equal((await lstat(join(repo.worktree, '.git'))).isFile(), true);
  const sentinel = await readFile(join(repo.worktree, 'AGENTS.md'), 'utf8');

  const projected = await projectRoleToWorktree({ roleDir, worktreeDir: repo.worktree });
  assert.equal(projected.roleId, 'pr-delivery');
  assert.equal(projected.roleVersion, '1.0.0');
  assert.equal(projected.skills.length, 1);
  assert.equal(projected.skills[0].name, 'pr-three-green-delivery');
  const guide = join(repo.worktree, '.agents/skills/pr-three-green-delivery/SKILL.md');
  assert.match(await readFile(guide, 'utf8'), /name: pr-three-green-delivery/);
  assert.equal(await readlink(join(repo.worktree, '.claude/skills')), '../.agents/skills');
  const local = await readFile(projected.instructionsFile!, 'utf8');
  assert.equal(local.split(/\r?\n/, 1)[0], AGENTS_LOCAL_GENERATED_HEADER);
  assert.equal(await readFile(join(repo.worktree, 'AGENTS.md'), 'utf8'), sentinel);
  assert.equal((await git(repo.worktree, ['status', '--porcelain'])).trim(), '');

  const again = await projectRoleToWorktree({ roleDir, worktreeDir: repo.worktree });
  assert.equal(again.digest, projected.digest);
  assert.equal((await git(repo.worktree, ['status', '--porcelain'])).trim(), '');

  const clean = await runGate(repo.worktree, ['--role-dir', roleDir]);
  assert.equal(clean.status, 0, JSON.stringify(clean.body));
  assert.equal(clean.body.ok, true);

  await mkdir(join(repo.worktree, '.agents/skills/evil-skill'), { recursive: true });
  await writeFile(join(repo.worktree, '.agents/skills/evil-skill/SKILL.md'), '---\nname: evil-skill\ndescription: bad\ndisableModelInvocation: true\n---\n');
  const dirtySkill = await runGate(repo.worktree);
  assert.equal(dirtySkill.status, 1);
  assert.equal(dirtySkill.body.ok, false);
  assert.equal(dirtySkill.body.checks.find(item => item.id === 'skill-frontmatter')?.ok, false);
});

test('projectRoleToWorktree refuses a bare directory before copying skills', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-bare-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const bare = join(parent, 'bare');
  await mkdir(bare);
  await assert.rejects(projectRoleToWorktree({ roleDir, worktreeDir: bare }), /missing \.git anchor/);
  await assert.rejects(access(join(bare, '.agents')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

  const root = join(parent, 'repo');
  await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  const fakeRole = join(parent, 'role');
  await mkdir(join(fakeRole, 'skills/ok-skill'), { recursive: true });
  await mkdir(join(fakeRole, 'skills/bad-skill'), { recursive: true });
  await writeFile(join(fakeRole, 'ROLE.md'), '# role\n');
  await writeFile(join(fakeRole, 'profile.json'), JSON.stringify({
    id: 'pr-delivery', version: '1.0.0', instructionsPath: 'ROLE.md', entrySkill: 'three-green',
    skills: [{ key: 'three-green', name: 'ok-skill' }, { key: 'bad', name: 'bad-skill' }],
  }));
  await writeFile(join(fakeRole, 'skills/ok-skill/SKILL.md'), '---\nname: ok-skill\ndescription: ok\n---\n# ok\n');
  await writeFile(join(fakeRole, 'skills/bad-skill/SKILL.md'), '---\nname: bad-skill\ndescription: bad\nuserInvocable: false\n---\n# bad\n');
  await assert.rejects(projectRoleToWorktree({ roleDir: fakeRole, worktreeDir: root }), /legacy key "userInvocable"/);
  await assert.rejects(access(join(root, '.agents')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('validateSkillFrontmatter rejects legacy keys, a missing description and a non-kebab name', () => {
  const ok = '---\nname: pr-three-green-delivery\ndescription: deliver\ndisable-model-invocation: false\nuser-invocable: true\n---\n# body\n';
  assert.equal(validateSkillFrontmatter(ok, 'pr-three-green-delivery').description, 'deliver');
  assert.throws(() => validateSkillFrontmatter('---\nname: pr-three-green-delivery\ndescription: x\ndisableModelInvocation: true\n---\n', 'pr-three-green-delivery'), /disableModelInvocation/);
  assert.throws(() => validateSkillFrontmatter('---\nname: pr-three-green-delivery\ndescription: x\nmodelInvocable: true\n---\n', 'pr-three-green-delivery'), /modelInvocable/);
  assert.throws(() => validateSkillFrontmatter('---\nname: pr-three-green-delivery\ndescription: x\nuserInvocable: true\n---\n', 'pr-three-green-delivery'), /userInvocable/);
  assert.throws(() => validateSkillFrontmatter('---\nname: pr-three-green-delivery\n---\n', 'pr-three-green-delivery'), /non-empty description/);
  assert.throws(() => validateSkillFrontmatter('---\nname: pr-three-green-delivery\ndescription: "   "\n---\n', 'pr-three-green-delivery'), /non-empty description/);
  assert.throws(() => validateSkillFrontmatter('---\nname: NotKebab\ndescription: x\n---\n', 'pr-three-green-delivery'), /not kebab-case/);
  assert.throws(() => validateSkillFrontmatter('---\nname: other-skill\ndescription: x\n---\n', 'pr-three-green-delivery'), /does not match/);
  assert.throws(() => validateSkillFrontmatter(ok, 'NotKebab'), /not kebab-case/);
});

test('l1-gate fails a worktree with no .git and a projection path that git would commit', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-gate-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const bare = join(parent, 'bare');
  await mkdir(bare);
  const missing = await runGate(bare);
  assert.equal(missing.status, 1);
  assert.equal(missing.body.checks.find(item => item.id === 'git-anchor')?.ok, false);

  const root = join(parent, 'repo');
  await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'anchor\n');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'init']);
  await mkdir(join(root, '.agents/hooks'), { recursive: true });
  await writeFile(join(root, 'AGENTS.local.md'), `${AGENTS_LOCAL_GENERATED_HEADER}\n\nstill untracked\n`);
  const leaked = await runGate(root);
  assert.equal(leaked.status, 1);
  assert.equal(leaked.body.checks.find(item => item.id === 'git-status')?.ok, false);
  assert.equal(leaked.body.checks.find(item => item.id === 'no-hooks')?.ok, false);
});
