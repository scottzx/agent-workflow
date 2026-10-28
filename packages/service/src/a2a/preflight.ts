/** Host-side admission checks; never starts an agent or invokes a shell. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { isDefaultJobDirectory } from './job-directory.js';
import type { A2APreflightInput, A2APreflightReport } from './types.js';

const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'), 'Expected an absolute host path');
const pythonModule = z.string().regex(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/).max(200);
const nodeModule = z.string().regex(/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/).max(200);
export const a2aPreflightRequirementsSchema = z.object({
  allowedDirectories: z.array(absolutePath).min(1).max(100).optional(),
  jobDirectory: absolutePath.optional(),
  requiredFiles: z.array(absolutePath).max(64).optional(),
  python: z.object({ executable: absolutePath, modules: z.array(pythonModule).max(32) }).strict().optional(),
  node: z.object({ executable: absolutePath, modules: z.array(nodeModule).max(32).optional(), moduleRoot: absolutePath.optional() }).strict().optional(),
}).strict();
export const a2aPreflightInputSchema = a2aPreflightRequirementsSchema.extend({ cwd: absolutePath }).strict();
export const a2aPreflightReportSchema = z.object({
  ok: z.boolean(), checkedAt: z.string(), cwd: absolutePath, jobDirectory: absolutePath.optional(),
  checks: z.array(z.object({ id: z.string(), ok: z.boolean(), detail: z.string().optional() }).strict()),
}).strict();
export class A2APreflightError extends Error {
  constructor(readonly report: A2APreflightReport) {
    super(`A2A preflight failed: ${report.checks.filter(check => !check.ok).map(check => `${check.id}: ${check.detail}`).join('; ')}`);
    this.name = 'A2APreflightError';
  }
}

const execute = promisify(execFile);
const within = (root: string, path: string): boolean => {
  const tail = relative(root, path);
  return tail === '' || (!tail.startsWith(`..${sep}`) && tail !== '..' && !isAbsolute(tail));
};
/** Creates `<cwd>/.1agents/jobs/<id>` segment by segment, refusing symbolic links so nothing is created outside cwd. */
async function ensureDefaultJobDirectory(cwd: string, directory: string): Promise<void> {
  let current = cwd;
  for (const segment of relative(cwd, directory).split(sep)) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (info?.isSymbolicLink()) throw new Error('the default job directory path must not contain symbolic links');
    if (!info) await mkdir(current, { mode: 0o700 });
  }
}
const failure = (error: unknown): string => error instanceof Error ? error.message.slice(0, 400) : 'Host check failed';

/** Enforce an explicitly supplied cwd allowlist against host realpaths and access permissions.
 * This is an admission check, not an OS sandbox or a restriction on every file the agent can read.
 * Match DSH workspace-write roots: the real project and platform temporary directories.
 * A successful OS write alone cannot establish that the agent sandbox admits it.
 */
export async function runA2APreflight(raw: A2APreflightInput): Promise<A2APreflightReport> {
  const input = a2aPreflightInputSchema.parse(raw);
  const report: A2APreflightReport = { ok: true, checkedAt: new Date().toISOString(), cwd: input.cwd, checks: [] };
  const check = async (id: string, action: () => Promise<string | void>): Promise<boolean> => {
    try {
      const detail = await action();
      report.checks.push({ id, ok: true, ...(detail === undefined ? {} : { detail }) });
      return true;
    } catch (error) {
      report.checks.push({ id, ok: false, detail: failure(error) });
      report.ok = false;
      return false;
    }
  };
  const cwdOk = await check('cwd', async () => {
    report.cwd = await realpath(input.cwd);
    if (!(await stat(report.cwd)).isDirectory()) throw new Error('A2A cwd must point to a directory on the host');
    if (input.allowedDirectories) await access(report.cwd, constants.R_OK | constants.X_OK);
    return report.cwd;
  });
  if (input.allowedDirectories) {
    const allowedRoots: string[] = [];
    let rootsOk = true;
    for (const [index, root] of input.allowedDirectories.entries()) {
      const rootOk = await check(`allowedDirectory.${index}`, async () => {
        const actual = await realpath(root);
        if (!(await stat(actual)).isDirectory()) throw new Error('Allowed root must already exist and be a directory');
        await access(actual, constants.R_OK | constants.X_OK);
        allowedRoots.push(actual);
        return actual;
      });
      rootsOk = rootOk && rootsOk;
    }
    const scopeOk = await check('allowedDirectories', async () => {
      if (!cwdOk) throw new Error('Cannot validate allowed directories without an accessible cwd');
      if (!rootsOk) throw new Error('Every configured allowed directory must exist and be accessible');
      if (!allowedRoots.some(root => within(root, report.cwd)))
        throw new Error('Real cwd is outside allowedDirectories (including symlink escapes)');
      return `real cwd ${report.cwd} is within configured real roots`;
    });
    // Do not run dependency executables or a write probe after the admission policy has rejected this cwd.
    if (!scopeOk) return report;
  }
  if (input.jobDirectory) await check('jobDirectory', async () => {
    if (!cwdOk) throw new Error('Cannot validate writable scope without a valid cwd');
    if (isDefaultJobDirectory(input.cwd, input.jobDirectory!)) await ensureDefaultJobDirectory(input.cwd, input.jobDirectory!);
    const directory = await realpath(input.jobDirectory!);
    if (!(await stat(directory)).isDirectory()) throw new Error('jobDirectory must already exist and be a directory');
    const temporaryRoots = await Promise.all(['/tmp', tmpdir()].map(path => realpath(path).catch(() => undefined)));
    if (![report.cwd, ...temporaryRoots.filter((path): path is string => path !== undefined)].some(root => within(root, directory))) {
      throw new Error('jobDirectory is outside the DSH workspace-write roots (cwd or platform temporary directories)');
    }
    const probe = join(directory, `.a2a-preflight-${randomUUID()}`);
    const handle = await open(probe, 'wx', 0o600);
    try { await handle.writeFile('a2a preflight\n'); await handle.sync(); }
    finally { await handle.close(); await unlink(probe); }
    report.jobDirectory = directory;
    return directory;
  });
  for (const [index, file] of (input.requiredFiles ?? []).entries()) await check(`requiredFile.${index}`, async () => {
    const actual = await realpath(file);
    if (!(await stat(actual)).isFile()) throw new Error('Required input is not a regular file');
    const handle = await open(actual, 'r');
    await handle.close();
    return actual;
  });
  if (input.python) await check('python', async () => {
    const executable = await realpath(input.python!.executable);
    const code = 'import importlib.util,json,sys; names=json.loads(sys.argv[1]); print(json.dumps({"version":sys.version.split()[0],"modules":{name:importlib.util.find_spec(name) is not None for name in names}}))';
    const { stdout } = await execute(executable, ['-I', '-c', code, JSON.stringify(input.python!.modules)], { timeout: 5000, maxBuffer: 65536, ...(cwdOk ? { cwd: report.cwd } : {}) });
    const result = JSON.parse(stdout) as { version: string; modules: Record<string, boolean> };
    const missing = input.python!.modules.filter(name => result.modules[name] !== true);
    if (missing.length) throw new Error(`Missing Python modules: ${missing.join(', ')}`);
    return `${executable}; Python ${result.version}; modules=${input.python!.modules.join(',')}`;
  });
  if (input.node) await check('node', async () => {
    const executable = await realpath(input.node!.executable);
    const moduleRoot = await realpath(input.node!.moduleRoot ?? report.cwd);
    if (!(await stat(moduleRoot)).isDirectory()) throw new Error('Node moduleRoot must be a directory');
    const code = 'const {createRequire}=require("node:module");const path=require("node:path");const req=createRequire(path.join(process.argv[1],"__a2a_preflight__.cjs"));const names=JSON.parse(process.argv[2]);console.log(JSON.stringify({version:process.version,modules:Object.fromEntries(names.map(name=>{try{return[name,req.resolve(name)]}catch{return[name,null]}}))}));';
    const { stdout } = await execute(executable, ['--input-type=commonjs', '-e', code, moduleRoot, JSON.stringify(input.node!.modules ?? [])], { timeout: 5000, maxBuffer: 65536, ...(cwdOk ? { cwd: report.cwd } : {}) });
    const result = JSON.parse(stdout) as { version: string; modules: Record<string, string | null> };
    const missing = (input.node!.modules ?? []).filter(name => typeof result.modules[name] !== 'string');
    if (missing.length) throw new Error(`Missing Node modules: ${missing.join(', ')}`);
    return `${executable}; Node ${result.version}; modules=${(input.node!.modules ?? []).join(',')}`;
  });
  return report;
}
