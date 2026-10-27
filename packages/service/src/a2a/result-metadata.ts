/** Host-authored task identity and verified artifact receipts; model text is not an authority. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { A2APreflightReport, A2ATarget } from './types.js';

const identifier = z.string().trim().min(1).max(512);
const absolutePath = z.string().min(1).max(8192).refine(value => isAbsolute(value) && !value.includes('\0'), 'Expected an absolute path');

export const a2aResultContractSchema = z.object({
  jobId: identifier,
  parentTaskId: identifier.optional(),
  parentSessionId: identifier.optional(),
  originSessionId: identifier.optional(),
  artifactManifestPath: absolutePath.optional(),
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

/** Resolve aliases such as /tmp once, then reject symlinks below the admitted job root. */
async function scopedFile(root: string, path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!within(root, canonical)) throw new A2AResultValidationError('artifact-outside-job-directory');
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

async function verifiedArtifacts(root: string, manifestPath: string): Promise<A2AVerifiedArtifact[]> {
  const manifestFile = await scopedFile(root, manifestPath);
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
  for (const item of parsed.data.artifacts) {
    const path = await scopedFile(root, item.path);
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
  if (contract?.artifactManifestPath && input.outcome === 'completed' && !input.validationCode) {
    const root = target?.preflight?.ok && target.preflight.jobDirectory;
    if (!root) throw new A2AResultValidationError('artifact-job-directory-not-admitted');
    if (await realpath(root) !== root) throw new A2AResultValidationError('job-directory-changed');
    try { metadata.artifacts = await verifiedArtifacts(root, contract.artifactManifestPath); }
    catch (error) {
      if (error instanceof A2AResultValidationError) throw error;
      throw new A2AResultValidationError('artifact-manifest-or-file-unavailable');
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
