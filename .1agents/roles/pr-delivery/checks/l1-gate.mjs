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
    const result = await execFileAsync('git', ['-c', 'core.excludesFile=/dev/null', 'status', '--porcelain', '--untracked-files=all'], { cwd: dir });
    stdout = result.stdout;
  } catch (error) {
    return { id: 'git-status', ok: false, detail: errorMessage(error) };
  }
  const leaks = [];
  for (const line of stdout.split(/\r?\n/)) {
    const leak = leakedPath(line);
    if (leak) leaks.push(leak);
  }
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

function leakedPath(line) {
  if (!line.trim()) return undefined;
  const status = line.slice(0, 2);
  const body = line.slice(3);
  const paths = body.includes(' -> ') ? body.split(' -> ') : [body];
  for (const item of paths) {
    const path = unquote(item).replaceAll('\\', '/');
    const projection = path === 'AGENTS.local.md' || path === 'CLAUDE.local.md'
      || path === '.agents' || path.startsWith('.agents/')
      || path === '.claude' || path.startsWith('.claude/');
    if (projection) return path;
    const role = path === '.1agents' || path.startsWith('.1agents/');
    if (role && (status === '??' || status[0] === 'A' || status[0] === '?')) return path;
  }
  return undefined;
}

function validateSkillFrontmatter(text, expectedName) {
  if (!SKILL_NAME.test(expectedName)) throw new Error(`Expected skill name "${expectedName}" is not kebab-case`);
  const data = parseFrontmatter(text);
  for (const key of Object.keys(data)) {
    if (LEGACY[key]) throw new Error(`Skill frontmatter rejects legacy key "${key}"; use "${LEGACY[key]}"`);
  }
  const name = data.name;
  if (name === undefined) throw new Error('Skill frontmatter requires kebab-case name');
  if (!SKILL_NAME.test(name)) throw new Error(`Skill frontmatter name "${name}" is not kebab-case`);
  if (name !== expectedName) throw new Error(`Skill frontmatter name "${name}" does not match ${expectedName}`);
  if (data.description === undefined || data.description.trim() === '') throw new Error('Skill frontmatter requires a non-empty description');
}

function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '');
  const fence = /^(---)\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!fence) throw new Error('Skill frontmatter requires an opening --- fence');
  const data = {};
  for (const rawLine of fence[2].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Skill frontmatter has an unreadable line: ${line.slice(0, 80)}`);
    const key = match[1] ?? match[2] ?? match[3];
    if (Object.hasOwn(data, key)) throw new Error(`Skill frontmatter has duplicate key "${key}"`);
    data[key] = unquote(match[4] ?? '');
  }
  return data;
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
