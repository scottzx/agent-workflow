import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foldObservations, sealedArguments, toolArguments, toolBlock, toolContent, toolLabel, toolName,
} from '../src/acp-tools.js';
import { acpToolDefinition } from '../src/acp-tool-definition.js';

const projection = (tool, sequence = 1) => ({
  turn: 1,
  step: 1,
  requestId: 'dsh-request',
  sequence,
  tool,
});
const chunk = (index, tool, sequence = 1) => ({
  type: 'block-end',
  index,
  block: { type: 'text', text: '', acpTool: projection(tool, sequence) },
});
const live = (seq, chunkRecord) => ({
  seq, time: 1000 + seq, type: 'assistant/live-chunk', data: { turn: 1, step: 1, chunk: chunkRecord },
});
const started = {
  toolCallId: 'exec-1',
  name: 'Bash',
  title: 'ls -la',
  status: 'in_progress',
  kind: 'execute',
  rawInput: { CommandLine: 'ls -la', Cwd: '/tmp' },
};

test('one remote call folds its updates into a single observation that keeps its first position', () => {
  let state = foldObservations(undefined, live(2, chunk(0, started)));
  state = foldObservations(state, live(3, chunk(1, { ...started, status: 'completed', rawOutput: 'README.md' }, 2)));
  assert.equal(state.steps.get('1').tools.size, 1);
  const observation = state.steps.get('1').tools.get('exec-1');
  assert.equal(observation.index, 0);
  assert.equal(observation.data.tool.status, 'completed');
  assert.equal(observation.data.tool.rawOutput, 'README.md');
});

test('the durable message replaces the live prefix so a replayed turn keeps one card per call', () => {
  let state = foldObservations(undefined, live(2, chunk(0, started)));
  state = foldObservations(state, {
    seq: 3,
    time: 1003,
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      stream: [
        { type: 'chunk', time: 1002, chunk: chunk(0, started) },
        { type: 'chunk', time: 1003, chunk: chunk(1, { ...started, status: 'completed' }, 2) },
      ],
    },
  });
  assert.equal(state.steps.get('1').tools.size, 1);
  assert.equal(state.steps.get('1').tools.get('exec-1').data.tool.status, 'completed');
});

test('an older observation never replaces a newer one', () => {
  let state = foldObservations(undefined, live(3, chunk(0, { ...started, status: 'completed' }, 5)));
  state = foldObservations(state, live(4, chunk(1, { ...started, status: 'pending' }, 2)));
  assert.equal(state.steps.get('1').tools.get('exec-1').data.tool.status, 'completed');
});

test('remote arguments reach the host rows in the shape those rows read', () => {
  assert.deepEqual(toolArguments({ rawInput: { CommandLine: 'ls -la', Cwd: '/tmp' } }), { command: 'ls -la', cwd: '/tmp' });
  assert.deepEqual(toolArguments({ rawInput: { Path: '/tmp/a.md' } }), { file_path: '/tmp/a.md' });
  assert.equal(toolName({ kind: 'execute' }), 'bash');
  assert.equal(toolName({ kind: 'read' }), 'read');
  assert.equal(toolName({ kind: 'delete' }), '');
  assert.equal(toolLabel({ kind: 'delete', title: 'Delete a.md' }), 'Delete a.md');
});

test('a sealed argument view answers the host rows like a complete argument set', () => {
  const args = sealedArguments({ command: 'ls -la', file_path: '/tmp/a.md' });
  assert.equal(args.complete('command'), true);
  assert.equal(args.complete('missing'), false);
  assert.equal(args.text('command'), 'ls -la');
  assert.equal(args.text('missing'), undefined);
  assert.equal(args.textPrefix('command', 2), 'ls');
  assert.equal(args.stringLength('command'), 6);
  assert.equal(args.isSealed, true);
});

test('a settled remote call carries its own result and a failed one is an error', () => {
  const state = foldObservations(undefined, live(3, chunk(0, { ...started, status: 'completed', rawOutput: 'README.md' }, 2)));
  const block = toolBlock(state.steps.get('1').tools.get('exec-1'));
  assert.equal(block.kind, 'tool-result');
  assert.equal(block.call.name, 'bash');
  assert.equal(block.call.argsRaw, '{"command":"ls -la","cwd":"/tmp"}');
  assert.equal(block.content[0].text, 'README.md');
  assert.equal(block.isError, false);
  const failed = toolBlock(foldObservations(undefined, live(3, chunk(0, { ...started, status: 'failed' }, 2))).steps.get('1').tools.get('exec-1'));
  assert.equal(failed.isError, true);
});

test('an unfinished remote call stays running and closes as interrupted when its step ends', () => {
  const observation = foldObservations(undefined, live(2, chunk(0, started))).steps.get('1').tools.get('exec-1');
  const running = toolBlock(observation);
  assert.equal(running.phase, 'start');
  assert.equal(running.callId, 'dsh-request:exec-1');
  const closed = toolBlock(observation, { closed: { time: 1500 } });
  assert.equal(closed.kind, 'tool-result');
  assert.equal(closed.error.code, 'interrupted');
  assert.equal(closed.isError, true);
});

test('a remote diff and a raw output both reach the result content', () => {
  assert.deepEqual(toolContent({ content: [{ type: 'content', content: { type: 'text', text: 'hi' } }] }), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(toolContent({ content: [{ type: 'diff', path: 'a.md', oldText: 'a', newText: 'b' }] }),
    [{ type: 'text', text: 'a.md\n---\na\n+++\nb' }]);
  assert.deepEqual(toolContent({ rawOutput: { code: 1 } }), [{ type: 'text', text: '{\n  "code": 1\n}' }]);
});

test('the definition folds one Assistant step and publishes its remote cards', () => {
  assert.equal(acpToolDefinition.kind, 'oneagents-acp-tools');
  assert.equal(acpToolDefinition.target, 'chat');
  assert.deepEqual(acpToolDefinition.match(live(2, chunk(0, started))), { id: '1', role: 'start' });
  assert.equal(acpToolDefinition.match({ type: 'user/message', data: {} }), null);
  const state = foldObservations(undefined, live(2, chunk(0, started)));
  const context = {
    key: 'oneagents-acp-tools:1',
    id: '1',
    state,
    matches: [{ event: { seq: 2, type: 'assistant/live-chunk' } }],
    start: { event: { seq: 2, type: 'assistant/live-chunk' }, location: { kind: 'step', turn: { turn: 1, status: 'open' }, step: { turn: 1, step: 1, status: 'open', start: { seq: 1 } } } },
    current: new Map(),
  };
  // The Turn's own data carries the Step's calls, so the Assistant row can
  // draw them between the prose around them.
  const data = acpToolDefinition.buildLocationData(context, 'turn', undefined);
  assert.equal(data.kind, 'turn');
  assert.equal(data.key, 'oneagents-acp-tools');
  assert.equal(data.value.steps.length, 1);
  assert.equal(data.value.steps[0].step, '1');
  assert.equal(data.value.steps[0].tools.length, 1);
  assert.equal(data.value.steps[0].visible, false);
  // A Step with no prose of its own publishes a row of its own, because the
  // host would hide its Assistant row.
  const node = acpToolDefinition.buildViewNode(context);
  assert.equal(node.kind, 'acp-tool-calls');
  assert.equal(node.anchorSeq, 1);
  assert.equal(node.data.tools.length, 1);
  assert.equal(node.visibility, 'visible');
  // A Step that shows prose keeps its calls inside the Assistant row.
  const prose = {
    seq: 3,
    time: 1003,
    type: 'assistant/live-chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'Done.' } },
  };
  const withProse = { ...context, state: foldObservations(state, prose) };
  assert.equal(acpToolDefinition.buildViewNode(withProse), null);
  assert.equal(acpToolDefinition.buildLocationData(withProse, 'turn', undefined).value.steps[0].visible, true);
});
