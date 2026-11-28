import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPromptInput } from '../dist/prompt-input.js';

const text = value => ({ type: 'text', text: value });
const userMessage = (id, value = 'hello', source = { kind: 'user' }) => ({ id, role: 'user', source, content: [text(value)] });
const injected = (id, kind, value = 'DSH injected context') => ({ id, role: 'user', source: { kind }, content: [text(value)] });
const assistantMessage = (id = 'assistant-1', value = 'Native reply') => ({ id, role: 'assistant', content: [text(value)] });
const noImports = () => new Set();

test('a step whose only new message is the user-approval notice selects no prompt', () => {
  const messages = [
    userMessage('turn-1'),
    assistantMessage(),
    injected('approval', 'user-approval', 'The user changed the approval policy to danger-full-access.'),
  ];
  assert.deepEqual(selectPromptInput(messages, noImports()), { kind: 'noop' });
});

test('a step with only runtime-context and agent-instructions messages selects no prompt', () => {
  const messages = [
    userMessage('turn-1'),
    assistantMessage(),
    injected('instructions', 'agent-instructions'),
    injected('runtime', 'runtime-context'),
  ];
  assert.deepEqual(selectPromptInput(messages, noImports()), { kind: 'noop' });
});

test('DSH-injected context without a preceding assistant reply is still not a prompt', () => {
  const messages = [injected('approval', 'user-approval')];
  assert.deepEqual(selectPromptInput(messages, noImports()), { kind: 'noop' });
});

test('a real user message beside an injected notice forwards only the user message', () => {
  const messages = [
    userMessage('turn-1', 'first prompt'),
    assistantMessage(),
    userMessage('turn-1-step-2', 'second prompt'),
    injected('approval', 'user-approval'),
    injected('runtime', 'runtime-context'),
  ];
  const selection = selectPromptInput(messages, noImports());
  assert.equal(selection.kind, 'prompt');
  assert.deepEqual(selection.input.map(message => message.id), ['turn-1-step-2']);
  assert.equal(selection.text, 'second prompt');
});

test('a queued cross-session message after an injected notice is forwarded normally', () => {
  const messages = [
    userMessage('turn-1'),
    assistantMessage(),
    injected('approval', 'user-approval'),
    assistantMessage('assistant-2', ''),
    userMessage('queued', 'Queued cross-session message', { kind: '1agents-acp', rpcId: 'a2a-1' }),
  ];
  const selection = selectPromptInput(messages, noImports());
  assert.equal(selection.kind, 'prompt');
  assert.deepEqual(selection.input.map(message => message.id), ['queued']);
  assert.equal(selection.text, 'Queued cross-session message');
});

test('multiple forwarded messages keep their order and join with a blank line', () => {
  const messages = [assistantMessage(), userMessage('a', 'one'), userMessage('b', 'two')];
  const selection = selectPromptInput(messages, noImports());
  assert.equal(selection.kind, 'prompt');
  assert.deepEqual(selection.text, 'one\n\ntwo');
});

test('a user message without a forwardable source is not forwarded', () => {
  // Pre-existing contract: only `user` and `1agents-acp` sources reach ACP, so identity-free input is not a prompt.
  const messages = [assistantMessage(), { role: 'user', content: [text('no source')] }];
  assert.throws(() => selectPromptInput(messages, noImports()), { message: 'No forwardable text prompt was supplied to the ACP plugin' });
});

test('a real user message with a non-text block still reports the text-only error', () => {
  const messages = [assistantMessage(), { id: 'image', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', data: 'AA==' }] }];
  assert.throws(() => selectPromptInput(messages, noImports()), { message: 'This ACP plugin currently accepts text prompts only' });
});

test('a real user message with empty content still reports the text-only error', () => {
  for (const content of [[], undefined]) {
    const messages = [assistantMessage(), { id: 'empty', role: 'user', source: { kind: 'user' }, content }];
    assert.throws(() => selectPromptInput(messages, noImports()), { message: 'This ACP plugin currently accepts text prompts only' });
  }
});

test('a step with no new message reports the missing-prompt error instead of text-only', () => {
  assert.throws(() => selectPromptInput([], noImports()), { message: 'No forwardable text prompt was supplied to the ACP plugin' });
  assert.throws(() => selectPromptInput([assistantMessage()], noImports()), { message: 'No forwardable text prompt was supplied to the ACP plugin' });
});

test('a step whose only new user message was already imported reports the missing-prompt error', () => {
  const messages = [assistantMessage(), userMessage('already-imported')];
  assert.throws(() => selectPromptInput(messages, new Set(['already-imported'])), { message: 'No forwardable text prompt was supplied to the ACP plugin' });
  // Imported and injected messages together are indistinguishable from DSH-owned context: no prompt, no error.
  assert.deepEqual(selectPromptInput([...messages, injected('runtime', 'runtime-context')], new Set(['already-imported'])), { kind: 'noop' });
});
