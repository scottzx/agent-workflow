/** Import the static package entry and report whether any host package was resolved. */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

await register(new URL('./hot-reload-trace-hooks.mjs', import.meta.url));
const mod = await import(pathToFileURL(process.argv[2]).href);
const trace = process.env.HOT_RELOAD_TRACE_FILE;
const seen = trace ? readFileSync(trace, 'utf8') : '';
if (seen.includes('@deepseek-ai/')) {
  console.error(seen);
  process.exit(2);
}
console.log(JSON.stringify({
  name: mod.name,
  serve: typeof mod.serveAcpService,
  apply: typeof mod.apply,
  inject: mod.inject,
}));
