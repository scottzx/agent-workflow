/** Bundles the gateway's workbench page into dist/workbench-ui. Preact ships inside app.js. */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const source = import.meta.dirname;
const out = join(source, '../dist/workbench-ui');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(source, 'src/main.tsx')],
  outfile: join(out, 'app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  legalComments: 'none',
});
for (const file of ['index.html', 'app.css']) copyFileSync(join(source, file), join(out, file));
console.log(`Built workbench page in ${out}`);
