#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { startA2AService } from './server.js';
if (process.argv.length !== 3 || ['--help', '-h'].includes(process.argv[2])) {
  console.log('Usage: dsh-a2a <config.json>\nStart a standalone A2A endpoint backed by the installed DSH headless runtime.');
  process.exit(process.argv.length === 3 ? 0 : 1);
}
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const service = await startA2AService(config);
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { void service.close().catch(() => { process.exitCode = 1; }); });
console.log(`DSH A2A listening at ${config.publicUrl ?? 'http://127.0.0.1:3080'}`);
