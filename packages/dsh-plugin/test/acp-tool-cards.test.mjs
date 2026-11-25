import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** Mount the built client bundle with the host services the ACP rows use. */
function mount() {
  let client;
  const slots = new Map();
  const registered = [];
  const nativeBash = { options: { key: 'bash' }, component: () => null };
  const nativeAssistant = {
    options: { key: 'assistant-step', priority: 0 },
    locale: 'conversation',
    component: () => null,
    inject: () => ({ hooks: { presentation: {} } }),
  };
  const entries = key => {
    if (key === 'conversation.chat.node') return [nativeAssistant];
    if (key === 'tool.call.toolview') return [nativeBash];
    return [];
  };
  runInNewContext(readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    AbortController,
    setInterval: () => 0,
    clearInterval: () => {},
    window: {
      __ModuleLoader__: {
        load: module => {
          client = module.factory(() => ({
            createElement: (type, props, ...children) => ({ type, props, children }),
            Fragment: 'fragment',
            useEffect: () => {},
            useRef: () => ({ current: null }),
            useState: value => [value, () => {}],
            useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
          }));
        },
      },
    },
    document: { createElement: () => ({ remove() {} }), head: { append() {} } },
    fetch: async () => ({ ok: true, json: async () => ({ writable: true, commands: [], configOptions: [] }) }),
  });
  const ctx = {
    uiConversation: { events: { register: definition => registered.push(definition) } },
    effect: setup => { const cleanup = setup(); if (cleanup) cleanup(); },
    on: () => {},
    conversation: { blocks: { set: () => {} } },
    locale: { register: () => {}, bind: namespace => key => `${namespace}:${key}` },
    slots: {
      entries,
      inject: (_key, setup) => { setup(); },
      register: (options, component) => {
        slots.set(options.key ?? options.name, { options, component });
        return () => slots.delete(options.key ?? options.name);
      },
    },
    sessions: { binding: () => undefined, subagentAddress: () => undefined },
    remote: { $on: () => {}, $host: { home: '/home/scott' }, session: {} },
    commandUi: { register: () => {} },
  };
  client.apply(ctx);
  return { slots, registered };
}

const observation = (index, tool) => ({
  index,
  data: { turn: 1, step: 1, requestId: 'dsh-request', sequence: index + 1, tool },
  seq: index + 2,
  time: 1000 + index,
  updatedAt: 1000 + index,
});
const bashTool = { toolCallId: 'exec-1', name: 'Bash', title: 'git status', status: 'completed', kind: 'execute', rawInput: { CommandLine: 'git status' } };

function assistantProps(overrides = {}) {
  return {
    node: {
      kind: 'assistant-step',
      data: {
        turn: 1,
        step: 1,
        status: 'settled',
        blocks: [
          { kind: 'reasoning', text: 'Checking the repository.' },
          { kind: 'text', text: '' },
          { kind: 'text', text: 'Done.' },
        ],
        finalNode: { messageId: 'answer' },
      },
    },
    sessionId: 'session-1',
    useTurnData: () => ({ steps: [{ step: '1', visible: true, tools: [observation(1, bashTool)] }] }),
    renderFactorySlot: (name, owner) => ({ type: 'factory', props: { name, owner } }),
    useDisclosure: () => ({ expanded: false, toggle: () => {} }),
    openFile: () => {},
    loadImage: () => {},
    ...overrides,
  };
}

test('the client registers the remote Tool projection and replaces the Assistant row', () => {
  const { slots, registered } = mount();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, 'oneagents-acp-tools');
  assert.equal(registered[0].target, 'chat');
  const row = slots.get('assistant-step');
  assert.ok(row !== undefined);
  // A smaller priority wins the cell, so the plugin's row replaces the host's.
  assert.equal(row.options.priority, -1);
  assert.ok(slots.get('acp-tool-calls') !== undefined);
});

test('a remote call is drawn after the thinking it followed, inside the same row', () => {
  const { slots } = mount();
  const row = slots.get('assistant-step').component;
  const element = row(assistantProps({ groupPart: 'reasoning' }));
  const rendered = element.type(element.props);
  const segments = rendered.children[0];
  assert.equal(segments.length, 2);
  const [thinking, card] = segments.map(segment => segment.children[0]);
  // The host's own row drew the thinking.
  assert.equal(thinking.props.node.data.blocks.length, 1);
  assert.equal(thinking.props.node.data.blocks[0].kind, 'reasoning');
  // The host's Bash row drew the remote call, after the thinking.
  assert.equal(card.props.toolName, 'bash');
  assert.equal(card.props.callId, 'dsh-request:exec-1');
  assert.equal(card.props.phase, 'result');
  assert.equal(card.props.block.call.argsRaw, '{"command":"git status"}');
  assert.equal(card.props.home, '/home/scott');
  assert.equal(typeof card.props.t, 'function');
  assert.equal(card.props.t('row'), 'conversation:row');
});

test('the reply row keeps the answer and leaves the call with the thinking it followed', () => {
  const { slots } = mount();
  const row = slots.get('assistant-step').component;
  const element = row(assistantProps({ groupPart: 'response' }));
  const rendered = element.type(element.props);
  const segments = rendered.children[0];
  assert.equal(segments.length, 1);
  const [answer] = segments.map(segment => segment.children[0]);
  assert.equal(answer.props.node.data.blocks.length, 1);
  assert.equal(answer.props.node.data.blocks[0].kind, 'text');
  assert.equal(answer.props.node.data.blocks[0].text, 'Done.');
});

test('a step with no remote calls keeps the host row untouched', () => {
  const { slots } = mount();
  const row = slots.get('assistant-step').component;
  const props = assistantProps({ groupPart: 'response', useTurnData: () => undefined });
  const element = row(props);
  const rendered = element.type(element.props);
  // With no remote calls the host's own Assistant renderer is used as-is.
  assert.equal(typeof rendered.type, 'function');
  assert.equal(rendered.props.node.data.blocks.length, 3);
});

test('a remote call no host view claims falls back to the plugin row', () => {
  const { slots } = mount();
  const row = slots.get('assistant-step').component;
  const tool = { toolCallId: 'del-1', name: 'Delete', title: 'Delete a.md', status: 'completed', kind: 'delete' };
  const element = row(assistantProps({
    groupPart: 'reasoning',
    useTurnData: () => ({ steps: [{ step: '1', visible: true, tools: [observation(1, tool)] }] }),
  }));
  const rendered = element.type(element.props);
  const card = rendered.children[0][1].children[0];
  const fallback = card.type(card.props);
  assert.equal(fallback.props['data-oneagents-acp-tool'], '');
  assert.equal(fallback.children[0].children[0], 'Delete a.md');
});
