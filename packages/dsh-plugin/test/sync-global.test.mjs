import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldSyncGlobal, syncGlobalAcpService } from '../dist/sync-global.js';

test('a DSH profile install replaces an older global CLI and does not recurse', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acp-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, '.dsh', 'profiles', 'desktop', 'node_modules', '@1agents', 'acp-service');
  const globalDir = join(root, 'global', '@1agents', 'acp-service');
  await mkdir(profile, { recursive: true });
  await mkdir(globalDir, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: '@1agents/acp-service', version: '0.11.2' }));
  await writeFile(join(globalDir, 'package.json'), JSON.stringify({ name: '@1agents/acp-service', version: '0.8.1' }));
  const calls = [];
  const result = await syncGlobalAcpService({
    packageDir: profile,
    execFile: async (command, args, env) => {
      calls.push({ command, args, skip: env.ACP_SERVICE_SKIP_GLOBAL_SYNC });
      if (args[0] === 'root') return { stdout: join(root, 'global') + '\n' };
      return { stdout: '' };
    },
  });
  assert.equal(result.updated, true);
  assert.equal(result.from, '0.8.1');
  assert.equal(result.version, '0.11.2');
  assert.equal(calls[1].args.includes(profile), true);
  assert.equal(calls[1].skip, '1');
});

test('the same version and a workspace checkout do not install globally', async () => {
  assert.equal(shouldSyncGlobal('/Users/scott/Documents/repo/packages/service'), false);
  assert.equal(shouldSyncGlobal('/Users/scott/.dsh/profiles/desktop/node_modules/@1agents/acp-service'), true);
  assert.equal(shouldSyncGlobal('/Users/scott/.dsh/profiles/desktop/node_modules/@1agents/acp-service', { ACP_SERVICE_SKIP_GLOBAL_SYNC: '1' }), false);
  const root = await mkdtemp(join(tmpdir(), 'acp-sync-same-'));
  const profile = join(root, '.dsh', 'profiles', 'desktop', 'node_modules', '@1agents', 'acp-service');
  const globalDir = join(root, 'global', '@1agents', 'acp-service');
  await mkdir(profile, { recursive: true });
  await mkdir(globalDir, { recursive: true });
  const manifest = JSON.stringify({ name: '@1agents/acp-service', version: '0.11.2' });
  await writeFile(join(profile, 'package.json'), manifest);
  await writeFile(join(globalDir, 'package.json'), manifest);
  let installs = 0;
  const result = await syncGlobalAcpService({
    packageDir: profile,
    execFile: async (_command, args) => {
      if (args[0] === 'install') installs += 1;
      return { stdout: join(root, 'global') };
    },
  });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'already-current');
  assert.equal(installs, 0);
  await rm(root, { recursive: true, force: true });
});
