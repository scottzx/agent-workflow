import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { embedRuntime } from './embed-runtime.mjs';
import { stageDsh } from './embed-dsh.mjs';
import { rewriteRuntimeSource } from './package-embed.mjs';
import { verifyPackageBuild } from './verify-package-build.mjs';

const flow = 'new Set(["acpx/flows", "@scottzx/1acp/flows"])';
const save = (path, contents) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); };

function consistent(t) {
  const root = mkdtempSync(join(tmpdir(), 'package-embed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = {
    name: '@1agents/acp-service', version: '0.0.0',
    exports: { './client': './vendor/dsh/client.js', './dsh-a2a': './vendor/dsh-a2a/index.js' },
    bin: { 'acp-service': 'dist/bin/acp-service.js', 'dsh-a2a': 'vendor/dsh-a2a/cli.js' },
    dsh: { bundle: { patch: './vendor/dsh/cordis.patch.yml' } },
    dependencies: {
      '@1agents/acp-runtime-sdk': 'npm:@agentclientprotocol/sdk@^1.9.0',
      'left-pad': '1.0.0',
      'ws': '^8.18.0',
      '@a2a-js/sdk': '1.3.0',
    },
  };
  save(join(root, 'packages/service/package.json'), JSON.stringify(service));
  save(join(root, 'packages/service/dist/bin/acp-service.js'), '#!/usr/bin/env node\n');
  save(join(root, 'packages/service/dist/workbench-ui/index.html'), '<!doctype html>\n');
  save(join(root, 'packages/service/dist/workbench-ui/app.js'), 'export {}\n');
  save(join(root, 'packages/runtime/package.json'), JSON.stringify({
    name: '@scottzx/1acp', version: '0.16.0', private: true,
    dependencies: { '@agentclientprotocol/sdk': '^1.9.0', 'left-pad': '1.0.0' },
    devDependencies: { typescript: '^5.7.2' }, scripts: { build: 'nope' },
  }));
  save(join(root, 'packages/runtime/dist/cli.js'), `import "@agentclientprotocol/sdk";\nconst a = ${flow};\nconst b = ${flow};\n`);
  save(join(root, 'packages/runtime/skills/use.md'), 'skill\n');
  save(join(root, 'packages/runtime/LICENSE'), 'MIT\n');
  save(join(root, 'packages/runtime/README.md'), 'runtime\n');
  save(join(root, 'packages/dsh-plugin/package.json'), JSON.stringify({
    name: '@1agents/dsh-acp', private: true,
    dependencies: { '@1agents/acp-service': 'workspace:^', ws: '^8.18.0' },
  }));
  save(join(root, 'packages/dsh-plugin/dist/client.js'), 'load({id:"@1agents/acp-service"});\n');
  save(join(root, 'packages/dsh-plugin/dist/service-worker.js'), 'export const worker = 1;\n');
  save(join(root, 'packages/dsh-plugin/cordis.patch.yml'), `- name: '${service.name}'\n- name: '${service.name}/dsh-a2a'\n`);
  save(join(root, 'packages/dsh-plugin/README.md'), 'plugin\n');
  save(join(root, 'packages/dsh-plugin/LICENSE'), 'MIT\n');
  save(join(root, 'packages/dsh-a2a/package.json'), JSON.stringify({
    name: '@1agents/dsh-a2a', private: true,
    dependencies: { '@1agents/acp-service': 'workspace:^', '@a2a-js/sdk': '1.3.0' },
  }));
  save(join(root, 'packages/dsh-a2a/dist/index.js'), 'export const name = "oneagents-dsh-a2a";\n');
  save(join(root, 'packages/dsh-a2a/dist/cli.js'), '#!/usr/bin/env node\n');
  save(join(root, 'packages/dsh-a2a/README.md'), 'dsh-a2a\n');
  embedRuntime(root);
  stageDsh(root);
  return root;
}

test('runtime rewrite keeps the SDK alias beside the service flow entry', () => {
  const rewritten = rewriteRuntimeSource(`import "@agentclientprotocol/sdk";\n${flow}\n`);
  assert.equal(rewritten.flowHooks, 1);
  assert.equal(rewritten.text, 'import "@1agents/acp-runtime-sdk";\nnew Set(["acpx/flows", "@scottzx/1acp/flows", "@1agents/acp-service/flows"])\n');
});

test('verify accepts an embed and rejects a stale byte, an unrewritten runtime, and a third SDK range', t => {
  const root = consistent(t);
  assert.doesNotThrow(() => verifyPackageBuild(root));
  const embedded = JSON.parse(readFileSync(join(root, 'packages/service/vendor/runtime/package.json'), 'utf8'));
  assert.equal(embedded.dependencies['@1agents/acp-runtime-sdk'], 'npm:@agentclientprotocol/sdk@^1.9.0');
  assert.equal(embedded.scripts, undefined);
  assert.equal(embedded.devDependencies, undefined);

  const worker = join(root, 'packages/service/vendor/dsh/service-worker.js');
  const original = readFileSync(worker, 'utf8');
  writeFileSync(worker, original.replace('1', '2'));
  assert.throws(() => verifyPackageBuild(root), /vendor\/dsh content mismatch: service-worker\.js/);
  writeFileSync(worker, original);

  const dshA2AIndex = join(root, 'packages/service/vendor/dsh-a2a/index.js');
  const originalA2A = readFileSync(dshA2AIndex, 'utf8');
  writeFileSync(dshA2AIndex, originalA2A + '// drift\n');
  assert.throws(() => verifyPackageBuild(root), /vendor\/dsh-a2a content mismatch: index\.js/);
  writeFileSync(dshA2AIndex, originalA2A);

  const cli = join(root, 'packages/service/vendor/runtime/dist/cli.js');
  const rewritten = readFileSync(cli, 'utf8');
  writeFileSync(cli, rewritten.replaceAll('@1agents/acp-runtime-sdk', '@agentclientprotocol/sdk'));
  assert.throws(() => verifyPackageBuild(root), /vendor\/runtime content mismatch: dist\/cli\.js/);
  writeFileSync(cli, rewritten);

  embedded.dependencies['@1agents/acp-runtime-sdk'] = 'npm:@agentclientprotocol/sdk@^1.5.0';
  writeFileSync(join(root, 'packages/service/vendor/runtime/package.json'), JSON.stringify(embedded, null, 2) + '\n');
  assert.throws(() => verifyPackageBuild(root), /vendor\/runtime content mismatch: package\.json/);
});
