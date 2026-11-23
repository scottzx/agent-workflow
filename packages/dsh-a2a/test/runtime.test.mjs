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
  await assert.rejects(restarted.prepare({ cwd: f.dir, agentPreset: 'oneagents-acp-codex' }), error => error.code === 'PRESET_UNSUPPORTED' && /composition/.test(error.message));
  await assert.rejects(restarted.prepare({ cwd: f.dir, provider: 'deepseek', model: 'deepseek-v4' }), error => error.code === 'MODEL_SELECTION_UNSUPPORTED' && /headless profile/.test(error.message));
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

test('standalone A2A rejects oneagents-acp-* preset and provider/model with clear error codes and no false queuing message', async t => {
  const f = await fixture(t);
  const service = await startA2AService({
    port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:3080', token: 'test',
    stateDirectory: join(f.dir, 'state-reject'), runtime: f.runtime,
  });
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  const rpc = async (method, params) => {
    const res = await fetch(`${origin}/a2a`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'A2A-Version': '1.0', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
    });
    assert.equal(res.status, 200);
    return res.json();
  };
  const send = await rpc('SendMessage', {
    message: { messageId: 'm-preset', role: 'ROLE_USER', parts: [{ text: 'hello', mediaType: 'text/plain' }] },
    configuration: { returnImmediately: true },
    metadata: { '1agents': { cwd: f.dir, agentPreset: 'oneagents-acp-grok-build' } },
  });
  const taskId = send.result.task.id;
  const submittedText = send.result.task.status?.message?.parts?.[0]?.text ?? '';
  assert.doesNotMatch(submittedText, /waiting in FIFO order/);
  let task;
  for (let i = 0; i < 40; i++) {
    const got = await rpc('GetTask', { id: taskId });
    task = got.result;
    if (task.status?.state === 'TASK_STATE_FAILED') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(task.status?.state, 'TASK_STATE_FAILED');
  assert.equal(task.metadata?.['1agents']?.result?.validation?.code, 'PRESET_UNSUPPORTED');
  assert.equal(task.status?.message?.parts?.[0]?.text, 'Only the configured DSH headless composition is supported');
  const historyTexts = (task.history ?? []).flatMap(item => (item.parts ?? []).map(p => p.text ?? ''));
  assert.ok(!historyTexts.some(line => line.includes('waiting in FIFO order')));

  const modelSend = await rpc('SendMessage', {
    message: { messageId: 'm-model', role: 'ROLE_USER', parts: [{ text: 'hello', mediaType: 'text/plain' }] },
    configuration: { returnImmediately: false },
    metadata: { '1agents': { cwd: f.dir, agentPreset: 'standard', provider: 'deepseek', model: 'deepseek-v4' } },
  });
  const modelTask = modelSend.result.task;
  assert.equal(modelTask.status?.state, 'TASK_STATE_FAILED');
  assert.equal(modelTask.metadata?.['1agents']?.result?.validation?.code, 'MODEL_SELECTION_UNSUPPORTED');
  assert.equal(modelTask.status?.message?.parts?.[0]?.text, 'Configure the model on the DSH headless profile');
});
