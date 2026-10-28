/**
 * Bundles the gateway's workbench page into dist/workbench-ui. Preact ships inside app.js; the preview and
 * chat libraries load their heavy renderers (markdown, highlighting) as chunk-*.js on first use.
 */
import { build } from 'esbuild';
import { appendFileSync, readFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const source = import.meta.dirname;
const out = join(source, '../dist/workbench-ui');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(source, 'src/main.tsx')],
  outdir: out,
  entryNames: 'app',
  chunkNames: 'chunk-[hash]',
  splitting: true,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  legalComments: 'none',
});
for (const file of ['index.html', 'app.css']) copyFileSync(join(source, file), join(out, file));
// The libraries ship their own stylesheet; the page's CSP only allows same-origin files, so it goes into app.css.
const require = createRequire(import.meta.url);
for (const lib of ['@1agents/file-preview', '@1agents/chat-view']) appendFileSync(join(out, 'app.css'), `\n${readFileSync(require.resolve(`${lib}/style.css`), 'utf8')}`);
console.log(`Built workbench page in ${out}`);
