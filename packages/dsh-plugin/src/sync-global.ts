/** Keep the global acp-service CLI on the same version as this DSH plugin install. */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PACKAGE = '@1agents/acp-service';

export interface SyncGlobalOptions {
  packageDir?: string;
  env?: NodeJS.ProcessEnv;
  execFile?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string }>;
}

export interface SyncGlobalResult {
  updated: boolean;
  version: string;
  from?: string;
  reason?: string;
}

/** The installed @1agents/acp-service directory that contains this module. */
export function packageDirectory(moduleUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
        if (manifest.name === PACKAGE) return dir;
      } catch { /* A broken manifest is not this package. */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${PACKAGE} package root was not found`);
}

function readVersion(directory: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (manifest.name !== PACKAGE || typeof manifest.version !== 'string' || !manifest.version) return undefined;
    return manifest.version;
  } catch { return undefined; }
}

/** DSH profile installs only. A workspace checkout and the global install itself do not recurse. */
export function shouldSyncGlobal(packageDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ACP_SERVICE_SKIP_GLOBAL_SYNC === '1' || env.ACP_SERVICE_SYNC_GLOBAL === '0') return false;
  if (env.ACP_SERVICE_SYNC_GLOBAL === '1') return true;
  return /[/\\]\.dsh[/\\]profiles[/\\]/.test(packageDir);
}

/** Install this exact package over the global CLI when its version differs. */
export async function syncGlobalAcpService(options: SyncGlobalOptions = {}): Promise<SyncGlobalResult> {
  const env = options.env ?? process.env;
  const packageDir = options.packageDir ?? packageDirectory();
  const version = readVersion(packageDir);
  if (!version) throw new Error(`${PACKAGE} version was not found`);
  if (!shouldSyncGlobal(packageDir, env)) return { updated: false, version, reason: 'not-a-dsh-profile-install' };
  const run = options.execFile ?? (async (command, args, commandEnv) => {
    const result = await exec(command, args, { env: commandEnv, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout };
  });
  const root = (await run('npm', ['root', '-g'], env)).stdout.trim();
  if (!root) throw new Error('npm root -g returned an empty path');
  const from = readVersion(join(root, PACKAGE));
  if (from === version) return { updated: false, version, from, reason: 'already-current' };
  await run('npm', ['install', '-g', packageDir, '--no-fund', '--no-audit'], { ...env, ACP_SERVICE_SKIP_GLOBAL_SYNC: '1' });
  return { updated: true, version, ...(from ? { from } : {}) };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  syncGlobalAcpService().then(result => {
    if (result.updated) console.log(`acp-service global CLI updated ${result.from ?? '(none)'} -> ${result.version}`);
    else console.log(`acp-service global CLI unchanged (${result.reason ?? result.version})`);
  }).catch(error => {
    console.warn(`acp-service global CLI was not updated: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 0;
  });
}
