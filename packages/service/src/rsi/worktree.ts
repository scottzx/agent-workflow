/**
 * Git worktree lifecycle for a role task: create an isolated tree, inspect its digest,
 * merge it only when formal policy allows, and remove it afterwards. Trial runs stay isolated.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const worktreeConfigSchema = z.object({
  strategy: z.literal('git_worktree'),
  root: z.string().min(1),
  baseBranch: z.string().min(1),
  branchTemplate: z.string().min(1),
  dependencySetup: z.string().min(1),
  mergePolicy: z.object({
    trial: z.literal('keep_isolated'),
    formal: z.literal('ff_or_merge_on_accepted'),
  }).strict(),
  cleanupOnMerge: z.boolean(),
}).strict();
export type WorktreeConfig = z.infer<typeof worktreeConfigSchema>;

export interface WorktreeEvent {
  type: 'worktree.created' | 'worktree.merged' | 'worktree.removed';
  at: string;
  worktreePath: string;
  branch?: string;
  baseCommit?: string;
  headCommit?: string;
  sourceCommit?: string;
  targetBranch?: string;
  mergedCommit?: string;
}

export interface WorktreeInspection {
  headCommit: string;
  dirty: boolean;
  changedFiles: string[];
  diffDigest: string;
}

export interface MergeWorktreeResult {
  merged: boolean;
  action?: 'kept_isolated';
  headCommit?: string;
  conflicted?: boolean;
  conflictFiles?: string[];
  reason?: string;
  strategy?: 'ff-only' | 'merge';
  sourceCommit?: string;
  targetBranch?: string;
  mergedCommit?: string;
  event?: WorktreeEvent;
}

const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,160}$/;

function run(command: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return run('git', ['-C', cwd, '-c', 'user.name=rsi', '-c', 'user.email=rsi@example.com', ...args]);
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}

/** Rejects a worktree path that leaves the repository or is the repository itself. */
export function assertWorktreePath(repo: string, worktreePath: string): string {
  if (worktreePath.split(/[\\/]/).includes('..')) throw new Error(`Path escapes the repository: ${worktreePath}`);
  const root = path.resolve(repo);
  const resolved = path.resolve(root, worktreePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Path escapes the repository: ${worktreePath}`);
  if (resolved === root) throw new Error('Worktree path must not be the repository root');
  return resolved;
}

function assertBranch(branch: string): void {
  if (!SAFE_BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new Error(`Unsafe branch name: ${branch}`);
  }
}

export function renderBranch(template: string, vars: { caseId: string; stage: string }): string {
  const branch = template.replaceAll('${caseId}', vars.caseId).replaceAll('${stage}', vars.stage);
  assertBranch(branch);
  return branch;
}

/** `pnpm install --offline` when the role asked for it. Not run unless createWorktree is told to provision. */
export function dependencySetupCommand(dependencySetup: string | undefined): string[] | undefined {
  if (!dependencySetup || dependencySetup === 'none') return undefined;
  if (dependencySetup === 'pnpm_offline') return ['pnpm', 'install', '--offline', '--frozen-lockfile'];
  return undefined;
}

export async function createWorktree(options: {
  repo: string; worktreePath: string; branch: string; baseRef: string;
  now?: () => Date; provision?: boolean; dependencySetup?: string;
}): Promise<{ worktreePath: string; branch: string; baseCommit: string; event: WorktreeEvent }> {
  assertBranch(options.branch);
  const worktreePath = assertWorktreePath(options.repo, options.worktreePath);
  const baseCommit = (await gitOk(options.repo, ['rev-parse', '--verify', `${options.baseRef}^{commit}`])).trim();
  const exists = await git(options.repo, ['show-ref', '--verify', '--quiet', `refs/heads/${options.branch}`]);
  if (exists.code === 0) throw new Error(`Branch already exists: ${options.branch}`);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const added = await git(options.repo, ['worktree', 'add', '-b', options.branch, worktreePath, options.baseRef]);
  if (added.code !== 0) throw new Error(`Could not create worktree: ${added.stderr.trim() || added.stdout.trim()}`);
  const command = options.provision ? dependencySetupCommand(options.dependencySetup) : undefined;
  if (command) {
    const installed = await run(command[0]!, command.slice(1), worktreePath);
    if (installed.code !== 0) throw new Error(`Dependency setup failed: ${installed.stderr.trim() || installed.stdout.trim()}`);
  }
  const event: WorktreeEvent = {
    type: 'worktree.created', at: (options.now ?? (() => new Date()))().toISOString(),
    worktreePath, branch: options.branch, baseCommit,
  };
  return { worktreePath, branch: options.branch, baseCommit, event };
}

function porcelainPath(line: string): string {
  return line.slice(3).split(' -> ').at(-1) ?? line.slice(3);
}

export async function inspectWorktree(worktreePath: string): Promise<WorktreeInspection> {
  const headCommit = (await gitOk(worktreePath, ['rev-parse', 'HEAD'])).trim();
  const status = await gitOk(worktreePath, ['status', '--porcelain', '--untracked-files=all']);
  const changedFiles = status.split('\n').filter(Boolean).map(porcelainPath);
  const diff = await git(worktreePath, ['diff', 'HEAD', '--binary']);
  const diffDigest = createHash('sha256').update(status).update('\0').update(diff.stdout).digest('hex');
  return { headCommit, dirty: changedFiles.length > 0, changedFiles, diffDigest };
}

async function postMergeFailure(check: (() => Promise<void | { ok: boolean; reason?: string }>) | undefined): Promise<string | undefined> {
  if (!check) return undefined;
  try {
    const result = await check();
    if (result && result.ok === false) return result.reason || 'post-merge check failed';
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Trial keeps the branch isolated. Formal fast-forwards the target when it can;
 * if the target moved, the worktree merges the base first and aborts on conflict
 * without touching the target. A failing postMergeCheck also leaves the target alone.
 */
export async function mergeWorktree(options: {
  repo: string; worktreePath: string; branch: string; mode: 'trial' | 'formal';
  targetBranch: string; baseBranch: string;
  postMergeCheck?: () => Promise<void | { ok: boolean; reason?: string }>;
  now?: () => Date;
}): Promise<MergeWorktreeResult> {
  const inspected = await inspectWorktree(options.worktreePath);
  if (options.mode === 'trial') return { merged: false, action: 'kept_isolated', headCommit: inspected.headCommit };
  if (inspected.dirty) return { merged: false, conflicted: false, headCommit: inspected.headCommit, reason: 'worktree has uncommitted changes' };

  const onBranch = (await gitOk(options.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (onBranch !== options.targetBranch) {
    const switched = await git(options.repo, ['checkout', options.targetBranch]);
    if (switched.code !== 0) return { merged: false, reason: `cannot checkout ${options.targetBranch}: ${switched.stderr.trim()}` };
  }
  // A nested worktree shows up as an untracked directory of the main checkout. Only tracked edits block the merge.
  const targetDirty = (await gitOk(options.repo, ['status', '--porcelain', '--untracked-files=no'])).trim();
  if (targetDirty) return { merged: false, reason: 'target worktree is dirty' };

  const beforeTarget = (await gitOk(options.repo, ['rev-parse', 'HEAD'])).trim();
  const refused = await postMergeFailure(options.postMergeCheck);
  if (refused) return { merged: false, headCommit: inspected.headCommit, reason: refused, targetBranch: options.targetBranch };

  const ff = await git(options.repo, ['merge', '--ff-only', options.branch]);
  const now = options.now ?? (() => new Date());
  if (ff.code === 0) {
    const mergedCommit = (await gitOk(options.repo, ['rev-parse', 'HEAD'])).trim();
    const event: WorktreeEvent = {
      type: 'worktree.merged', at: now().toISOString(), worktreePath: options.worktreePath, branch: options.branch,
      sourceCommit: inspected.headCommit, targetBranch: options.targetBranch, mergedCommit,
    };
    return { merged: true, strategy: 'ff-only', sourceCommit: inspected.headCommit, targetBranch: options.targetBranch, mergedCommit, headCommit: inspected.headCommit, event };
  }

  const headBefore = inspected.headCommit;
  const integrated = await git(options.worktreePath, ['merge', '--no-edit', options.baseBranch]);
  if (integrated.code !== 0) {
    const listed = await git(options.worktreePath, ['diff', '--name-only', '--diff-filter=U']);
    await git(options.worktreePath, ['merge', '--abort']);
    const still = (await gitOk(options.repo, ['rev-parse', 'HEAD'])).trim();
    if (still !== beforeTarget) throw new Error('target branch moved during an aborted worktree merge');
    return {
      merged: false, conflicted: true, conflictFiles: listed.stdout.split('\n').filter(Boolean),
      headCommit: headBefore, targetBranch: options.targetBranch, reason: integrated.stderr.trim() || 'merge conflict',
    };
  }

  const afterIntegrate = await postMergeFailure(options.postMergeCheck);
  if (afterIntegrate) {
    await git(options.worktreePath, ['reset', '--hard', headBefore]);
    const still = (await gitOk(options.repo, ['rev-parse', 'HEAD'])).trim();
    if (still !== beforeTarget) throw new Error('target branch moved after a failed post-merge check');
    return { merged: false, headCommit: headBefore, targetBranch: options.targetBranch, reason: afterIntegrate };
  }

  const sourceCommit = (await gitOk(options.worktreePath, ['rev-parse', 'HEAD'])).trim();
  const ffAfter = await git(options.repo, ['merge', '--ff-only', options.branch]);
  let strategy: 'ff-only' | 'merge' = 'merge';
  if (ffAfter.code !== 0) {
    const merged = await git(options.repo, ['merge', '--no-edit', options.branch]);
    if (merged.code !== 0) {
      await git(options.repo, ['merge', '--abort']);
      return { merged: false, conflicted: true, headCommit: sourceCommit, targetBranch: options.targetBranch, reason: merged.stderr.trim() || 'target merge failed' };
    }
    strategy = 'merge';
  }
  const mergedCommit = (await gitOk(options.repo, ['rev-parse', 'HEAD'])).trim();
  const event: WorktreeEvent = {
    type: 'worktree.merged', at: now().toISOString(), worktreePath: options.worktreePath, branch: options.branch,
    sourceCommit, targetBranch: options.targetBranch, mergedCommit,
  };
  return { merged: true, strategy, sourceCommit, targetBranch: options.targetBranch, mergedCommit, headCommit: sourceCommit, event };
}

export async function removeWorktree(options: {
  repo: string; worktreePath: string; branch?: string; deleteBranch?: boolean; forceDeleteBranch?: boolean; now?: () => Date;
}): Promise<{ removed: boolean; event: WorktreeEvent }> {
  const worktreePath = path.resolve(options.worktreePath);
  const removed = await git(options.repo, ['worktree', 'remove', '--force', worktreePath]);
  if (removed.code !== 0) throw new Error(`Could not remove worktree: ${removed.stderr.trim() || removed.stdout.trim()}`);
  if (options.deleteBranch && options.branch) {
    assertBranch(options.branch);
    const deleted = await git(options.repo, ['branch', options.forceDeleteBranch ? '-D' : '-d', options.branch]);
    if (deleted.code !== 0 && !options.forceDeleteBranch) {
      await git(options.repo, ['branch', '-D', options.branch]);
    }
  }
  const event: WorktreeEvent = {
    type: 'worktree.removed', at: (options.now ?? (() => new Date()))().toISOString(),
    worktreePath, ...(options.branch ? { branch: options.branch } : {}),
  };
  return { removed: true, event };
}
