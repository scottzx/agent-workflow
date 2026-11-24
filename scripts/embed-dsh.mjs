/** Include the already-built DSH host/client faces in the sole public package. */
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPluginDepsDeclared, dshSidecarFiles } from './package-embed.mjs';
import { verifyPackageBuild } from './verify-package-build.mjs';

export function stageDsh(root = resolve(import.meta.dirname, '..')) {
  const plugin = join(root, 'packages/dsh-plugin');
  const service = join(root, 'packages/service');
  const source = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'));
  const target = JSON.parse(readFileSync(join(service, 'package.json'), 'utf8'));
  assertPluginDepsDeclared(source, target);
  const destination = join(service, 'vendor/dsh');
  rmSync(destination, { recursive: true, force: true });
  cpSync(join(plugin, 'dist'), destination, { recursive: true });
  for (const file of dshSidecarFiles) cpSync(join(plugin, file), join(destination, file));
  return target;
}

export function embedDsh(root = resolve(import.meta.dirname, '..')) {
  const target = stageDsh(root);
  verifyPackageBuild(root);
  console.log(`Embedded DSH plugin in ${target.name}@${target.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) embedDsh();
