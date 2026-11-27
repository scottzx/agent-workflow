/**
 * Read-only, uncached view of `<projectRoot>/.1agents/roles/<roleId>/`.
 * ACP sessions do not receive DSH's native skill catalog, so they call this on each turn.
 * Every call stats and reads the disk again; `digest` covers exactly the files included in that response.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { loadChecklist, type NormalizedChecklist } from '../rsi/checklist.js';
import { loadWorkflow, type Workflow } from '../rsi/engine.js';
import { roleSkillProfileSchema, type RoleSkillProfile } from './skills.js';

const ROLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const ROLE_FILES = ['profile.json', 'workflow.json', 'checklist.json', 'routing.json', 'ROLE.md', 'QA.md', 'AGENTS.local.template.md'] as const;
type RoleFileName = typeof ROLE_FILES[number];

export const roleRulesPhaseSchema = z.enum(['all', 'implement', 'review', 'gate', 'coach']);
export type RoleRulesPhase = z.infer<typeof roleRulesPhaseSchema>;

const routingEndpointSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  deliveryMode: z.string().min(1),
  readOnly: z.boolean().optional(),
}).strict();

export const roleRoutingSchema = z.object({
  schemaVersion: z.literal(1),
  worker: routingEndpointSchema,
  reviewer: routingEndpointSchema,
}).strict();
export type RoleRouting = z.infer<typeof roleRoutingSchema>;

export const readRoleRulesOptionsSchema = z.object({
  projectRoot: z.string().min(1),
  roleId: z.string().min(1),
  phase: roleRulesPhaseSchema.optional(),
}).strict();

export interface RoleRules {
  roleId: string;
  roleVersion: string;
  roleDir: string;
  phase: RoleRulesPhase;
  digest: string;
  files: string[];
  profile: RoleSkillProfile;
  workflow?: Workflow;
  checklist?: NormalizedChecklist;
  routing?: RoleRouting;
  roleInstructions?: string;
  qaInstructions?: string;
  agentsLocalTemplate?: string;
}

const PHASE_FILES: Record<RoleRulesPhase, readonly RoleFileName[]> = {
  implement: ['profile.json', 'workflow.json', 'checklist.json', 'ROLE.md', 'AGENTS.local.template.md'],
  review: ['profile.json', 'checklist.json', 'routing.json', 'QA.md'],
  gate: ['profile.json', 'workflow.json', 'checklist.json', 'routing.json'],
  coach: ROLE_FILES,
  all: ROLE_FILES,
};

interface RoleFile {
  text: string;
  bytes: Buffer;
}

/** Reject path separators and `..` before any filesystem lookup. */
export function assertSafeRoleId(roleId: string): void {
  if (!ROLE_ID.test(roleId) || roleId.includes('..') || roleId.includes('/') || roleId.includes('\\') || roleId.includes('\0')) {
    throw new Error(`Unsafe roleId: ${roleId.slice(0, 64)}`);
  }
}

function escapes(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function sameOrInside(root: string, candidate: string): boolean {
  return root === candidate || !escapes(root, candidate);
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function directoryOf(realPath: string): Promise<string> {
  const info = await stat(realPath);
  return info.isDirectory() ? realPath : dirname(realPath);
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

type GitAnchor =
  | { kind: 'symlink' }
  | { kind: 'dir' | 'file'; root: string; gitPath: string };

/** First `.git` at or above `startReal`. A symlink is not a repository anchor and stops the walk. */
async function findGitAnchor(startReal: string): Promise<GitAnchor | undefined> {
  let current = await directoryOf(startReal);
  for (;;) {
    const gitPath = join(current, '.git');
    const info = await lstatOrUndefined(gitPath);
    if (info) {
      if (info.isSymbolicLink()) return { kind: 'symlink' };
      if (info.isDirectory()) return { kind: 'dir', root: current, gitPath };
      if (info.isFile()) return { kind: 'file', root: current, gitPath };
      return { kind: 'symlink' };
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Walk `rootReal/parts` without following a symlink. */
async function containedRealDir(rootReal: string, parts: string[]): Promise<string | undefined> {
  let current = rootReal;
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return undefined;
    current = join(current, part);
    const info = await lstatOrUndefined(current);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return undefined;
    const real = await realpath(current).catch(() => undefined);
    if (!real || !sameOrInside(rootReal, real)) return undefined;
    current = real;
  }
  return current;
}

/**
 * A worktree counts only when `<commonGitDir>/worktrees/<entry>/gitdir` points back at this `.git` file.
 * A handwritten `gitdir:` line, including one aimed at a real worktree admin directory, fails that check.
 */
async function verifiedWorktree(candRoot: string, gitFile: string): Promise<{ commonGitDir: string } | undefined> {
  const info = await lstatOrUndefined(gitFile);
  if (!info || info.isSymbolicLink() || !info.isFile()) return undefined;
  const match = /^gitdir:\s*(.*\S)\s*$/m.exec(await readFile(gitFile, 'utf8'));
  if (!match?.[1]) return undefined;
  const declared = await realpath(resolve(dirname(gitFile), match[1].trim())).catch(() => undefined);
  if (!declared) return undefined;
  const entry = basename(declared);
  if (basename(dirname(declared)) !== 'worktrees') return undefined;
  const commonGitDir = dirname(dirname(declared));
  const located = await containedRealDir(commonGitDir, ['worktrees', entry]);
  if (!located || located !== declared) return undefined;
  const backInfo = await lstatOrUndefined(join(located, 'gitdir'));
  if (!backInfo || backInfo.isSymbolicLink() || !backInfo.isFile()) return undefined;
  const back = (await readFile(join(located, 'gitdir'), 'utf8')).split(/\r?\n/, 1)[0]?.trim();
  if (!back) return undefined;
  const backReal = await realpath(resolve(located, back)).catch(() => undefined);
  const gitFileReal = await realpath(gitFile);
  const rootReal = await realpath(candRoot);
  if (!backReal || backReal !== gitFileReal || dirname(gitFileReal) !== rootReal) return undefined;
  return { commonGitDir: await realpath(commonGitDir) };
}

/** Real common git directory of `startReal`, after the same back-pointer check used for candidates. */
async function trustedCommonGitDir(startReal: string): Promise<string | undefined> {
  const anchor = await findGitAnchor(startReal);
  if (!anchor || anchor.kind === 'symlink') return undefined;
  if (anchor.kind === 'dir') {
    const gitReal = await realpath(anchor.gitPath);
    const rootReal = await realpath(anchor.root);
    return rootReal === dirname(gitReal) ? gitReal : undefined;
  }
  return (await verifiedWorktree(anchor.root, anchor.gitPath))?.commonGitDir;
}

/**
 * `explicit` must be the allowed root, a path inside it, or a registered worktree of that same repository.
 * A `.git` symlink or a handwritten `gitdir:` file is not evidence. Returns the real path of `explicit`.
 */
export async function assertAllowedRoleProjectPath(explicit: string, allowedRoot: string): Promise<string> {
  const explicitReal = await realpath(explicit).catch(error => {
    if (isMissingPath(error)) throw new Error(`projectRoot does not exist: ${explicit}`);
    throw error;
  });
  const allowedReal = await realpath(allowedRoot);
  if (sameOrInside(allowedReal, explicitReal)) return explicitReal;
  const allowedCommon = await trustedCommonGitDir(allowedReal);
  const anchor = await findGitAnchor(explicitReal);
  const outside = new Error(`projectRoot is outside the allowed project: ${explicit}`);
  if (!allowedCommon || !anchor || anchor.kind === 'symlink') throw outside;
  if (anchor.kind === 'dir') {
    const gitReal = await realpath(anchor.gitPath);
    const rootReal = await realpath(anchor.root);
    if (gitReal === allowedCommon && rootReal === dirname(allowedCommon)) return explicitReal;
    throw outside;
  }
  const worktree = await verifiedWorktree(anchor.root, anchor.gitPath);
  if (worktree?.commonGitDir === allowedCommon) return explicitReal;
  throw outside;
}

/**
 * Nearest directory at or above `cwd` that contains `.1agents/roles`.
 * Stops at the first `.git` file or directory when that directory has no role root,
 * so a nested repo cannot climb into an unrelated ancestor. Worktree `.git` files count.
 */
export async function resolveProjectRootFromCwd(cwd: string): Promise<string | undefined> {
  if (!cwd.trim()) return undefined;
  let current: string;
  try {
    current = await realpath(cwd);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
  current = await directoryOf(current);
  for (;;) {
    if (await isDirectory(join(current, '.1agents', 'roles'))) return current;
    if (await exists(join(current, '.git'))) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

async function resolveRolesRoot(projectRootReal: string): Promise<string> {
  let current = projectRootReal;
  for (const part of ['.1agents', 'roles']) {
    const next = join(current, part);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (isMissingPath(error)) throw new Error(`No .1agents/roles directory under ${projectRootReal}`);
      throw error;
    }
    if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error(`${next} is not a directory`);
    const real = await realpath(next).catch(error => {
      throw new Error(`Refusing to read ${next}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!sameOrInside(projectRootReal, real)) throw new Error(`Refusing to follow ${next}: symlink escapes the project root`);
    const followed = await stat(real);
    if (!followed.isDirectory()) throw new Error(`${next} is not a directory`);
    current = real;
  }
  return current;
}

async function resolveRoleDir(rolesRootReal: string, roleId: string): Promise<string> {
  const rolePath = join(rolesRootReal, roleId);
  let info;
  try {
    info = await lstat(rolePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Role "${roleId}" was not found under .1agents/roles`);
    throw error;
  }
  if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error(`Role "${roleId}" is not a directory`);
  const roleReal = await realpath(rolePath).catch(error => {
    throw new Error(`Refusing to read role "${roleId}": ${error instanceof Error ? error.message : String(error)}`);
  });
  if (dirname(roleReal) !== rolesRootReal || !sameOrInside(rolesRootReal, roleReal)) {
    throw new Error(`Refusing to read role "${roleId}": symlink escapes .1agents/roles`);
  }
  const followed = await stat(roleReal);
  if (!followed.isDirectory()) throw new Error(`Role "${roleId}" is not a directory`);
  return roleReal;
}

async function readRoleFile(rolesRootReal: string, roleReal: string, name: RoleFileName): Promise<RoleFile | undefined> {
  if (basename(name) !== name) throw new Error(`Unsafe role file name: ${name}`);
  const target = join(roleReal, name);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`${name} is not a file`);
  const real = await realpath(target).catch(error => {
    throw new Error(`Refusing to read ${name}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!sameOrInside(roleReal, real) || !sameOrInside(rolesRootReal, real)) {
    throw new Error(`Refusing to read ${name}: symlink escapes .1agents/roles`);
  }
  const followed = await stat(real);
  if (!followed.isFile()) throw new Error(`${name} is not a file`);
  const bytes = await readFile(real);
  return { bytes, text: bytes.toString('utf8') };
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function digestOf(files: { path: string; bytes: Buffer }[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Read and validate one role package. No memoization: a later edit is visible on the next call. */
export async function readRoleRules(options: { projectRoot: string; roleId: string; phase?: RoleRulesPhase }): Promise<RoleRules> {
  const parsed = readRoleRulesOptionsSchema.parse(options);
  const phase = parsed.phase ?? 'all';
  assertSafeRoleId(parsed.roleId);
  const projectRootReal = await realpath(parsed.projectRoot).catch(error => {
    if (isMissingPath(error)) throw new Error(`projectRoot does not exist: ${parsed.projectRoot}`);
    throw error;
  });
  const rolesRootReal = await resolveRolesRoot(projectRootReal);
  const roleReal = await resolveRoleDir(rolesRootReal, parsed.roleId);
  const wanted = new Set<RoleFileName>(PHASE_FILES[phase]);
  const present = new Map<RoleFileName, RoleFile>();
  for (const name of ROLE_FILES) {
    if (!wanted.has(name)) continue;
    const file = await readRoleFile(rolesRootReal, roleReal, name);
    if (file) present.set(name, file);
  }
  const profileFile = present.get('profile.json');
  if (!profileFile) throw new Error(`Role "${parsed.roleId}" is missing profile.json`);
  const profile = roleSkillProfileSchema.parse(parseJson(profileFile.text, 'profile.json'));
  if (profile.id !== parsed.roleId) throw new Error(`profile.json id "${profile.id}" does not match role directory "${parsed.roleId}"`);

  const workflow = wanted.has('workflow.json') && present.has('workflow.json') ? await loadWorkflow(roleReal) : undefined;
  const checklist = wanted.has('checklist.json') && present.has('checklist.json') ? await loadChecklist(roleReal) : undefined;
  const routing = wanted.has('routing.json') && present.has('routing.json')
    ? roleRoutingSchema.parse(parseJson(present.get('routing.json')!.text, 'routing.json'))
    : undefined;

  const included = [...present.entries()]
    .map(([path, file]) => ({ path, bytes: file.bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const roleInstructions = wanted.has('ROLE.md') ? present.get('ROLE.md')?.text : undefined;
  const qaInstructions = wanted.has('QA.md') ? present.get('QA.md')?.text : undefined;
  const agentsLocalTemplate = wanted.has('AGENTS.local.template.md') ? present.get('AGENTS.local.template.md')?.text : undefined;

  return {
    roleId: profile.id,
    roleVersion: profile.version,
    roleDir: roleReal,
    phase,
    digest: digestOf(included),
    files: included.map(file => file.path),
    profile,
    ...(workflow && wanted.has('workflow.json') ? { workflow } : {}),
    ...(checklist ? { checklist } : {}),
    ...(routing && wanted.has('routing.json') ? { routing } : {}),
    ...(roleInstructions !== undefined ? { roleInstructions } : {}),
    ...(qaInstructions !== undefined ? { qaInstructions } : {}),
    ...(agentsLocalTemplate !== undefined ? { agentsLocalTemplate } : {}),
  };
}
