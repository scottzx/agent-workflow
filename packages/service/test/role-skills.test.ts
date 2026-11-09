import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { linkClaudeSkills, loadRoleSkills, syncRoleSkills } from '../src/roles/index.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'role-skills-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'dist'), cwd = join(root, 'workspace'), profilePath = join(root, 'role', 'profile.json');
  await mkdir(join(root, 'role'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(root, 'role', 'ROLE.md'), '# Role text');
  await writeFile(profilePath, JSON.stringify({ id: 'ppt', version: '2', instructionsPath: 'ROLE.md', entrySkill: 'design',
    skills: [{ key: 'design', name: 'design' }, { key: 'data', name: 'data' }] }));
  for (const name of ['design', 'data']) {
    await mkdir(join(source, name, 'assets'), { recursive: true });
    await writeFile(join(source, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n# ${name}`);
    await writeFile(join(source, name, 'assets', 'big.bin'), Buffer.alloc(4096, name.length));
  }
  return { root, source, cwd, profilePath };
}

test('sync copies skills with their assets into .agents/skills and links .claude/skills', async t => {
  const f = await fixture(t);
  const loaded = await syncRoleSkills(f);
  assert.equal(loaded.roleId, 'ppt'); assert.equal(loaded.instructions, '# Role text');
  assert.equal(loaded.entryGuidePath, join(f.cwd, '.agents/skills/design/SKILL.md'));
  assert.equal((await readFile(join(f.cwd, '.agents/skills/data/assets/big.bin'))).length, 4096);
  assert.ok((await lstat(join(f.cwd, '.claude/skills'))).isSymbolicLink());
  assert.equal(await readlink(join(f.cwd, '.claude/skills')), '../.agents/skills');
  assert.match(await readFile(join(f.cwd, '.claude/skills/design/SKILL.md'), 'utf8'), /# design/);
});

test('load works offline on the directory as it is, including later edits', async t => {
  const f = await fixture(t); await syncRoleSkills(f);
  await writeFile(join(f.cwd, '.agents/skills/design/SKILL.md'), '---\nname: design\n---\n# edited');
  const loaded = await loadRoleSkills(f);
  assert.match(await readFile(loaded.entryGuidePath!, 'utf8'), /# edited/);
});

test('a missing skill or a mismatched declared name stops loading', async t => {
  const f = await fixture(t);
  await assert.rejects(loadRoleSkills(f), /Required skill unavailable.*design/);
  await syncRoleSkills(f);
  await writeFile(join(f.cwd, '.agents/skills/data/SKILL.md'), '---\nname: other\n---\n');
  await assert.rejects(loadRoleSkills(f), /declares name other/);
  await assert.rejects(syncRoleSkills({ ...f, source: join(f.root, 'nowhere') }), /not found in source/);
});

test('an existing .claude/skills directory only gains links; a foreign link is refused', async t => {
  const f = await fixture(t); await syncRoleSkills(f);
  await rm(join(f.cwd, '.claude/skills'));
  await mkdir(join(f.cwd, '.claude/skills/mine'), { recursive: true });
  await linkClaudeSkills(f.cwd, ['design', 'data']);
  assert.ok((await lstat(join(f.cwd, '.claude/skills/mine'))).isDirectory());
  assert.ok((await lstat(join(f.cwd, '.claude/skills/design'))).isSymbolicLink());
  assert.match(await readFile(join(f.cwd, '.claude/skills/data/SKILL.md'), 'utf8'), /# data/);
  await rm(join(f.cwd, '.claude'), { recursive: true });
  await mkdir(join(f.cwd, '.claude')); await mkdir(join(f.root, 'elsewhere'));
  await symlink(join(f.root, 'elsewhere'), join(f.cwd, '.claude/skills'));
  await assert.rejects(linkClaudeSkills(f.cwd, ['design']), /link to somewhere other/);
});

test('syncing again replaces a skill and syncing in place is a no-op', async t => {
  const f = await fixture(t); await syncRoleSkills(f);
  await writeFile(join(f.source, 'design/SKILL.md'), '---\nname: design\n---\n# v2');
  await syncRoleSkills(f);
  assert.match(await readFile(join(f.cwd, '.agents/skills/design/SKILL.md'), 'utf8'), /# v2/);
  await syncRoleSkills({ ...f, source: join(f.cwd, '.agents/skills') });
  assert.match(await readFile(join(f.cwd, '.agents/skills/design/SKILL.md'), 'utf8'), /# v2/);
});

test('a skill name that could leave .agents/skills is refused', async t => {
  const f = await fixture(t);
  await writeFile(f.profilePath, JSON.stringify({ id: 'ppt', version: '1', skills: [{ key: 'x', name: '../escape' }] }));
  await assert.rejects(loadRoleSkills(f), /Unsafe skill name/);
  await assert.rejects(syncRoleSkills(f), /Unsafe skill name/);
});

test('a profile with the removed network fields is rejected', async t => {
  const f = await fixture(t);
  await writeFile(f.profilePath, JSON.stringify({ id: 'ppt', version: '1', network: { agentUrl: 'http://127.0.0.1:1' }, skills: [{ key: 'design', name: 'design' }] }));
  await assert.rejects(loadRoleSkills(f), /network/);
  await writeFile(f.profilePath, JSON.stringify({ id: 'ppt', version: '1', skills: [{ key: 'design', name: 'design', sourceId: 'x' }] }));
  await assert.rejects(loadRoleSkills(f), /sourceId/);
});
