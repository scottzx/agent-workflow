/**
 * BL-003: the deterministic `evals_immutable` and `--allowed-paths` machine checks of the L1 gate.
 *
 * Every case drives the real `checks/l1-gate.mjs` process against a throwaway git repository, and
 * asserts the observed exit code plus the JSON summary. Two anchors of the design are pinned here:
 *
 * 1. `evals_immutable` is always on and rejects a change to `.1agents/roles/<role>/evals/` in every
 *    shape — unstaged, staged, committed (`baseSha..HEAD`) and untracked — unless a person approved
 *    it with `--allow-eval-change`. Renaming an eval file away is still a change to it.
 * 2. `--allowed-paths` is opt-in and fail-closed: an empty, absolute, escaping or missing spec is a
 *    usage error, and any changed path outside the whitelist fails the gate.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../..');
const gate = join(repoRoot, '.1agents/roles/pr-delivery/checks/l1-gate.mjs');
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'l1-gate-test',
  GIT_AUTHOR_EMAIL: 'l1-gate-test@example.com',
  GIT_COMMITTER_NAME: 'l1-gate-test',
  GIT_COMMITTER_EMAIL: 'l1-gate-test@example.com',
};
const ignoreRules = ['/.agents/skills/*', '/.claude/', '**/AGENTS.local.md', '**/CLAUDE.local.md'];
const DEFAULT_AGENTS_MD = [
  '# Repo Agents',
  'SENTINEL',
  '',
  '<!-- aoci:begin -->',
  '## AOCI 仓库认知',
  'DO NOT MODIFY THIS BLOCK',
  '<!-- aoci:end -->',
  '',
].join('\n');
const EVAL_MANIFEST = '{"schemaVersion":1,"cases":[]}\n';

interface CheckResult {
  id: string;
  ok: boolean;
  detail?: string;
  baseRef?: string;
  baseSha?: string | null;
  overridden?: boolean;
  violations?: string[];
  patterns?: string[];
  skipped?: boolean;
}
interface GateSummary { ok: boolean; worktree: string | null; checks: CheckResult[] }

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd, env: gitEnv });
  return result.stdout;
}

async function runGate(worktree: string, extra: string[] = []): Promise<{ status: number; body: GateSummary }> {
  try {
    const result = await exec(process.execPath, [gate, '--worktree', worktree, ...extra], { encoding: 'utf8' });
    return { status: 0, body: JSON.parse(result.stdout) as GateSummary };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { status: typeof failed.code === 'number' ? failed.code : 1, body: JSON.parse(failed.stdout ?? '') as GateSummary };
  }
}

function check(body: GateSummary, id: string): CheckResult {
  const found = body.checks.find(item => item.id === id);
  assert.ok(found, `missing ${id} in ${JSON.stringify(body.checks)}`);
  return found!;
}

/** A repository whose only role asset is one tracked eval manifest, so any eval edit is the only change. */
async function initRepo(): Promise<{ parent: string; root: string; baseSha: string }> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'l1-gate-hardening-')));
  const root = join(parent, 'repo');
  await mkdir(join(root, '.1agents/roles/pr-delivery/evals'), { recursive: true });
  await git(root, ['init', '-b', 'main']);
  await writeFile(join(root, '.gitignore'), `${ignoreRules.join('\n')}\n`);
  await writeFile(join(root, 'AGENTS.md'), DEFAULT_AGENTS_MD);
  await writeFile(join(root, 'README.md'), 'anchor\n');
  await writeFile(join(root, '.1agents/roles/pr-delivery/evals/manifest.json'), EVAL_MANIFEST);
  await git(root, ['add', '.gitignore', 'AGENTS.md', 'README.md', '.1agents/roles/pr-delivery/evals/manifest.json']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'init']);
  const baseSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  await git(root, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  return { parent, root, baseSha };
}

test('evals_immutable is on by default and catches unstaged, staged, committed, renamed and untracked eval changes', async t => {
  const repo = await initRepo();
  t.after(() => rm(repo.parent, { recursive: true, force: true }));
  const manifest = join(repo.root, '.1agents/roles/pr-delivery/evals/manifest.json');

  const clean = await runGate(repo.root);
  assert.equal(clean.status, 0, JSON.stringify(clean.body));
  const cleanEvals = check(clean.body, 'evals_immutable');
  assert.equal(cleanEvals.ok, true);
  assert.equal(cleanEvals.baseRef, 'origin/main');
  assert.equal(cleanEvals.baseSha, repo.baseSha);
  assert.equal('violations' in cleanEvals, false, 'a passing check reports no violations');

  // 1. Unstaged working-tree edit.
  await writeFile(manifest, '{"schemaVersion":1,"cases":["edited"]}\n');
  const unstaged = await runGate(repo.root);
  assert.equal(unstaged.status, 1, JSON.stringify(unstaged.body));
  assert.equal(unstaged.body.ok, false);
  const unstagedEvals = check(unstaged.body, 'evals_immutable');
  assert.equal(unstagedEvals.ok, false);
  assert.deepEqual(unstagedEvals.violations, ['.1agents/roles/pr-delivery/evals/manifest.json']);

  // 2. Staged edit.
  await git(repo.root, ['add', '.1agents/roles/pr-delivery/evals/manifest.json']);
  const staged = await runGate(repo.root);
  assert.equal(staged.status, 1, JSON.stringify(staged.body));
  assert.deepEqual(check(staged.body, 'evals_immutable').violations, ['.1agents/roles/pr-delivery/evals/manifest.json']);

  // 3. Committed edit: the baseline range, not just the working tree, must catch it.
  await git(repo.root, ['commit', '--no-gpg-sign', '-m', 'relax the exam']);
  assert.equal((await git(repo.root, ['status', '--porcelain'])).trim(), '', 'the tree is clean before the gate runs');
  const committed = await runGate(repo.root);
  assert.equal(committed.status, 1, JSON.stringify(committed.body));
  assert.deepEqual(check(committed.body, 'evals_immutable').violations, ['.1agents/roles/pr-delivery/evals/manifest.json']);

  // A forged --base-ref cannot move the anchor: every git-derived check shares resolveBaseline().
  const forged = await runGate(repo.root, ['--base-ref', 'HEAD']);
  assert.equal(forged.status, 1, JSON.stringify(forged.body));
  const forgedEvals = check(forged.body, 'evals_immutable');
  assert.equal(forgedEvals.ok, false);
  assert.match(forgedEvals.detail ?? '', /is not an ancestor of origin\/main|does not match merge-base/);

  // Any other role's exam directory is protected by the same rule.
  await git(repo.root, ['reset', '--hard', repo.baseSha]);
  await mkdir(join(repo.root, '.1agents/roles/pr-coach/evals'), { recursive: true });
  await writeFile(join(repo.root, '.1agents/roles/pr-coach/evals/new-case.json'), '{}\n');
  const untracked = await runGate(repo.root);
  assert.equal(untracked.status, 1, JSON.stringify(untracked.body));
  assert.deepEqual(check(untracked.body, 'evals_immutable').violations, ['.1agents/roles/pr-coach/evals/new-case.json']);

  // A rename or copy out of evals/ still changes the eval file: the diff source path counts.
  await rm(join(repo.root, '.1agents/roles/pr-coach/evals/new-case.json'));
  await mkdir(join(repo.root, 'docs'), { recursive: true });
  await git(repo.root, ['mv', '.1agents/roles/pr-delivery/evals/manifest.json', 'docs/manifest.json']);
  await git(repo.root, ['commit', '--no-gpg-sign', '-m', 'move the exam out of the way']);
  const renamed = await runGate(repo.root);
  assert.equal(renamed.status, 1, JSON.stringify(renamed.body));
  const renamedEvals = check(renamed.body, 'evals_immutable');
  assert.equal(renamedEvals.ok, false);
  assert.deepEqual(renamedEvals.violations, ['.1agents/roles/pr-delivery/evals/manifest.json'], 'the rename source path is a change to the eval file');

  // `--allow-eval-change` is the only override, and it names itself in the summary.
  const approved = await runGate(repo.root, ['--allow-eval-change']);
  assert.equal(approved.status, 0, JSON.stringify(approved.body));
  assert.equal(approved.body.ok, true);
  const approvedEvals = check(approved.body, 'evals_immutable');
  assert.equal(approvedEvals.ok, true);
  assert.equal(approvedEvals.overridden, true);
  assert.equal(approvedEvals.baseRef, 'origin/main');
  assert.equal(approvedEvals.baseSha, repo.baseSha);
  assert.equal('violations' in approvedEvals, false);
});

test('evals_immutable fails closed without a .git anchor or origin/main', async t => {
  const bareParent = await realpath(await mkdtemp(join(tmpdir(), 'l1-gate-bare-')));
  t.after(() => rm(bareParent, { recursive: true, force: true }));
  const bare = join(bareParent, 'bare');
  await mkdir(bare);
  const noAnchor = await runGate(bare);
  assert.equal(noAnchor.status, 1);
  const anchorEvals = check(noAnchor.body, 'evals_immutable');
  assert.equal(anchorEvals.ok, false);
  assert.equal(anchorEvals.baseSha, null);
  assert.match(anchorEvals.detail ?? '', /missing \.git anchor/);

  const repo = await initRepo();
  t.after(() => rm(repo.parent, { recursive: true, force: true }));
  await git(repo.root, ['update-ref', '-d', 'refs/remotes/origin/main']);
  const noOrigin = await runGate(repo.root);
  assert.equal(noOrigin.status, 1);
  const originEvals = check(noOrigin.body, 'evals_immutable');
  assert.equal(originEvals.ok, false);
  assert.equal(originEvals.baseSha, null);
  assert.match(originEvals.detail ?? '', /origin\/main \(fail-closed; gate never fetches\)/);

  // The whitelist check is just as fail-closed: an unverifiable baseline never authorizes a path.
  const whitelistEvals = check((await runGate(repo.root, ['--allowed-paths', 'README.md'])).body, 'allowed_paths');
  assert.equal(whitelistEvals.ok, false);
  assert.equal(whitelistEvals.baseSha, null);
});

test('--allowed-paths authorizes exact files, directory prefixes and globs, and rejects every other changed path', async t => {
  const repo = await initRepo();
  t.after(() => rm(repo.parent, { recursive: true, force: true }));
  const source = join(repo.root, 'packages/service/src/a.ts');
  const notes = join(repo.root, 'docs/notes.md');
  await mkdir(join(repo.root, 'packages/service/src'), { recursive: true });
  await writeFile(source, 'export const a = 1;\n');
  await git(repo.root, ['add', 'packages/service/src/a.ts']);
  await git(repo.root, ['commit', '--no-gpg-sign', '-m', 'feat: add a']);
  await mkdir(join(repo.root, 'docs'), { recursive: true });
  await writeFile(notes, '# notes\n');

  // Without the flag the gate keeps its historical shape: no whitelist check, and nothing blocked.
  const unflagged = await runGate(repo.root);
  assert.equal(unflagged.status, 0, JSON.stringify(unflagged.body));
  assert.equal(unflagged.body.checks.some(item => item.id === 'allowed_paths'), false,
    'the whitelist is opt-in and must not appear in the default summary');

  // The untracked docs file is outside an exact-file whitelist for the committed source file.
  const exact = await runGate(repo.root, ['--allowed-paths', 'packages/service/src/a.ts']);
  assert.equal(exact.status, 1, JSON.stringify(exact.body));
  const exactCheck = check(exact.body, 'allowed_paths');
  assert.equal(exactCheck.ok, false);
  assert.deepEqual(exactCheck.violations, ['docs/notes.md']);
  assert.deepEqual(exactCheck.patterns, ['packages/service/src/a.ts']);

  // A staged path is judged the same way as an untracked one.
  await git(repo.root, ['add', 'docs/notes.md']);
  const staged = await runGate(repo.root, ['--allowed-paths', 'packages/service/src/a.ts']);
  assert.equal(staged.status, 1, JSON.stringify(staged.body));
  assert.deepEqual(check(staged.body, 'allowed_paths').violations, ['docs/notes.md']);
  await git(repo.root, ['reset', 'HEAD', 'docs/notes.md']);

  // Directory prefixes: with a trailing slash, and as a bare directory name.
  const trailingSlash = await runGate(repo.root, ['--allowed-paths', 'packages/service/src/,docs/']);
  assert.equal(trailingSlash.status, 0, JSON.stringify(trailingSlash.body));
  assert.equal(check(trailingSlash.body, 'allowed_paths').ok, true);
  const bareDirectory = await runGate(repo.root, ['--allowed-paths', 'packages']);
  assert.equal(bareDirectory.status, 1, JSON.stringify(bareDirectory.body));
  assert.deepEqual(check(bareDirectory.body, 'allowed_paths').violations, ['docs/notes.md']);

  // Globs: `*` stays inside one segment while `**` crosses them; repeated and comma-separated specs combine.
  const singleSegment = await runGate(repo.root, ['--allowed-paths', 'packages/*/src/*.ts,docs/*.md']);
  assert.equal(singleSegment.status, 0, JSON.stringify(singleSegment.body));
  const recursive = await runGate(repo.root, ['--allowed-paths', 'packages/**', '--allowed-paths', 'docs/**']);
  assert.equal(recursive.status, 0, JSON.stringify(recursive.body));
  const crossSegmentOnly = await runGate(repo.root, ['--allowed-paths', 'packages/*']);
  assert.equal(crossSegmentOnly.status, 1, JSON.stringify(crossSegmentOnly.body));
  assert.deepEqual(check(crossSegmentOnly.body, 'allowed_paths').violations, ['docs/notes.md', 'packages/service/src/a.ts'],
    'packages/* authorizes neither a nested source file nor the untracked docs file');
});

test('--allowed-paths fails closed on a missing, empty, absolute or escaping spec', async t => {
  const repo = await initRepo();
  t.after(() => rm(repo.parent, { recursive: true, force: true }));
  const usage = async (extra: string[]): Promise<GateSummary> => {
    const result = await runGate(repo.root, extra);
    assert.equal(result.status, 1, `expected a usage failure for ${JSON.stringify(extra)}`);
    assert.equal(result.body.ok, false);
    const entry = check(result.body, 'usage');
    assert.equal(entry.ok, false);
    assert.equal(result.body.checks.some(item => item.id === 'allowed_paths'), false,
      'an unusable whitelist fails before any path is judged');
    return result.body;
  };

  assert.match(check(await usage(['--allowed-paths']), 'usage').detail ?? '', /missing value for --allowed-paths/);
  assert.match(check(await usage(['--allowed-paths', '']), 'usage').detail ?? '', /at least one non-empty path/);
  assert.match(check(await usage(['--allowed-paths', ' , ,']), 'usage').detail ?? '', /at least one non-empty path/);
  assert.match(check(await usage(['--allowed-paths', '/etc/passwd']), 'usage').detail ?? '', /must be relative to the worktree/);
  assert.match(check(await usage(['--allowed-paths', '../outside']), 'usage').detail ?? '', /escapes the worktree/);
  assert.match(check(await usage(['--allowed-paths', 'docs/../../outside']), 'usage').detail ?? '', /escapes the worktree/);
  assert.match(check(await usage(['--allowed-paths', '--allow-eval-change']), 'usage').detail ?? '', /looks like a flag/);
});
