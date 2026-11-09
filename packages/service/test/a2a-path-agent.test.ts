import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { DefaultExecutionEventBus, RequestContext, ServerCallContext, type AgentExecutionEvent } from '@a2a-js/sdk/server';
import { A2ASessionExecutor, parseA2AInput } from '../src/a2a/executor.js';
import { FileA2AStore } from '../src/a2a/store.js';
import type { A2ABackend, A2ATarget } from '../src/a2a/types.js';
import { listAgentFiles, parseAgentMarkdown } from '../src/execution/agent-files.js';

const executorAgent = '---\nname: restore-executor\ndescription: "还原轨迹"\ntools: Read, Bash\n---\n\n你是轨迹还原执行者。\n';

async function scenario(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'path-agent-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agents'));
  await writeFile(join(root, 'agents', 'restore-executor.md'), executorAgent);
  return root;
}

test('agent Markdown keeps frontmatter fields apart from the instructions', () => {
  assert.deepEqual(parseAgentMarkdown(executorAgent), { fields: { name: 'restore-executor', description: '还原轨迹', tools: 'Read, Bash' }, body: '你是轨迹还原执行者。' });
  assert.deepEqual(parseAgentMarkdown('﻿只有正文\r\n'), { fields: {}, body: '只有正文' });
});

test('listing agents/*.md requires unique valid names and files that stay inside the directory', async t => {
  const root = await scenario(t);
  const [agent] = await listAgentFiles(root);
  assert.equal(agent!.name, 'restore-executor');
  assert.equal(agent!.description, '还原轨迹');
  assert.equal(agent!.file, join(root, 'agents', 'restore-executor.md'));
  await assert.rejects(listAgentFiles('relative/path'), /absolute/);
  await assert.rejects(listAgentFiles(join(root, 'agents')), /No agents\/ directory/);

  await writeFile(join(root, 'agents', 'copy.md'), executorAgent);
  await assert.rejects(listAgentFiles(root), /unique/);
  await rm(join(root, 'agents', 'copy.md'));
  await writeFile(join(root, 'agents', 'bad.md'), '---\nname: ../escape\n---\nbody\n');
  await assert.rejects(listAgentFiles(root), /Invalid agent name/);
  await rm(join(root, 'agents', 'bad.md'));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'path-agent-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'leak.md'), '---\nname: leak\n---\nsecret\n');
  await symlink(join(outside, 'leak.md'), join(root, 'agents', 'leak.md'));
  await assert.rejects(listAgentFiles(root), /inside its directory/);
});

test('the host prefixes a new session with the path agent and leaves continuations alone', async t => {
  const root = await scenario(t);
  const store = new FileA2AStore(join(root, '.state'));
  const runs: { target: A2ATarget; prompt: string }[] = [];
  const backend: A2ABackend = {
    async prepare(input) { return { sessionId: input.sessionId ?? `session-${randomUUID()}`, cwd: input.cwd!, agentPreset: input.agentPreset }; },
    async run(target, prompt) { runs.push({ target: structuredClone(target), prompt }); return { text: 'done', outcome: 'completed' }; },
  };
  const options = { capacity: testCapacity(root), defaultCwd: root, defaultAgentPreset: 'codex' };
  const executor = new A2ASessionExecutor(backend, store, options);
  t.after(async () => { await executor.close(); store.close(); });
  const context = new ServerCallContext({ tenant: 'tenant', user: { isAuthenticated: true, userName: 'owner' } });
  async function execute(metadata: Record<string, unknown>, contextId = randomUUID()) {
    const request = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', contextId, parts: [{ text: '还原这份轨迹' }] },
      metadata: { '1agents': metadata } });
    const events: AgentExecutionEvent[] = [], bus = new DefaultExecutionEventBus();
    bus.on('event', event => events.push(event));
    await executor.execute(new RequestContext(request, randomUUID(), contextId, context), bus);
    const final = events.findLast(event => event.kind === 'statusUpdate'); assert.ok(final?.kind === 'statusUpdate');
    return { contextId, state: final.data.status?.state, events };
  }

  const agentFile = join(root, 'agents', 'restore-executor.md');
  const first = await execute({ cwd: root, agentPreset: 'oneagents-acp-grok-build', agentFile });
  assert.equal(first.state, TaskState.TASK_STATE_COMPLETED);
  assert.match(runs[0]!.prompt, /^宿主已按路径加载智能体 restore-executor/);
  assert.ok(runs[0]!.prompt.includes('你是轨迹还原执行者。'));
  assert.ok(runs[0]!.prompt.endsWith('上游任务：\n还原这份轨迹'));
  await execute({}, first.contextId);
  assert.equal(runs[1]!.prompt, '还原这份轨迹');

  // A file outside the session's cwd fails the task before the model runs.
  const other = await realpath(await mkdtemp(join(tmpdir(), 'path-agent-other-')));
  t.after(() => rm(other, { recursive: true, force: true }));
  const outside = await execute({ cwd: other, agentPreset: 'oneagents-acp-grok-build', agentFile });
  assert.equal(outside.state, TaskState.TASK_STATE_FAILED);
  assert.equal(runs.length, 2);
  const combined = (metadata: Record<string, unknown>) => SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'x' }] }, metadata: { '1agents': metadata } });
  // A path agent and a host role may now be combined: the role's skills sit in the same cwd.
  assert.doesNotThrow(() => parseA2AInput(combined({ cwd: root, agentFile, roleId: 'maker' }), { ...options, roleSkills: { profiles: { maker: join(root, 'profile.json') } } }));
  assert.throws(() => parseA2AInput(combined({ cwd: root, agentFile: 'agents/restore-executor.md' }), options), /absolute path/);
});

test('a path-agent target fixes cwd and preset and keeps its agent file inside cwd', async t => {
  const root = await scenario(t);
  const { TargetDirectory } = await import('../src/execution/targets.js');
  const targets = new TargetDirectory(join(root, '.targets'), { fixture: { url: 'http://127.0.0.1:1' } });
  targets.invoke('execution_connection_create', { connectionId: 'local', remote: 'fixture' });
  const base = { kind: 'agent_host', name: 'restore', connectionId: 'local' };
  assert.throws(() => targets.invoke('execution_target_create', { ...base, targetId: 'outside', binding: { cwd: root, agentPreset: 'oneagents-acp-codex', agentFile: '/elsewhere/agents/a.md' } }), /inside cwd/);
  assert.throws(() => targets.invoke('execution_target_create', { ...base, targetId: 'no-preset', binding: { cwd: root, agentFile: join(root, 'agents', 'restore-executor.md') } }), /fixed cwd and agentPreset/);
  targets.invoke('execution_target_create', { ...base, targetId: 'restore', binding: { cwd: root, agentPreset: 'oneagents-acp-codex', agentFile: join(root, 'agents', 'restore-executor.md') } });
  assert.throws(() => targets.resolve('restore', { cwd: '/tmp', prompt: 'x' }), /cannot override/);
  const resolved = targets.resolve('restore', { prompt: 'x' });
  assert.equal(resolved.cwd, root);
  assert.equal(resolved.agentPreset, 'oneagents-acp-codex');
});

test('only a path agent on a DSH-native preset can fix its model', async t => {
  const root = await scenario(t);
  const { TargetDirectory } = await import('../src/execution/targets.js');
  const targets = new TargetDirectory(join(root, '.targets'), { fixture: { url: 'http://127.0.0.1:1' } });
  targets.invoke('execution_connection_create', { connectionId: 'local', remote: 'fixture' });
  const base = { kind: 'agent_host', name: 'restore', connectionId: 'local' }, agentFile = join(root, 'agents', 'restore-executor.md');
  assert.throws(() => targets.invoke('execution_target_create', { ...base, targetId: 'acp-model', binding: { cwd: root, agentPreset: 'oneagents-acp-codex', agentFile, provider: 'p', model: 'm' } }), /DSH-native/);
  assert.throws(() => targets.invoke('execution_target_create', { ...base, targetId: 'half', binding: { cwd: root, agentPreset: 'standard', agentFile, provider: 'p' } }), /together/);
  assert.throws(() => targets.invoke('execution_target_create', { ...base, targetId: 'plain', binding: { provider: 'p', model: 'm' } }), /Only a path agent/);
  targets.invoke('execution_target_create', { ...base, targetId: 'native', binding: { cwd: root, agentPreset: 'standard', agentFile, provider: 'p', model: 'm' } });
  assert.equal(targets.resolve('native', { prompt: 'x' }).agentPreset, 'standard');
});
