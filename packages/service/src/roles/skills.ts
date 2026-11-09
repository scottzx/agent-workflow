/**
 * Role skills for a working directory. Skills live in `<cwd>/.agents/skills/<name>/` (read by DSH and Codex when a
 * session starts) and are exposed to Claude Code through `<cwd>/.claude/skills`. Nothing here talks to a network
 * catalogue or pins revisions: the directory is used as it is, and acceptance checks are what guard drift.
 * `syncRoleSkills` copies skills, assets included, from a distribution directory when a role is set up.
 */
import { cp, lstat, mkdir, readFile, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const requirement = z.object({ key: identifier, name: z.string().min(1) }).strict();
export const roleSkillProfileSchema = z.object({ id: identifier, version: z.string().min(1), instructionsPath: z.string().min(1).optional(),
  skills: z.array(requirement).min(1).max(100), entrySkill: identifier.optional() }).strict().superRefine((value, ctx) => {
  if (new Set(value.skills.map(skill => skill.key)).size !== value.skills.length) ctx.addIssue({ code: 'custom', message: 'Duplicate skill key' });
  if (value.entrySkill && !value.skills.some(skill => skill.key === value.entrySkill)) ctx.addIssue({ code: 'custom', message: 'Unknown entrySkill' });
});
export type RoleSkillProfile = z.infer<typeof roleSkillProfileSchema>;

export const SKILLS_DIRECTORY = '.agents/skills';
export const CLAUDE_SKILLS_DIRECTORY = '.claude/skills';

export interface RoleSkillsLoad {
  roleId: string; roleVersion: string; roleDirectory: string;
  instructions: string; entryGuidePath?: string;
  skills: { key: string; name: string; directory: string; guidePath: string }[];
}

async function lstatOrUndefined(path: string) {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
/** A skill name becomes a directory name under `.agents/skills`, so it must not be able to leave it. */
async function readProfile(profilePath: string): Promise<RoleSkillProfile> {
  const profile = roleSkillProfileSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')));
  for (const skill of profile.skills) if (!identifier.safeParse(skill.name).success) throw new Error(`Unsafe skill name: ${skill.name.slice(0, 64)}`);
  return profile;
}
function frontMatterName(text: string): string | undefined {
  const block = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const line = block?.split(/\r?\n/).find(item => /^name\s*:/.test(item));
  return line?.replace(/^name\s*:\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** Make `.claude/skills` reach `.agents/skills`. An existing real `.claude/skills` directory only gains links for the named skills. */
export async function linkClaudeSkills(cwd: string, names: string[]): Promise<void> {
  const source = join(cwd, SKILLS_DIRECTORY), link = join(cwd, CLAUDE_SKILLS_DIRECTORY);
  await mkdir(dirname(link), { recursive: true });
  const info = await lstatOrUndefined(link);
  if (!info) { await symlink(relative(dirname(link), source), link, 'dir'); return; }
  if (info.isSymbolicLink()) {
    if (await realpath(link).catch(() => undefined) !== await realpath(source)) throw new Error(`${CLAUDE_SKILLS_DIRECTORY} is a link to somewhere other than ${SKILLS_DIRECTORY}`);
    return;
  }
  if (!info.isDirectory()) throw new Error(`${CLAUDE_SKILLS_DIRECTORY} is not a directory`);
  for (const name of names) {
    const entry = join(link, name);
    if (await lstatOrUndefined(entry)) continue;
    await symlink(relative(link, join(source, name)), entry, 'dir');
  }
}

/** Check that every skill the profile names is present under `<cwd>/.agents/skills`, link it for Claude Code and return what the prompt needs. */
export async function loadRoleSkills(options: { profilePath: string; cwd: string }): Promise<RoleSkillsLoad> {
  const profilePath = resolve(options.profilePath), cwd = resolve(options.cwd), profile = await readProfile(profilePath);
  const instructions = profile.instructionsPath ? await readFile(resolve(dirname(profilePath), profile.instructionsPath), 'utf8') : '';
  const skills: RoleSkillsLoad['skills'] = [];
  for (const wanted of profile.skills) {
    const directory = join(cwd, SKILLS_DIRECTORY, wanted.name), guidePath = join(directory, 'SKILL.md');
    const info = await stat(guidePath).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`Required skill unavailable in ${cwd}: ${wanted.name}`);
    const declared = frontMatterName(await readFile(guidePath, 'utf8'));
    if (declared !== undefined && declared !== wanted.name) throw new Error(`Skill directory ${wanted.name} declares name ${declared}`);
    skills.push({ key: wanted.key, name: wanted.name, directory, guidePath });
  }
  await linkClaudeSkills(cwd, skills.map(skill => skill.name));
  const entry = profile.entrySkill ? skills.find(skill => skill.key === profile.entrySkill) : undefined;
  return { roleId: profile.id, roleVersion: profile.version, roleDirectory: dirname(profilePath), instructions,
    ...(entry ? { entryGuidePath: entry.guidePath } : {}), skills };
}

/** Copy the profile's skills from a distribution directory into `<cwd>/.agents/skills`, then verify and link them. No network, no model. */
export async function syncRoleSkills(options: { profilePath: string; source: string; cwd: string }): Promise<RoleSkillsLoad> {
  const profile = await readProfile(resolve(options.profilePath)), cwd = resolve(options.cwd), source = resolve(options.source);
  const target = join(cwd, SKILLS_DIRECTORY);
  await mkdir(target, { recursive: true });
  for (const wanted of profile.skills) {
    const from = join(source, wanted.name);
    if (!(await stat(join(from, 'SKILL.md')).catch(() => undefined))?.isFile()) throw new Error(`Skill not found in source: ${wanted.name}`);
    const destination = join(target, wanted.name);
    // Skip a skill that is already this very directory (for instance when source and target are the same place).
    if (await realpath(destination).catch(() => undefined) === await realpath(from)) continue;
    const staging = join(target, `.sync-${randomUUID()}`);
    try {
      await cp(from, staging, { recursive: true, dereference: true });
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  return loadRoleSkills({ profilePath: options.profilePath, cwd });
}
