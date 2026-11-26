import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ReviewHandBack } from '../dist/review.js';

test('review MCP session_identity returns the bound session and never the token', async t => {
  const secret = 'super-secret-review-token';
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/review-mcp.js', import.meta.url))], {
    env: {
      ...process.env,
      ONEAGENTS_REVIEW_URL: 'http://127.0.0.1:9/review',
      ONEAGENTS_REVIEW_SESSION: 'sess-42',
      ONEAGENTS_REVIEW_TOKEN: secret,
      ONEAGENTS_SESSION_HOST: 'dsh-local',
      ONEAGENTS_DSH_ORIGIN: 'http://127.0.0.1:9',
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
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return JSON.parse(lines[before]);
  };
  const listed = await ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const spec = listed.result.tools.find(tool => tool.name === 'session_identity');
  assert.equal(spec.inputSchema.additionalProperties, false);
  assert.deepEqual(spec.inputSchema.properties, {});
  assert.equal(JSON.stringify(spec).includes(secret), false);
  const called = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_identity', arguments: {} } });
  assert.equal(called.result.isError, undefined);
  assert.deepEqual(JSON.parse(called.result.content[0].text), {
    sessionId: 'sess-42', defaultHost: 'dsh-local', origin: 'http://127.0.0.1:9',
  });
  assert.equal(called.result.content[0].text.includes(secret), false);
  assert.equal(JSON.stringify(called).includes('ONEAGENTS_REVIEW_TOKEN'), false);
});

test('the ACP review server publishes the default host and DSH origin', async t => {
  const root = await mkdtemp(join(tmpdir(), 'review-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.ONEAGENTS_SESSION_HOST;
  delete process.env.ONEAGENTS_SESSION_HOST;
  try {
    const review = await ReviewHandBack.open(join(root, 'review.secret'));
    const server = review.mcpServer('sess-7', 'http://127.0.0.1:9/');
    const env = Object.fromEntries(server.env.map(item => [item.name, item.value]));
    assert.equal(env.ONEAGENTS_SESSION_HOST, 'dsh-local');
    assert.equal(env.ONEAGENTS_DSH_ORIGIN, 'http://127.0.0.1:9/');
    assert.equal(env.ONEAGENTS_REVIEW_SESSION, 'sess-7');
    assert.equal(typeof env.ONEAGENTS_REVIEW_TOKEN, 'string');
    assert.notEqual(env.ONEAGENTS_REVIEW_TOKEN, '');
  } finally {
    if (previous === undefined) delete process.env.ONEAGENTS_SESSION_HOST;
    else process.env.ONEAGENTS_SESSION_HOST = previous;
  }
});
