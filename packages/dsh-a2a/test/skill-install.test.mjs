import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dshSkillsDirectory, installAcpSkill } from '../src/install-skill.js';

async function skillSource(root) {
  const source = join(root, 'packaged');
  await mkdir(join(source, 'references'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: acp-service\nversion: 0.10.5\ndescription: usage\n---\n\n# ACP\n');
  await writeFile(join(source, 'references', 'a2a.md'), '# A2A\n');
  return source;
}

test('the user skill root follows DSH_HOME, otherwise ~/.dsh/skills', () => {
  assert.equal(dshSkillsDirectory({ DSH_HOME: '/var/dsh' }, '/home/scott'), '/var/dsh/skills');
  assert.equal(dshSkillsDirectory({ DSH_HOME: '  ' }, '/home/scott'), '/home/scott/.dsh/skills');
});

test('install copies the skill and refreshes only a copy this plugin installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-skill-'));
  const source = await skillSource(root);
  const skills = join(root, 'skills');
  const first = await installAcpSkill({ source, skillsDirectory: skills, version: '0.2.0' });
  assert.equal(first.installed, true);
  assert.match(await readFile(join(first.path, 'SKILL.md'), 'utf8'), /name: acp-service/);
  assert.equal(JSON.parse(await readFile(join(first.path, '.installed-by-dsh-a2a.json'), 'utf8')).version, '0.10.5');
  await writeFile(join(skills, 'acp-service.md'), '# duplicate\n');
  await writeFile(join(source, 'SKILL.md'), '---\nname: acp-service\nversion: 0.10.4\ndescription: older\n---\n\n# Older\n');
  const kept = await installAcpSkill({ source, skillsDirectory: skills, version: '0.10.4' });
  assert.equal(kept.reason, 'current');
  assert.match(await readFile(join(first.path, 'SKILL.md'), 'utf8'), /usage/);
  assert.equal(await readFile(join(skills, 'acp-service.md'), 'utf8').catch(() => ''), '');

  await writeFile(join(source, 'SKILL.md'), '---\nname: acp-service\nversion: 0.10.6\ndescription: updated\n---\n\n# Updated\n');
  const refreshed = await installAcpSkill({ source, skillsDirectory: skills, version: '0.10.6' });
  assert.equal(refreshed.installed, true);
  assert.match(await readFile(join(refreshed.path, 'SKILL.md'), 'utf8'), /Updated/);

  await writeFile(join(skills, 'acp-service', 'SKILL.md'), '---\nname: acp-service\ndescription: unversioned\n---\n');
  await rm(join(skills, 'acp-service', '.installed-by-dsh-a2a.json'));
  const replaced = await installAcpSkill({ source, skillsDirectory: skills, version: '0.10.6' });
  assert.equal(replaced.installed, true);
  assert.match(await readFile(join(replaced.path, 'SKILL.md'), 'utf8'), /Updated/);
  await rm(root, { recursive: true, force: true });
});
