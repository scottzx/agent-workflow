/** Explicit role administration: copy a role's skills into a working directory, check what is there, project a package onto a worktree, or manage trial/formal asset lifecycles. No model is invoked. */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  AssetLifecycleStore,
  assetKindSchema,
  loadRoleSkills,
  projectRoleToWorktree,
  syncRoleSkills,
  type AssetDependency,
} from '../src/roles/index.js';
import { settler } from './ticket.js';

const USAGE = `Usage: acp-service roles sync --profile FILE --cwd DIRECTORY --source DIRECTORY
       acp-service roles check --profile FILE --cwd DIRECTORY
       acp-service roles project --role-dir DIRECTORY --worktree DIRECTORY [--skills-source DIRECTORY]
       acp-service roles lifecycle save-trial --store DIRECTORY --role-dir DIRECTORY --kind preset|check|rubric|dag --id ID --path RELPATH --version VER [--dep KIND:ID[:DIGEST]]...
       acp-service roles lifecycle promote --store DIRECTORY --kind preset|check|rubric|dag --id ID --evidence TEXT [--digest SHA256]
       acp-service roles lifecycle fork --store DIRECTORY --kind preset|check|rubric|dag --id ID --version VER [--role-dir DIRECTORY]
       acp-service roles lifecycle rollback --store DIRECTORY --kind preset|check|rubric|dag --id ID --reason TEXT [--digest SHA256] [--role-dir DIRECTORY]
       acp-service roles lifecycle inspect --store DIRECTORY

sync copies the skills the profile names from SOURCE/<name> into DIRECTORY/.agents/skills (assets included), then links
DIRECTORY/.claude/skills to it for Claude Code. check only verifies and links. project validates the role package and
projects it one way into a git worktree (.agents/skills, the .claude/skills symlink, and AGENTS.local.md), then prints
JSON { roleId, roleVersion, worktreeDir, skills, instructionsFile, digest }. lifecycle binds trial/formal snapshots to
real role directory files with SHA-256 verification and person-only formal promotion/rollback.`;

function parseDepSpecs(specs: string[] | undefined): AssetDependency[] {
  return (specs ?? []).map(spec => {
    const [rawKind, id, digest] = spec.split(':');
    if (!rawKind || !id) throw new Error(`Invalid --dep "${spec}"; expected KIND:ID[:SHA256]`);
    const kind = assetKindSchema.parse(rawKind);
    return { kind, id, ...(digest ? { digest } : {}) };
  });
}

async function runLifecycleCli(argv: string[]): Promise<void> {
  const action = argv[0];
  if (!action || !['save-trial', 'promote', 'fork', 'rollback', 'inspect'].includes(action)) {
    throw new Error('Unknown roles lifecycle command; use roles --help');
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      store: { type: 'string' },
      'role-dir': { type: 'string' },
      kind: { type: 'string' },
      id: { type: 'string' },
      path: { type: 'string' },
      version: { type: 'string' },
      evidence: { type: 'string' },
      reason: { type: 'string' },
      digest: { type: 'string' },
      dep: { type: 'string', multiple: true },
    },
    strict: true,
  });
  if (!values.store) throw new Error('--store is required');
  const store = new AssetLifecycleStore(resolve(values.store));
  const actor = settler().kind === 'coach' ? 'coach' : 'person';

  if (action === 'inspect') {
    console.log(JSON.stringify(await store.inspect(), null, 2));
    return;
  }
  if (!values.kind || !values.id) throw new Error('--kind and --id are required');
  const kind = assetKindSchema.parse(values.kind);

  if (action === 'save-trial') {
    if (!values['role-dir'] || !values.path || !values.version) {
      throw new Error('--role-dir, --path, and --version are required for save-trial');
    }
    const saved = await store.saveTrialAsset({
      kind,
      id: values.id,
      sourceRoot: resolve(values['role-dir']),
      relativePath: values.path,
      version: values.version,
      dependencies: parseDepSpecs(values.dep),
      actor,
    });
    console.log(JSON.stringify(saved, null, 2));
    return;
  }
  if (action === 'promote') {
    if (!values.evidence) throw new Error('--evidence is required for promote');
    const promoted = await store.promoteTrialToFormal({
      kind,
      id: values.id,
      ...(values.digest ? { expectedDigest: values.digest } : {}),
      actor,
      evidence: values.evidence,
    });
    console.log(JSON.stringify(promoted, null, 2));
    return;
  }
  if (action === 'fork') {
    if (!values.version) throw new Error('--version is required for fork');
    const forked = await store.forkTrialFromFormal({
      kind,
      id: values.id,
      newVersion: values.version,
      actor,
      ...(values['role-dir'] ? { targetRoot: resolve(values['role-dir']) } : {}),
    });
    console.log(JSON.stringify(forked, null, 2));
    return;
  }
  if (!values.reason) throw new Error('--reason is required for rollback');
  const rolledBack = await store.rollbackFormalSnapshot({
    kind,
    id: values.id,
    ...(values.digest ? { targetDigest: values.digest } : {}),
    ...(values['role-dir'] ? { targetRoot: resolve(values['role-dir']) } : {}),
    actor,
    reason: values.reason,
  });
  console.log(JSON.stringify(rolledBack, null, 2));
}

export async function runRolesCli(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const command = argv[0];
  if (command === 'lifecycle') {
    await runLifecycleCli(argv.slice(1));
    return;
  }
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
