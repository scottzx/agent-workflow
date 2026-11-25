import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { readRowConfig, saveRowConfig, validateRowConfig } from '../dist/row-config.js';

test('validateRowConfig enforces constraints and preserves advanced fields for both bundled rows', () => {
  const acpSaved = validateRowConfig(
    'oneagents-acp',
    {
      serviceMode: 'launchd',
      serviceUrl: 'http://127.0.0.1:36812',
      serviceManagerLabel: 'com.1agents.acp-service',
      agents: ['codex', 'claude'],
      reconnectAttempts: 8,
      reconnectDelayMs: 500,
    },
    {
      sessionPolicies: { initialModeId: 'agent' },
      a2a: { enabled: true, tokenEnv: 'DSH_A2A_TOKEN' },
    },
  );
  assert.deepEqual(acpSaved, {
    sessionPolicies: { initialModeId: 'agent' },
    a2a: { enabled: true, tokenEnv: 'DSH_A2A_TOKEN' },
    serviceMode: 'launchd',
    serviceUrl: 'http://127.0.0.1:36812',
    serviceManagerLabel: 'com.1agents.acp-service',
    agents: ['codex', 'claude'],
    reconnectAttempts: 8,
    reconnectDelayMs: 500,
  });

  assert.throws(() => validateRowConfig('oneagents-acp', { serviceMode: 'invalid' }), /serviceMode/);
  assert.throws(() => validateRowConfig('oneagents-acp', { serviceMode: 'launchd', serviceUrl: 'http://127.0.0.1:36812' }), /serviceManagerLabel/);
  assert.throws(() => validateRowConfig('oneagents-acp', { serviceUrl: 'ftp://bad' }), /serviceUrl/);
  assert.throws(() => validateRowConfig('oneagents-acp', { agents: ['bad agent!'] }), /agents/);

  const a2aSaved = validateRowConfig(
    'oneagents-dsh-a2a',
    {
      hostWorkbench: true,
      host: '127.0.0.1',
      port: 3467,
      publicUrl: 'http://127.0.0.1:3467',
      tokenEnv: 'DSH_A2A_TOKEN',
      tokenFile: '/Users/scott/.dsh/state/web-a2a.token',
      workbench: { url: 'http://127.0.0.1:36814' },
      runtime: { mode: 'headless', command: 'dsh', args: ['--profile', 'headless'] },
    },
    {
      pushNotificationOrigins: ['http://127.0.0.1:36815'],
      workbench: { pageRelaySecret: 'kept-secret' },
    },
  );
  assert.deepEqual(a2aSaved, {
    pushNotificationOrigins: ['http://127.0.0.1:36815'],
    hostWorkbench: true,
    host: '127.0.0.1',
    port: 3467,
    publicUrl: 'http://127.0.0.1:3467',
    tokenEnv: 'DSH_A2A_TOKEN',
    tokenFile: '/Users/scott/.dsh/state/web-a2a.token',
    workbench: { pageRelaySecret: 'kept-secret', url: 'http://127.0.0.1:36814' },
    runtime: { mode: 'headless', command: 'dsh', args: ['--profile', 'headless'] },
  });

  const workbenchOnly = validateRowConfig('oneagents-dsh-a2a', { hostWorkbench: true, port: false });
  assert.equal(workbenchOnly.port, false);
  assert.throws(() => validateRowConfig('oneagents-dsh-a2a', { port: 0 }), /port/);
  assert.throws(() => validateRowConfig('oneagents-dsh-a2a', { port: 3080, publicUrl: 'http://127.0.0.1:3080/path' }), /Origin/);
  assert.throws(() => validateRowConfig('unknown-row', {}), /unsupported rowId/);
});

test('readRowConfig and saveRowConfig integrate with ConfigEditor cleanly', async () => {
  const entry = {
    disabled: false,
    fiber: { state: 2 },
    options: {
      id: 'oneagents-dsh-a2a',
      config: { host: '127.0.0.1', port: 3080, pushNotificationOrigins: ['http://127.0.0.1:36815'] },
    },
  };
  let edited = null;
  const editor = {
    configuration: () => [{ entry, inherited: { port: 3080 }, override: entry.options.config }],
    async edit(target, fn) {
      assert.equal(target, entry);
      edited = fn(entry.options.config, { port: 3080 });
      entry.options.config = edited;
    },
  };

  const before = readRowConfig(editor, 'oneagents-dsh-a2a');
  assert.equal(before.ok, true);
  assert.equal(before.writable, true);
  assert.equal(before.effective.port, 3080);

  const after = await saveRowConfig(editor, 'oneagents-dsh-a2a', {
    host: '127.0.0.1',
    port: 3467,
    publicUrl: 'http://127.0.0.1:3467',
  });
  assert.equal(after.ok, true);
  assert.equal(after.effective.port, 3467);
  assert.deepEqual(after.effective.pushNotificationOrigins, ['http://127.0.0.1:36815']);
  assert.equal(edited.port, 3467);

  const missing = readRowConfig(editor, 'oneagents-acp');
  assert.equal(missing.ok, true);
  assert.equal(missing.writable, false);
  assert.equal(missing.reason, 'inactive');

  const badSave = await saveRowConfig(editor, 'oneagents-dsh-a2a', { port: 99999 });
  assert.equal(badSave.ok, false);
  assert.equal(badSave.error.code, 'VALIDATION');
});

test('unified client registers plugins.row.config panels for both oneagents-acp and oneagents-dsh-a2a', async () => {
  let client;
  const slots = new Map();
  const mounted = [];
  const cleanups = [];
  runInNewContext(readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    AbortController,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    window: {
      __ModuleLoader__: {
        load: mod => {
          client = mod.factory(() => ({
            createElement: (type, props, ...children) => ({ type, props, children }),
            useState: v => [typeof v === 'function' ? v() : v, () => {}],
            useEffect: () => {},
            useCallback: fn => fn,
            useRef: v => ({ current: v }),
            useSyncExternalStore: (_s, g) => g(),
          }));
        },
      },
    },
    document: { createElement: () => ({ remove() {} }), head: { append() {} } },
    fetch: async () => ({ status: 404, ok: false, json: async () => ({}) }),
  });
  const ctx = {
    effect: setup => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); return cleanup ?? (() => {}); },
    on: () => {},
    plugin: async def => { def.apply(ctx); },
    conversation: { blocks: { set: () => {} } },
    locale: { register: () => {}, bind: () => key => key },
    slots: {
      entries: key => key === 'conversation.chat.node' ? [{ options: { key: 'assistant-step', priority: 0 }, locale: 'conversation', inject: () => ({ hooks: { presentation: {} } }), component: () => null }] : [],
      inject: (_key, setup) => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); return cleanup ?? (() => {}); },
      register: (options, component) => {
        const key = options.key ?? options.id ?? options.name;
        slots.set(`${options.name}:${key}`, { options, component });
        return () => slots.delete(`${options.name}:${key}`);
      },
    },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => ({ subscribe: () => () => {}, getSnapshot: () => 'standard' }) } } }), subagentAddress: () => undefined },
    remote: {
      $on: () => {},
      $mount: async contrib => { mounted.push(contrib); return () => {}; },
      acpRowConfig: { read: async () => ({ ok: true, writable: true, effective: {} }), save: async () => ({ ok: true, writable: true, effective: {} }) },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }), selectModel: async () => ({ ok: true }) },
    },
    commandUi: { register: () => {} },
  };
  client.apply(ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].package, '@1agents/acp-service');
  assert.ok(slots.has('plugins.row.config:@1agents/acp-service#oneagents-acp'));
  assert.ok(slots.has('plugins.row.config:@1agents/acp-service#oneagents-dsh-a2a'));
  const acpPanel = slots.get('plugins.row.config:@1agents/acp-service#oneagents-acp');
  const a2aPanel = slots.get('plugins.row.config:@1agents/acp-service#oneagents-dsh-a2a');
  assert.equal(acpPanel.component({ t: k => k, view: 'summary', api: acpPanel.options.inject().api }), 'summary.oneagents-acp');
  assert.equal(a2aPanel.component({ t: k => k, view: 'summary', api: a2aPanel.options.inject().api }), 'summary.oneagents-dsh-a2a');
  for (const cleanup of cleanups.reverse()) cleanup();
});
