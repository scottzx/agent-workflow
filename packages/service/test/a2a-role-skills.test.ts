import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { DefaultExecutionEventBus, RequestContext, ServerCallContext, type AgentExecutionEvent } from '@a2a-js/sdk/server';
import { A2ASessionExecutor, parseA2AInput, type A2AExecutionOptions } from '../src/a2a/executor.js';
import { FileA2AStore } from '../src/a2a/store.js';
import type { A2ABackend, A2APrepareInput, A2ATarget } from '../src/a2a/types.js';
import { createA2AServer } from '../src/a2a/server.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-role-test-')));
  const cwd = join(root, 'workspace'), skillDirectory = join(cwd, '.agents/skills/design');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: design\n---\n# Design version one');
  const profilePath = join(root, 'profile.json');
  await writeFile(join(root, 'ROLE.md'), '# Canonical PPT role');
  const profile = { id: 'ppt', version: '1', instructionsPath: 'ROLE.md', entrySkill: 'design', skills: [{ key: 'design', name: 'design' }] };
  await writeFile(profilePath, JSON.stringify(profile));
  const options: A2AExecutionOptions = { capacity: testCapacity(root), defaultCwd: cwd, defaultAgentPreset: 'codex', roleSkills: { profiles: { maker: profilePath, reviewer: profilePath } } };
  let store = new FileA2AStore(join(root, 'state'));
  const prepares: A2APrepareInput[] = [], runs: { target: A2ATarget; prompt: string }[] = [];
  const backend: A2ABackend = {
    async prepare(input) { prepares.push(input); return { sessionId: input.sessionId ?? `session-${prepares.length}`, cwd: input.cwd!, agentPreset: input.agentPreset }; },
    async run(target, prompt) { runs.push({ target: structuredClone(target), prompt }); return { text: 'ok', outcome: 'completed' }; },
  };
  let executor = new A2ASessionExecutor(backend, store, options);
  const serverContext = new ServerCallContext({ tenant: 'tenant', user: { isAuthenticated: true, userName: 'owner' } });
  async function execute(metadata?: Record<string, unknown>, contextId = randomUUID(), context = serverContext) {
    const request = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', contextId, parts: [{ text: 'Inspect existing deck only; do not modify it.' }] },
      metadata: metadata ? { '1agents': metadata } : undefined });
    const events: AgentExecutionEvent[] = [], bus = new DefaultExecutionEventBus();
    bus.on('event', event => events.push(event));
    await executor.execute(new RequestContext(request, randomUUID(), contextId, context), bus);
    const final = events.findLast(event => event.kind === 'statusUpdate'); assert.ok(final?.kind === 'statusUpdate');
    return { contextId, final: final.data, events };
  }
  t.after(async () => { await executor.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, cwd, skillDirectory, profilePath, profile, options, prepares, runs, execute, serverContext, backend,
    target: (id: string) => store.loadTarget(id, serverContext) };
}

test('a role session reads its skills from the working directory, links .claude/skills and publishes host-authored metadata', async t => {
  const f = await fixture(t);
  const run = await f.execute({ roleId: 'maker' });
  assert.equal(run.final.status?.state, TaskState.TASK_STATE_COMPLETED); assert.equal(f.runs.length, 1);
  const target = f.runs[0]!.target;
  assert.equal(target.roleId, 'maker'); assert.equal(target.roleSkills!.roleId, 'ppt');
  assert.equal(target.roleSkills!.skills[0]!.guidePath, join(f.skillDirectory, 'SKILL.md'));
  assert.match(f.runs[0]!.prompt, /# Canonical PPT role/); assert.ok(f.runs[0]!.prompt.includes(join(f.skillDirectory, 'SKILL.md')));
  assert.match(f.runs[0]!.prompt, /Inspect existing deck only/);
  assert.equal((await lstat(join(f.cwd, '.claude/skills'))).isSymbolicLink(), true);
  const metadata = run.final.metadata?.['1agents'] as Record<string, any>;
  assert.equal(metadata.result.roleId, 'maker'); assert.deepEqual(metadata.result.roleSkills, target.roleSkills);
  assert.deepEqual(f.target(run.contextId), target);
});

test('ordinary tasks neither load a role nor touch the working directory', async t => {
  const f = await fixture(t);
  const run = await f.execute();
  assert.equal(run.final.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.runs[0]!.target.roleSkills, undefined);
  await assert.rejects(lstat(join(f.cwd, '.claude')));
});

test('a fixed preset binding loads its role while other presets stay ordinary', async t => {
  const f = await fixture(t);
  f.options.roleSkills!.presetRoles = { 'ppt-beautifier': 'maker' };
  const ppt = await f.execute({ agentPreset: 'ppt-beautifier' });
  assert.equal(ppt.final.status?.state, TaskState.TASK_STATE_COMPLETED); assert.equal(f.runs[0]!.target.roleId, 'maker');
  for (const agentPreset of ['standard', 'oneagents-acp-codex']) {
    await f.execute({ agentPreset });
    assert.equal(f.runs.at(-1)!.target.roleSkills, undefined);
  }
});

test('a continuation keeps its role and sees the skill files as they are now', async t => {
  const f = await fixture(t);
  const first = await f.execute({ roleId: 'maker' });
  await writeFile(join(f.skillDirectory, 'SKILL.md'), '---\nname: design\n---\n# Design version two');
  const next = await f.execute(undefined, first.contextId);
  assert.equal(next.final.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.runs[1]!.target.roleId, 'maker'); assert.match(f.runs[1]!.prompt, /# Canonical PPT role/);
});

test('an untyped context cannot acquire a role, and a missing skill stops before any session is created', async t => {
  const f = await fixture(t), old = await f.execute();
  const typed = await f.execute({ roleId: 'maker' }, old.contextId);
  assert.equal(typed.final.status?.state, TaskState.TASK_STATE_FAILED); assert.equal(f.runs.length, 1);
  f.profile.skills[0]!.name = 'unavailable'; await writeFile(f.profilePath, JSON.stringify(f.profile));
  const missing = await f.execute({ roleId: 'maker' });
  assert.equal(missing.final.status?.state, TaskState.TASK_STATE_FAILED); assert.equal(f.prepares.length, 1); assert.equal(f.runs.length, 1);
});

test('a path agent can now be combined with a host role', async t => {
  const f = await fixture(t);
  const agentFile = join(f.cwd, '.claude/agents/helper.md');
  await mkdir(join(f.cwd, '.claude/agents'), { recursive: true });
  await writeFile(agentFile, '---\nname: helper\ndescription: test\n---\nHelper rules.');
  const run = await f.execute({ roleId: 'maker', agentFile, cwd: f.cwd });
  assert.equal(run.final.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.match(f.runs[0]!.prompt, /# Canonical PPT role/); assert.match(f.runs[0]!.prompt, /Helper rules/);
});

test('metadata cannot override host profiles', async t => {
  const f = await fixture(t);
  const request = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'work' }] }, metadata: { '1agents': { roleId: 'maker', profilePath: '/tmp/attacker' } } });
  assert.throws(() => parseA2AInput(request, f.options), /Unknown metadata/);
  request.metadata = { '1agents': { roleId: 'unknown' } };
  assert.throws(() => parseA2AInput(request, f.options), /Unknown host role/);
});

test('invalid role host configuration fails before taking a state-directory lease', async t => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-role-options-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend: A2ABackend = { async prepare() { throw new Error('unused'); }, async run() { throw new Error('unused'); } };
  const stateDirectory = join(root, 'state');
  await assert.rejects(createA2AServer({ backend, publicUrl: 'http://localhost', token: 'test', stateDirectory, roleSkills: { profiles: { maker: 'relative.json' } } }), /absolute profile/);
  await assert.rejects(createA2AServer({ backend, publicUrl: 'http://localhost', token: 'test', stateDirectory,
    roleSkills: { profiles: {}, presetRoles: { 'ppt-beautifier': 'missing' } } }), /registered host profiles/);
  const store = new FileA2AStore(stateDirectory); store.close();
});
