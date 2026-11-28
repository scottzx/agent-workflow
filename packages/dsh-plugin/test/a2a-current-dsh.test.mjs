import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshA2ABackend, inspectSession, projectModelCatalog } from '../dist/a2a-executor.js';
import { resolveA2AToken, resolveA2AWorkbench } from '../dist/a2a.js';

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

test('DshA2ABackend.checkRouteAvailability rejects failing or quota-exhausted providers with sanitized HTTP 429/503', async t => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-route-avail-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const f = currentDsh(cwd);
  f.ctx.sessionController.modelCatalog = async () => ({
    default: { provider: 'magpie', model: 'group/daily-choice' },
    groups: [{ id: 'magpie', name: 'Magpie', models: [{ id: 'group/daily-choice', name: 'Daily' }] }],
    failures: [
      { id: 'broken', name: 'Broken', message: 'secret upstream detail' },
      { id: 'grok-upstream', name: 'Grok', status: 429, code: 'ACCOUNT_QUOTA', message: 'secret quota token xyz' },
    ],
  });
  const backend = new DshA2ABackend(f.ctx);
  await backend.checkRouteAvailability({ provider: 'magpie', model: 'group/daily-choice', agentPreset: 'standard' });
  await assert.rejects(
    backend.checkRouteAvailability({ provider: 'broken', model: 'any-model', agentPreset: 'standard' }),
    error => error.status === 503 && error.code === 'HTTP_503' && !/secret upstream detail/.test(error.message),
  );
  await assert.rejects(
    backend.checkRouteAvailability({ provider: 'grok-upstream', model: 'grok/grok-4.7@500k', agentPreset: 'standard' }),
    error => error.status === 429 && error.code === 'ACCOUNT_QUOTA' && error.category === 'quota' && !/secret quota token/.test(error.message),
  );
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

test('resolveA2AToken and resolveA2AWorkbench load 0600 secret files and reject permissive modes', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-a2a-creds-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const tokenFile = join(dir, 'a2a.token');
  writeFileSync(tokenFile, 'secret-token-value\n', { mode: 0o600 });
  assert.equal(await resolveA2AToken({ tokenFile, tokenEnv: 'NONEXISTENT_A2A_ENV_TEST' }), 'secret-token-value');

  chmodSync(tokenFile, 0o644);
  await assert.rejects(resolveA2AToken({ tokenFile, tokenEnv: 'NONEXISTENT_A2A_ENV_TEST' }), /must not be accessible/);

  const gwFile = join(dir, 'gateway.json');
  writeFileSync(gwFile, JSON.stringify({ workbench: { token: 'wb-tok', pageRelaySecret: 'relay-sec' } }), { mode: 0o600 });
  const wb = await resolveA2AWorkbench({ url: 'http://127.0.0.1:36814' }, gwFile);
  assert.deepEqual(wb, { url: 'http://127.0.0.1:36814', token: 'wb-tok', pageRelaySecret: 'relay-sec' });

  chmodSync(gwFile, 0o640);
  await assert.rejects(resolveA2AWorkbench({ url: 'http://127.0.0.1:36814' }, gwFile), /must not be accessible/);
});

test('prepare enforces sandboxMode read-only through the host permission presets and fails closed without them', async t => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-sandbox-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // 1. The host exposes permissionPresets: the preset is installed on this agent's session before any prompt.
  const enforced = currentDsh(cwd);
  const calls = [];
  enforced.ctx.permissionPresets = { set: (session, preset) => { calls.push([session, preset]); } };
  const backend = new DshA2ABackend(enforced.ctx);
  const target = await backend.prepare({ sessionId: 'stored', sandboxMode: 'read-only' });
  assert.equal(target.sessionId, 'stored');
  assert.equal(calls.length, 1, 'exactly one permission preset call');
  assert.equal(calls[0][1], 'read-only');
  assert.deepEqual(calls[0][0], { id: 'stored', header: { id: 'stored', cwd, agentPreset: 'standard' } },
    'the preset applies to the prepared agent session');

  // 2. A host without permission presets refuses instead of silently running writable work.
  const absent = currentDsh(cwd);
  delete absent.ctx.permissionPresets;
  await assert.rejects(
    new DshA2ABackend(absent.ctx).prepare({ sessionId: 'stored', sandboxMode: 'read-only' }),
    error => error.code === 'SANDBOX_UNAVAILABLE' && /read-only sandbox/.test(error.message),
    'a missing permissionPresets service must fail closed',
  );

  // 3. A preset call that throws also fails closed, with the host error kept as the cause.
  const broken = currentDsh(cwd);
  const hostError = new Error('permission preset service is unavailable');
  broken.ctx.permissionPresets = { set: () => { throw hostError; } };
  await assert.rejects(
    new DshA2ABackend(broken.ctx).prepare({ sessionId: 'stored', sandboxMode: 'read-only' }),
    error => error.code === 'SANDBOX_UNAVAILABLE' && error.cause === hostError,
    'a refused preset must not be downgraded to workspace-write',
  );

  // 4. Without sandboxMode nothing is touched: a writable task keeps its host default.
  const untouched = currentDsh(cwd);
  const untouchedCalls = [];
  untouched.ctx.permissionPresets = { set: (session, preset) => { untouchedCalls.push([session, preset]); } };
  await new DshA2ABackend(untouched.ctx).prepare({ sessionId: 'stored' });
  assert.deepEqual(untouchedCalls, [], 'a task without sandboxMode never changes permissions');
});

test('a brand-new read-only session also gets the preset, and a refused preset prevents the session from running', async t => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-sandbox-new-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const f = currentDsh(cwd);
  const freshSession = { id: 'fresh', header: { id: 'fresh', cwd, agentPreset: 'standard' } };
  const freshAgent = { id: 'fresh', session: freshSession };
  const calls = [];
  f.ctx.permissionPresets = { set: (session, preset) => { calls.push([session, preset]); } };
  f.ctx.sessionController.create = async () => ({ sessionId: 'fresh', agentPreset: 'standard' });
  const resolve = f.ctx.sessionController.resolveAgent;
  f.ctx.sessionController.resolveAgent = async id => id === 'fresh' ? { agent: freshAgent } : resolve(id);

  const target = await new DshA2ABackend(f.ctx).prepare({ cwd, agentPreset: 'standard', sandboxMode: 'read-only' });
  assert.equal(target.sessionId, 'fresh');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], freshSession);
  assert.equal(calls[0][1], 'read-only');

  // The same new-session path fails closed when the host cannot set the preset.
  const g = currentDsh(cwd);
  g.ctx.sessionController.create = async () => ({ sessionId: 'fresh', agentPreset: 'standard' });
  const resolveFresh = g.ctx.sessionController.resolveAgent;
  g.ctx.sessionController.resolveAgent = async id => id === 'fresh' ? { agent: freshAgent } : resolveFresh(id);
  await assert.rejects(
    new DshA2ABackend(g.ctx).prepare({ cwd, agentPreset: 'standard', sandboxMode: 'read-only' }),
    error => error.code === 'SANDBOX_UNAVAILABLE',
  );
});
