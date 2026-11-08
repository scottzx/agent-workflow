import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshA2ABackend, inspectSession } from '../dist/a2a-executor.js';

/** A context shaped like DSH 0.2.2: no sessionController.inspect, headers through sessionQuery, models on the agent. */
function currentDsh(cwd) {
  const headers = new Map([['stored', { id: 'stored', cwd, agentPreset: 'standard' }]]);
  const disposed = [], selected = [], controllerSelections = [], defaults = [];
  const agent = { id: 'stored', session: { id: 'stored', header: headers.get('stored') }, model: { select: value => selected.push(value) } };
  const ctx = {
    sessions: { get: () => undefined },
    sessionController: {
      resolveAgent: async id => id === 'stored' ? { agent } : { error: new Error(`session "${id}" not found`) },
      selectModel: async request => { controllerSelections.push(request); defaults.push(request); return { selected: request }; },
      modelCatalog: async () => ({ groups: [{ id: 'minimax-cn', models: [{ id: 'MiniMax-M3.1-Flash' }] }] }),
    },
    llm: { resolveCallConfig: async value => value },
    get: name => name === 'sessionQuery' ? {
      observeSession: async id => {
        const header = headers.get(id);
        if (!header) throw Object.assign(new Error(`session "${id}" not found`), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
        return { header, [Symbol.dispose]: () => disposed.push(id) };
      },
    } : undefined,
  };
  return { ctx, disposed, selected, controllerSelections, defaults };
}

test('inspectSession reads a stored header without sessionController.inspect and releases the observation', async t => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-current-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const f = currentDsh(cwd);
  assert.deepEqual(await inspectSession(f.ctx, 'stored'), { meta: { id: 'stored', cwd, agentPreset: 'standard' } });
  assert.deepEqual(f.disposed, ['stored']);
  assert.equal(await inspectSession(f.ctx, 'missing'), null);
  // Older hosts keep their own inspect.
  const legacy = { sessionController: { inspect: async id => ({ meta: { id, cwd: '/legacy' } }) } };
  assert.deepEqual(await inspectSession(legacy, 'x'), { meta: { id: 'x', cwd: '/legacy' } });
});

test('continuing a stored session prepares it and selects its model without saving a host default', async t => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-current-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const f = currentDsh(cwd);
  const backend = new DshA2ABackend(f.ctx);
  const target = await backend.prepare({ sessionId: 'stored', provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' });
  assert.equal(target.sessionId, 'stored');
  assert.equal(target.cwd, cwd);
  assert.equal(target.agentPreset, 'standard');
  assert.deepEqual(f.selected, [{ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' }]);
  assert.deepEqual(f.controllerSelections, []);
  assert.deepEqual(f.defaults, []);
  await assert.rejects(backend.prepare({ sessionId: 'missing' }), /not found/);
  assert.deepEqual(await backend.status({ sessionId: 'stored', agentPreset: 'standard' }), { attached: true, activeTurn: false });
  assert.deepEqual(await backend.status({ sessionId: 'missing', agentPreset: 'standard' }), { attached: false, activeTurn: false });
});
