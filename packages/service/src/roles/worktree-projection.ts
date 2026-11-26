/**
 * One-way projection of a git-tracked role package onto a git worktree.
 *
 * DSH 0.2.2-rc.5 (`dsh-skill-filesystem`) discovers skills only at `<projectRoot>/.agents/skills`, where
 * `projectRoot` is the nearest ancestor containing `.git` (a file or a directory). A bare directory is refused:
 * otherwise `findProjectRoot` walks upward and the projection lands off the project root. Invocation keys must be
 * the kebab-case pair `disable-model-invocation` / `user-invocable`. The legacy camelCase keys are rejected by DSH
 * and the whole skill is dropped with a warning. The optional routing field DSH actually parses is `whenToUse`;
 * `description` is what the per-step catalog shows.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { roleSkillProfileSchema, syncRoleSkills, type RoleSkillProfile } from './skills.js';

/** First line of a projected `AGENTS.local.md`. DSH loads this overlay; it must never be hand-edited. */
export const AGENTS_LOCAL_GENERATED_HEADER = '<!-- AUTO-GENERATED FROM .1agents/roles/pr-delivery — DO NOT EDIT -->';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LEGACY_INVOCATION_KEYS: Record<string, string> = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
};

export interface WorktreeProjectionSkill {
  key: string;
  name: string;
  directory: string;
  guidePath: string;
}

export interface WorktreeProjection {
  roleId: string;
  roleVersion: string;
  worktreeDir: string;
  skills: WorktreeProjectionSkill[];
  instructionsFile?: string;
  digest: string;
}

export class SkillFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFrontmatterError';
  }
}

/** Strict skill frontmatter check. Throws when DSH would ignore the file or bind it to the wrong name. */
export function validateSkillFrontmatter(text: string, expectedName: string): { name: string; description: string } {
  if (!SKILL_NAME.test(expectedName)) {
    throw new SkillFrontmatterError(`Expected skill name "${expectedName}" is not kebab-case`);
  }
  const data = parseFrontmatter(text);
  for (const key of Object.keys(data)) {
    const canonical = LEGACY_INVOCATION_KEYS[key];
    if (canonical) throw new SkillFrontmatterError(`Skill frontmatter rejects legacy key "${key}"; use "${canonical}"`);
  }
  const name = data.name;
  if (!name) throw new SkillFrontmatterError('Skill frontmatter requires kebab-case name');
  if (name.kind !== 'string') throw new SkillFrontmatterError('Skill frontmatter name must be a string');
  if (!SKILL_NAME.test(name.value)) throw new SkillFrontmatterError(`Skill frontmatter name "${name.value}" is not kebab-case`);
  if (name.value !== expectedName) throw new SkillFrontmatterError(`Skill frontmatter name "${name.value}" does not match ${expectedName}`);
  const description = data.description;
  if (!description) throw new SkillFrontmatterError('Skill frontmatter requires a non-empty description');
  if (description.kind !== 'string') throw new SkillFrontmatterError('Skill frontmatter description must be a string');
  if (description.value.trim() === '') throw new SkillFrontmatterError('Skill frontmatter requires a non-empty description');
  return { name: name.value, description: description.value };
}

/**
 * Copy the role's declared skills into `<worktreeDir>/.agents/skills`, link `.claude/skills`, and write
 * `AGENTS.local.md` from the role template. Validates the whole batch before any skill is copied.
 * Does not modify `AGENTS.md`.
 */
export async function projectRoleToWorktree(options: {
  roleDir: string;
  worktreeDir: string;
  skillsSourceDir?: string;
  renderVars?: Record<string, string>;
}): Promise<WorktreeProjection> {
  const roleDir = resolve(options.roleDir);
  const worktreeReal = await realpath(options.worktreeDir);
  await assertGitAnchor(worktreeReal);
  const profilePath = join(roleDir, 'profile.json');
  const profile = roleSkillProfileSchema.parse(JSON.parse(await readFile(profilePath, 'utf8'))) as RoleSkillProfile;
  const source = resolve(options.skillsSourceDir ?? join(roleDir, 'skills'));
  // PR#11 M1: validate the whole batch before any copy, so one bad skill cannot leave an earlier one behind.
  for (const wanted of profile.skills) {
    const guide = join(source, wanted.name, 'SKILL.md');
    const text = await readFile(guide, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Skill not found in source: ${wanted.name}`);
      }
      throw error;
    });
    validateSkillFrontmatter(text, wanted.name);
  }
  const templatePath = join(roleDir, 'AGENTS.local.template.md');
  const template = await readFile(templatePath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  const instructions = template === undefined ? undefined : renderTemplate(template, options.renderVars);
  if (instructions !== undefined) assertGeneratedHeader(instructions);
  await assertContained(worktreeReal, join(worktreeReal, '.agents'));
  await assertContained(worktreeReal, join(worktreeReal, '.agents', 'skills'));
  await assertContained(worktreeReal, join(worktreeReal, '.claude'));
  for (const wanted of profile.skills) {
    await assertContained(worktreeReal, join(worktreeReal, '.agents', 'skills', wanted.name));
  }
  await assertClaudeSkillsLink(worktreeReal);
  if (instructions !== undefined) await assertAgentsLocalWritable(worktreeReal);

  const loaded = await syncRoleSkills({ profilePath, source, cwd: worktreeReal });
  const projectedTexts: { name: string; text: string }[] = [];
  for (const skill of loaded.skills) {
    const text = await readFile(skill.guidePath, 'utf8');
    validateSkillFrontmatter(text, skill.name);
    projectedTexts.push({ name: skill.name, text });
  }
  let instructionsFile: string | undefined;
  if (instructions !== undefined) {
    instructionsFile = join(worktreeReal, 'AGENTS.local.md');
    await writeAtomic(instructionsFile, instructions, worktreeReal);
    const landed = await readFile(instructionsFile, 'utf8');
    assertGeneratedHeader(landed);
    if (landed !== instructions) throw new Error(`Projected AGENTS.local.md at ${instructionsFile} does not match the rendered template`);
  }
  return {
    roleId: loaded.roleId,
    roleVersion: loaded.roleVersion,
    worktreeDir: worktreeReal,
    skills: loaded.skills.map(skill => ({ key: skill.key, name: skill.name, directory: skill.directory, guidePath: skill.guidePath })),
    ...(instructionsFile ? { instructionsFile } : {}),
    digest: projectionDigest(profile, projectedTexts, instructions),
  };
}

async function assertGitAnchor(worktreeDir: string): Promise<void> {
  const gitPath = join(worktreeDir, '.git');
  let info;
  try {
    info = await lstat(gitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Refusing to project into ${worktreeDir}: missing .git anchor (bare directory would let DSH findProjectRoot walk upward)`);
    }
    throw error;
  }
  const kind = info.isSymbolicLink() ? await stat(gitPath).catch(() => undefined) : info;
  if (!kind || (!kind.isFile() && !kind.isDirectory())) {
    throw new Error(`Refusing to project into ${worktreeDir}: .git is not a file or directory`);
  }
}

/** A path stays inside the worktree only when every existing segment is a real directory and realpath(relative) does not escape. */
async function assertContained(worktreeReal: string, target: string): Promise<void> {
  const rel = relative(worktreeReal, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to project outside the worktree: ${target}`);
  }
  let current = worktreeReal;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Refusing to project through symlink ${current}`);
    const real = await realpath(current);
    const fromRoot = relative(worktreeReal, real);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Refusing to project outside the worktree: ${current}`);
    }
    if (current !== target && !info.isDirectory()) throw new Error(`Refusing to project through non-directory ${current}`);
  }
}

async function assertClaudeSkillsLink(worktreeReal: string): Promise<void> {
  const link = join(worktreeReal, '.claude', 'skills');
  const expected = join(worktreeReal, '.agents', 'skills');
  let info;
  try {
    info = await lstat(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    const raw = await readlink(link);
    if (resolve(dirname(link), raw) !== expected) {
      throw new Error(`Refusing to project: .claude/skills points at ${raw}, not .agents/skills`);
    }
    return;
  }
  if (info.isDirectory()) {
    throw new Error('Refusing to project: .claude/skills is a real directory, not a symlink to .agents/skills');
  }
  throw new Error('Refusing to project: .claude/skills exists and is not a symlink to .agents/skills');
}

async function assertAgentsLocalWritable(worktreeReal: string): Promise<void> {
  const file = join(worktreeReal, 'AGENTS.local.md');
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error('Refusing to overwrite symlinked AGENTS.local.md');
  if (!info.isFile()) throw new Error('Refusing to overwrite non-file AGENTS.local.md');
  const text = await readFile(file, 'utf8');
  if (text.split(/\r?\n/, 1)[0] !== AGENTS_LOCAL_GENERATED_HEADER) {
    throw new Error('Refusing to overwrite handwritten AGENTS.local.md');
  }
}

function assertGeneratedHeader(text: string): void {
  const first = text.split(/\r?\n/, 1)[0];
  if (first !== AGENTS_LOCAL_GENERATED_HEADER) {
    throw new Error('AGENTS.local template must start with the auto-generated header');
  }
}

function renderTemplate(template: string, vars: Record<string, string> | undefined): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, key: string) => {
    const value = vars[key];
    return value === undefined ? whole : value;
  });
}

/** Identical content is left in place. The temp file stays under `.agents/skills/`, which `/.agents/skills/*` already ignores. */
async function writeAtomic(destination: string, content: string, worktreeDir: string): Promise<void> {
  const current = await readFile(destination, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (current === content) return;
  const staging = join(worktreeDir, '.agents', 'skills');
  await mkdir(staging, { recursive: true });
  const temp = join(staging, `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, 'utf8');
    await rename(temp, destination);
  } finally {
    await rm(temp, { force: true });
  }
}

function projectionDigest(profile: RoleSkillProfile, skills: { name: string; text: string }[], instructions: string | undefined): string {
  const body = JSON.stringify({
    roleId: profile.id,
    roleVersion: profile.version,
    skills: skills.map(skill => ({ name: skill.name, sha256: sha256(skill.text) })),
    instructionsSha256: instructions === undefined ? null : sha256(instructions),
  });
  return sha256(body);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

type FrontmatterValue = { kind: 'string'; value: string } | { kind: 'other' };

function parseFrontmatter(text: string): Record<string, FrontmatterValue> {
  if (text.charCodeAt(0) === 0xfeff) throw new SkillFrontmatterError('Skill frontmatter rejects a UTF-8 BOM');
  const fence = /^(---)\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!fence) throw new SkillFrontmatterError('Skill frontmatter requires an opening --- fence');
  const data: Record<string, FrontmatterValue> = {};
  for (const rawLine of fence[2].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*(.*)$/.exec(line);
    if (!match) throw new SkillFrontmatterError(`Skill frontmatter has an unreadable line: ${line.slice(0, 80)}`);
    const key = match[1] ?? match[2] ?? match[3];
    if (!key) throw new SkillFrontmatterError('Skill frontmatter has an empty key');
    if (Object.hasOwn(data, key)) throw new SkillFrontmatterError(`Skill frontmatter has duplicate key "${key}"`);
    data[key] = parseScalar(match[4] ?? '');
  }
  return data;
}

/** Quoted YAML is a string. Bare numbers, booleans and null are not; DSH would reject those descriptions. */
function parseScalar(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return { kind: 'string', value: trimmed.slice(1, -1).trim() };
  }
  const comment = trimmed.indexOf(' #');
  const bare = (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
  if (/^(?:true|false|null|~|yes|no|on|off)$/i.test(bare)) return { kind: 'other' };
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(bare)) return { kind: 'other' };
  return { kind: 'string', value: bare };
}
