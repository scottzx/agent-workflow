import { build } from 'esbuild';
import { chmod, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

// Host-side and standalone entries embedded under `@1agents/acp-service/vendor/dsh-a2a`.
// `@1agents/acp-service/*` resolves via package self-reference inside the unified package,
// and `@deepseek-ai/*` stays external because the hosting DSH provides them.
await build({
  entryPoints: [
    'src/index.js',
    'src/server.js',
    'src/executor.js',
    'src/cli.js',
    'src/workbench.js',
    'src/approvals.js',
    'src/sdk-runtime.js',
  ],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir: 'dist',
  external: ['@1agents/acp-service', '@1agents/acp-service/*', '@deepseek-ai/*', '@a2a-js/*', 'zod', 'dsh-zod', 'node:*'],
});

await chmod('dist/cli.js', 0o755);
