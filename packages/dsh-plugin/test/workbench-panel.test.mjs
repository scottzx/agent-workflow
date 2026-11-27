import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

function hookRenderer() {
  const values = [], effects = [];
  let index = 0, pending = [];
  const hooks = {
    useState(initial) {
      const key = index++;
      if (!(key in values)) values[key] = initial;
      return [values[key], value => { values[key] = typeof value === 'function' ? value(values[key]) : value; }];
    },
    useRef(initial) {
      const key = index++;
      if (!(key in values)) values[key] = { current: initial };
      return values[key];
    },
    useEffect(setup, dependencies) {
      const key = index++;
      const previous = effects[key];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        pending.push(() => {
          previous?.cleanup?.();
          effects[key] = { dependencies, cleanup: setup() };
        });
      }
    },
  };
  return {
    hooks,
    render(component, props) {
      index = 0;
      pending = [];
      const tree = component(props);
      for (const effect of pending) effect();
      return tree;
    },
  };
}

function textOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  return [node.children].flat(Infinity).map(textOf).join('');
}

function findBadge(node) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.props?.['data-approvals-badge']) return node;
  for (const child of [node.children].flat()) {
    const found = findBadge(child);
    if (found) return found;
  }
}

test('workbench icon badge follows the approvals summary poll and a same-origin postMessage', async () => {
  const hooks = hookRenderer();
  const slots = new Map();
  const messageListeners = new Set();
  const visibilityListeners = new Set();
  let hidden = false;
  let pending = 4;
  let intervalFn;
  const bundle = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8');
  let client;
  runInNewContext(bundle, {
    AbortController,
    setInterval: fn => { intervalFn = fn; return 7; },
    clearInterval: () => { intervalFn = undefined; },
    setTimeout: () => 0,
    clearTimeout: () => {},
    location: { origin: 'http://127.0.0.1:3466' },
    window: {
      __ModuleLoader__: { load: mod => { client = mod.factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }), ...hooks.hooks })); } },
      addEventListener: (_type, fn) => messageListeners.add(fn),
      removeEventListener: (_type, fn) => messageListeners.delete(fn),
    },
    document: {
      get hidden() { return hidden; },
      addEventListener: (type, fn) => { if (type === 'visibilitychange') visibilityListeners.add(fn); },
      removeEventListener: (type, fn) => { if (type === 'visibilitychange') visibilityListeners.delete(fn); },
      createElement: () => ({ remove() {} }),
      head: { append() {} },
      getElementById: () => null,
    },
    fetch: async url => {
      const path = String(url);
      if (path.includes('/approvals')) {
        return { status: 200, ok: true, json: async () => ({ totalPending: pending, counts: { process_request: 1, review: 0, handoff: 0, proposal: pending - 1 }, latestCreatedAt: '2026-11-25T00:00:00.000Z' }) };
      }
      return { status: 200, ok: true, json: async () => ({ authenticated: true }) };
    },
  });
  const ctx = {
    effect: setup => setup(),
    on: () => {},
    inject: (_deps, fn) => fn(ctx),
    locale: { register: () => {}, bind: () => key => key },
    slots: {
      entries: key => key === 'conversation.chat.node' ? [{ options: { key: 'assistant-step', priority: 0 }, locale: 'conversation', inject: () => ({ hooks: { presentation: {} } }), component: () => null }] : [],
      inject: (_key, setup) => setup(),
      register: (options, component) => {
        slots.set(`${options.name}:${options.key ?? options.id}`, { options, component });
        return () => {};
      },
    },
    conversation: { blocks: { set: () => {} } },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => ({ subscribe: () => () => {}, getSnapshot: () => 'standard' }) } } }), subagentAddress: () => undefined },
    remote: { $on: () => {}, session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }), selectModel: async () => ({ ok: true }) } },
    commandUi: { register: () => {} },
    uiWorkspace: { openSession: () => {} },
  };
  client.apply(ctx);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const icon = slots.get('sidebar.panellist:oneagents-a2a-workbench').component;
  let tree = hooks.render(icon, { size: 20 });
  tree = hooks.render(icon, { size: 20 });
  let badge = findBadge(tree);
  assert.equal(textOf(badge), '4');
  assert.equal(badge.props['data-unread'], 'false');
  assert.match(tree.props.title, /4 条待审批/);
  assert.match(tree.props.title, /过程请求/);

  hidden = true;
  pending = 9;
  intervalFn();
  await new Promise(resolve => setImmediate(resolve));
  tree = hooks.render(icon, { size: 20 });
  assert.equal(textOf(findBadge(tree)), '4', 'a hidden document does not poll');

  hidden = false;
  for (const listener of visibilityListeners) listener();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  tree = hooks.render(icon, { size: 20 });
  assert.equal(textOf(findBadge(tree)), '9');

  for (const listener of messageListeners) {
    listener({ origin: 'http://127.0.0.1:3466', data: { type: '1agents:approvals-state', pendingCount: 2, unreadCount: 2, byKind: { process_request: 1, proposal: 1, review: 0, handoff: 0 } } });
  }
  tree = hooks.render(icon, { size: 20 });
  badge = findBadge(tree);
  assert.equal(textOf(badge), '2');
  assert.equal(badge.props['data-unread'], 'true');
  assert.match(badge.props.style.animation, /pulse/);
  assert.match(tree.props.title, /2 条新/);

  for (const listener of messageListeners) {
    listener({ origin: 'http://127.0.0.1:3466', data: { type: '1agents:approvals-state', pendingCount: 120, unreadCount: 0, byKind: {} } });
  }
  tree = hooks.render(icon, { size: 20 });
  assert.equal(textOf(findBadge(tree)), '99+');

  for (const listener of messageListeners) {
    listener({ origin: 'http://evil.example', data: { type: '1agents:approvals-state', pendingCount: 1, unreadCount: 1, byKind: {} } });
    listener({ origin: 'http://127.0.0.1:3466', data: { type: '1agents:approvals-state', pendingCount: 0, unreadCount: 3, byKind: {} } });
  }
  tree = hooks.render(icon, { size: 20 });
  assert.equal(findBadge(tree), undefined);
  assert.equal(tree.props.title, undefined);
});
