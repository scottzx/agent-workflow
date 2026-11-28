/**
 * Unified `trial / formal` lifecycle lock for the 4 managed agent assets:
 * `preset`, `check`, `rubric`, and `dag`.
 *
 * Security & governance invariants:
 * - Every asset carries `lifecycle: 'trial' | 'formal'` and a content SHA-256 `digest`.
 * - Coach agents may autonomously create/modify `trial` assets, but are strictly blocked from
 *   mutating `formal` snapshots or any `evals/` exam-paper path (only `person` may touch `evals/`
 *   or promote/rollback `formal`).
 * - Unidirectional `formal` dependency closure: a `formal` asset (such as a `formal` DAG or Preset)
 *   may ONLY depend on `formal` assets (and never transitively reference any `trial` asset).
 *   Conversely, a `trial` asset MAY depend on `formal` baselines.
 * - `formal` snapshots are persisted read-only (`0o444`) on disk with SHA-256 verification on
 *   fork (`forkTrialFromFormal`) and instant rollback (`rollbackFormalSnapshot`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const ASSET_KINDS = ['preset', 'check', 'rubric', 'dag'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_LIFECYCLES = ['trial', 'formal'] as const;
export type AssetLifecycle = (typeof ASSET_LIFECYCLES)[number];

export type LifecycleActor = 'person' | 'coach' | 'executor';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const assetKindSchema = z.enum(ASSET_KINDS);
export const assetLifecycleSchema = z.enum(ASSET_LIFECYCLES);

export const assetDependencySchema = z.object({
  kind: assetKindSchema,
  id: z.string().regex(SAFE_ID),
  digest: z.string().regex(SHA256).optional(),
}).strict();
export type AssetDependency = z.infer<typeof assetDependencySchema>;

export const assetRecordSchema = z.object({
  kind: assetKindSchema,
  id: z.string().regex(SAFE_ID),
  lifecycle: assetLifecycleSchema,
  digest: z.string().regex(SHA256),
  version: z.string().min(1).max(64),
  relativePath: z.string().min(1).max(512),
  dependencies: z.array(assetDependencySchema).default([]),
  forkedFromDigest: z.string().regex(SHA256).optional(),
  evidence: z.string().min(1).max(4000).optional(),
  createdAt: z.string().min(1),
  createdBy: z.enum(['person', 'coach', 'executor']),
}).strict();
export type AssetRecord = z.infer<typeof assetRecordSchema>;

export type AssetLifecycleErrorCode =
  | 'EVAL_EXAM_READONLY'
  | 'FORMAL_ASSET_READONLY'
  | 'FORMAL_SNAPSHOT_IMMUTABLE'
  | 'FORMAL_DEPENDENCY_VIOLATION'
  | 'APPROVAL_REQUIRED'
  | 'EVIDENCE_REQUIRED'
  | 'ASSET_NOT_FOUND'
  | 'SNAPSHOT_CORRUPT'
  | 'UNSAFE_PATH';

export class AssetLifecycleError extends Error {
  constructor(readonly code: AssetLifecycleErrorCode, message: string) {
    super(message);
    this.name = 'AssetLifecycleError';
  }
}

export function assetKey(kind: AssetKind, id: string): string {
  return `${kind}:${id}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).filter(k => rec[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
}

export function computeAssetDigest(content: Buffer | string | Record<string, unknown>): string {
  const hash = createHash('sha256');
  if (Buffer.isBuffer(content)) hash.update(content);
  else if (typeof content === 'string') hash.update(content, 'utf8');
  else hash.update(canonicalJson(content), 'utf8');
  return hash.digest('hex');
}

function assertSafeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length || segments.some(seg => seg === '.' || seg === '..') || normalized.includes('\0')) {
    throw new AssetLifecycleError('UNSAFE_PATH', `Unsafe asset path: ${relativePath}`);
  }
  return segments.join('/');
}

function resolveContainedPath(rootDir: string, relativePath: string): { cleanPath: string; fullPath: string } {
  const cleanPath = assertSafeRelativePath(relativePath);
  const resolvedRoot = path.resolve(rootDir);
  const fullPath = path.resolve(resolvedRoot, cleanPath);
  const rel = path.relative(resolvedRoot, fullPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AssetLifecycleError('UNSAFE_PATH', `Asset path escapes root directory: ${relativePath}`);
  }
  return { cleanPath, fullPath };
}

async function atomicWriteFile(filePath: string, data: string | Buffer, mode?: number): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmpPath, data, mode !== undefined ? { mode } : undefined);
  await rename(tmpPath, filePath);
}

/** True when a path points to or inside an `evals/` exam-paper directory. */
export function isEvalExamPath(relativePath: string): boolean {
  const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.includes('evals');
}

/**
 * Enforces the `trial / formal` and `evals/` write permission matrix:
 * - `evals/` exam papers: strictly read-only for `coach` and `executor`; only `person` may write.
 * - `formal` snapshots: immutable in-place for all actors; only `person` may promote or rollback.
 * - `trial` assets (outside `evals/`): `coach` and `person` may write freely; `executor` cannot mutate role assets.
 */
export function assertAssetWriteAllowed(input: {
  actor: LifecycleActor;
  lifecycle: AssetLifecycle;
  relativePath: string;
  operation?: 'write' | 'promote' | 'rollback' | 'fork';
}): void {
  const cleanPath = assertSafeRelativePath(input.relativePath);
  const op = input.operation ?? 'write';

  if (isEvalExamPath(cleanPath) && input.actor !== 'person') {
    throw new AssetLifecycleError(
      'EVAL_EXAM_READONLY',
      `Refusing ${input.actor} write to protected evals/ exam-paper path: ${cleanPath} (person approval required)`,
    );
  }

  if (op === 'write') {
    if (input.lifecycle === 'formal') {
      throw new AssetLifecycleError(
        'FORMAL_SNAPSHOT_IMMUTABLE',
        `Refusing direct mutation of formal asset ${cleanPath}; fork a trial candidate first`,
      );
    }
    if (input.actor === 'executor') {
      throw new AssetLifecycleError(
        'FORMAL_ASSET_READONLY',
        `Executor is not permitted to mutate role asset ${cleanPath}`,
      );
    }
    return;
  }

  if ((op === 'promote' || op === 'rollback') && input.actor !== 'person') {
    throw new AssetLifecycleError(
      'APPROVAL_REQUIRED',
      `Only a person may ${op} a formal asset (${cleanPath}); actor "${input.actor}" must raise a promote_formal proposal`,
    );
  }

  if (op === 'fork' && input.actor === 'executor') {
    throw new AssetLifecycleError(
      'APPROVAL_REQUIRED',
      `Executor cannot fork formal asset ${cleanPath}`,
    );
  }
}

export interface DependencyClosureResult {
  ok: boolean;
  violations: string[];
  visited: string[];
}

/**
 * Validates the unidirectional `formal` dependency closure for a target asset.
 * Every direct and transitive dependency of a `formal` asset must resolve to an existing
 * `formal` asset (never `trial`), and any pinned dependency digest must match the resolved formal digest.
 */
export function validateFormalDependencyClosure(
  target: Pick<AssetRecord, 'kind' | 'id' | 'dependencies'>,
  registry: ReadonlyMap<string, AssetRecord>,
): DependencyClosureResult {
  const violations: string[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  const walk = (parentLabel: string, deps: readonly AssetDependency[]) => {
    for (const dep of deps) {
      const key = assetKey(dep.kind, dep.id);
      const resolved = registry.get(key);
      if (!resolved) {
        violations.push(`${parentLabel} -> ${key}: dependency not found in formal registry`);
        continue;
      }
      if (resolved.lifecycle !== 'formal') {
        violations.push(`${parentLabel} -> ${key}: formal asset cannot depend on trial asset (lifecycle=${resolved.lifecycle})`);
        continue;
      }
      if (dep.digest && resolved.digest !== dep.digest) {
        violations.push(`${parentLabel} -> ${key}: pinned digest ${dep.digest.slice(0, 12)} !== formal digest ${resolved.digest.slice(0, 12)}`);
        continue;
      }
      if (stack.has(key)) {
        violations.push(`${parentLabel} -> ${key}: circular dependency detected`);
        continue;
      }
      if (visited.has(key)) continue;
      visited.add(key);
      stack.add(key);
      walk(key, resolved.dependencies);
      stack.delete(key);
    }
  };

  const rootKey = assetKey(target.kind, target.id);
  stack.add(rootKey);
  walk(rootKey, target.dependencies);
  stack.delete(rootKey);

  return {
    ok: violations.length === 0,
    violations,
    visited: [...visited],
  };
}

interface StoredLifecycleState {
  schemaVersion: 1;
  /** Active formal asset per `kind:id`. */
  formal: Record<string, AssetRecord>;
  /** Immutable promotion history per `kind:id`, oldest first. */
  formalHistory: Record<string, AssetRecord[]>;
  /** Latest trial candidate per `kind:id`. */
  trial: Record<string, AssetRecord>;
}

const storedStateSchema = z.object({
  schemaVersion: z.literal(1),
  formal: z.record(z.string(), assetRecordSchema),
  formalHistory: z.record(z.string(), z.array(assetRecordSchema)),
  trial: z.record(z.string(), assetRecordSchema),
}).strict();

/**
 * File-backed unified `trial / formal` asset lifecycle store.
 * Formal snapshots are written with mode `0o444` (OS read-only) and verified by SHA-256
 * before fork or rollback.
 */
export class AssetLifecycleStore {
  private readonly stateFile: string;
  private readonly formalDir: string;
  private readonly trialDir: string;

  constructor(readonly rootDirectory: string) {
    const resolved = path.resolve(rootDirectory);
    this.stateFile = path.join(resolved, 'asset-lifecycle.json');
    this.formalDir = path.join(resolved, 'snapshots', 'formal');
    this.trialDir = path.join(resolved, 'trials');
  }

  private async loadState(): Promise<StoredLifecycleState> {
    try {
      const text = await readFile(this.stateFile, 'utf8');
      return storedStateSchema.parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, formal: {}, formalHistory: {}, trial: {} };
      }
      throw error;
    }
  }

  private async saveState(state: StoredLifecycleState): Promise<void> {
    await atomicWriteFile(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o644);
  }

  formalSnapshotPath(kind: AssetKind, id: string, digest: string): string {
    return path.join(this.formalDir, kind, id, `${digest}.snapshot`);
  }

  trialCandidatePath(kind: AssetKind, id: string): string {
    return path.join(this.trialDir, kind, id, 'candidate.asset');
  }

  /**
   * Autonomous coach/person write to a `trial` asset. Rejects `formal` or `evals/` targets.
   * When `sourceRoot` is supplied without `content`, bytes are read directly from
   * `path.join(sourceRoot, relativePath)` so `digest` is bound to the real file on disk.
   */
  async saveTrialAsset(input: {
    kind: AssetKind;
    id: string;
    content?: string | Buffer;
    sourceRoot?: string;
    relativePath: string;
    version: string;
    dependencies?: AssetDependency[];
    forkedFromDigest?: string;
    actor: LifecycleActor;
    now?: () => Date;
  }): Promise<{ record: AssetRecord; filePath: string; sourcePath?: string }> {
    assetKindSchema.parse(input.kind);
    z.string().regex(SAFE_ID).parse(input.id);
    assertAssetWriteAllowed({ actor: input.actor, lifecycle: 'trial', relativePath: input.relativePath, operation: 'write' });

    let bytes: Buffer;
    let sourcePath: string | undefined;
    if (input.sourceRoot) {
      const resolved = resolveContainedPath(input.sourceRoot, input.relativePath);
      sourcePath = resolved.fullPath;
      if (input.content !== undefined) {
        bytes = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
        await atomicWriteFile(sourcePath, bytes, 0o644);
      } else {
        bytes = await readFile(sourcePath);
      }
    } else if (input.content !== undefined) {
      bytes = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
    } else {
      throw new AssetLifecycleError('ASSET_NOT_FOUND', `Either content or sourceRoot must be provided for ${input.kind}:${input.id}`);
    }

    const digest = computeAssetDigest(bytes);
    const record: AssetRecord = assetRecordSchema.parse({
      kind: input.kind,
      id: input.id,
      lifecycle: 'trial',
      digest,
      version: input.version,
      relativePath: assertSafeRelativePath(input.relativePath),
      dependencies: input.dependencies ?? [],
      ...(input.forkedFromDigest ? { forkedFromDigest: input.forkedFromDigest } : {}),
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      createdBy: input.actor,
    });

    const filePath = this.trialCandidatePath(input.kind, input.id);
    await atomicWriteFile(filePath, bytes, 0o644);

    const state = await this.loadState();
    state.trial[assetKey(input.kind, input.id)] = record;
    await this.saveState(state);
    return { record, filePath, ...(sourcePath ? { sourcePath } : {}) };
  }

  /**
   * Promotes an existing `trial` candidate to a read-only (`0o444`) `formal` snapshot.
   * Requires `actor === 'person'`, non-empty `evidence`, and clean unidirectional `formal` dependency closure.
   */
  async promoteTrialToFormal(input: {
    kind: AssetKind;
    id: string;
    expectedDigest?: string;
    actor: LifecycleActor;
    evidence: string;
    now?: () => Date;
  }): Promise<{ record: AssetRecord; snapshotPath: string }> {
    const key = assetKey(input.kind, input.id);
    const state = await this.loadState();
    const candidate = state.trial[key];
    if (!candidate) {
      throw new AssetLifecycleError('ASSET_NOT_FOUND', `No trial candidate found for ${key}`);
    }
    assertAssetWriteAllowed({
      actor: input.actor,
      lifecycle: 'formal',
      relativePath: candidate.relativePath,
      operation: 'promote',
    });
    if (!input.evidence.trim()) {
      throw new AssetLifecycleError('EVIDENCE_REQUIRED', `Promoting ${key} to formal requires non-empty evidence`);
    }
    if (input.expectedDigest && candidate.digest !== input.expectedDigest) {
      throw new AssetLifecycleError(
        'SNAPSHOT_CORRUPT',
        `Trial digest mismatch for ${key}: expected ${input.expectedDigest}, found ${candidate.digest}`,
      );
    }

    // Build combined registry: all active formal assets plus any trial assets so closure check can clearly report trial refs.
    const registry = new Map<string, AssetRecord>();
    for (const [k, rec] of Object.entries(state.trial)) registry.set(k, rec);
    for (const [k, rec] of Object.entries(state.formal)) registry.set(k, rec);
    const closure = validateFormalDependencyClosure(candidate, registry);
    if (!closure.ok) {
      throw new AssetLifecycleError(
        'FORMAL_DEPENDENCY_VIOLATION',
        `Cannot promote ${key} to formal: ${closure.violations.join('; ')}`,
      );
    }

    const trialFile = this.trialCandidatePath(input.kind, input.id);
    const bytes = await readFile(trialFile);
    if (computeAssetDigest(bytes) !== candidate.digest) {
      throw new AssetLifecycleError('SNAPSHOT_CORRUPT', `Trial file bytes on disk do not match digest ${candidate.digest}`);
    }

    const snapshotPath = this.formalSnapshotPath(input.kind, input.id, candidate.digest);
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    // If an identical immutable snapshot already exists, verify its digest rather than overwriting.
    const existingSnap = await stat(snapshotPath).then(s => s.isFile(), () => false);
    if (existingSnap) {
      const snapBytes = await readFile(snapshotPath);
      if (computeAssetDigest(snapBytes) !== candidate.digest) {
        throw new AssetLifecycleError('SNAPSHOT_CORRUPT', `Existing formal snapshot at ${snapshotPath} is corrupt`);
      }
    } else {
      await writeFile(snapshotPath, bytes);
      await chmod(snapshotPath, 0o444);
    }

    const formalRecord: AssetRecord = assetRecordSchema.parse({
      ...candidate,
      lifecycle: 'formal',
      evidence: input.evidence.trim(),
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      createdBy: input.actor,
    });
    state.formal[key] = formalRecord;
    state.formalHistory[key] = [...(state.formalHistory[key] ?? []), formalRecord];
    await this.saveState(state);
    return { record: formalRecord, snapshotPath };
  }

  /**
   * One-click fork of an active `formal` snapshot into a writable `trial` candidate
   * so a coach can autonomously fix a formal defect without mutating `formal`.
   * When `targetRoot` is provided, the forked bytes are also materialized at
   * `path.join(targetRoot, activeFormal.relativePath)`.
   */
  async forkTrialFromFormal(input: {
    kind: AssetKind;
    id: string;
    newVersion: string;
    actor: LifecycleActor;
    targetRoot?: string;
    now?: () => Date;
  }): Promise<{ record: AssetRecord; filePath: string; sourcePath?: string }> {
    const key = assetKey(input.kind, input.id);
    const state = await this.loadState();
    const activeFormal = state.formal[key];
    if (!activeFormal) {
      throw new AssetLifecycleError('ASSET_NOT_FOUND', `No active formal asset found for ${key}`);
    }
    assertAssetWriteAllowed({
      actor: input.actor,
      lifecycle: 'formal',
      relativePath: activeFormal.relativePath,
      operation: 'fork',
    });

    const snapshotPath = this.formalSnapshotPath(input.kind, input.id, activeFormal.digest);
    const bytes = await readFile(snapshotPath);
    if (computeAssetDigest(bytes) !== activeFormal.digest) {
      throw new AssetLifecycleError('SNAPSHOT_CORRUPT', `Formal snapshot digest mismatch for ${key}`);
    }

    return this.saveTrialAsset({
      kind: input.kind,
      id: input.id,
      content: bytes,
      ...(input.targetRoot ? { sourceRoot: input.targetRoot } : {}),
      relativePath: activeFormal.relativePath,
      version: input.newVersion,
      dependencies: activeFormal.dependencies,
      forkedFromDigest: activeFormal.digest,
      actor: input.actor,
      ...(input.now ? { now: input.now } : {}),
    });
  }

  /**
   * One-click instant rollback of a `formal` asset to a previous immutable `formal` snapshot
   * (defaults to the immediately preceding distinct snapshot in `formalHistory`).
   * When `targetRoot` is supplied, atomically writes the verified snapshot bytes back to
   * `path.join(targetRoot, restored.relativePath)` on disk.
   */
  async rollbackFormalSnapshot(input: {
    kind: AssetKind;
    id: string;
    targetDigest?: string;
    targetRoot?: string;
    actor: LifecycleActor;
    reason: string;
    now?: () => Date;
  }): Promise<{ record: AssetRecord; snapshotPath: string; rolledBackFromDigest: string; restoredPath?: string }> {
    const key = assetKey(input.kind, input.id);
    const state = await this.loadState();
    const current = state.formal[key];
    if (!current) {
      throw new AssetLifecycleError('ASSET_NOT_FOUND', `No active formal asset found for ${key}`);
    }
    assertAssetWriteAllowed({
      actor: input.actor,
      lifecycle: 'formal',
      relativePath: current.relativePath,
      operation: 'rollback',
    });
    if (!input.reason.trim()) {
      throw new AssetLifecycleError('EVIDENCE_REQUIRED', `Rolling back ${key} requires a non-empty reason`);
    }

    const history = state.formalHistory[key] ?? [];
    const target = input.targetDigest
      ? [...history].reverse().find(item => item.digest === input.targetDigest)
      : [...history].reverse().find(item => item.digest !== current.digest);
    if (!target) {
      throw new AssetLifecycleError(
        'ASSET_NOT_FOUND',
        `No prior formal snapshot found to roll back ${key}${input.targetDigest ? ` (digest ${input.targetDigest})` : ''}`,
      );
    }

    const snapshotPath = this.formalSnapshotPath(input.kind, input.id, target.digest);
    const bytes = await readFile(snapshotPath);
    if (computeAssetDigest(bytes) !== target.digest) {
      throw new AssetLifecycleError('SNAPSHOT_CORRUPT', `Rollback target snapshot at ${snapshotPath} failed digest check`);
    }

    const formalMap = new Map<string, AssetRecord>(Object.entries(state.formal));
    const closure = validateFormalDependencyClosure(target, formalMap);
    if (!closure.ok) {
      throw new AssetLifecycleError(
        'FORMAL_DEPENDENCY_VIOLATION',
        `Cannot roll back ${key}: ${closure.violations.join('; ')}`,
      );
    }

    let restoredPath: string | undefined;
    if (input.targetRoot) {
      const resolved = resolveContainedPath(input.targetRoot, target.relativePath);
      await atomicWriteFile(resolved.fullPath, bytes, 0o644);
      restoredPath = resolved.fullPath;
    }

    const restored: AssetRecord = assetRecordSchema.parse({
      ...target,
      evidence: `rollback from ${current.digest.slice(0, 12)}: ${input.reason.trim()}`,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      createdBy: input.actor,
    });
    state.formal[key] = restored;
    state.formalHistory[key] = [...history, restored];
    await this.saveState(state);
    return { record: restored, snapshotPath, rolledBackFromDigest: current.digest, ...(restoredPath ? { restoredPath } : {}) };
  }

  /** Read active state snapshot (read-only). */
  async inspect(): Promise<StoredLifecycleState> {
    return this.loadState();
  }

  /** Attempt to directly overwrite a formal snapshot file is always refused. */
  async attemptDirectFormalOverwrite(kind: AssetKind, id: string, actor: LifecycleActor): Promise<never> {
    const key = assetKey(kind, id);
    const state = await this.loadState();
    const current = state.formal[key];
    const relPath = current?.relativePath ?? `${kind}/${id}`;
    assertAssetWriteAllowed({ actor, lifecycle: 'formal', relativePath: relPath, operation: 'write' });
    throw new AssetLifecycleError('FORMAL_SNAPSHOT_IMMUTABLE', `Formal snapshot ${key} is immutable`);
  }

  /** Clean up a trial candidate (never deletes formal snapshots). */
  async discardTrial(kind: AssetKind, id: string, actor: LifecycleActor): Promise<void> {
    const key = assetKey(kind, id);
    const state = await this.loadState();
    const existing = state.trial[key];
    if (!existing) return;
    assertAssetWriteAllowed({ actor, lifecycle: 'trial', relativePath: existing.relativePath, operation: 'write' });
    delete state.trial[key];
    await rm(this.trialCandidatePath(kind, id), { force: true });
    await this.saveState(state);
  }
}
