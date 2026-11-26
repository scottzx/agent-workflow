import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { roleSkillProfileSchema } from '../src/roles/skills.js';
import { AGENTS_LOCAL_GENERATED_HEADER, projectRoleToWorktree, validateSkillFrontmatter } from '../src/roles/index.js';
import { loadChecklist } from '../src/rsi/checklist.js';
import { loadWorkflow } from '../src/rsi/engine.js';

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
const ignoreRules = ['/.agents/skills/*', '!/.agents/skills/autoreview/', '/.claude/', '**/AGENTS.local.md', '**/CLAUDE.local.md'];

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

  const workflow = await loadWorkflow(roleDir);
  assert.equal(workflow.schemaVersion, 1);
  assert.deepEqual(workflow.nodes.map(node => node.id), ['implement', 'l1_gate', 'draft_pr', 'cross_model_cr', 'ready_for_human']);
  assert.equal(workflow.cycles.programBounce.when, 'block_failed');
  assert.equal(workflow.cycles.programBounce.from, 'l1_gate');
  assert.equal(workflow.cycles.qaRevise.when, 'verdict_revise');
  assert.equal(workflow.cycles.qaRevise.to, 'implement');
  assert.equal(workflow.policies.trial.requireQa, true);
  assert.equal(workflow.policies.formal.enforceObserveAsBlock, true);
  assert.equal('routing' in workflow, false);

  const checklist = await loadChecklist(roleDir);
  assert.equal(checklist.schemaVersion, 2);
  assert.equal(checklist.roleId, 'pr-delivery');
  assert.deepEqual(checklist.artifacts, ['commit']);
  const ids = checklist.items.map(item => item.id);
  for (const id of ['self_check', 'l1_deterministic', 'cross_model_cr', 'ci_status', 'proj_git_anchor', 'proj_skill_frontmatter', 'proj_claude_symlink', 'proj_agents_local_header', 'proj_no_hooks']) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(checklist.items.find(item => item.id === 'self_check')?.kind, 'self');
  assert.equal(checklist.items.find(item => item.id === 'l1_deterministic')?.kind, 'program');
  assert.equal(checklist.items.find(item => item.id === 'cross_model_cr')?.kind, 'self_and_qa');
  assert.equal(checklist.items.every(item => typeof item.locked === 'boolean'), true);

  const routing = JSON.parse(await readFile(join(roleDir, 'routing.json'), 'utf8'));
  assert.equal(routing.worker.provider, 'magpie-responses');
  assert.equal(routing.worker.model, 'grok/grok-4.7@500k');
  assert.equal(routing.worker.deliveryMode, 'workspace_git');
  assert.equal(routing.reviewer.provider, 'magpie');
  assert.equal(routing.reviewer.model, 'group/deepseek-v4.1');
  assert.equal(routing.reviewer.readOnly, true);
  assert.equal(routing.reviewer.deliveryMode, 'none');

  const skill = await readFile(join(roleDir, 'skills/pr-three-green-delivery/SKILL.md'), 'utf8');
  assert.deepEqual(validateSkillFrontmatter(skill, 'pr-three-green-delivery'), {
    name: 'pr-three-green-delivery',
    description: skill.match(/^description:\s*(.+)$/m)?.[1],
  });
  const frontmatter = skill.split(/^---$/m)[1] ?? '';
  assert.match(skill, /^whenToUse: /m);
  assert.doesNotMatch(frontmatter, /^when-to-use\s*:/m);
  assert.match(skill, /^disable-model-invocation: false$/m);
  assert.match(skill, /^user-invocable: true$/m);
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
  await writeFile(join(repo.worktree, '.agents/skills/.AGENTS.local.md.crash.tmp'), 'partial\n');
  assert.equal((await git(repo.worktree, ['status', '--porcelain'])).trim(), '', 'a temp file under .agents/skills stays ignored');
  await writeFile(join(repo.worktree, '.agents/.AGENTS.local.md.crash.tmp'), 'partial\n');
  assert.match(await git(repo.worktree, ['status', '--porcelain']), /\?\? \.agents\//);
  await rm(join(repo.worktree, '.agents/.AGENTS.local.md.crash.tmp'));

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
  assert.throws(() => validateSkillFrontmatter(`\uFEFF${ok}`, 'pr-three-green-delivery'), /UTF-8 BOM/);
  assert.throws(() => validateSkillFrontmatter('---\nname: pr-three-green-delivery\ndescription: 123\n---\n', 'pr-three-green-delivery'), /description must be a string/);
  assert.throws(() => validateSkillFrontmatter('---\nname: pr-three-green-delivery\ndescription: true\n---\n', 'pr-three-green-delivery'), /description must be a string/);
  assert.equal(validateSkillFrontmatter('---\nname: pr-three-green-delivery\ndescription: "123"\n---\n', 'pr-three-green-delivery').description, '123');
});

test('gitignore does not hide any already tracked file', async () => {
  const ignored = (await git(repoRoot, ['ls-files', '--ignored', '--exclude-standard', '--cached'])).trim();
  assert.equal(ignored, '');
});

test('projectRoleToWorktree refuses a symlink that would write outside the worktree', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-escape-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const outside = join(parent, 'outside');
  const root = join(parent, 'repo');
  await mkdir(outside);
  await mkdir(root);
  await writeFile(join(outside, 'DO-NOT-TOUCH.txt'), 'keep\n');
  await git(root, ['init', '-b', 'main']);
  await symlink(outside, join(root, '.agents'));
  await assert.rejects(projectRoleToWorktree({ roleDir, worktreeDir: root }), /symlink/);
  assert.equal(await readFile(join(outside, 'DO-NOT-TOUCH.txt'), 'utf8'), 'keep\n');
  await assert.rejects(access(join(outside, 'skills')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('a foreign .claude/skills symlink fails before any skill is copied', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-claude-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const elsewhere = join(parent, 'elsewhere');
  const root = join(parent, 'repo');
  await mkdir(elsewhere);
  await mkdir(join(root, '.claude'), { recursive: true });
  await git(root, ['init', '-b', 'main']);
  await symlink(elsewhere, join(root, '.claude', 'skills'));
  await assert.rejects(projectRoleToWorktree({ roleDir, worktreeDir: root }), /points at/);
  await assert.rejects(access(join(root, '.agents', 'skills')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  assert.equal(await readlink(join(root, '.claude', 'skills')), elsewhere);
});

test('handwritten AGENTS.local.md is left untouched', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-local-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  const handwritten = 'this file was written by a person\n';
  await writeFile(join(root, 'AGENTS.local.md'), handwritten);
  await assert.rejects(projectRoleToWorktree({ roleDir, worktreeDir: root }), /handwritten AGENTS\.local\.md/);
  assert.equal(await readFile(join(root, 'AGENTS.local.md'), 'utf8'), handwritten);
  await assert.rejects(access(join(root, '.agents')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('l1-gate blocks a forced add and allows a tracked .agents edit', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-status-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const staged = join(parent, 'staged');
  await mkdir(join(staged, '.agents/skills/foo'), { recursive: true });
  await git(staged, ['init', '-b', 'main']);
  await writeFile(join(staged, 'README.md'), 'anchor\n');
  await writeFile(join(staged, '.gitignore'), `${ignoreRules.join('\n')}\n`);
  await git(staged, ['add', 'README.md', '.gitignore']);
  await git(staged, ['commit', '--no-gpg-sign', '-m', 'init']);
  await writeFile(join(staged, '.agents/skills/foo/SKILL.md'), '---\nname: foo\ndescription: x\n---\n');
  await git(staged, ['add', '-f', '.agents/skills/foo/SKILL.md']);
  const addedSkill = await runGate(staged);
  assert.equal(addedSkill.status, 1, JSON.stringify(addedSkill.body));
  assert.equal(addedSkill.body.checks.find(item => item.id === 'git-status')?.ok, false);
  await git(staged, ['reset', 'HEAD']);
  await rm(join(staged, '.agents'), { recursive: true, force: true });
  await writeFile(join(staged, 'AGENTS.local.md'), `${AGENTS_LOCAL_GENERATED_HEADER}\n\nstaged\n`);
  await git(staged, ['add', '-f', 'AGENTS.local.md']);
  const addedLocal = await runGate(staged);
  assert.equal(addedLocal.status, 1);
  assert.equal(addedLocal.body.checks.find(item => item.id === 'git-status')?.ok, false);

  const tracked = join(parent, 'tracked');
  await mkdir(join(tracked, '.agents/skills/autoreview'), { recursive: true });
  await git(tracked, ['init', '-b', 'main']);
  await writeFile(join(tracked, '.agents/skills/autoreview/test.md'), 'v1\n');
  await git(tracked, ['add', '.agents/skills/autoreview/test.md']);
  await git(tracked, ['commit', '--no-gpg-sign', '-m', 'track']);
  await writeFile(join(tracked, '.agents/skills/autoreview/test.md'), 'v2\n');
  const edited = await runGate(tracked);
  assert.equal(edited.status, 0, JSON.stringify(edited.body));
  assert.equal(edited.body.checks.find(item => item.id === 'git-status')?.ok, true);
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

test('projectRoleToWorktree refuses a real .claude/skills directory before copying', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-claude-dir-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  await mkdir(join(root, '.claude/skills'), { recursive: true });
  await git(root, ['init', '-b', 'main']);
  await assert.rejects(projectRoleToWorktree({ roleDir, worktreeDir: root }), /real directory/);
  await assert.rejects(access(join(root, '.agents', 'skills')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('roles project CLI prints the projection summary', async t => {
  const repo = await initRepo();
  t.after(() => rm(repo.parent, { recursive: true, force: true }));
  const cli = join(repoRoot, 'packages/service/bin/acp-service.ts');
  const run = async (args: string[]) => {
    try {
      const result = await exec(process.execPath, ['--import', 'tsx', cli, 'roles', ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      return { status: 0, stdout: result.stdout, stderr: result.stderr ?? '' };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { status: typeof failed.code === 'number' ? failed.code : 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  };
  const help = await run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /roles project --role-dir DIRECTORY --worktree DIRECTORY \[--skills-source DIRECTORY\]/);
  const projected = await run(['project', '--role-dir', roleDir, '--worktree', repo.worktree]);
  assert.equal(projected.status, 0, projected.stderr);
  const body = JSON.parse(projected.stdout) as { roleId: string; roleVersion: string; worktreeDir: string; skills: { name: string }[]; instructionsFile: string; digest: string };
  assert.equal(body.roleId, 'pr-delivery');
  assert.equal(body.roleVersion, '1.0.0');
  assert.equal(body.skills[0]?.name, 'pr-three-green-delivery');
  assert.equal(body.instructionsFile.endsWith(`${sep}AGENTS.local.md`) || body.instructionsFile.endsWith('/AGENTS.local.md'), true);
  assert.match(body.digest, /^[a-f0-9]{64}$/);
  assert.equal((await git(repo.worktree, ['status', '--porcelain'])).trim(), '');
});

test('l1-gate rejects a .claude symlink that leaves the worktree', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-claude-escape-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const outside = join(parent, 'outside');
  const root = join(parent, 'repo');
  await mkdir(outside);
  await mkdir(root);
  await symlink(join('..', '.agents', 'skills'), join(outside, 'skills'));
  await git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'anchor\n');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'init']);
  await symlink(outside, join(root, '.claude'));
  const escaped = await runGate(root);
  assert.equal(escaped.status, 1);
  const link = escaped.body.checks.find(item => item.id === 'claude-skills-link');
  assert.equal(link?.ok, false);
  assert.match(link?.detail ?? '', /outside the worktree/);
  await assert.rejects(projectRoleToWorktree({ roleDir, worktreeDir: root }), /symlink/);
  await assert.rejects(access(join(outside, '.agents')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('l1-gate rejects untracked or newly staged .1agents secrets but not a tracked edit', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pr-delivery-secret-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  await mkdir(join(root, '.1agents/config'), { recursive: true });
  await git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'anchor\n');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'init']);
  await writeFile(join(root, '.1agents/config/host.local.json'), '{"token":"secret"}\n');
  const untracked = await runGate(root);
  assert.equal(untracked.status, 1);
  assert.match(untracked.body.checks.find(item => item.id === 'git-status')?.detail ?? '', /\.1agents\/config\/host\.local\.json/);
  await rm(join(root, '.1agents/config/host.local.json'));
  await writeFile(join(root, '.1agents/config/public.json'), 'v1\n');
  await git(root, ['add', '.1agents/config/public.json']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'track config']);
  await writeFile(join(root, '.1agents/config/public.json'), 'v2\n');
  const edited = await runGate(root);
  assert.equal(edited.body.checks.find(item => item.id === 'git-status')?.ok, true, JSON.stringify(edited.body));
  await git(root, ['add', '.1agents/config/public.json']);
  const stagedEdit = await runGate(root);
  assert.equal(stagedEdit.body.checks.find(item => item.id === 'git-status')?.ok, true, JSON.stringify(stagedEdit.body));
  await mkdir(join(root, '.1agents/cache'), { recursive: true });
  await writeFile(join(root, '.1agents/cache/lock.json'), '{}\n');
  await git(root, ['add', '-f', '.1agents/cache/lock.json']);
  const added = await runGate(root);
  assert.equal(added.status, 1);
  assert.match(added.body.checks.find(item => item.id === 'git-status')?.detail ?? '', /\.1agents\/cache\/lock\.json/);
});
