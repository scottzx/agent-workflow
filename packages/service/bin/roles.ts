/** Explicit role administration: copy a role's skills into a working directory, or check what is there. No model is invoked. */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRoleSkills, syncRoleSkills } from '../src/roles/index.js';

export async function runRolesCli(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: acp-service roles sync --profile FILE --cwd DIRECTORY --source DIRECTORY
       acp-service roles check --profile FILE --cwd DIRECTORY

sync copies the skills the profile names from SOURCE/<name> into DIRECTORY/.agents/skills (assets included), then links
DIRECTORY/.claude/skills to it for Claude Code. check only verifies and links. DSH and Codex read .agents/skills and Claude Code
reads .claude/skills when a session starts; nothing is downloaded or pinned.`);
    return;
  }
  const command = argv[0];
  if (command !== 'sync' && command !== 'check') throw new Error('Unknown roles command; use roles --help');
  const { values } = parseArgs({ args: argv.slice(1), options: { profile: { type: 'string' }, cwd: { type: 'string' }, source: { type: 'string' } }, strict: true });
  if (!values.profile || !values.cwd) throw new Error('--profile and --cwd are required');
  if (command === 'sync' && !values.source) throw new Error('--source is required');
  const profilePath = resolve(values.profile), cwd = resolve(values.cwd);
  const loaded = command === 'sync' ? await syncRoleSkills({ profilePath, cwd, source: resolve(values.source!) }) : await loadRoleSkills({ profilePath, cwd });
  console.log(JSON.stringify({ roleId: loaded.roleId, roleVersion: loaded.roleVersion, cwd, entryGuidePath: loaded.entryGuidePath,
    skills: loaded.skills.map(({ key, name, directory }) => ({ key, name, directory })) }, null, 2));
}
