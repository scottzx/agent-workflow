import assert from 'node:assert/strict';
import test from 'node:test';
import { chatItems } from '../src/execution/workbench-chat.js';

const msg = (messageId: string, role: string, text: string) => ({ messageId, role, parts: [{ text }] });

test('queue notices are dropped, repeats collapse, and the artifact answer closes the transcript', () => {
  const items = chatItems([{ attemptId: 'a1', task: { id: 't', contextId: 'c',
    status: { state: 'TASK_STATE_COMPLETED', message: msg('s', 'ROLE_AGENT', 'CAPACITY_PENDING') },
    history: [msg('1', 'ROLE_USER', '暗号是什么？'), msg('2', 'ROLE_AGENT', 'Pending: waiting in FIFO order for device memory and ACP capacity.'),
      msg('3', 'ROLE_AGENT', 'CAPACITY_PENDING'), msg('4', 'ROLE_AGENT', 'CAPACITY_PENDING'), msg('5', 'ROLE_AGENT', '处理中'), msg('6', 'ROLE_AGENT', '处理中')],
    artifacts: [{ artifactId: 'x', name: 'DSH response', parts: [{ text: '蓝鲸' }] }, { artifactId: 'y', parts: [{ url: 'http://h/f.md' }] }] } }]);
  assert.deepEqual(items.map(item => [item.kind, item.content]), [['user', '暗号是什么？'], ['assistant_text', '处理中'], ['assistant_text', '蓝鲸']]);
});

test('an answer already present in history is not repeated from the artifact', () => {
  const items = chatItems([{ task: { id: 't', contextId: 'c', status: { state: 'TASK_STATE_COMPLETED' }, history: [msg('1', 'ROLE_AGENT', '蓝鲸')],
    artifacts: [{ artifactId: 'x', parts: [{ text: '蓝鲸' }] }] } }]);
  assert.equal(items.length, 1);
});
