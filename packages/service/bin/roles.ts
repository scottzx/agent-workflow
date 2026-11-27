/** Explicit role administration: copy a role's skills into a working directory, check what is there, or project a package onto a worktree. No model is invoked. */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRoleSkills, projectRoleToWorktree, syncRoleSkills } from '../src/roles/index.js';

const USAGE = `Usage: acp-service roles sync --profile FILE --cwd DIRECTORY --source DIRECTORY
       acp-service roles check --profile FILE --cwd DIRECTORY
       acp-service roles project --role-dir DIRECTORY --worktree DIRECTORY [--skills-source DIRECTORY]

sync copies the skills the profile names from SOURCE/<name> into DIRECTORY/.agents/skills (assets included), then links
DIRECTORY/.claude/skills to it for Claude Code. check only verifies and links. project validates the role package and
projects it one way into a git worktree (.agents/skills, the .claude/skills symlink, and AGENTS.local.md), then prints
JSON { roleId, roleVersion, worktreeDir, skills, instructionsFile, digest }. DSH and Codex read .agents/skills and Claude Code
reads .claude/skills when a session starts; nothing is downloaded or pinned.`;

export async function runRolesCli(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const command = argv[0];
  if (command === 'project') {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { 'role-dir': { type: 'string' }, worktree: { type: 'string' }, 'skills-source': { type: 'string' } },
      strict: true,
    });
    if (!values['role-dir'] || !values.worktree) throw new Error('--role-dir and --worktree are required');
    const projected = await projectRoleToWorktree({
      roleDir: resolve(values['role-dir']),
      worktreeDir: resolve(values.worktree),
      ...(values['skills-source'] ? { skillsSourceDir: resolve(values['skills-source']) } : {}),
    });
    console.log(JSON.stringify({
      roleId: projected.roleId,
      roleVersion: projected.roleVersion,
      worktreeDir: projected.worktreeDir,
      skills: projected.skills,
      ...(projected.instructionsFile ? { instructionsFile: projected.instructionsFile } : {}),
      digest: projected.digest,
    }, null, 2));
    return;
  }
  if (command !== 'sync' && command !== 'check') throw new Error('Unknown roles command; use roles --help');
  const { values } = parseArgs({ args: argv.slice(1), options: { profile: { type: 'string' }, cwd: { type: 'string' }, source: { type: 'string' } }, strict: true });
  if (!values.profile || !values.cwd) throw new Error('--profile and --cwd are required');
  if (command === 'sync' && !values.source) throw new Error('--source is required');
  const profilePath = resolve(values.profile), cwd = resolve(values.cwd);
  const loaded = command === 'sync' ? await syncRoleSkills({ profilePath, cwd, source: resolve(values.source!) }) : await loadRoleSkills({ profilePath, cwd });
  console.log(JSON.stringify({ roleId: loaded.roleId, roleVersion: loaded.roleVersion, cwd, entryGuidePath: loaded.entryGuidePath,
    skills: loaded.skills.map(({ key, name, directory }) => ({ key, name, directory })) }, null, 2));
}
