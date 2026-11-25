/** Place the bundled ACP usage skill where DSH's user skill root reads it. */
import { existsSync, readFileSync } from 'node:fs';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACP_SKILL_NAME = 'acp-service';
const MARKER = '.installed-by-dsh-a2a.json';
const OWNER = '@1agents/acp-service/dsh-a2a';

/** `<dshHome>/skills`. `$DSH_HOME` wins; otherwise `~/.dsh`, matching DSH's user-dsh root. */
export function dshSkillsDirectory(env = process.env, home = homedir()) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return join(configured || join(home, '.dsh'), 'skills');
}

/** Resolve the bundled `acp-service` skill whether embedded under `vendor/dsh-a2a/` or run in the workspace. */
export function packagedSkillDirectory(moduleUrl = import.meta.url) {
  for (const relative of ['../../skills/acp-service', '../skills/acp-service', '../../service/skills/acp-service']) {
    const candidate = fileURLToPath(new URL(relative, moduleUrl));
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate;
  }
  return fileURLToPath(new URL('../../skills/acp-service', moduleUrl));
}

/** Resolve the owning package version (`@1agents/acp-service` when embedded, workspace manifest otherwise). */
export function packagedVersion(moduleUrl = import.meta.url) {
  for (const relative of ['../../package.json', '../../service/package.json', '../package.json']) {
    const candidate = fileURLToPath(new URL(relative, moduleUrl));
    if (!existsSync(candidate)) continue;
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
      if (typeof manifest.version === 'string' && manifest.version.trim()) return manifest.version.trim();
    } catch { /* fall through to next candidate */ }
  }
  return undefined;
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/** Numeric major.minor.patch. A missing version is older than any numbered one. */
export function compareSkillVersions(left, right) {
  const parts = value => String(value ?? '').match(/\d+(?:\.\d+){0,2}/)?.[0].split('.').map(Number) ?? null;
  const a = parts(left), b = parts(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export function skillVersion(markdown) {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return frontmatter?.[1].match(/^version:\s*['"]?([0-9]+(?:\.[0-9]+){0,2})['"]?\s*$/m)?.[1];
}

/**
 * Keep one `acp-service` skill. A copy already at this path stays only when its version is newer or the same.
 */
export async function installAcpSkill({ source, skillsDirectory, version }) {
  const sourceSkill = join(source, 'SKILL.md');
  if (!(await exists(sourceSkill))) return { installed: false, reason: 'skill-not-packaged' };
  const nextVersion = skillVersion(await readFile(sourceSkill, 'utf8')) ?? version;
  if (!nextVersion) return { installed: false, reason: 'version-missing' };
  await mkdir(skillsDirectory, { recursive: true });
  const target = join(skillsDirectory, ACP_SKILL_NAME);
  const markerPath = join(target, MARKER);
  if (await exists(join(target, 'SKILL.md'))) {
    let installed;
    try { installed = JSON.parse(await readFile(markerPath, 'utf8')).version; } catch { installed = undefined; }
    installed ??= skillVersion(await readFile(join(target, 'SKILL.md'), 'utf8'));
    if (installed && compareSkillVersions(installed, nextVersion) >= 0) {
      await rm(join(skillsDirectory, `${ACP_SKILL_NAME}.md`), { force: true });
      return { installed: false, reason: 'current', version: installed, path: target };
    }
  }
  const staging = join(skillsDirectory, `.${ACP_SKILL_NAME}.installing`);
  await rm(staging, { recursive: true, force: true });
  await cp(source, staging, { recursive: true });
  await writeFile(join(staging, MARKER), `${JSON.stringify({ package: OWNER, version: nextVersion }, null, 2)}\n`);
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
  await rm(join(skillsDirectory, `${ACP_SKILL_NAME}.md`), { force: true });
  return { installed: true, version: nextVersion, path: target };
}
