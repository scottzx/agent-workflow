/** Run the plugin tests. Without linked DeepSeek Harness packages (pnpm link:dsh), test files that load
 * @deepseek-ai/* at runtime (directly or through relative imports), and tests named 'real Cordis', are skipped. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const linked = existsSync(resolve(root, 'node_modules/@deepseek-ai/cordis'));
const files = readdirSync(resolve(root, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => resolve(root, 'test', f));
const memo = new Map();
function needsHost(file) {
  if (memo.has(file)) return memo.get(file);
  memo.set(file, false);
  if (!existsSync(file)) return false;
  const src = readFileSync(file, 'utf8');
  // Value imports only; `import type` is erased at compile time.
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import(?!\s+type\b)[^'"]*?from\s*|import\s*\(\s*|export[^'"]*?from\s*)['"]([^'"]+)['"]/g)].map(m => m[1]);
  const result = specs.some(s => s.startsWith('@deepseek-ai/') || (s.startsWith('.') && needsHost(resolve(dirname(file), s))));
  memo.set(file, result);
  return result;
}
const selected = linked ? files : files.filter(f => !needsHost(f));
if (!linked) {
  const skipped = files.filter(f => !selected.includes(f)).map(f => f.slice(root.length + 1));
  console.log(`[dsh-acp] DeepSeek Harness not linked; skipping ${skipped.length} host-dependent test files: ${skipped.join(', ')}`);
}
// Individual tests that dynamically load real Cordis are named 'real Cordis'.
const skip = linked ? [] : ['--test-skip-pattern=real Cordis'];
const r = spawnSync(process.execPath, ['--test', ...skip, ...selected], { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
