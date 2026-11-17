import { build } from 'esbuild';
import { mkdir, copyFile, cp, readdir, readFile, writeFile } from 'node:fs/promises';

await cp('../service/skills/acp-service', 'skills/acp-service', { recursive: true, force: true });
const serviceVersion = JSON.parse(await readFile('../service/package.json', 'utf8')).version;
const skillPath = 'skills/acp-service/SKILL.md';
const skill = await readFile(skillPath, 'utf8');
const stamped = skill.replace(/^(version:\s*).+$/m, `$1${serviceVersion}`);
if (!/^---\r?\nname: acp-service\r?\nversion: \d+\.\d+\.\d+\r?\n/.test(stamped)) {
  throw new Error('acp-service skill is missing a version field to stamp');
}
await writeFile(skillPath, stamped);
await mkdir('dist/shared/a2a', { recursive: true });
await copyFile('../service/dist/src/a2a/workbench-ui.js', 'dist/shared/a2a/workbench-ui.js');
await cp('../service/dist/workbench-ui', 'dist/workbench-ui', { recursive: true });

// Host-side entries. `@deepseek-ai/*` stays external: the hosting DSH provides them.
await build({
  entryPoints: ['src/index.js', 'src/server.js', 'src/executor.js', 'src/cli.js', 'src/workbench.js', 'src/approvals.js', 'src/sdk-runtime.js'],
  bundle: true, platform: 'node', target: 'node22', format: 'esm', outdir: 'dist',
  external: ['@deepseek-ai/*', 'node:*'],
});

// Browser half of the sidebar panel, wrapped for the host's module loader.
const client = await build({
  entryPoints: ['src/client.js'], bundle: true, platform: 'browser', target: 'es2022',
  format: 'cjs', external: ['react', '@deepseek-ai/*'], write: false,
});
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"@1agents/dsh-a2a",dependencies:["react"],factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);

// The shared source resolves assets relative to acp-service; keep dsh-a2a's own tree.
for (const name of await readdir('dist')) {
  if (!name.endsWith('.js')) continue;
  const path = `dist/${name}`;
  const source = await readFile(path, 'utf8');
  await writeFile(path, source.replaceAll('dist/workbench-ui', 'dist/workbench-ui'));
}