/** Verify the tarball installed outside the workspace can load and launch its runtime. */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const archive = resolve(process.argv[2]);
const directory = mkdtempSync(join(tmpdir(), 'acp-service-package-'));
const flowDirectory = mkdtempSync(join(tmpdir(), 'acp-service-external-flow-'));
try {
  writeFileSync(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync('npm', ['install', archive, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: directory, stdio: 'inherit', timeout: 180_000 });
  writeFileSync(join(directory, 'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { execFileSync } from 'node:child_process';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { createAgentRegistry, createRuntimeStore } from '@1agents/acp-service/runtime';
    import { defineFlow } from '@1agents/acp-service/flows';
    const require = createRequire(import.meta.url);
    assert.ok(createAgentRegistry().list().includes('codex'));
    assert.ok(createRuntimeStore({ stateDir: './state' }));
    assert.equal(typeof defineFlow, 'function');
    assert.throws(() => require.resolve('@scottzx/1acp'));
    assert.throws(() => require.resolve('@1agents/dsh-acp'));
    assert.throws(() => require.resolve('@1agents/dsh-a2a'));
    assert.throws(() => require.resolve('@deepseek-ai/cordis'));
    const cli = require.resolve('@1agents/acp-service/runtime-cli');
    assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /Usage:/);
    const service = require.resolve('@1agents/acp-service/package.json').replace(/package\\.json$/, 'dist/bin/acp-service.js');
    assert.match(execFileSync(process.execPath, [service, '--help'], { encoding: 'utf8' }), /acp-service serve/);
    assert.match(execFileSync(process.execPath, [service, 'codex', '--help'], { encoding: 'utf8' }), /codex/);
    const dshA2ACli = require.resolve('@1agents/acp-service/package.json').replace(/package\\.json$/, 'vendor/dsh-a2a/cli.js');
    assert.match(execFileSync(process.execPath, [dshA2ACli, '--help'], { encoding: 'utf8' }), /Usage: dsh-a2a/);
    const dshA2A = await import('@1agents/acp-service/dsh-a2a');
    assert.equal(dshA2A.name, 'oneagents-dsh-a2a');
    assert.equal(typeof dshA2A.apply, 'function');
    assert.equal(typeof (await import('@1agents/acp-service/dsh-a2a/server')).startA2AService, 'function');
    assert.equal(typeof (await import('@1agents/acp-service/dsh-a2a/executor')).HeadlessDshBackend, 'function');
    const packageRoot = dirname(require.resolve('@1agents/acp-service/package.json'));
    const skill = readFileSync(join(packageRoot, 'skills/acp-service/SKILL.md'), 'utf8');
    const listedSkills = JSON.parse(execFileSync(process.execPath, [service, '--skill', 'list', '--json'], { encoding: 'utf8' }));
    assert.ok(listedSkills.skills.some(item => item.id === 'acp-service'));
    assert.ok(listedSkills.skills.some(item => item.id === 'acpx'));
    assert.equal(execFileSync(process.execPath, [service, '--skill', 'show', 'acp-service'], { encoding: 'utf8' }), skill);
    const skillArchive = join(packageRoot, 'skill-export.tar');
    writeFileSync(skillArchive, execFileSync(process.execPath, [service, '--skill', 'export', 'acp-service']));
    const skillEntries = execFileSync('tar', ['-tf', skillArchive], { encoding: 'utf8' }).trim().split('\\n');
    for (const entry of ['SKILL.md', 'agents/openai.yaml', 'references/acp.md', 'references/dsh.md', 'references/a2a.md']) {
      assert.ok(skillEntries.includes('acp-service/' + entry), 'Missing exported skill resource: ' + entry);
      assert.equal(execFileSync('tar', ['-xOf', skillArchive, 'acp-service/' + entry], { encoding: 'utf8' }),
        readFileSync(join(packageRoot, 'skills/acp-service', entry), 'utf8'));
    }
    const api = await import('@1agents/acp-service');
    assert.equal(typeof api.serveAcpService, 'function');
    assert.equal(typeof api.apply, 'function');
    const serviceApi = await import('@1agents/acp-service/service');
    assert.equal(serviceApi.serveAcpService, api.serveAcpService);
    const a2a = await import('@1agents/acp-service/a2a');
    assert.equal(typeof a2a.createA2AServer, 'function');
    assert.equal(typeof a2a.FileA2AStore, 'function');
    assert.equal(typeof a2a.RemoteAgentGateway, 'function');
    assert.equal(typeof a2a.serveA2AGateway, 'function');
    assert.match(execFileSync(process.execPath, [service, 'a2a', '--help'], { encoding: 'utf8' }), /remote_agent_spawn/);
    const server = await api.serveAcpService({ host: '127.0.0.1', port: 0, report: false });
    await server.close();
  `);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: directory, stdio: 'inherit', timeout: 60_000 });
  mkdirSync(join(directory, 'home'));
  for (const extension of ['ts', 'cts', 'mts', 'mjs']) {
    const flow = join(flowDirectory, `external.flow.${extension}`);
    writeFileSync(flow, `import { compute, defineFlow } from '@1agents/acp-service/flows';
      export default defineFlow({ name: 'installed-flow', startAt: 'done', nodes: {
        done: compute({ run: () => ({ ok: true }) })
      }, edges: [] });`);
    const output = execFileSync(process.execPath, [join(directory, 'node_modules/@1agents/acp-service/dist/bin/acp-service.js'),
      '--approve-all', '--cwd', directory, '--format', 'json', 'flow', 'run', flow], {
      cwd: directory, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: join(directory, 'home') },
    });
    assert.equal(JSON.parse(output.trim()).status, 'completed');
  }
  // Run the existing real-runtime protocol scenario against the installed
  // package, including detached queue owners, replay and session resume.
  const testDirectory = join(directory, 'test');
  mkdirSync(join(testDirectory, 'fixtures'), { recursive: true });
  cpSync(new URL('../packages/service/test/fixtures/acp-agent.mjs', import.meta.url), join(testDirectory, 'fixtures/acp-agent.mjs'));
  const testSource = new URL('../packages/service/test/', import.meta.url);
  const installedTests = ['acp-runtime.integration.test.ts', 'catalog.test.ts', 'a2a-server.test.ts', 'a2a-store.test.ts', 'a2a-gateway.test.ts'];
  // Sibling helper modules are shared by the installed tests. Node strips types
  // natively but never remaps "./helper.js" to "./helper.ts", so copy the real
  // TypeScript files and point the specifiers at them.
  const helperModules = readdirSync(testSource).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  const helperSpecifiers = helperModules.map((name) => [`'./${name.replace(/\.ts$/, '.js')}'`, `'./${name}'`]);
  for (const file of [...installedTests, ...helperModules]) {
    let source = readFileSync(new URL(file, testSource), 'utf8')
      .replaceAll("'../src/", "'./node_modules/@1agents/acp-service/dist/src/")
      .replace("'./fixtures/acp-agent.mjs'", "'./test/fixtures/acp-agent.mjs'");
    for (const [from, to] of helperSpecifiers) source = source.replaceAll(from, to);
    writeFileSync(join(directory, file), source);
  }
  execFileSync(process.execPath, ['--test', ...installedTests], { cwd: directory, stdio: 'inherit', timeout: 60_000 });
  if (process.argv[3]) {
    cpSync(new URL('./smoke-dsh-package.mjs', import.meta.url), join(directory, 'dsh-smoke.mjs'));
    execFileSync(process.execPath, ['--expose-internals', 'dsh-smoke.mjs', resolve(process.argv[3])], {
      cwd: directory, stdio: 'inherit', timeout: 60_000,
      env: { ...process.env, ACP_STATE_DIR: join(directory, 'state'), DSH_HOME: join(directory, 'dsh-home') },
    });
  }
  console.log('Installed service tarball smoke test passed');
} finally {
  rmSync(directory, { recursive: true, force: true });
  rmSync(flowDirectory, { recursive: true, force: true });
}
