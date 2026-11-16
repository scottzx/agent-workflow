import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
for (const directory of ['src', 'scripts', 'test']) {
  for (const name of await readdir(directory)) {
    if (!/\.m?js$/.test(name)) continue;
    execFileSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'inherit' });
  }
}
console.log('All DSH A2A JavaScript sources, scripts and tests pass syntax checks.');
