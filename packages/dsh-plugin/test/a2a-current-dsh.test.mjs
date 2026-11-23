import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshA2ABackend, inspectSession, projectModelCatalog } from '../dist/a2a-executor.js';

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

test('model catalog keeps routing groups and drops provider failure text', () => {
  const catalog = projectModelCatalog({
    default: { provider: 'magpie', model: 'group/daily-choice' },
    groups: [{ id: 'magpie', name: 'Magpie', models: [
      { id: 'group/daily-choice', name: '平价 · routing group', reasoning: { efforts: [{ id: 'high', name: 'high' }], defaultEffort: 'high' } },
      { id: 'minimax-cn/MiniMax-M3.1-Flash', name: 'MiniMax' },
    ] }],
    failures: [{ id: 'broken', name: 'Broken', message: 'secret upstream detail' }],
  });
  assert.equal(catalog.default.model, 'group/daily-choice');
  assert.equal(catalog.groups[0].models[0].routingGroup, true);
  assert.deepEqual(catalog.groups[0].models[0].reasoning, { efforts: [{ id: 'high', name: 'high' }], defaultEffort: 'high' });
  assert.equal(catalog.groups[0].models[1].routingGroup, undefined);
  assert.deepEqual(catalog.failures, [{ id: 'broken', name: 'Broken' }]);
  assert.equal(JSON.stringify(catalog).includes('secret upstream'), false);
});

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

test('a routing group is recorded even when exact model resolution rejects it', async t => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-current-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const f = currentDsh(cwd);
  f.ctx.sessionController.modelCatalog = async () => ({
    default: { provider: 'magpie', model: 'group/daily-choice' },
    groups: [{ id: 'magpie', models: [{ id: 'group/daily-choice', name: '平价 · routing group' }, { id: 'group/work', name: '主力 · routing group' }] }],
  });
  f.ctx.llm.resolveCallConfig = async () => { throw Object.assign(new Error('pi-ai provider "magpie" has no configured model "group/daily-choice"'), { code: 'UNKNOWN_MODEL' }); };
  const backend = new DshA2ABackend(f.ctx);
  const target = await backend.prepare({ sessionId: 'stored', cwd, agentPreset: 'standard', provider: 'magpie', model: 'group/daily-choice' });
  assert.equal(target.provider, 'magpie');
  assert.equal(target.model, 'group/daily-choice');
  assert.deepEqual(f.selected, [{ provider: 'magpie', model: 'group/daily-choice' }]);
  assert.deepEqual(f.controllerSelections, [], 'the session route is recorded locally and is not saved as the host default');
});

test('the host default route is accepted when the catalog cannot enumerate it', async t => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-current-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const f = currentDsh(cwd);
  f.ctx.sessionController.modelCatalog = async () => { throw new Error('catalog.groups is not iterable'); };
  f.ctx.agentDefaultModel = { currentSelection: () => ({ provider: 'magpie', model: 'group/daily-choice' }) };
  f.ctx.llm.resolveCallConfig = async () => { throw new Error('exact model lookup failed'); };
  const backend = new DshA2ABackend(f.ctx);
  const target = await backend.prepare({ sessionId: 'stored', cwd, provider: 'magpie', model: 'group/daily-choice' });
  assert.deepEqual(f.selected, [{ provider: 'magpie', model: 'group/daily-choice' }]);
  assert.equal(`${target.provider}/${target.model}`, 'magpie/group/daily-choice');
  await assert.rejects(backend.prepare({ sessionId: 'stored', cwd, provider: 'magpie', model: 'missing-model' }),
    error => error.code === 'UNKNOWN_MODEL_OR_GROUP' && error.message === 'Unknown model or routing group: magpie/missing-model');
});
