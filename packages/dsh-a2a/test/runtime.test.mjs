import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadlessDshBackend } from '../src/executor.js';
import { startA2AService } from '../src/server.js';

async function fixture(t, mode = 'ok') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-only-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'runtime.mjs');
  await writeFile(script, `let text='';for await(const c of process.stdin)text+=c;const a=process.argv.slice(2);if(!a.includes('--json')||!a.includes('--approval-policy')||a.at(-1)!=='-')process.exit(2);const id=a.includes('--session-id')?a[a.indexOf('--session-id')+1]:'session-real';console.log(JSON.stringify({type:'session',sessionId:id}));${mode === 'missing' ? '' : "console.log(JSON.stringify({type:'final',sessionId:id,text,reason:{kind:'completed'}}));"}`);
  return { dir, runtime: { command: process.execPath, args: [script] } };
}
test('DSH-only runtime creates and resumes persisted sessions across backend restarts', async t => {
  const f = await fixture(t), config = { directory: join(f.dir, 'sessions'), ...f.runtime };
  const backend = new HeadlessDshBackend(config), target = await backend.prepare({ cwd: f.dir });
  const options = { signal: new AbortController().signal, requestId: 'one' };
  assert.deepEqual(await backend.run(target, 'hello', options), { outcome: 'completed', text: 'hello' });
  const restarted = new HeadlessDshBackend(config);
  assert.equal((await restarted.run(target, 'continue', options)).text, 'continue');
  assert.equal((await restarted.status(target)).activeTurn, false);
  await assert.rejects(restarted.prepare({ cwd: f.dir, agentPreset: 'oneagents-acp-codex' }), /composition/);
});
test('missing final is failed and cannot silently replay an uncertain run', async t => {
  const f = await fixture(t, 'missing'), backend = new HeadlessDshBackend({ directory: f.dir, ...f.runtime });
  const target = await backend.prepare({ cwd: f.dir }), options = { signal: new AbortController().signal };
  assert.equal((await backend.run(target, 'hello', options)).outcome, 'failed');
  await assert.rejects(backend.run(target, 'retry', options), /unknown outcome/);
});
test('standalone A2A opens its own port without ACP or Host services and releases storage', async t => {
  const f = await fixture(t);
  const config = { port: 0, publicUrl: 'http://127.0.0.1:3080', token: 'test', stateDirectory: join(f.dir, 'state'), runtime: f.runtime };
  const service = await startA2AService(config);
  try {
    const origin = `http://127.0.0.1:${service.server.address().port}`;
    assert.equal((await fetch(`${origin}/.well-known/agent-card.json`)).status, 200);
    assert.equal((await fetch(`${origin}/a2a`, { method: 'POST' })).status, 401);
  } finally { await service.close(); }
  const restarted = await startA2AService(config); await restarted.close();
});
test('a taken listen port moves forward and the agent card follows it', async t => {
  const f = await fixture(t);
  const held = createServer((_req, res) => { res.writeHead(200); res.end('held'); });
  await new Promise(resolve => held.listen(0, '127.0.0.1', resolve));
  const busy = held.address().port;
  t.after(() => new Promise(resolve => { held.closeAllConnections(); held.close(() => resolve()); }));
  const notes = [];
  const original = console.error;
  console.error = (...args) => notes.push(args.join(' '));
  let service;
  try {
    service = await startA2AService({
      port: busy, host: '127.0.0.1', publicUrl: `http://127.0.0.1:${busy}`, token: 'test',
      stateDirectory: join(f.dir, 'fallback-state'), runtime: f.runtime,
    });
  } finally { console.error = original; }
  t.after(() => service.close());
  const actual = service.server.address().port;
  assert.notEqual(actual, busy);
  assert.equal(service.port, actual);
  assert.equal(service.publicUrl, `http://127.0.0.1:${actual}`);
  assert.ok(notes.some(line => line.includes(`${busy} is already in use`) && line.includes(String(actual))));
  const card = await (await fetch(`http://127.0.0.1:${actual}/.well-known/agent-card.json`)).json();
  assert.match(JSON.stringify(card), new RegExp(`http://127\\.0\\.0\\.1:${actual}/a2a`));
  assert.equal(await (await fetch(`http://127.0.0.1:${busy}/`)).text(), 'held');
});
test('a listen error other than a taken port still fails before the store is acquired', async t => {
  const f = await fixture(t);
  const directory = join(f.dir, 'bad-port');
  await assert.rejects(startA2AService({
    port: 70_000, token: 'test', stateDirectory: directory, runtime: f.runtime,
  }), /port|range/i);
  const recovered = await startA2AService({
    port: 0, publicUrl: 'http://127.0.0.1:3080', token: 'test', stateDirectory: directory, runtime: f.runtime,
  });
  await recovered.close();
});
