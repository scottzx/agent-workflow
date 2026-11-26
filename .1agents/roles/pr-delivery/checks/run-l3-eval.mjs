#!/usr/bin/env node
/**
 * Thin launcher for `acp-service rsi eval-cr`. Scoring lives in pr-cr-eval.ts.
 * Prefer the compiled service when that build already contains the eval command;
 * otherwise forward to the TypeScript CLI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const serviceDir = join(repoRoot, 'packages/service');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node .1agents/roles/pr-delivery/checks/run-l3-eval.mjs --role-dir DIR [--repo DIR] [--results FILE] [--json]

Forwards to acp-service rsi eval-cr. Exit code is the scorer's exit code.`);
  process.exit(0);
}

let roleDir;
let repo;
let results;
let json = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--role-dir') roleDir = args[++index];
  else if (arg === '--repo') repo = args[++index];
  else if (arg === '--results') results = args[++index];
  else if (arg === '--json') json = true;
  else {
    console.error(`unknown argument ${arg}`);
    process.exit(1);
  }
}
if (!roleDir) {
  console.error('missing --role-dir <dir>');
  process.exit(1);
}

const forwarded = ['rsi', 'eval-cr', '--role', roleDir];
if (repo) forwarded.push('--repo', repo);
if (results) forwarded.push('--results', results);
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
