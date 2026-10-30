/**
 * Role versions: a version is a frozen copy of the role directory with a sha256 list. A coach proposes one;
 * a proposal that changes a locked item is refused. Publishing is a person's act on the workbench page.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export interface SnapshotFile { path: string; bytes: number; sha256: string }
export interface VersionChanges { added: string[]; modified: string[]; removed: string[] }
export interface RoleVersion {
  roleId: string; version: string; number: number; parent?: string;
  status: 'proposed' | 'published' | 'superseded';
  preset?: { id: string; locked: true };
  snapshot: { directory: string; files: SnapshotFile[] };
  changes: VersionChanges; checklistChanged: boolean;
  proposal: { summary: string; proposedAt: string };
  evaluation?: VersionEvaluation;
  decision?: { by: string; displayName?: string; at: string; note?: string };
}
export interface VersionEvaluation {
  evaluatedAt: string;
  results: { caseId: string; kind: 'original' | 'variant'; jobId?: string; passed: boolean; rounds: number; outlineSha256?: string; failedItems: string[] }[];
}
export class VersionLockError extends Error {
  constructor(readonly violations: string[]) { super(`The proposal changes locked items: ${violations.join('; ')}`); }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Every regular file under the role directory, by relative path. Links and other entries are refused. */
export async function inventory(directory: string): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  async function visit(relative: string): Promise<void> {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      if (name === '.DS_Store') continue;
      const rel = relative ? `${relative}/${name}` : name, info = await lstat(path.join(directory, rel));
      if (info.isDirectory()) await visit(rel);
      else if (info.isFile()) files.push({ path: rel, bytes: info.size, sha256: sha256(await readFile(path.join(directory, rel))) });
      else throw new Error(`Role directory entries must be regular files: ${rel}`);
    }
  }
  await visit('');
  return files;
}

export function diffInventories(parent: SnapshotFile[], next: SnapshotFile[]): VersionChanges {
  const before = new Map(parent.map(file => [file.path, file.sha256])), after = new Map(next.map(file => [file.path, file.sha256]));
  return { added: [...after.keys()].filter(file => !before.has(file)), removed: [...before.keys()].filter(file => !after.has(file)),
    modified: [...after.keys()].filter(file => before.has(file) && before.get(file) !== after.get(file)) };
}

type Checklist = { outlineTemplate?: { locked?: boolean }; items?: { id: string; locked?: boolean }[]; program?: unknown };
const canonical = (value: unknown) => JSON.stringify(value);

/**
 * What a coach may not change: checks/ (the scripts behind locked program items), cases/ (curated by people),
 * the profile's id, and in checklist.json every locked item, a locked outline template and the program entry.
 */
export async function lockViolations(parentDirectory: string, nextDirectory: string, changes: VersionChanges): Promise<string[]> {
  const touched = [...changes.added, ...changes.modified, ...changes.removed], violations: string[] = [];
  for (const file of touched) {
    if (file.startsWith('checks/')) violations.push(`${file}: program checks are locked`);
    if (file.startsWith('cases/')) violations.push(`${file}: cases are kept by people`);
  }
  const json = async (directory: string, file: string) => JSON.parse(await readFile(path.join(directory, file), 'utf8')) as Record<string, unknown>;
  if (changes.modified.includes('profile.json') && (await json(parentDirectory, 'profile.json')).id !== (await json(nextDirectory, 'profile.json')).id) {
    violations.push('profile.json: the role id cannot change');
  }
  if (changes.removed.includes('checklist.json')) violations.push('checklist.json: the checklist cannot be removed');
  else if (changes.modified.includes('checklist.json')) {
    const before = await json(parentDirectory, 'checklist.json') as Checklist, after = await json(nextDirectory, 'checklist.json') as Checklist;
    if (before.outlineTemplate?.locked && canonical(before.outlineTemplate) !== canonical(after.outlineTemplate)) violations.push('checklist.json: the outline template is locked');
    if (canonical(before.program) !== canonical(after.program)) violations.push('checklist.json: the program entry is locked');
    for (const item of before.items ?? []) {
      if (!item.locked) continue;
      const kept = (after.items ?? []).find(candidate => candidate.id === item.id);
      if (!kept || canonical(kept) !== canonical(item)) violations.push(`checklist.json: ${item.id} is locked`);
    }
  }
  return violations;
}

/** Copy the role directory into its version folder and make the copy read-only. */
export async function freeze(source: string, destination: string): Promise<SnapshotFile[]> {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false, filter: file => path.basename(file) !== '.DS_Store' });
  const files = await inventory(destination);
  for (const file of files) await chmod(path.join(destination, file.path), 0o444);
  return files;
}

const id = z.string().trim().min(1).max(200);
const proposeSchema = z.object({ roleId: id, summary: z.string().trim().min(1).max(4000) }).strict();
const listSchema = z.object({ roleId: id }).strict();
const evaluationSchema = z.object({ roleId: id, version: id, evaluation: z.object({ evaluatedAt: z.string().datetime(),
  results: z.array(z.object({ caseId: id, kind: z.enum(['original', 'variant']), jobId: id.optional(), passed: z.boolean(), rounds: z.number().int().min(0),
    outlineSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), failedItems: z.array(id) }).strict()).min(1) }).strict() }).strict();
/** Coach-facing methods. Publishing is absent on purpose: only the workbench page publishes. */
export const RSI_METHODS = {
  rsi_version_propose: { description: '把角色目录当前内容冻结成候选版本，并和已上线版本比对；改到锁定项（checks/、cases/、锁定检查项、大纲模板）直接拒绝。不会上线。', parameters: z.toJSONSchema(proposeSchema) },
  rsi_version_list: { description: '列出角色的全部版本：状态、父版本、改动文件、复验结果和上线记录。', parameters: z.toJSONSchema(listSchema) },
  rsi_version_evaluation: { description: '把复验结果（原题和变体题）记到候选版本上，供上线门展示；不会上线。', parameters: z.toJSONSchema(evaluationSchema) },
};
export interface RsiRoleConfig { directory: string; preset?: string }
interface RegistryState { version: 1; roles: Record<string, RoleVersion[]> }

/** The gateway's record of role versions. A proposal replaces an earlier one still waiting; publishing supersedes the live version. */
export class RoleVersionRegistry {
  private state: RegistryState;
  constructor(private readonly file: string, private readonly snapshotRoot: string, private readonly roles: Record<string, RsiRoleConfig>) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as RegistryState : { version: 1, roles: {} };
  }
  private save(): void {
    const temp = `${this.file}.${randomUUID()}.tmp`, fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.file);
  }
  private role(roleId: string): RsiRoleConfig {
    if (!Object.hasOwn(this.roles, roleId)) throw new Error(`Role ${roleId} is not configured for versions`);
    return this.roles[roleId]!;
  }
  roleIds(): string[] { return Object.keys(this.roles); }
  list(roleId: string): RoleVersion[] { this.role(roleId); return structuredClone(this.state.roles[roleId] ?? []); }
  get(roleId: string, version: string): RoleVersion {
    const found = (this.state.roles[roleId] ?? []).find(item => item.version === version);
    if (!found) throw new Error(`Version ${version} of ${roleId} does not exist`);
    return structuredClone(found);
  }
  published(roleId: string): RoleVersion | undefined { return structuredClone((this.state.roles[roleId] ?? []).findLast(item => item.status === 'published')); }

  async propose(roleId: string, summary: string, at = new Date().toISOString()): Promise<RoleVersion> {
    const role = this.role(roleId), versions = this.state.roles[roleId] ??= [], parent = this.published(roleId);
    const number = (versions.at(-1)?.number ?? 0) + 1, version = `v${number}`, directory = path.join(this.snapshotRoot, roleId, version);
    // Checks run on the frozen copy, so a change made while copying cannot slip past them.
    const files = await freeze(role.directory, directory);
    try {
      const changes = diffInventories(parent?.snapshot.files ?? [], files);
      if (parent && !changes.added.length && !changes.modified.length && !changes.removed.length) throw new Error('Nothing changed since the published version');
      const violations = parent ? await lockViolations(parent.snapshot.directory, directory, changes) : [];
      if (violations.length) throw new VersionLockError(violations);
      for (const item of versions) if (item.status === 'proposed') item.status = 'superseded';
      const record: RoleVersion = { roleId, version, number, ...(parent ? { parent: parent.version } : {}), status: 'proposed',
        ...(role.preset ? { preset: { id: role.preset, locked: true } } : {}), snapshot: { directory, files }, changes,
        checklistChanged: [...changes.added, ...changes.modified, ...changes.removed].includes('checklist.json'), proposal: { summary, proposedAt: at } };
      versions.push(record); this.save();
      return structuredClone(record);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  evaluate(roleId: string, version: string, evaluation: VersionEvaluation): RoleVersion {
    const record = (this.state.roles[roleId] ?? []).find(item => item.version === version);
    if (!record || record.status !== 'proposed') throw new Error(`Only a proposed version takes evaluation results; ${version} is ${record?.status ?? 'missing'}`);
    record.evaluation = structuredClone(evaluation); this.save();
    return structuredClone(record);
  }
  /** A person's release decision on the page. A version without evaluation results cannot go live. */
  publish(roleId: string, version: string, actor: { id: string; displayName?: string }, note?: string, at = new Date().toISOString()): RoleVersion {
    const versions = this.state.roles[roleId] ?? [], record = versions.find(item => item.version === version);
    if (!record || record.status !== 'proposed') throw new Error(`Only a proposed version can be published; ${version} is ${record?.status ?? 'missing'}`);
    if (!record.evaluation) throw new Error(`${version} has no evaluation results yet`);
    for (const item of versions) if (item.status === 'published') item.status = 'superseded';
    record.status = 'published';
    record.decision = { by: actor.id, ...(actor.displayName ? { displayName: actor.displayName } : {}), at, ...(note ? { note } : {}) };
    this.save();
    return structuredClone(record);
  }
  /** Line diff of a version against its parent, as `git diff --no-index` prints it for the two frozen copies. */
  async diff(roleId: string, version: string): Promise<string> {
    const record = this.get(roleId, version);
    if (!record.parent) return '';
    const parent = this.get(roleId, record.parent), cwd = path.dirname(record.snapshot.directory);
    return new Promise((resolve, reject) => execFile('git', ['diff', '--no-index', '--no-color', '--', path.basename(parent.snapshot.directory), path.basename(record.snapshot.directory)],
      { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error && (error as { code?: unknown }).code !== 1 ? reject(error) : resolve(stdout)));
  }
  async invoke(method: string, params: unknown): Promise<unknown> {
    if (method === 'rsi_version_propose') { const input = proposeSchema.parse(params); return this.propose(input.roleId, input.summary); }
    if (method === 'rsi_version_list') {
      const { roleId } = listSchema.parse(params);
      return { roleId, published: this.published(roleId)?.version, versions: this.list(roleId) };
    }
    if (method === 'rsi_version_evaluation') { const input = evaluationSchema.parse(params); return this.evaluate(input.roleId, input.version, input.evaluation); }
    throw new Error(`Unknown RSI method ${method}`);
  }
}
