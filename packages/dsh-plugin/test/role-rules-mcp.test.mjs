import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ReviewHandBack } from '../dist/review.js';
import { readSessionRoleRules } from '../dist/role-rules-session.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

test('review-mcp forwards role_rules_get with optional phase and the hand-back rejects bad calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'role-rules-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const review = await ReviewHandBack.open(join(root, 'review.secret'));
  const seen = [];
  const server = createServer(review.roleRulesHandler(async (sessionId, args) => {
    seen.push({ sessionId, args });
    return JSON.stringify({ ok: true, sessionId, roleId: args.roleId, phase: args.phase ?? 'all' });
  }));
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/1agents-acp/role-rules`;
  const published = Object.fromEntries(review.mcpServer('sess-9', 'http://127.0.0.1:9/').env.map(item => [item.name, item.value]));
  assert.equal(published.ONEAGENTS_ROLE_RULES_URL, 'http://127.0.0.1:9/1agents-acp/role-rules');
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));

  const post = async (headers, body) => {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const denied = await post({}, { tool: 'role_rules_get', arguments: { roleId: 'pr-delivery' } });
  assert.equal(denied.status, 401);
  const wrong = await post({ authorization: 'Bearer nope', 'x-oneagents-session': 'sess-9' }, { tool: 'role_rules_get', arguments: { roleId: 'pr-delivery' } });
  assert.equal(wrong.status, 401);
  const foreign = await post({
    authorization: `Bearer ${published.ONEAGENTS_REVIEW_TOKEN}`,
    'x-oneagents-session': 'sess-9',
    origin: 'http://evil.example',
  }, { tool: 'role_rules_get', arguments: { roleId: 'pr-delivery' } });
  assert.equal(foreign.status, 403);
  const badPhase = await post({
    authorization: `Bearer ${published.ONEAGENTS_REVIEW_TOKEN}`,
    'x-oneagents-session': 'sess-9',
  }, { tool: 'role_rules_get', arguments: { roleId: 'pr-delivery', phase: 'nope' } });
  assert.equal(badPhase.status, 400);
  assert.match(badPhase.body.error, /invalid phase/);
  const rooted = await post({
    authorization: `Bearer ${published.ONEAGENTS_REVIEW_TOKEN}`,
    'x-oneagents-session': 'sess-9',
  }, { tool: 'role_rules_get', arguments: { roleId: 'pr-delivery', projectRoot: '/tmp' } });
  assert.equal(rooted.status, 400);
  assert.match(rooted.body.error, /unexpected argument: projectRoot/);
  assert.equal(seen.length, 0);

  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/review-mcp.js', import.meta.url))], {
    env: {
      ...process.env,
      ONEAGENTS_REVIEW_URL: 'http://127.0.0.1:9/review',
      ONEAGENTS_ROLE_RULES_URL: endpoint,
      ONEAGENTS_REVIEW_SESSION: 'sess-9',
      ONEAGENTS_REVIEW_TOKEN: published.ONEAGENTS_REVIEW_TOKEN,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) { lines.push(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
  });
  t.after(() => { child.kill(); });
  const ask = async message => {
    const before = lines.length;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const deadline = Date.now() + 5000;
    while (lines.length === before) {
      if (child.exitCode !== null) throw new Error(`review-mcp exited ${child.exitCode}: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`review-mcp timed out: ${stderr}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    return JSON.parse(lines[before]);
  };
  const listed = await ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const spec = listed.result.tools.find(tool => tool.name === 'role_rules_get');
  assert.deepEqual(spec.inputSchema.required, ['roleId']);
  assert.equal(spec.inputSchema.required.includes('phase'), false);
  assert.deepEqual(spec.inputSchema.properties.phase.enum, ['all', 'implement', 'review', 'gate', 'coach']);
  assert.equal(spec.inputSchema.properties.projectRoot, undefined);
  const omitted = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'role_rules_get', arguments: { roleId: 'pr-delivery' } } });
  assert.equal(omitted.result.isError, undefined);
  assert.deepEqual(JSON.parse(omitted.result.content[0].text), { ok: true, sessionId: 'sess-9', roleId: 'pr-delivery', phase: 'all' });
  const reviewed = await ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'role_rules_get', arguments: { roleId: 'pr-delivery', phase: 'review' } } });
  assert.equal(reviewed.result.isError, undefined);
  assert.equal(JSON.parse(reviewed.result.content[0].text).phase, 'review');
  const invalid = await ask({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'role_rules_get', arguments: { roleId: 'pr-delivery', phase: 'ship' } } });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /invalid phase/);
  const injected = await ask({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'role_rules_get', arguments: { roleId: 'pr-delivery', projectRoot: repoRoot } } });
  assert.equal(injected.result.isError, true);
  assert.match(injected.result.content[0].text, /projectRoot/);
  assert.deepEqual(seen.map(call => call.args), [
    { roleId: 'pr-delivery' },
    { roleId: 'pr-delivery', phase: 'review' },
  ]);
});

test('readSessionRoleRules uses the authenticated session cwd and not a caller root', async () => {
  const cwd = join(repoRoot, 'packages/dsh-plugin');
  const gate = JSON.parse(await readSessionRoleRules({
    sessionId: 'sess-cwd',
    roleId: 'pr-delivery',
    phase: 'gate',
    resolveAgent: async () => ({ agent: { session: { header: { cwd } } } }),
  }));
  assert.equal(gate.phase, 'gate');
  assert.equal(gate.roleId, 'pr-delivery');
  assert.equal(gate.roleInstructions, undefined);
  assert.equal(gate.qaInstructions, undefined);
  assert.equal(JSON.stringify(gate).includes('异模型审查者'), false);
  const review = JSON.parse(await readSessionRoleRules({
    sessionId: 'sess-cwd',
    roleId: 'pr-delivery',
    phase: 'review',
    resolveAgent: async () => ({ agent: { session: { header: { cwd } } } }),
  }));
  assert.match(review.qaInstructions, /异模型审查者/);
  assert.equal(review.roleInstructions, undefined);
  await assert.rejects(readSessionRoleRules({
    sessionId: 'missing',
    roleId: 'pr-delivery',
    resolveAgent: async () => ({ error: new Error('session gone') }),
  }), /无法取得会话工作目录：session gone/);
  await assert.rejects(readSessionRoleRules({
    sessionId: 'bare',
    roleId: 'pr-delivery',
    resolveAgent: async () => ({ agent: { session: { header: {} } } }),
  }), /没有工作目录/);
});
