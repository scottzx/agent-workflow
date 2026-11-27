#!/usr/bin/env node
/**
 * Thin launcher for `acp-service rsi eval-cr`. Scoring lives in pr-cr-eval.ts.
 * Prefer the compiled service when that build already contains the eval command;
 * otherwise forward to the TypeScript CLI.
 * Relative --role-dir/--repo/--results are resolved from the caller's cwd before
 * the child cwd is switched to packages/service.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const serviceDir = join(repoRoot, 'packages/service');
const callerCwd = process.cwd();

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node .1agents/roles/pr-delivery/checks/run-l3-eval.mjs --role-dir DIR [--repo DIR] [--results FILE] [--json]

Forwards to acp-service rsi eval-cr. Relative paths are resolved from the current directory.
Exit code is the scorer's exit code.`);
  process.exit(0);
}

let roleDir;
let repo;
let results;
let json = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--json') { json = true; continue; }
  const taken = valueOf(arg, index);
  if (taken.name === '--role-dir' || taken.name === '--role') roleDir = taken.value;
  else if (taken.name === '--repo') repo = taken.value;
  else if (taken.name === '--results') results = taken.value;
  else {
    console.error(`unknown argument ${arg}`);
    process.exit(1);
  }
  index = taken.next;
}
if (!roleDir) {
  console.error('missing --role-dir <dir>');
  process.exit(1);
}

const forwarded = ['rsi', 'eval-cr', '--role', absolute(roleDir)];
if (repo) forwarded.push('--repo', absolute(repo));
if (results) forwarded.push('--results', absolute(results));
if (json) forwarded.push('--json');

const distCli = join(serviceDir, 'dist/bin/acp-service.js');
const distRsi = join(serviceDir, 'dist/bin/rsi.js');
const distEval = join(serviceDir, 'dist/src/rsi/pr-cr-eval.js');
const compiled = existsSync(distCli) && existsSync(distRsi) && existsSync(distEval)
  && readFileSync(distRsi, 'utf8').includes('eval-cr')
  && readFileSync(distEval, 'utf8').includes('scoreCrEvalSuite');
const nodeArgs = compiled
  ? [distCli, ...forwarded]
  : ['--import', 'tsx', join(serviceDir, 'bin/acp-service.ts'), ...forwarded];
const child = spawnSync(process.execPath, nodeArgs, { cwd: serviceDir, stdio: 'inherit' });
process.exit(child.status === null ? 1 : child.status);

function valueOf(arg, index) {
  const eq = arg.indexOf('=');
  if (arg.startsWith('--') && eq > 2) return { name: arg.slice(0, eq), value: arg.slice(eq + 1), next: index };
  return { name: arg, value: args[index + 1], next: index + 1 };
}

function absolute(value) {
  return isAbsolute(value) ? value : resolve(callerCwd, value);
}
