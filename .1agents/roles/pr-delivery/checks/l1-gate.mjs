#!/usr/bin/env node
/**
 * Deterministic L1 gate for a pr-delivery worktree.
 * Twin of packages/service/src/roles/worktree-projection.ts validateSkillFrontmatter.
 * DSH 0.2.2-rc.5 drops a skill whose frontmatter uses disableModelInvocation, modelInvocable, or userInvocable.
 *
 *   node .1agents/roles/pr-delivery/checks/l1-gate.mjs --worktree <dir> [--role-dir <dir>]
 */
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HEADER = '<!-- AUTO-GENERATED FROM .1agents/roles/pr-delivery — DO NOT EDIT -->';
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LEGACY = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
};

const args = process.argv.slice(2);
let worktree;
let roleDir;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--worktree') worktree = args[++index];
  else if (arg === '--role-dir') roleDir = args[++index];
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
const checks = [];
const anchor = await checkGitAnchor(root);
checks.push(anchor);
checks.push(await checkSkillFrontmatter(root));
checks.push(await checkAgentsLocal(root));
checks.push(await checkClaudeLink(root));
checks.push(await checkNoHooks(root));
checks.push(anchor.ok ? await checkGitStatus(root) : { id: 'git-status', ok: true, skipped: true, detail: 'skipped because .git anchor is missing' });
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

async function checkClaudeLink(dir) {
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

function porcelainLeaks(stdout) {
  const leaks = [];
  let offset = 0;
  while (offset < stdout.length) {
    const end = stdout.indexOf('\0', offset);
    if (end < 0 || end < offset + 3) break;
    const xy = stdout.slice(offset, offset + 2);
    const first = stdout.slice(offset + 3, end);
    offset = end + 1;
    const renamed = xy.includes('R') || xy.includes('C');
    let second;
    if (renamed) {
      const end2 = stdout.indexOf('\0', offset);
      if (end2 < 0) break;
      second = stdout.slice(offset, end2);
      offset = end2 + 1;
    }
    for (const path of [first, second]) {
      if (path && isStatusLeak(xy, path)) leaks.push(path);
    }
  }
  return leaks;
}

function isStatusLeak(xy, path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const watched = normalized === 'AGENTS.local.md' || normalized === 'CLAUDE.local.md'
    || normalized === '.agents' || normalized.startsWith('.agents/')
    || normalized === '.claude' || normalized.startsWith('.claude/')
    || normalized === '.1agents/jobs' || normalized.startsWith('.1agents/jobs/')
    || normalized === '.1agents/worktrees' || normalized.startsWith('.1agents/worktrees/')
    || normalized === '.1agents/runtime' || normalized.startsWith('.1agents/runtime/')
    || normalized === '.1agents/state' || normalized.startsWith('.1agents/state/');
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
