/** Include the already-built DSH ACP and DSH A2A faces in the sole public package. */
import { chmodSync, cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPluginDepsDeclared, dshA2ASidecarFiles, dshSidecarFiles } from './package-embed.mjs';
import { verifyPackageBuild } from './verify-package-build.mjs';

export function stageDsh(root = resolve(import.meta.dirname, '..')) {
  const plugin = join(root, 'packages/dsh-plugin');
  const dshA2A = join(root, 'packages/dsh-a2a');
  const service = join(root, 'packages/service');
  const source = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'));
  const a2aSource = JSON.parse(readFileSync(join(dshA2A, 'package.json'), 'utf8'));
  const target = JSON.parse(readFileSync(join(service, 'package.json'), 'utf8'));
  assertPluginDepsDeclared(source, target);
  assertPluginDepsDeclared(a2aSource, target);

  const destination = join(service, 'vendor/dsh');
  rmSync(destination, { recursive: true, force: true });
  cpSync(join(plugin, 'dist'), destination, { recursive: true });
  for (const file of dshSidecarFiles) cpSync(join(plugin, file), join(destination, file));

  const a2aDestination = join(service, 'vendor/dsh-a2a');
  rmSync(a2aDestination, { recursive: true, force: true });
  cpSync(join(dshA2A, 'dist'), a2aDestination, { recursive: true });
  for (const file of dshA2ASidecarFiles) cpSync(join(dshA2A, file), join(a2aDestination, file));
  const cli = join(a2aDestination, 'cli.js');
  if (existsSync(cli)) chmodSync(cli, 0o755);

  return target;
}

export function embedDsh(root = resolve(import.meta.dirname, '..')) {
  const target = stageDsh(root);
  verifyPackageBuild(root);
  console.log(`Embedded DSH ACP + A2A plugins in ${target.name}@${target.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) embedDsh();
