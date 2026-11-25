import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
// The host packages must be linked for this test to run at all.
import { PartialArguments } from '@deepseek-ai/dsh-util-values';

// Exercise the target DSH engine, not a local imitation of its match lifecycle.
const root = resolve(import.meta.dirname, '..');
const hostRoot = resolve(root, 'node_modules/@deepseek-ai');
/** The published client bundles are loader factories; their sources are the engine. */
const dshSources = {
  name: 'dsh-sources',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\// }, args => {
      const parts = args.path.split('/');
      const pkg = parts[1];
      const sub = parts.slice(2).join('/');
      const base = resolve(hostRoot, pkg, 'src');
      const candidates = sub === ''
        ? [resolve(base, 'index.ts'), resolve(base, 'index.tsx')]
        : [resolve(base, `${sub}.ts`), resolve(base, `${sub}.tsx`), resolve(base, sub, 'index.ts'), resolve(base, sub, 'index.tsx')];
      for (const candidate of candidates) if (existsSync(candidate)) return { path: candidate };
      if (pkg === 'dsh-client-store') return { path: resolve(root, 'test/helpers/client-store-stub.mjs') };
      return null;
    });
  },
};
const bundle = await build({
  stdin: {
    contents: [
      "export { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembler.ts';",
      "export { ChatSnapshotBuilder } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts';",
      "export { assistantDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/assistant.ts';",
      "export { turnProcessDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/turn-process.ts';",
      `export { acpToolDefinition } from ${JSON.stringify(resolve(root, 'src/acp-tool-definition.js'))};`,
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  write: false,
  plugins: [dshSources],
});
const directory = mkdtempSync(resolve(tmpdir(), 'acp-tool-engine-'));
const path = resolve(directory, 'engine.mjs');
writeFileSync(path, bundle.outputFiles[0].text);
const { ConversationNodeAssembler: Assembler, ChatSnapshotBuilder, assistantDefinition, turnProcessDefinition, acpToolDefinition } =
  await import(pathToFileURL(path).href);
rmSync(directory, { recursive: true, force: true });
assert.equal(typeof PartialArguments.fromText, 'function');

const row = (seq, type, data, surfaceOp) => ({
  type: 'event',
  event: { seq, time: 1000 + seq, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) },
});
const toolChunk = (index, tool, sequence) => ({
  type: 'block-end',
  index,
  block: { type: 'text', text: '', acpTool: { turn: 1, step: 1, requestId: 'dsh-request', sequence, tool } },
});
const started = {
  toolCallId: 'exec-1',
  name: 'Bash',
  title: 'git status',
  status: 'in_progress',
  kind: 'execute',
  rawInput: { CommandLine: 'git status', Cwd: '/tmp' },
};
const completed = { ...started, status: 'completed', rawOutput: 'clean' };

/** The engine's own view of the Definition, with the published data recorded. */
function engine() {
  const published = [];
  const definition = {
    ...acpToolDefinition,
    buildLocationData: (context, scope, previous) => {
      const data = acpToolDefinition.buildLocationData(context, scope, previous);
      if (data !== null) published.push({ scope, data });
      return data;
    },
  };
  const assembler = new Assembler(
    { entries: () => [definition, assistantDefinition, turnProcessDefinition], fallbackEntry: () => undefined },
    { entries: () => [{ target: 'chat', create: () => new ChatSnapshotBuilder() }] },
  );
  assembler.activateTarget('chat');
  return { assembler, published };
}

const message = (content, stream) => row(3, 'assistant/message', {
  turn: 1,
  step: 1,
  stream: stream.map((chunk, index) => ({ type: 'chunk', time: 1000 + index, chunk })),
  message: { id: 'answer', role: 'assistant', content },
}, 'append');

test('DSH folds the remote calls of one step into the Turn data the Assistant row reads', () => {
  const { assembler, published } = engine();
  assembler.replaceWindow([
    row(0, 'turn/start', { turn: 1 }),
    row(1, 'step/start', { turn: 1, step: 1 }),
    message([
      { type: 'reasoning', text: 'Checking the repository.' },
      toolChunk(0, started, 1).block,
      toolChunk(1, { ...completed, toolCallId: 'exec-2' }, 2).block,
      { type: 'text', text: 'Done.' },
    ], [toolChunk(0, started, 1), toolChunk(1, { ...completed, toolCallId: 'exec-2' }, 2)]),
    row(4, 'step/end', { turn: 1, step: 1 }),
    row(5, 'turn/end', { turn: 1 }),
  ], false);
  assembler.flush();
  assert.equal(published.length > 0, true);
  const data = published.at(-1).data;
  assert.equal(published.at(-1).scope, 'turn');
  assert.equal(data.kind, 'turn');
  assert.equal(data.key, 'oneagents-acp-tools');
  assert.equal(data.value.steps.length, 1);
  assert.equal(data.value.steps[0].step, '1');
  assert.equal(data.value.steps[0].tools.length, 2);
  assert.equal(data.value.steps[0].visible, true);
  // The Step shows prose, so its calls stay inside the Assistant row.
  const chat = assembler.snapshot('chat');
  assert.equal([...chat.nodes.values()].some(node => node.kind === 'acp-tool-calls'), false);
  assert.equal([...chat.nodes.values()].some(node => node.kind === 'assistant-step'), true);
});

test('a Step with no prose of its own publishes a row for its remote calls', () => {
  const { assembler } = engine();
  assembler.replaceWindow([
    row(0, 'turn/start', { turn: 1 }),
    row(1, 'step/start', { turn: 1, step: 1 }),
    message([toolChunk(0, started, 1).block], [toolChunk(0, started, 1)]),
    row(4, 'step/end', { turn: 1, step: 1 }),
    row(5, 'turn/end', { turn: 1 }),
  ], false);
  assembler.flush();
  const chat = assembler.snapshot('chat');
  const cards = [...chat.nodes.values()].filter(node => node.kind === 'acp-tool-calls');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].data.tools.length, 1);
  assert.equal(cards[0].data.tools[0].call.name, 'bash');
  assert.equal(cards[0].data.tools[0].call.argsRaw, '{"command":"git status","cwd":"/tmp"}');
});

test('an ordinary DSH session publishes no remote Tool rows', () => {
  const { assembler, published } = engine();
  assembler.replaceWindow([
    row(0, 'turn/start', { turn: 1 }),
    row(1, 'step/start', { turn: 1, step: 1 }),
    message([{ type: 'text', text: 'Hello.' }], [{ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello.' } }]),
  ], false);
  assembler.flush();
  const chat = assembler.snapshot('chat');
  assert.equal([...chat.nodes.values()].some(node => node.kind === 'acp-tool-calls'), false);
  assert.equal(published.length, 0);
});
