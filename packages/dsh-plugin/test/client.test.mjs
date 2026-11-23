import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function mount(preset, writable = true, assistantChildren, customFetch, reactHooks = {}, overrides = {}) {
  let client, command;
  const remoteHandlers = new Map();
  const localHandlers = new Map();
  const presets = new Map();
  const slots = new Map();
  const calls = [], blocks = new Map(), cleanups = [];
  const nativeAssistant = { options: { key: 'assistant-step', priority: 0 }, locale: 'conversation',
    inject: () => ({ hooks: { presentation: {} } }), component: () => null,
    ...(assistantChildren ? { children: assistantChildren } : {}) };
  const nativeBash = { options: { key: 'bash' }, component: () => null };
  const entries = key => key === 'conversation.chat.node' ? [nativeAssistant] : [nativeBash];
  const native = { writable, blocked: writable ? undefined : 'active-writer', configOptions: [{ id: 'native-model', category: 'model', type: 'select', currentValue: 'b', options: [{ group: 'family', name: 'Family', options: [{ value: 'b', name: 'Native B' }] }] }] };
  runInNewContext(readFileSync(process.env.ACP_CLIENT_BUNDLE ?? new URL('../dist/client.js', import.meta.url), 'utf8'), {
    AbortController,
    setInterval: () => 0, clearInterval: () => {},
    window: { __ModuleLoader__: { load: module => { client = module.factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }), ...reactHooks })); } } },
    document: { createElement: () => ({ remove() {} }), head: { append() {} } },
    fetch: async (url, options) => { calls.push([url, options]); if (customFetch) return customFetch(url, options); return { ok: true, json: async () => native }; },
  });
  const ctx = {
    uiConversation: { events: { register: () => {} } },
    effect: setup => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); }, on: (name, handler) => localHandlers.set(name, handler),
    conversation: { blocks: { set: (id, block) => blocks.set(id, block) } },
    locale: { register: () => {}, bind: () => key => key === 'toolGroup' ? '已调用 {count} 个工具' : key },
    slots: { entries, inject: (_key, setup) => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); }, register: (options, component) => {
      if (entries(options.name).some(entry => entry.options.key === options.key && (entry.options.priority ?? 0) === (options.priority ?? 0))) throw new Error('duplicate slot priority');
      const key = options.key ?? options.name; slots.set(key, { options, component });
      return () => slots.delete(key);
    } },
    sessions: { binding: id => ({ session: { projections: { faceOf: name => ({ subscribe: () => () => {}, getSnapshot: () => name === "modelSelection" ? overrides.modelSelection?.(id) : (presets.get(id) ?? preset) }) } } }), subagentAddress: id => overrides.subagentAddress?.(id) },
    remote: { $on: (name, handler) => remoteHandlers.set(name, handler), session: {
      modelCatalog: async () => overrides.modelCatalog ? overrides.modelCatalog() : ({ ok: true, value: { groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'dsh-model', name: 'DSH model' }] }] } }),
      selectModel: async value => { calls.push(value); return overrides.selectModel ? overrides.selectModel(value) : { ok: true }; },
    } },
    commandUi: { register: value => { command = value; } },
  };
  client.apply(ctx);
  return { command, calls, slots, blocks, native, nativeAssistant, nativeBash, emitLocal: name => localHandlers.get(name)?.(), emitRemote: (name, ...args) => remoteHandlers.get(name)?.(...args), setPreset: (id, value) => presets.set(id, value), dispose: () => { for (const cleanup of cleanups) cleanup(); } };
}

test('/model in ACP sessions uses native grouped options and forwards the native config id', async () => {
  const { command, calls } = mount('oneagents-acp-codex');
  const context = { sessionId: 'acp-session' };
  assert.equal(command.description(), 'description');
  const options = await command.ui.options(context);
  assert.equal(options[0].label, 'Native B');
  assert.equal(options[0].active, true);
  await command.ui.onSelect(options[0], context);
  assert.deepEqual(JSON.parse(calls[1][1].body), { configId: 'native-model', value: 'b' });
});

test('/model in standard sessions keeps the ordinary DSH selection API', async () => {
  const { command, calls } = mount('standard');
  const context = { sessionId: 'dsh-session' };
  assert.equal(command.description(), 'description');
  const options = await command.ui.options(context);
  assert.equal(options[0].label, 'DSH model');
  await command.ui.onSelect(options[0], context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ sessionId: 'dsh-session', provider: 'deepseek', model: 'dsh-model' }]);
});


test('native writer contention disables only its composer, then clears after restoration and on unload', async () => {
  const f = mount('oneagents-acp-codex', false);
  const context = { sessionId: 'busy-session' };
  await f.command.ui.options(context);
  assert.equal(f.blocks.get(context.sessionId).reason, 'activeWriter');
  assert.equal(f.blocks.has('other-session'), false);
  f.native.writable = true;
  await f.command.ui.options(context);
  assert.equal(f.blocks.get(context.sessionId), undefined);
  f.native.writable = false;
  await f.command.ui.options(context);
  f.dispose();
  assert.equal(f.blocks.get(context.sessionId), undefined);
});

test('the client leaves the chat transcript to DSH and does not replace assistant-step', () => {
  for (const preset of ['standard', 'oneagents-acp-codex']) {
    const f = mount(preset);
    assert.equal(f.slots.has('assistant-step'), false);
    f.dispose();
  }
});

test('standard selection clears ACP loading before the projection catches up', async () => {
  const f = mount('oneagents-acp-codex');
  const context = { sessionId: 'switching' };
  await f.command.ui.options(context);
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  assert.equal(f.blocks.get(context.sessionId), undefined);
  f.setPreset(context.sessionId, 'standard');
  assert.equal((await f.command.ui.options(context))[0].label, 'DSH model');
  f.dispose();
});

test('an in-flight ACP failure cannot restore a block after switching to standard', async () => {
  let rejectFetch;
  const response = new Promise((resolve, reject) => { rejectFetch = reject; });
  const f = mount('oneagents-acp-codex', true, undefined, () => response);
  const context = { sessionId: 'pending-switch' };
  const loading = f.command.ui.options(context);
  assert.equal(f.blocks.get(context.sessionId).reason, 'loading');
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  const atSelection = f.blocks.get(context.sessionId);
  f.setPreset(context.sessionId, 'standard');
  rejectFetch(new Error('old ACP request failed'));
  assert.equal((await loading).length, 0);
  assert.equal(atSelection, undefined);
  assert.equal(f.blocks.get(context.sessionId), undefined);
  f.dispose();
});

test('preset selection invalidates only the selected session', async () => {
  const f = mount('oneagents-acp-codex', false);
  await f.command.ui.options({ sessionId: 'first' });
  await f.command.ui.options({ sessionId: 'second' });
  assert.equal(f.blocks.get('second').reason, 'activeWriter');
  f.emitRemote('agent-preset/selected', 'first', 'standard');
  assert.equal(f.blocks.get('first'), undefined);
  assert.equal(f.blocks.get('second').reason, 'activeWriter');
  f.dispose();
});

test('a late ACP success cannot restore writer contention in standard mode', async () => {
  let resolveFetch;
  const response = new Promise(resolve => { resolveFetch = resolve; });
  const f = mount('oneagents-acp-codex', false, undefined, () => response);
  const context = { sessionId: 'pending-success' };
  const loading = f.command.ui.options(context);
  const signal = f.calls[0][1].signal;
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  assert.equal(signal.aborted, true);
  f.setPreset(context.sessionId, 'standard');
  resolveFetch({ ok: true, json: async () => f.native });
  assert.equal((await loading).length, 0);
  assert.equal(f.blocks.get(context.sessionId), undefined);
  assert.equal((await f.command.ui.options(context))[0].label, 'DSH model');
  f.dispose();
});

for (const outcome of ['success', 'failure']) test('a late ACP configuration ' + outcome + ' is ignored after switching mode', async () => {
  let settle;
  const response = new Promise((resolve, reject) => { settle = outcome === 'success' ? resolve : reject; });
  const f = mount('oneagents-acp-codex', false, undefined, () => response);
  const context = { sessionId: 'config-' + outcome };
  const updating = f.command.ui.onSelect({ id: JSON.stringify(['native-model', 'b']) }, context);
  assert.equal(f.calls[0][1].method, 'POST');
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  f.setPreset(context.sessionId, 'standard');
  settle(outcome === 'success' ? { ok: true, json: async () => f.native } : new Error('old configuration failed'));
  await updating;
  assert.equal(f.blocks.get(context.sessionId), undefined);
  assert.equal((await f.command.ui.options(context))[0].label, 'DSH model');
  f.dispose();
});

test('a current ACP configuration failure remains visible to the caller', async () => {
  const f = mount('oneagents-acp-codex', true, undefined, async () => { throw new Error('configuration failed'); });
  await assert.rejects(f.command.ui.onSelect({ id: JSON.stringify(['native-model', 'b']) }, { sessionId: 'current-config' }), /configuration failed/);
  f.dispose();
});

function hookRenderer() {
  const values = [], effects = [];
  let index = 0, pending = [];
  const hooks = {
    useState(initial) {
      const key = index++;
      if (!(key in values)) values[key] = initial;
      return [values[key], value => { values[key] = value; }];
    },
    useRef(initial) {
      const key = index++;
      if (!(key in values)) values[key] = { current: initial };
      return values[key];
    },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
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

test('configuration busy clears after a same-mode reconnect without showing the old failure', async () => {
  const renderer = hookRenderer();
  let rejectPost;
  const response = new Promise((_resolve, reject) => { rejectPost = reject; });
  const f = mount('oneagents-acp-codex', true, undefined, async (_url, options) =>
    options.method === 'POST' ? response : { ok: true, json: async () => f.native }, renderer.hooks);
  const context = { sessionId: 'reconnect-controls' };
  const component = f.slots.get('conversation.input.model').component;
  const render = () => renderer.render(component, context);
  await f.command.ui.options(context);
  const updating = render().props.onConfigure('native-model', 'b');
  assert.equal(render().props.busy, true);
  f.emitLocal('connection/reset');
  render();
  rejectPost(new Error('old configuration failed'));
  await updating;
  await f.command.ui.options(context);
  const tree = render();
  assert.equal(tree.props.busy, false);
  assert.equal(tree.props.error, '');
  f.dispose();
});

test('a previous mode configuration cannot clear a newer configuration busy state', async () => {
  const renderer = hookRenderer();
  const posts = [];
  const f = mount('oneagents-acp-codex', true, undefined, async (_url, options) => {
    if (options.method === 'POST') return new Promise(resolve => posts.push(resolve));
    return { ok: true, json: async () => f.native };
  }, renderer.hooks);
  const context = { sessionId: 'switch-controls' };
  const component = f.slots.get('conversation.input.model').component;
  const render = () => renderer.render(component, context);
  await f.command.ui.options(context);
  const first = render().props.onConfigure('native-model', 'b');
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  f.setPreset(context.sessionId, 'standard');
  render();
  f.emitRemote('agent-preset/selected', context.sessionId, 'oneagents-acp-codex');
  f.setPreset(context.sessionId, 'oneagents-acp-codex');
  render();
  await f.command.ui.options(context);
  const second = render().props.onConfigure('native-model', 'b');
  posts[0]({ ok: true, json: async () => f.native });
  await first;
  let tree = render();
  assert.equal(tree.props.busy, true);
  assert.equal(tree.props.error, '');
  posts[1]({ ok: true, json: async () => f.native });
  await second;
  tree = render();
  assert.equal(tree.props.busy, false);
  assert.equal(tree.props.error, '');
  f.dispose();
});

function findNodes(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) findNodes(item, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  if (node.children) findNodes(node.children, predicate, out);
  return out;
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node.children) return textOf(node.children);
  return "";
}

test("conversation.input.model declares official label and options child slots", () => {
  const f = mount("standard");
  const entry = f.slots.get("conversation.input.model");
  assert.deepEqual(JSON.parse(JSON.stringify(entry.options.children)), {
    "conversation.input.model.label": { kind: "single", scope: "session", inline: true },
    "conversation.input.model.options": { kind: "list", scope: "session" },
  });
  assert.equal(entry.options.inject("s1").available, true);
  f.dispose();

  const sub = mount("standard", true, undefined, undefined, {}, { subagentAddress: () => ({ id: "sub" }) });
  assert.equal(sub.slots.get("conversation.input.model").options.inject("s2").available, false);
  sub.dispose();
});

test("standard DSH session renders official capsule trigger, two-level popover, badges, and model.options slot", async () => {
  const outer = hookRenderer();
  const inner = hookRenderer();
  let activeHooks = outer.hooks;
  const catalogValue = {
    default: { provider: "deepseek-account", model: "routing-group" },
    groups: [
      { id: "third-party", name: "Third Party", models: [{ id: "tp-1", name: "TP Model" }] },
      {
        id: "deepseek-account",
        name: "Account",
        models: [
          {
            id: "routing-group",
            name: "routing group",
            badge: { tone: "neutral", text: { zh: "平价", en: "Economy" } },
            reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] },
          },
        ],
      },
    ],
  };
  let selectResult = { ok: true };
  const labelSlots = [];
  let optionsOwner = null;
  const reactHooks = {
    Fragment: Symbol.for("react.fragment"),
    useState: init => activeHooks.useState(init),
    useRef: init => activeHooks.useRef(init),
    useSyncExternalStore: (sub, snap) => activeHooks.useSyncExternalStore(sub, snap),
    useEffect: (fn, deps) => activeHooks.useEffect(fn, deps),
    useLayoutEffect: (fn, deps) => activeHooks.useEffect(fn, deps),
    useId: () => ":r1:",
    useMemo: fn => fn(),
  };
  const f = mount("standard", true, undefined, undefined, reactHooks, {
    modelCatalog: async () => ({ ok: true, value: catalogValue }),
    modelSelection: () => ({ next: undefined }),
    selectModel: async () => selectResult,
  });
  const entry = f.slots.get("conversation.input.model");
  const injected = entry.options.inject("dsh-1");
  const renderSlot = (name, owner, opts) => {
    if (name === "conversation.input.model.label") {
      labelSlots.push(owner);
      return opts.fallback;
    }
    if (name === "conversation.input.model.options") {
      optionsOwner = owner;
      return { type: "team-toggle", props: { locked: owner.locked }, children: ["启用智能体团队协作"] };
    }
    return null;
  };
  const outerTree = entry.component({ ...injected, locked: false, renderSlot });
  const StandardSelect = outerTree.type;
  assert.equal(typeof StandardSelect, "function");

  // Render StandardModelSelect with its own hook state; trigger initial catalog load.
  const renderStandard = (extraProps = {}) => {
    const prev = activeHooks;
    activeHooks = inner.hooks;
    try {
      let tree;
      const proxy = props => {
        tree = StandardSelect(props);
        return { children: [tree] };
      };
      return inner.render(proxy, { ...outerTree.props, ...extraProps });
    } finally {
      activeHooks = prev;
    }
  };

  renderStandard();
  await new Promise(resolve => setImmediate(resolve));

  // Trigger shows badge ("平价"), model name ("routing group"), and effort ("effortDefault").
  let tree = renderStandard();
  const trigger = findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-trigger")[0];
  assert.ok(trigger, "capsule trigger button should render");
  assert.equal(trigger.props["aria-expanded"], false);
  const triggerText = textOf(trigger);
  assert.ok(triggerText.includes("平价"), "trigger should include localized model badge");
  assert.ok(triggerText.includes("routing group"), "trigger should include model name");
  assert.ok(triggerText.includes("effortDefault"), "trigger should include effort label");
  assert.equal(labelSlots[labelSlots.length - 1].placement, "trigger");

  // Open root popover menu.
  trigger.props.onClick();
  tree = renderStandard();
  const menu = findNodes(tree, n => n.props?.className === "oacp-ms-menu")[0];
  assert.ok(menu, "popover menu should render when open");
  assert.equal(menu.props.role, "menu");
  const cells = findNodes(menu, n => n.type === "button" && n.props?.className === "oacp-ms-cell");
  assert.equal(cells.length, 2, "root pane should have Model and Reasoning Effort rows");
  assert.ok(textOf(menu).includes("启用智能体团队协作"), "conversation.input.model.options child slot should mount inside root pane");
  assert.equal(optionsOwner.locked, false);

  // Drill into effort pane and choose High.
  cells[1].props.onClick();
  tree = renderStandard();
  const effortButtons = findNodes(tree, n => n.type === "button" && n.props?.role === "menuitemradio");
  assert.deepEqual(effortButtons.map(b => textOf(b)), ["effortDefault", "Low", "High"]);
  effortButtons[2].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
    { sessionId: "dsh-1", provider: "deepseek-account", model: "routing-group", reasoningEffort: "high" },
  ]);

  // Reopen root pane, drill into model pane, verify provider ordering (deepseek-account first) and select third-party model.
  tree = renderStandard();
  findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-trigger")[0].props.onClick();
  tree = renderStandard();
  findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-cell")[0].props.onClick();
  tree = renderStandard();
  const modelButtons = findNodes(tree, n => n.type === "button" && n.props?.role === "menuitemradio");
  assert.equal(modelButtons.length, 2);
  assert.ok(textOf(modelButtons[0]).includes("routing group"), "deepseek-account should be ordered first");
  assert.ok(textOf(modelButtons[1]).includes("TP Model"));

  // Failed selection surfaces writer-held toast.
  selectResult = { ok: false, error: { code: "session/writer-held", message: "busy" } };
  modelButtons[1].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = renderStandard();
  const toasts = findNodes(tree, n => typeof n.props?.text === "string" && typeof n.props?.onDone === "function");
  assert.ok(toasts.some(a => a.props.text.includes("errorSessionInUse")));

  // Options slot reportFailure and dismiss work as expected.
  findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-trigger")[0].props.onClick();
  tree = renderStandard();
  findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-trigger")[0].props.onClick();
  tree = renderStandard();
  assert.ok(optionsOwner);
  optionsOwner.reportFailure("team error");
  optionsOwner.dismiss();
  tree = renderStandard();
  assert.equal(findNodes(tree, n => n.props?.className === "oacp-ms-menu").length, 0);
  assert.ok(findNodes(tree, n => typeof n.props?.text === "string" && typeof n.props?.onDone === "function").some(a => a.props.text.includes("team error")));

  // Subagent session renders null.
  assert.equal(entry.component({ ...injected, available: false, locked: false, renderSlot }), null);
  f.dispose();
});

test("ACP external Agent session renders official capsule trigger and two-level popover for model, thought_level, and mode", async () => {
  const outer = hookRenderer();
  const inner = hookRenderer();
  let activeHooks = outer.hooks;
  const antigravityCaps = {
    agent: "antigravity",
    writable: true,
    configOptions: [
      {
        id: "model",
        category: "model",
        name: "Model",
        type: "select",
        currentValue: "gemini-4-neon",
        options: [
          { group: "gemini", name: "Gemini", options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "gemini-pro", name: "Gemini Pro" },
          ] },
          { group: "claude", name: "Claude", options: [
            { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
            { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
            { value: "gpt-oss-120b", name: "GPT OSS 120B" },
          ] },
        ],
      },
      {
        id: "thought_level",
        category: "thought_level",
        name: "Thought Level",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ],
    modes: {
      currentModeId: "agent",
      availableModes: [
        { id: "agent", name: "Agent" },
        { id: "plan", name: "Plan" },
      ],
    },
  };
  const reactHooks = {
    Fragment: Symbol.for("react.fragment"),
    useState: init => activeHooks.useState(init),
    useRef: init => activeHooks.useRef(init),
    useSyncExternalStore: (sub, snap) => activeHooks.useSyncExternalStore(sub, snap),
    useEffect: (fn, deps) => activeHooks.useEffect(fn, deps),
    useLayoutEffect: (fn, deps) => activeHooks.useEffect(fn, deps),
    useId: () => ":acp1:",
    useMemo: fn => fn(),
  };
  const f = mount("oneagents-acp-antigravity", true, undefined, async (_url, options) => {
    if (options?.method === "POST") {
      const body = JSON.parse(options.body);
      if (body.configId === "thought_level") antigravityCaps.configOptions[1].currentValue = body.value;
      if (body.configId === "$mode") antigravityCaps.modes.currentModeId = body.value;
      if (body.configId === "model") antigravityCaps.configOptions[0].currentValue = body.value;
    }
    return { ok: true, json: async () => structuredClone(antigravityCaps) };
  }, reactHooks);

  const entry = f.slots.get("conversation.input.model");
  const injected = entry.options.inject("acp-1");
  await f.command.ui.options({ sessionId: "acp-1" });

  const renderAcp = () => {
    const outerTree = outer.render(entry.component, { ...injected, locked: false });
    const AcpSelect = outerTree.type;
    const prev = activeHooks;
    activeHooks = inner.hooks;
    try {
      return inner.render(AcpSelect, outerTree.props);
    } finally {
      activeHooks = prev;
    }
  };

  // Trigger capsule displays current model and thought level.
  let tree = renderAcp();
  assert.equal(tree.props["data-oneagents-acp-controls"], "acp");
  const trigger = findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-trigger")[0];
  assert.ok(trigger, "ACP capsule trigger button should render");
  assert.equal(trigger.props["aria-expanded"], false);
  assert.ok(textOf(trigger).includes("Gemini 4 Neon"), "trigger should show current ACP model");
  assert.ok(textOf(trigger).includes("Medium"), "trigger should show current thought level");

  // Open root popover: Model, Thought Level, Mode cells.
  trigger.props.onClick();
  tree = renderAcp();
  const menu = findNodes(tree, n => n.props?.className === "oacp-ms-menu")[0];
  assert.ok(menu, "ACP popover menu should open");
  const cells = findNodes(menu, n => n.type === "button" && n.props?.className === "oacp-ms-cell");
  assert.equal(cells.length, 3, "root pane should list Model, Thought Level, and Mode");
  assert.ok(textOf(cells[0]).includes("Gemini 4 Neon"));
  assert.ok(textOf(cells[1]).includes("Medium"));
  assert.ok(textOf(cells[2]).includes("Agent"));

  // Drill into Model pane (> 4 options shows search box) and select Claude Opus 5.5.
  cells[0].props.onClick();
  tree = renderAcp();
  assert.equal(findNodes(tree, n => n.props?.role === "searchbox").length, 1, "model list with >4 items should show search box");
  const modelOptions = findNodes(tree, n => n.type === "button" && n.props?.role === "menuitemradio");
  assert.equal(modelOptions.length, 5);
  modelOptions[2].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const lastPost = f.calls.filter(([, opts]) => opts?.method === "POST").at(-1);
  assert.deepEqual(JSON.parse(lastPost[1].body), { configId: "model", value: "claude-opus-5-5" });

  // Reopen root pane, drill into Thought Level, select High.
  tree = renderAcp();
  findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-trigger")[0].props.onClick();
  tree = renderAcp();
  findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-cell")[1].props.onClick();
  tree = renderAcp();
  const effortOptions = findNodes(tree, n => n.type === "button" && n.props?.role === "menuitemradio");
  assert.deepEqual(effortOptions.map(b => textOf(b)), ["Low", "Medium", "High"]);
  effortOptions[2].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const effortPost = f.calls.filter(([, opts]) => opts?.method === "POST").at(-1);
  assert.deepEqual(JSON.parse(effortPost[1].body), { configId: "thought_level", value: "high" });

  // Reopen root pane, drill into Mode, select Plan.
  tree = renderAcp();
  findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-trigger")[0].props.onClick();
  tree = renderAcp();
  findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-cell")[2].props.onClick();
  tree = renderAcp();
  const modeOptions = findNodes(tree, n => n.type === "button" && n.props?.role === "menuitemradio");
  assert.deepEqual(modeOptions.map(b => textOf(b)), ["Agent", "Plan"]);
  modeOptions[1].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const modePost = f.calls.filter(([, opts]) => opts?.method === "POST").at(-1);
  assert.deepEqual(JSON.parse(modePost[1].body), { configId: "$mode", value: "plan" });

  // Trigger reflects updated model and thought level.
  tree = renderAcp();
  const updatedTrigger = findNodes(tree, n => n.type === "button" && n.props?.className === "oacp-ms-trigger")[0];
  assert.ok(textOf(updatedTrigger).includes("Claude Opus 5.5"));
  assert.ok(textOf(updatedTrigger).includes("High"));
  f.dispose();
});
