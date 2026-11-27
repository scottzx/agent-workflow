/** Host-authored task identity and verified artifact receipts; model text is not an authority. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { deliveryModeSchema, isDefaultJobDirectory, isManagedJobDirectory } from './job-directory.js';
import type { A2APreflightReport, A2ATarget } from './types.js';
const executeGit = promisify(execFile);

const identifier = z.string().trim().min(1).max(512);
const absolutePath = z.string().min(1).max(8192).refine(value => isAbsolute(value) && !value.includes('\0'), 'Expected an absolute path');

export const a2aResultContractSchema = z.object({
  jobId: identifier,
  parentTaskId: identifier.optional(),
  parentSessionId: identifier.optional(),
  originSessionId: identifier.optional(),
  artifactManifestPath: absolutePath.optional(),
  deliveryMode: deliveryModeSchema.optional(),
}).strict();
export type A2AResultContract = z.infer<typeof a2aResultContractSchema>;

const artifactSchema = z.object({
  path: absolutePath,
  url: z.string().url().refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'Artifact URL must use HTTP(S) without credentials').optional(),
  mediaType: z.string().min(1).max(256).optional(),
}).strict();
const manifestSchema = z.object({ artifacts: z.array(artifactSchema).max(128) }).strict();

export interface A2AVerifiedArtifact {
  path: string;
  size: number;
  sha256: string;
  url?: string;
  mediaType?: string;
}

/** Read-only sample of the checkout a workspace_git task finished in. Absent when git cannot be read. */
export interface A2AGitDelivery {
  branch?: string;
  headCommit?: string;
  clean: boolean;
  dirtyCount: number;
  diffStat?: string;
}

export interface A2AResultMetadata {
  version: 1;
  producer: '1agents/a2a-host';
  taskId: string;
  contextId: string;
  requestId: string;
  sessionId?: string;
  cwd?: string;
  agentPreset?: string;
  /** Model actually selected for a standard preset; absent means the host default. */
  provider?: string;
  model?: string;
  roleId?: string;
  /** Resolved by the execution host, independently from caller-declared lineage. */
  roleSkills?: A2ATarget['roleSkills'];
  startedAt: string;
  finishedAt: string;
  outcome: 'completed' | 'failed' | 'input-required' | 'canceled';
  /** These associations are declared by the authenticated caller, not independently proven by this host. */
  lineage?: A2AResultContract & { source: 'caller-declared' };
  preflight?: A2APreflightReport;
  artifacts: A2AVerifiedArtifact[];
  /** Set for a completed workspace_git task when the cwd is a readable git checkout. */
  gitDelivery?: A2AGitDelivery;
  validation: { status: 'not-requested' | 'passed' | 'failed'; code?: string };
  recordPath?: string;
}

export class A2AResultValidationError extends Error {
  constructor(readonly code: string) { super(`A2A result validation failed: ${code}`); }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Resolve aliases such as /tmp once, then reject symlinks below an admitted root. The manifest itself stays in the job root. */
async function scopedFile(roots: string[], path: string): Promise<string> {
  const canonical = await realpath(path);
  const root = roots.find(item => within(item, canonical));
  if (!root) throw new A2AResultValidationError('artifact-outside-job-directory');
  // A symlink pointing back into the scope is rejected too: the receipt describes a real file.
  let current = path;
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new A2AResultValidationError('artifact-symlink');
    if (await realpath(dirname(current)) === root) break;
    const parent = dirname(current);
    if (parent === current) throw new A2AResultValidationError('artifact-outside-job-directory');
    current = parent;
  }
  return canonical;
}

const DIFF_STAT_LIMIT = 4096;

function truncateUtf8(text: string, max = DIFF_STAT_LIMIT): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= max) return text;
  let end = max;
  while (end > 0 && (buffer[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/** Git identity comes from cwd. A caller-injected GIT_DIR must not redirect the sample. */
function gitSampleEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  return env;
}

/** Read-only git sample. Never writes the repo; any failure omits the sample instead of failing the task. */
async function sampleGitDelivery(cwd: string): Promise<A2AGitDelivery | undefined> {
  const git = async (args: string[], maxBuffer = 1024 * 1024): Promise<string> => {
    const { stdout } = await executeGit('git', ['--no-optional-locks', ...args], {
      cwd, timeout: 5000, maxBuffer, encoding: 'utf8', windowsHide: true, env: gitSampleEnv(),
    });
    return String(stdout);
  };
  try {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const headCommit = (await git(['rev-parse', 'HEAD'])).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(headCommit)) return undefined;
    const dirtyCount = (await git(['status', '--porcelain'])).split('\n').filter(line => line.length > 0).length;
    let diffStat: string | undefined;
    try {
      const diff = truncateUtf8((await git(['show', '--stat', '--stat-count=50', '--format=', 'HEAD'], 64 * 1024)).trim());
      if (diff) diffStat = diff;
    } catch { /* A huge or unreadable stat must not drop the commit sample. */ }
    return {
      ...(branch && branch !== 'HEAD' ? { branch } : {}), headCommit, clean: dirtyCount === 0, dirtyCount,
      ...(diffStat ? { diffStat } : {}),
    };
  } catch {
    return undefined;
  }
}

const ENV_FILE_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

/** Judge secrets relative to cwd. An absolute path would treat a worktree under `.1agents/worktrees` as internal. */
function isSensitiveWorkspaceFile(cwdRoot: string, file: string): boolean {
  const name = basename(file);
  if (name === '.env' || (name.startsWith('.env.') && !ENV_FILE_TEMPLATES.has(name))) return true;
  const tail = relative(cwdRoot, file);
  if (tail === '' || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) return false;
  const parts = tail.split(sep);
  return parts.includes('.git') || parts.includes('.1agents');
}

function isImplicitJobDirectory(cwd: string, directory: string): boolean {
  return isDefaultJobDirectory(cwd, directory) || isManagedJobDirectory(cwd, directory);
}

async function verifiedArtifacts(root: string, extraRoots: string[], manifestPath: string, cwdRoot?: string): Promise<A2AVerifiedArtifact[]> {
  const manifestFile = await scopedFile([root], manifestPath);
  const manifest = await open(manifestFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source: unknown;
  try {
    const info = await manifest.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new A2AResultValidationError('invalid-artifact-manifest');
    source = JSON.parse(await manifest.readFile('utf8'));
  } finally { await manifest.close(); }
  const parsed = manifestSchema.safeParse(source);
  if (!parsed.success) throw new A2AResultValidationError('invalid-artifact-manifest');
  const output: A2AVerifiedArtifact[] = [];
  const seen = new Set<string>();
  const fileRoots = cwdRoot ? [root, ...extraRoots, cwdRoot] : [root, ...extraRoots];
  for (const item of parsed.data.artifacts) {
    const path = await scopedFile(fileRoots, item.path);
    const authorized = [root, ...extraRoots].some(candidate => within(candidate, path));
    if (cwdRoot && !authorized && isSensitiveWorkspaceFile(cwdRoot, path)) throw new A2AResultValidationError('artifact-sensitive-path');
    if (seen.has(path)) throw new A2AResultValidationError('duplicate-artifact');
    seen.add(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new A2AResultValidationError('artifact-is-not-a-file');
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new A2AResultValidationError('artifact-changed-during-verification');
      }
      output.push({ path, size: after.size, sha256: hash.digest('hex'),
        ...(item.url ? { url: item.url } : {}), ...(item.mediaType ? { mediaType: item.mediaType } : {}) });
    } finally { await file.close(); }
  }
  return output;
}

/** Produce identities even for an admission failure; artifact checks only run after completed execution. */
export async function createA2AResultMetadata(input: {
  taskId: string; contextId: string; requestId: string; startedAt: string;
  outcome: A2AResultMetadata['outcome']; target?: A2ATarget; contract?: A2AResultContract;
  validationCode?: string; preflight?: A2APreflightReport;
}): Promise<A2AResultMetadata> {
  const { target, contract } = input;
  const metadata: A2AResultMetadata = {
    version: 1, producer: '1agents/a2a-host', taskId: input.taskId, contextId: input.contextId,
    requestId: input.requestId, ...(target ? { sessionId: target.sessionId, cwd: target.cwd,
      ...(target.agentPreset ? { agentPreset: target.agentPreset } : {}),
      ...(target.provider ? { provider: target.provider, model: target.model } : {}),
      ...(target.roleSkills ? { roleId: target.roleId, roleSkills: structuredClone(target.roleSkills) } : {}) } : {}),
    startedAt: input.startedAt, finishedAt: new Date().toISOString(), outcome: input.outcome,
    ...(contract ? { lineage: { ...contract, source: 'caller-declared' } } : {}),
    ...(target?.preflight || input.preflight ? { preflight: target?.preflight ?? input.preflight } : {}), artifacts: [],
    validation: input.validationCode ? { status: 'failed', code: input.validationCode } : { status: 'not-requested' },
  };
  if (contract?.deliveryMode === 'workspace_git' && input.outcome === 'completed' && target?.cwd) {
    const gitDelivery = await sampleGitDelivery(target.cwd);
    if (gitDelivery) metadata.gitDelivery = gitDelivery;
  }
  if (contract?.artifactManifestPath && input.outcome === 'completed' && !input.validationCode) {
    const root = target?.preflight?.ok && target.preflight.jobDirectory;
    // A manifest the gateway announced by default is optional: no admitted directory or manifest means no artifacts,
    // and a bad one is reported in `validation` without failing a task that otherwise completed.
    // The gateway may name cwd through a symlink while the host stores the resolved path, so compare both spellings.
    const real = async (path: string) => realpath(path).catch(() => path);
    const manifestDirectory = dirname(contract.artifactManifestPath);
    const implicit = Boolean(target?.cwd) && (isImplicitJobDirectory(target!.cwd, manifestDirectory)
      || isImplicitJobDirectory(await real(target!.cwd), await real(manifestDirectory)));
    if (!root) {
      if (implicit) return metadata;
      throw new A2AResultValidationError('artifact-job-directory-not-admitted');
    }
    if (await realpath(root) !== root) {
      if (implicit) { metadata.validation = { status: 'failed', code: 'job-directory-changed' }; return metadata; }
      throw new A2AResultValidationError('job-directory-changed');
    }
    if (implicit && !(await lstat(contract.artifactManifestPath).catch(() => undefined))) return metadata;
    const admittedSpace = target?.preflight?.artifactSpace;
    const extraRoots = admittedSpace && await realpath(admittedSpace) === admittedSpace ? [admittedSpace] : [];
    if (admittedSpace && !extraRoots.length) {
      const code = 'artifact-space-changed';
      if (implicit) { metadata.validation = { status: 'failed', code }; return metadata; }
      throw new A2AResultValidationError(code);
    }
    let cwdRoot: string | undefined;
    if (contract.deliveryMode === 'workspace_files' && target?.cwd) cwdRoot = await realpath(target.cwd).catch(() => undefined);
    try { metadata.artifacts = await verifiedArtifacts(root, extraRoots, contract.artifactManifestPath, cwdRoot); }
    catch (error) {
      const code = error instanceof A2AResultValidationError ? error.code : 'artifact-manifest-or-file-unavailable';
      if (implicit) { metadata.validation = { status: 'failed', code }; return metadata; }
      throw error instanceof A2AResultValidationError ? error : new A2AResultValidationError(code);
    }
    metadata.validation = { status: 'passed' };
  }
  return metadata;
}

/** A system sidecar is optional for legacy callers, but mandatory when an admitted job is specified. */
export async function saveA2AResultMetadata(metadata: A2AResultMetadata, target?: A2ATarget): Promise<void> {
  const root = target?.preflight?.ok && target.preflight.jobDirectory;
  if (!root) return;
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new A2AResultValidationError('job-directory-changed');
  const filename = `result-metadata.${encodeURIComponent(metadata.taskId)}.json`;
  if (basename(filename) !== filename) throw new A2AResultValidationError('invalid-task-id');
  const destination = join(root, filename);
  const temporary = join(root, `.result-${randomUUID()}.tmp`);
  metadata.recordPath = destination;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(JSON.stringify(metadata, null, 2) + '\n');
    await file.sync();
    await file.close(); file = undefined;
    // rename replaces a pre-existing symlink itself rather than following it.
    await rename(temporary, destination);
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}
