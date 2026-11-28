#!/usr/bin/env node
/**
 * Deterministic L1 gate for a pr-delivery worktree.
 * Twin of packages/service/src/roles/worktree-projection.ts validateSkillFrontmatter.
 * DSH 0.2.2-rc.5 drops a skill whose frontmatter uses disableModelInvocation, modelInvocable, or userInvocable.
 *
 *   node .1agents/roles/pr-delivery/checks/l1-gate.mjs --worktree <dir> [--role-dir <dir>] [--base-ref <ref>]
 *        [--allow-eval-change] [--allowed-paths <p1,p2,...>]...
 *
 *   --worktree <dir>          Worktree to judge. Required.
 *   --role-dir <dir>          Also validate that role source package (profile.json + skills/).
 *   --base-ref <ref>          Optional alias for the baseline ref. It cannot move the anchor: it must
 *                             resolve to merge-base(HEAD, origin/main) or the gate fails closed.
 *   --allow-eval-change       Approve a change under .1agents/roles/<role>/evals/. Only a person
 *                             accepting an `eval_change` proposal may pass it.
 *   --allowed-paths <spec>    Authorization whitelist, repeatable and comma separated. Every changed
 *                             path must match one entry: an exact file, a directory prefix (`dir/` or
 *                             `dir`) or a glob (`*` inside one segment, `**` across segments).
 *
 * Git-derived checks share resolveBaseline(): merge-base(HEAD, refs/remotes/origin/main). The gate
 * never fetches, so a missing or stale origin/main fails closed, and the changed-path window covers
 * committed (baseSha..HEAD), staged, unstaged and untracked paths including rename/copy source+target.
 */
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HEADER = '<!-- AUTO-GENERATED FROM .1agents/roles/pr-delivery — DO NOT EDIT -->';
const AOCI_BEGIN = '<!-- aoci:begin -->';
const AOCI_END = '<!-- aoci:end -->';
const CONFIG_EXAMPLE = /^\.1agents\/config\/[^/]+\.example\.(?:json|yml)$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVALS_PATH = /^\.1agents\/roles\/[^/]+\/evals(?:\/|$)/;
const PROJECTION_PATHS = ['AGENTS.local.md', 'CLAUDE.local.md'];

const LEGACY = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
};

const args = process.argv.slice(2);
let worktree;
let roleDir;
let baseRef;
let hasBaseRef = false;
let allowEvalChange = false;
const allowedPathArgs = [];
let missingAllowedPathsValue = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--worktree') worktree = args[++index];
  else if (arg === '--role-dir') {
    roleDir = args[++index];
    // An empty or whitespace-only value must fail closed, not silently skip --role-dir validation.
    if (roleDir === undefined || !roleDir.trim() || roleDir.startsWith('-')) {
      await finish({
        ok: false,
        worktree: worktree ?? null,
        checks: [{ id: 'usage', ok: false, detail: 'missing value for --role-dir <dir>' }],
      });
    }
  }
  else if (arg === '--base-ref') {
    hasBaseRef = true;
    baseRef = args[++index];
    if (baseRef === undefined) {
      await finish({
        ok: false,
        worktree: worktree ?? null,
        checks: [{ id: 'usage', ok: false, detail: 'missing value for --base-ref <ref>' }],
      });
    }
  }
  else if (arg === '--allow-eval-change') allowEvalChange = true;
  else if (arg === '--allowed-paths') {
    const spec = args[++index];
    if (spec === undefined) missingAllowedPathsValue = true;
    else allowedPathArgs.push(spec);
  }
  else {
    await finish({
      ok: false,
      worktree: worktree ?? null,
      checks: [{ id: 'usage', ok: false, detail: `unknown argument ${arg}` }],
    });
  }
}
if (!worktree) {
  await finish({
    ok: false,
    worktree: null,
    checks: [{ id: 'usage', ok: false, detail: 'missing --worktree <dir>' }],
  });
}

const root = resolve(worktree);
if (missingAllowedPathsValue) {
  await finish({
    ok: false,
    worktree: root,
    checks: [{ id: 'usage', ok: false, detail: 'missing value for --allowed-paths <spec>' }],
  });
}
// A whitelist that names nothing is a configuration error, never "allow everything".
const whitelist = allowedPathArgs.length ? parseAllowedPaths(allowedPathArgs) : undefined;
if (whitelist && !whitelist.ok) {
  await finish({
    ok: false,
    worktree: root,
    checks: [{ id: 'usage', ok: false, detail: whitelist.detail }],
  });
}

const checks = [];
const anchor = await checkGitAnchor(root);
// One baseline for every git-derived check: a forged --base-ref can never widen their window.
const baseline = await resolveBaseline(root, hasBaseRef ? baseRef : undefined, anchor.ok);
checks.push(anchor);
checks.push(await checkSkillFrontmatter(root));
checks.push(await checkAgentsLocal(root));
checks.push(await checkClaudeLink(root));
checks.push(await checkNoHooks(root));
checks.push(anchor.ok ? await checkGitStatus(root) : { id: 'git-status', ok: true, skipped: true, detail: 'skipped because .git anchor is missing' });
checks.push(await checkAociBlockImmutable(root, baseline));
checks.push(await checkEvalsImmutable(root, baseline, allowEvalChange));
if (whitelist) checks.push(await checkAllowedPaths(root, baseline, whitelist.patterns));
if (roleDir) checks.push(await checkRoleSource(resolve(roleDir)));

await finish({ ok: checks.every(item => item.ok), worktree: root, checks });

function finish(result) {
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  return new Promise(() => {
    process.stdout.write(payload, () => {
      process.exit(result.ok ? 0 : 1);
    });
  });
}

async function checkGitAnchor(dir) {
  const gitPath = join(dir, '.git');
  let info;
  try {
    info = await lstat(gitPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { id: 'git-anchor', ok: false, detail: 'missing .git anchor' };
    return { id: 'git-anchor', ok: false, detail: errorMessage(error) };
  }
  const kind = info.isSymbolicLink() ? await stat(gitPath).catch(() => undefined) : info;
  if (!kind || (!kind.isFile() && !kind.isDirectory())) {
    return { id: 'git-anchor', ok: false, detail: '.git is not a file or directory' };
  }
  return { id: 'git-anchor', ok: true, kind: kind.isFile() ? 'file' : 'directory' };
}

async function checkSkillFrontmatter(dir) {
  const skillsDir = join(dir, '.agents', 'skills');
  let entries = [];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { id: 'skill-frontmatter', ok: true, checked: 0 };
    return { id: 'skill-frontmatter', ok: false, detail: errorMessage(error) };
  }
  const failures = [];
  let checked = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const guide = join(skillsDir, entry.name, 'SKILL.md');
    const info = await stat(guide).catch(() => undefined);
    if (!info?.isFile()) continue;
    checked += 1;
    try {
      validateSkillFrontmatter(await readFile(guide, 'utf8'), entry.name);
    } catch (error) {
      failures.push(`${entry.name}: ${errorMessage(error)}`);
    }
  }
  return failures.length
    ? { id: 'skill-frontmatter', ok: false, checked, detail: failures.join('; ') }
    : { id: 'skill-frontmatter', ok: true, checked };
}

async function checkAgentsLocal(dir) {
  const path = join(dir, 'AGENTS.local.md');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { id: 'agents-local', ok: true, present: false };
    return { id: 'agents-local', ok: false, detail: errorMessage(error) };
  }
  const first = text.split(/\r?\n/, 1)[0];
  if (first !== HEADER) return { id: 'agents-local', ok: false, present: true, detail: 'missing auto-generated header' };
  return { id: 'agents-local', ok: true, present: true };
}

function pathEscapes(root, target) {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

async function checkClaudeLink(dir) {
  let rootReal = dir;
  try { rootReal = await realpath(dir); } catch { rootReal = dir; }
  const claude = join(dir, '.claude');
  let parent;
  try {
    parent = await lstat(claude);
  } catch (error) {
    if (error?.code === 'ENOENT') return { id: 'claude-skills-link', ok: true, present: false };
    return { id: 'claude-skills-link', ok: false, detail: errorMessage(error) };
  }
  if (!parent.isSymbolicLink() && !parent.isDirectory()) {
    return { id: 'claude-skills-link', ok: false, present: true, detail: '.claude is not a directory' };
  }
  let claudeReal;
  try {
    claudeReal = await realpath(claude);
  } catch (error) {
    return { id: 'claude-skills-link', ok: false, present: true, detail: errorMessage(error) };
  }
  if (pathEscapes(rootReal, claudeReal)) {
    return { id: 'claude-skills-link', ok: false, present: true, detail: `.claude resolves outside the worktree (${claudeReal})` };
  }
  const link = join(dir, '.claude', 'skills');
  const source = join(dir, '.agents', 'skills');
  let info;
  try {
    info = await lstat(link);
  } catch (error) {
    if (error?.code === 'ENOENT') return { id: 'claude-skills-link', ok: true, present: false };
    return { id: 'claude-skills-link', ok: false, detail: errorMessage(error) };
  }
  if (!info.isSymbolicLink()) return { id: 'claude-skills-link', ok: false, present: true, detail: '.claude/skills is not a symlink' };
  const raw = await readlink(link);
  let same = false;
  try {
    same = await stat(link).then(found => found.isDirectory()) && resolve(dir, '.claude', raw) === resolve(source);
  } catch {
    same = false;
  }
  const relativeOk = raw === '../.agents/skills' || raw === '..\\agents\\skills';
  if (!same && !relativeOk) return { id: 'claude-skills-link', ok: false, present: true, detail: `symlink target ${raw} is not .agents/skills` };
  return { id: 'claude-skills-link', ok: true, present: true };
}

async function checkNoHooks(dir) {
  const hooks = join(dir, '.agents', 'hooks');
  const info = await lstat(hooks).catch(error => (error?.code === 'ENOENT' ? undefined : error));
  if (info instanceof Error) return { id: 'no-hooks', ok: false, detail: errorMessage(info) };
  if (info) return { id: 'no-hooks', ok: false, detail: '.agents/hooks exists' };
  return { id: 'no-hooks', ok: true };
}

async function checkGitStatus(dir) {
  let stdout;
  try {
    // Ignore the developer's private excludes file. The gate judges the worktree's own rules,
    // so a global AGENTS.local.md ignore cannot hide a repository that forgot to ignore the projection.
    const result = await execFileAsync('git', [
      '-c', 'core.excludesFile=/dev/null', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall',
    ], { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    return { id: 'git-status', ok: false, detail: errorMessage(error) };
  }
  const leaks = porcelainLeaks(stdout);
  return leaks.length
    ? { id: 'git-status', ok: false, detail: `projection or untracked role path in git status: ${leaks.join(', ')}` }
    : { id: 'git-status', ok: true };
}

async function gitOutput(dir, gitArgs) {
  const result = await execFileAsync('git', ['--no-optional-locks', ...gitArgs], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

function extractAociBlock(text, label) {
  const beginIndex = text.indexOf(AOCI_BEGIN);
  if (beginIndex === -1) return { ok: false, detail: `${label} is missing ${AOCI_BEGIN}` };
  if (text.indexOf(AOCI_BEGIN, beginIndex + AOCI_BEGIN.length) !== -1) {
    return { ok: false, detail: `${label} has multiple ${AOCI_BEGIN} markers` };
  }
  const endIndex = text.indexOf(AOCI_END);
  if (endIndex === -1) return { ok: false, detail: `${label} is missing ${AOCI_END}` };
  if (text.indexOf(AOCI_END, endIndex + AOCI_END.length) !== -1) {
    return { ok: false, detail: `${label} has multiple ${AOCI_END} markers` };
  }
  if (endIndex < beginIndex) {
    return { ok: false, detail: `${label} has ${AOCI_END} before ${AOCI_BEGIN}` };
  }
  return { ok: true, block: text.slice(beginIndex, endIndex + AOCI_END.length) };
}

/**
 * The single fail-closed baseline for every git-derived check.
 *
 * The anchor is always merge-base(HEAD, refs/remotes/origin/main). The gate never fetches, so a
 * missing or stale origin/main fails closed instead of silently comparing against nothing. An
 * explicit `--base-ref` cannot move the anchor: it must resolve to that exact same merge-base, so
 * passing HEAD or a branch that also changed a protected path cannot widen the changed-path window.
 * @returns `{ ok: true, baseRef, baseSha }` or `{ ok: false, baseRef, baseSha, detail }`.
 */
async function resolveBaseline(dir, explicitBaseRef, anchorOk) {
  const reportedRef = explicitBaseRef ?? 'origin/main';
  if (!anchorOk) {
    return { ok: false, baseRef: reportedRef, baseSha: null, detail: 'missing .git anchor (fail-closed)' };
  }
  if (explicitBaseRef !== undefined && (!explicitBaseRef.trim() || explicitBaseRef.startsWith('-'))) {
    return { ok: false, baseRef: explicitBaseRef, baseSha: null, detail: 'invalid --base-ref (fail-closed)' };
  }
  let originMainSha;
  try {
    originMainSha = (await gitOutput(dir, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])).trim();
  } catch {
    return {
      ok: false,
      baseRef: reportedRef,
      baseSha: null,
      detail: 'missing refs/remotes/origin/main (fail-closed; gate never fetches)',
    };
  }
  let originMergeBase;
  try {
    originMergeBase = (await gitOutput(dir, ['merge-base', 'HEAD', originMainSha])).trim();
  } catch (error) {
    return {
      ok: false,
      baseRef: reportedRef,
      baseSha: null,
      detail: `cannot compute merge-base(HEAD, origin/main): ${errorMessage(error)}`,
    };
  }

  let baseSha = originMergeBase;
  if (explicitBaseRef !== undefined) {
    let resolvedRefSha;
    try {
      resolvedRefSha = (await gitOutput(dir, ['rev-parse', '--verify', `${explicitBaseRef}^{commit}`])).trim();
    } catch {
      return {
        ok: false,
        baseRef: reportedRef,
        baseSha: null,
        detail: `--base-ref "${explicitBaseRef}" does not resolve to a commit`,
      };
    }
    try {
      baseSha = (await gitOutput(dir, ['merge-base', 'HEAD', resolvedRefSha])).trim();
    } catch (error) {
      return {
        ok: false,
        baseRef: reportedRef,
        baseSha: null,
        detail: `cannot compute merge-base(HEAD, ${explicitBaseRef}): ${errorMessage(error)}`,
      };
    }
    try {
      await gitOutput(dir, ['merge-base', '--is-ancestor', baseSha, originMainSha]);
    } catch {
      return {
        ok: false,
        baseRef: reportedRef,
        baseSha,
        detail: `resolved baseSha ${baseSha} for --base-ref "${explicitBaseRef}" is not an ancestor of origin/main`,
      };
    }
    if (baseSha !== originMergeBase) {
      return {
        ok: false,
        baseRef: reportedRef,
        baseSha,
        detail: `merge-base(HEAD, ${explicitBaseRef}) (${baseSha}) does not match merge-base(HEAD, origin/main) (${originMergeBase})`,
      };
    }
  }

  return { ok: true, baseRef: reportedRef, baseSha };
}

async function checkAociBlockImmutable(dir, baseline) {
  if (!baseline.ok) return { id: 'aoci_block_immutable', ...baseline };
  const { baseRef: reportedRef, baseSha } = baseline;

  let baseAgents;
  try {
    baseAgents = await gitOutput(dir, ['show', `${baseSha}:AGENTS.md`]);
  } catch {
    return {
      id: 'aoci_block_immutable',
      ok: false,
      baseRef: reportedRef,
      baseSha,
      detail: `baseline ${baseSha}:AGENTS.md is missing (fail-closed)`,
    };
  }
  const baseBlock = extractAociBlock(baseAgents, `${baseSha}:AGENTS.md`);
  if (!baseBlock.ok) {
    return { id: 'aoci_block_immutable', ok: false, baseRef: reportedRef, baseSha, detail: `${baseBlock.detail} (fail-closed)` };
  }

  const agentsPath = join(dir, 'AGENTS.md');
  let agentsInfo;
  try {
    agentsInfo = await lstat(agentsPath);
  } catch (error) {
    return { id: 'aoci_block_immutable', ok: false, baseRef: reportedRef, baseSha, detail: `working tree AGENTS.md missing: ${errorMessage(error)}` };
  }
  if (agentsInfo.isSymbolicLink() || !agentsInfo.isFile()) {
    return { id: 'aoci_block_immutable', ok: false, baseRef: reportedRef, baseSha, detail: 'working tree AGENTS.md must be a regular file' };
  }
  const worktreeAgents = await readFile(agentsPath, 'utf8');
  const worktreeBlock = extractAociBlock(worktreeAgents, 'working tree AGENTS.md');
  if (!worktreeBlock.ok) {
    return { id: 'aoci_block_immutable', ok: false, baseRef: reportedRef, baseSha, detail: worktreeBlock.detail };
  }
  if (worktreeBlock.block !== baseBlock.block) {
    return {
      id: 'aoci_block_immutable',
      ok: false,
      baseRef: reportedRef,
      baseSha,
      detail: `working tree AGENTS.md modified the AOCI block relative to ${baseSha}`,
    };
  }

  let headAgents;
  try {
    headAgents = await gitOutput(dir, ['show', 'HEAD:AGENTS.md']);
  } catch {
    return { id: 'aoci_block_immutable', ok: false, baseRef: reportedRef, baseSha, detail: 'HEAD:AGENTS.md is missing (fail-closed)' };
  }
  const headBlock = extractAociBlock(headAgents, 'HEAD:AGENTS.md');
  if (!headBlock.ok) {
    return { id: 'aoci_block_immutable', ok: false, baseRef: reportedRef, baseSha, detail: headBlock.detail };
  }
  if (headBlock.block !== baseBlock.block) {
    return {
      id: 'aoci_block_immutable',
      ok: false,
      baseRef: reportedRef,
      baseSha,
      detail: `HEAD:AGENTS.md modified the AOCI block relative to ${baseSha}`,
    };
  }

  try {
    const stagedAgents = await gitOutput(dir, ['show', ':AGENTS.md']);
    const stagedBlock = extractAociBlock(stagedAgents, 'index :AGENTS.md');
    if (!stagedBlock.ok) {
      return { id: 'aoci_block_immutable', ok: false, baseRef: reportedRef, baseSha, detail: stagedBlock.detail };
    }
    if (stagedBlock.block !== baseBlock.block) {
      return {
        id: 'aoci_block_immutable',
        ok: false,
        baseRef: reportedRef,
        baseSha,
        detail: `staged :AGENTS.md modified the AOCI block relative to ${baseSha}`,
      };
    }
  } catch {
    return { id: 'aoci_block_immutable', ok: false, baseRef: reportedRef, baseSha, detail: 'staged :AGENTS.md is missing (fail-closed)' };
  }

  return { id: 'aoci_block_immutable', ok: true, baseRef: reportedRef, baseSha };
}

/** The untracked projection artifacts are gitignored by contract; they never count as a change. */
function isProjectionPath(file) {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  return PROJECTION_PATHS.includes(normalized)
    || normalized === '.agents' || normalized.startsWith('.agents/')
    || normalized === '.claude' || normalized.startsWith('.claude/');
}

/**
 * Every path this worktree changed relative to the baseline: the committed range, the index, the
 * working tree and untracked files. Rename and copy source+target both count, so moving a file out
 * of a protected directory is still a change to it.
 */
async function collectChangedPaths(dir, baseSha) {
  const paths = new Set();
  const failures = [];
  const add = value => {
    if (!value) return;
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalized) paths.add(normalized);
  };
  const diffs = [
    ['diff', '--name-status', '-z', '--find-renames', '--find-copies', `${baseSha}..HEAD`],
    ['diff', '--cached', '--name-status', '-z', '--find-renames', '--find-copies'],
    ['diff', '--name-status', '-z', '--find-renames', '--find-copies'],
  ];
  for (const gitArgs of diffs) {
    try {
      for (const path of diffNameStatusPaths(await gitOutput(dir, gitArgs))) add(path);
    } catch (error) {
      failures.push(`${gitArgs.slice(0, gitArgs.includes('--cached') ? 2 : 1).join(' ')}: ${errorMessage(error)}`);
    }
  }
  if (failures.length) return { paths: [...paths], failures };
  try {
    // Same global-excludes hardening as checkGitStatus: a private excludes file cannot hide an
    // untracked change from the gate. A repository's own .gitignore still decides what is untracked.
    const stdout = await gitOutput(dir, ['-c', 'core.excludesFile=/dev/null', 'status', '--porcelain=v1', '-z', '-uall']);
    for (const entry of porcelainEntries(stdout)) {
      if (entry.xy === '??' && !isProjectionPath(entry.path)) add(entry.path);
    }
  } catch (error) {
    failures.push(`status: ${errorMessage(error)}`);
  }
  return { paths: [...paths].sort(), failures };
}

/** `git diff --name-status -z` emits `status\0path\0`, or `R<n>\0from\0to\0` for a rename/copy. */
function diffNameStatusPaths(stdout) {
  const paths = [];
  const fields = stdout.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (!status) continue;
    const first = fields[++index];
    if (first === undefined) break;
    paths.push(first);
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = fields[++index];
      if (second !== undefined) paths.push(second);
    }
  }
  return paths;
}

/**
 * The role exams under `.1agents/roles/<role>/evals/` are the grader, not the code under test.
 * Any change to them — committed, staged, unstaged or untracked — fails the gate unless a person
 * approved an `eval_change` proposal and passed `--allow-eval-change`.
 */
async function checkEvalsImmutable(dir, baseline, overridden) {
  const id = 'evals_immutable';
  if (!baseline.ok) return { id, ...baseline };
  const collected = await collectChangedPaths(dir, baseline.baseSha);
  if (collected.failures.length) {
    return {
      id,
      ok: false,
      baseRef: baseline.baseRef,
      baseSha: baseline.baseSha,
      violations: [],
      detail: `cannot enumerate changed paths: ${collected.failures.join('; ')}`,
    };
  }
  const violations = collected.paths.filter(path => EVALS_PATH.test(path));
  if (overridden) return { id, ok: true, overridden: true, baseRef: baseline.baseRef, baseSha: baseline.baseSha };
  return violations.length
    ? { id, ok: false, baseRef: baseline.baseRef, baseSha: baseline.baseSha, violations }
    : { id, ok: true, baseRef: baseline.baseRef, baseSha: baseline.baseSha };
}

/** Opt-in authorization whitelist: every changed path must match one `--allowed-paths` entry. */
async function checkAllowedPaths(dir, baseline, patterns) {
  const id = 'allowed_paths';
  if (!baseline.ok) return { id, ...baseline, patterns };
  const collected = await collectChangedPaths(dir, baseline.baseSha);
  if (collected.failures.length) {
    return {
      id,
      ok: false,
      baseRef: baseline.baseRef,
      baseSha: baseline.baseSha,
      patterns,
      violations: [],
      detail: `cannot enumerate changed paths: ${collected.failures.join('; ')}`,
    };
  }
  const violations = collected.paths.filter(path => !patterns.some(pattern => allowedPathMatches(path, pattern)));
  return violations.length
    ? { id, ok: false, baseRef: baseline.baseRef, baseSha: baseline.baseSha, patterns, violations }
    : { id, ok: true, baseRef: baseline.baseRef, baseSha: baseline.baseSha, patterns };
}

/** Reject a whitelist that could never be satisfied honestly: absolute, escaping or empty entries. */
function parseAllowedPaths(values) {
  const patterns = [];
  for (const value of values) {
    for (const raw of value.split(',')) {
      const candidate = raw.trim().replaceAll('\\', '/').replace(/^\.\//, '');
      if (!candidate) continue;
      if (candidate.startsWith('-')) {
        return { ok: false, detail: `invalid --allowed-paths entry "${candidate}" (looks like a flag, not a path)` };
      }
      if (candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)) {
        return { ok: false, detail: `--allowed-paths entry "${candidate}" must be relative to the worktree` };
      }
      if (candidate.split('/').includes('..')) {
        return { ok: false, detail: `--allowed-paths entry "${candidate}" escapes the worktree` };
      }
      patterns.push(candidate.replace(/\/{2,}/g, '/'));
    }
  }
  if (!patterns.length) return { ok: false, detail: '--allowed-paths requires at least one non-empty path' };
  return { ok: true, patterns };
}

/** Exact file, directory prefix (`dir/` or `dir`) or glob (`*` one segment, `**` across segments). */
function allowedPathMatches(file, pattern) {
  const normalized = file.replaceAll('\\', '/');
  if (normalized === pattern) return true;
  if (!pattern.includes('*')) {
    const directory = pattern.replace(/\/+$/, '');
    return directory !== '' && normalized.startsWith(`${directory}/`);
  }
  return globToRegExp(pattern.endsWith('/') ? `${pattern}**` : pattern).test(normalized);
}

function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` also matches zero directories, so `**/*.ts` covers the repository root.
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]+/)*';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

async function checkRoleSource(dir) {
  const profilePath = join(dir, 'profile.json');
  let profile;
  try {
    profile = JSON.parse(await readFile(profilePath, 'utf8'));
  } catch (error) {
    return { id: 'role-source', ok: false, detail: errorMessage(error) };
  }
  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  const failures = [];
  for (const skill of skills) {
    const name = skill?.name;
    if (typeof name !== 'string') {
      failures.push('skill missing name');
      continue;
    }
    try {
      validateSkillFrontmatter(await readFile(join(dir, 'skills', name, 'SKILL.md'), 'utf8'), name);
    } catch (error) {
      failures.push(`${name}: ${errorMessage(error)}`);
    }
  }
  return failures.length
    ? { id: 'role-source', ok: false, detail: failures.join('; ') }
    : { id: 'role-source', ok: true, checked: skills.length };
}

/** `git status --porcelain=v1 -z` records, including the source path of a rename or copy. */
function porcelainEntries(stdout) {
  const entries = [];
  let offset = 0;
  while (offset < stdout.length) {
    const end = stdout.indexOf('\0', offset);
    if (end < 0 || end < offset + 3) break;
    const xy = stdout.slice(offset, offset + 2);
    const path = stdout.slice(offset + 3, end);
    offset = end + 1;
    const entry = { xy, path, from: undefined };
    if (xy.includes('R') || xy.includes('C')) {
      const end2 = stdout.indexOf('\0', offset);
      if (end2 < 0) break;
      entry.from = stdout.slice(offset, end2);
      offset = end2 + 1;
    }
    entries.push(entry);
  }
  return entries;
}

function porcelainLeaks(stdout) {
  const leaks = [];
  for (const entry of porcelainEntries(stdout)) {
    for (const path of [entry.path, entry.from]) {
      if (path && isStatusLeak(entry.xy, path)) leaks.push(path);
    }
  }
  return leaks;
}

function isStatusLeak(xy, path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (CONFIG_EXAMPLE.test(normalized)) return false;
  const watched = normalized === 'AGENTS.local.md' || normalized === 'CLAUDE.local.md'
    || normalized === '.agents' || normalized.startsWith('.agents/')
    || normalized === '.claude' || normalized.startsWith('.claude/')
    || normalized === '.1agents/jobs' || normalized.startsWith('.1agents/jobs/')
    || normalized === '.1agents/worktrees' || normalized.startsWith('.1agents/worktrees/')
    || normalized === '.1agents/runtime' || normalized.startsWith('.1agents/runtime/')
    || normalized === '.1agents/state' || normalized.startsWith('.1agents/state/')
    || normalized === '.1agents/cache' || normalized.startsWith('.1agents/cache/')
    || normalized === '.1agents/skills' || normalized.startsWith('.1agents/skills/')
    || normalized === '.1agents/config' || normalized.startsWith('.1agents/config/');
  if (!watched) return false;
  if (xy === '??') return true;
  const index = xy[0];
  return index === 'A' || index === 'C' || index === 'R';
}

function validateSkillFrontmatter(text, expectedName) {
  if (!SKILL_NAME.test(expectedName)) throw new Error(`Expected skill name "${expectedName}" is not kebab-case`);
  const data = parseFrontmatter(text);
  for (const key of Object.keys(data)) {
    if (LEGACY[key]) throw new Error(`Skill frontmatter rejects legacy key "${key}"; use "${LEGACY[key]}"`);
  }
  const name = data.name;
  if (!name) throw new Error('Skill frontmatter requires kebab-case name');
  if (name.kind !== 'string') throw new Error('Skill frontmatter name must be a string');
  if (!SKILL_NAME.test(name.value)) throw new Error(`Skill frontmatter name "${name.value}" is not kebab-case`);
  if (name.value !== expectedName) throw new Error(`Skill frontmatter name "${name.value}" does not match ${expectedName}`);
  const description = data.description;
  if (!description) throw new Error('Skill frontmatter requires a non-empty description');
  if (description.kind !== 'string') throw new Error('Skill frontmatter description must be a string');
  if (description.value.trim() === '') throw new Error('Skill frontmatter requires a non-empty description');
}

function parseFrontmatter(text) {
  if (text.charCodeAt(0) === 0xfeff) throw new Error('Skill frontmatter rejects a UTF-8 BOM');
  const fence = /^(---)\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!fence) throw new Error('Skill frontmatter requires an opening --- fence');
  const data = {};
  for (const rawLine of fence[2].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Skill frontmatter has an unreadable line: ${line.slice(0, 80)}`);
    const key = match[1] ?? match[2] ?? match[3];
    if (Object.hasOwn(data, key)) throw new Error(`Skill frontmatter has duplicate key "${key}"`);
    data[key] = parseScalar(match[4] ?? '');
  }
  return data;
}

function parseScalar(raw) {
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
