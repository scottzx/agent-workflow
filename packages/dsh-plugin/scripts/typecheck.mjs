/** Compile with real DSH types when linked (pnpm link:dsh), otherwise with the host shims in types/dsh-host.d.ts. */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const linked = existsSync(new URL('../node_modules/@deepseek-ai/cordis', import.meta.url));
const project = linked ? 'tsconfig.json' : 'tsconfig.standalone.json';
if (!linked) console.log('[dsh-acp] DeepSeek Harness packages not linked; type-checking against host shims (types/dsh-host.d.ts).');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', project], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
