import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../dist/index.js';

test('bundle registers ACP-only presets and releases them with its lifetime', async () => {
 const dir=mkdtempSync(join(tmpdir(),'dsh-acp-preset-')); const effects=[]; const routes=[]; const presets=new Map(); const listeners=new Map();
 const ctx={provide: (key, value) => { ctx[key] = value; effects.push(() => delete ctx[key]); },get: key => key==='dshHomePath' ? (...p)=>join(dir,...p) : undefined, llm:{registerAdapter: names=>{routes.push(...names);return ()=>{};}}, effect: async setup=>{effects.push(await setup());}, webServer:{register:()=>()=>{}}, on: (name, listener)=>{listeners.set(name, listener); return ()=>listeners.delete(name);}, agentPresets:{register:async definition=>{presets.set(definition.id,definition);return ()=>presets.delete(definition.id);}}};
 try {
  await apply(ctx, { agents: ['codex', 'grok-build'], serviceMode: 'external' });
  assert.deepEqual(routes,['1agents-acp']);
  assert.equal(typeof ctx.oneagentsAcpSessions.importSession, 'function');
  assert.deepEqual([...presets.keys()],['oneagents-acp-codex','oneagents-acp-grok-build']);
  const codex=presets.get('oneagents-acp-codex');
  assert.equal(codex.plugins[0].config.includeRuntimeContext,false);
  assert.equal(codex.plugins[1].name,'@1agents/acp-service/dsh/preset');
  assert.equal(codex.plugins[1].config.agent,'codex');
  assert.ok(listeners.get('agent-preset/selected'),'a preset selected on a running session records the ACP route');
 } finally { for(const dispose of effects) await dispose?.(); rmSync(dir,{recursive:true,force:true}); }
 assert.equal(presets.size,0);
});

import { createServer } from 'node:http';
import { discoverPresets } from '../dist/discovery.js';

async function inventoryServer(t, body, status = 200) {
 const server = createServer((req, res) => {
  assert.equal(req.url, '/agents'); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise(resolve => server.close(resolve)));
 return `http://127.0.0.1:${server.address().port}`;
}

test('default bundle imports service-discovered harness names and labels, then disposes presets', async t => {
 const serviceUrl = await inventoryServer(t, { agents: [
  { id: 'local-harness', label: 'Local Harness', chat_ready: true },
  { id: 'missing', label: 'Missing', chat_ready: false },
 ] });
 const stateDirectory = mkdtempSync(join(tmpdir(), 'dsh-acp-discovery-'));
 t.after(() => rmSync(stateDirectory, { recursive: true, force: true }));
 const effects = []; const presets = new Map(); let adapter;
 const ctx = { provide: (key, value) => { ctx[key] = value; effects.push(() => delete ctx[key]); }, get: () => undefined, effect: async setup => { effects.push(await setup()); },
  llm: { registerAdapter: (_names, value) => { adapter = value; return () => {}; } },
  webServer: { register: () => () => {} },
  on: () => () => {},
  agentPresets: { register: async preset => { presets.set(preset.id, preset); return () => presets.delete(preset.id); } },
 };
 try {
  await apply(ctx, { serviceUrl, serviceMode: 'external', stateDirectory });
  assert.deepEqual([...presets.keys()], ['oneagents-acp-local-harness']);
  assert.equal(presets.get('oneagents-acp-local-harness').name, 'ACP · Local Harness');
  assert.equal(presets.get('oneagents-acp-local-harness').plugins[1].config.agent, 'local-harness');
  assert.ok(adapter);
 } finally { for (const dispose of effects) await dispose?.(); }
 assert.equal(presets.size, 0);
});

test('discovery accepts an empty host and rejects malformed inventories and service failures', async t => {
 assert.deepEqual(await discoverPresets(await inventoryServer(t, { agents: [] })), []);
 await assert.rejects(discoverPresets(await inventoryServer(t, {})), /agents array/);
 await assert.rejects(discoverPresets(await inventoryServer(t, { agents: [{ id: '../bad', label: 'Bad', chat_ready: true }] })), /Invalid ACP/);
 await assert.rejects(discoverPresets(await inventoryServer(t, {}, 503)), /HTTP 503/);
});
