import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['src/client.js'], bundle: true, platform: 'browser', target: 'es2022', format: 'cjs', external: ['react', '@deepseek-ai/*'], write: false });
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"@1agents/acp-service",dependencies:["react"],factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`);
