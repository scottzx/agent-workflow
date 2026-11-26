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
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
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
  if (name === undefined) throw new SkillFrontmatterError('Skill frontmatter requires kebab-case name');
  if (!SKILL_NAME.test(name)) throw new SkillFrontmatterError(`Skill frontmatter name "${name}" is not kebab-case`);
  if (name !== expectedName) throw new SkillFrontmatterError(`Skill frontmatter name "${name}" does not match ${expectedName}`);
  const description = data.description;
  if (description === undefined || description.trim() === '') {
    throw new SkillFrontmatterError('Skill frontmatter requires a non-empty description');
  }
  return { name, description };
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
  const worktreeDir = resolve(options.worktreeDir);
  await assertGitAnchor(worktreeDir);
  const profilePath = join(roleDir, 'profile.json');
  const profile = roleSkillProfileSchema.parse(JSON.parse(await readFile(profilePath, 'utf8'))) as RoleSkillProfile;
  const source = resolve(options.skillsSourceDir ?? join(roleDir, 'skills'));
  // PR#11 M1: validate every skill, then copy. One bad frontmatter must not leave an earlier skill behind.
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

  const loaded = await syncRoleSkills({ profilePath, source, cwd: worktreeDir });
  const projectedTexts: { name: string; text: string }[] = [];
  for (const skill of loaded.skills) {
    const text = await readFile(skill.guidePath, 'utf8');
    validateSkillFrontmatter(text, skill.name);
    projectedTexts.push({ name: skill.name, text });
  }
  let instructionsFile: string | undefined;
  if (instructions !== undefined) {
    instructionsFile = join(worktreeDir, 'AGENTS.local.md');
    await writeAtomic(instructionsFile, instructions, worktreeDir);
    const landed = await readFile(instructionsFile, 'utf8');
    assertGeneratedHeader(landed);
    if (landed !== instructions) throw new Error(`Projected AGENTS.local.md at ${instructionsFile} does not match the rendered template`);
  }
  return {
    roleId: loaded.roleId,
    roleVersion: loaded.roleVersion,
    worktreeDir,
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

/** Identical content is left in place. The temp file stays under `.agents/`, which the worktree gitignore already covers. */
async function writeAtomic(destination: string, content: string, worktreeDir: string): Promise<void> {
  const current = await readFile(destination, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (current === content) return;
  const staging = join(worktreeDir, '.agents');
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

function parseFrontmatter(text: string): Record<string, string> {
  const normalized = text.replace(/^\uFEFF/, '');
  const fence = /^(---)\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!fence) throw new SkillFrontmatterError('Skill frontmatter requires an opening --- fence');
  const data: Record<string, string> = {};
  for (const rawLine of fence[2].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*(.*)$/.exec(line);
    if (!match) throw new SkillFrontmatterError(`Skill frontmatter has an unreadable line: ${line.slice(0, 80)}`);
    const key = match[1] ?? match[2] ?? match[3];
    if (!key) throw new SkillFrontmatterError('Skill frontmatter has an empty key');
    if (Object.hasOwn(data, key)) throw new SkillFrontmatterError(`Skill frontmatter has duplicate key "${key}"`);
    data[key] = unquote(match[4] ?? '');
  }
  return data;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1).trim();
  }
  const comment = trimmed.indexOf(' #');
  return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
}
