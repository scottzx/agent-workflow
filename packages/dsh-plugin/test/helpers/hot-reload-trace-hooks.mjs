/** Records bare @deepseek-ai specifiers resolved while importing the package root. */
import { appendFileSync } from 'node:fs';

const file = process.env.HOT_RELOAD_TRACE_FILE;

export async function resolve(specifier, context, nextResolve) {
  if (file && specifier.startsWith('@deepseek-ai/')) appendFileSync(file, `${specifier}\n`);
  return nextResolve(specifier, context);
}
