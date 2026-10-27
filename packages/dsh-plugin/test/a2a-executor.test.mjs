import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import { currentA2AExecution } from '@1agents/acp-service/a2a';
import { DshA2ABackend } from '../dist/a2a-executor.js';
import { diagnosticsFixture, identity } from './helpers/diagnostics.mjs';
import { toSafeError } from '@1agents/acp-service/runtime';

const targetIdentity = ({ preflight, ...identity }) => identity;

test('A2A checks startup admission after session serialization and before submitting a prompt', async t => {
  const f = await fixture(t);
  const target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const first = f.backend.run(target, 'first', { requestId: 'first', signal: new AbortController().signal });
  await f.admitted.promise;
  const gate = Promise.withResolvers();
  const checked = Promise.withResolvers();
  let checks = 0;
  const second = f.backend.run(target, 'second', { requestId: 'second', signal: new AbortController().signal,
    beforeStart: async () => { checks++; checked.resolve(); await gate.promise; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 0, 'the occupied session must drain before admission is sampled');
  f.claim(agent, 'first', 1); f.output(agent, 1, 'first done'); f.finish(agent, 1, { kind: 'completed' });
  await first;
  await checked.promise;
  assert.equal(f.prompts.length, 1, 'the queued turn cannot submit a model prompt while memory is pending');
  gate.resolve();
  while (f.prompts.length < 2) await new Promise(resolve => setImmediate(resolve));
  f.claim(agent, 'second', 2); f.output(agent, 2, 'second done'); f.finish(agent, 2, { kind: 'completed' });
  assert.equal((await second).outcome, 'completed');
  assert.equal(checks, 1);
});

test('an A2A execution binding lasts for the prompt and clears when the turn ends', async t => {
  const f = await fixture(t);
  const target = await f.backend.prepare({ cwd: f.cwd });
  let during;
  const prompt = f.controller.prompt.bind(f.controller);
  f.controller.prompt = async (request, signal) => {
    during = currentA2AExecution(target.sessionId);
    return prompt(request, signal);
  };
  const execution = { jobId: 'job-1', attemptId: 'attempt-1' };
  const run = f.backend.run(target, 'bound', { requestId: 'bound', signal: new AbortController().signal, execution });
  await f.admitted.promise;
  assert.deepEqual(during, execution);
  assert.deepEqual(currentA2AExecution(target.sessionId), execution);
  const agent = f.agents.get(target.sessionId);
  f.claim(agent, 'bound', 1); f.output(agent, 1, 'done'); f.finish(agent, 1, { kind: 'completed' });
  assert.equal((await run).outcome, 'completed');
  assert.equal(currentA2AExecution(target.sessionId), undefined);
});

test('A2A samples memory after an existing native turn drains and cancellation does not wait for that turn', async t => {
  const f = await fixture(t);
  const target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const idle = Promise.withResolvers();
  agent.whenIdle = () => idle.promise;
  let checks = 0;
  const controller = new AbortController();
  const canceled = f.backend.run(target, 'cancel', { requestId: 'cancel', signal: controller.signal,
    beforeStart: async () => { checks++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 0); assert.equal(f.prompts.length, 0);
  controller.abort(new Error('cancel before native idle'));
  await assert.rejects(canceled, /cancel before native idle/);
  const run = f.backend.run(target, 'after idle', { requestId: 'after-idle', signal: new AbortController().signal,
    beforeStart: async () => { checks++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 0);
  idle.resolve();
  await f.admitted.promise;
  assert.equal(checks, 1);
  f.claim(agent, 'after-idle', 1); f.output(agent, 1, 'done'); f.finish(agent, 1, { kind: 'completed' });
  assert.equal((await run).outcome, 'completed');
});

test('disposing a native session aborts pending memory admission and never submits a late prompt', async t => {
  const f = await fixture(t);
  const target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const waiting = Promise.withResolvers();
  let admissionAborted = false;
  const run = f.backend.run(target, 'pending', { requestId: 'dispose-pending', signal: new AbortController().signal,
    beforeStart: signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { admissionAborted = true; reject(signal.reason); }, { once: true });
      waiting.resolve();
    }) });
  await waiting.promise;
  f.ctx.emit('agent/disposed', { agent });
  const result = await run;
  assert.equal(result.failureReason, 'disposed');
  assert.equal(admissionAborted, true);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.listenerCount, 0);
});

test('preparation cancellation never restores a late blank session or submits a prompt', async t => {
  const f = await fixture(t);
  const create = f.controller.create;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.controller.create = async request => { entered.resolve(); await release.promise; return create(request); };
  const controller = new AbortController();
  const preparing = f.backend.prepare({ cwd: f.cwd }, { signal: controller.signal });
  await entered.promise;
  controller.abort(new Error('cancel session preparation'));
  const rejection = assert.rejects(preparing, /cancel session preparation/);
  release.resolve();
  await rejection;
  assert.equal(f.createCount, 1, 'the host retains its own durable blank session');
  assert.equal(f.resolveCount, 0, 'cancellation must prevent subsequent Agent restoration');
  assert.equal(f.prompts.length, 0);
  await assert.rejects(f.backend.prepare({ cwd: f.cwd }, { signal: controller.signal }), /cancel session preparation/);
  assert.equal(f.createCount, 1, 'a pre-canceled request cannot allocate another session');
});

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-a2a-executor-')));
  const { diagnostics } = await diagnosticsFixture(t, join(cwd, 'diagnostics'));
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const agents = new Map(), pending = new Map(), cancels = [], prompts = [], creates = [];
  const admitted = Promise.withResolvers();
  let activeListeners = 0, createCount = 0, resolveCount = 0, promptBehavior;
  const observe = (...args) => {
    activeListeners++;
    const dispose = ctx.on(...args);
    let disposed = false;
    return () => { if (disposed) return; disposed = true; activeListeners--; dispose(); };
  };
  const event = (agent, type, data) => ctx.emit('session/event', agent.session, { type, data });
  const user = requestId => ({ id: `${requestId}-message`, role: 'user', source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: requestId }] });
  const insert = (agent, requestId) => {
    const message = user(requestId);
    pending.set(message.id, { agent, message });
    ctx.emit('agent/inbox/inserted', { agent, message });
    return message;
  };
  const makeAgent = session => {
    const agent = {
      id: session.id, session, whenIdle: async () => {}, activeTurn: undefined, startedTurn: false, ctx: { on: observe },
      inbox: { remove: id => {
        const entry = pending.get(id);
        if (!entry) return false;
        pending.delete(id);
        ctx.emit('agent/inbox/discarded', entry);
        return true;
      } },
      cancel: (cause, options) => {
        cancels.push({ agent, cause, options });
        event(agent, 'turn/end', { turn: agent.activeTurn, reason: { kind: 'aborted', reason: cause } });
        agent.activeTurn = undefined;
      },
    };
    agents.set(agent.id, agent);
    return agent;
  };
  const controller = {
    inspect: async id => {
      const agent = agents.get(id);
      if (!agent) throw new Error(`Session ${id} not found`);
      return { meta: agent.session.header, events: [] };
    },
    create: async request => {
      creates.push(request);
      const existing = request.sessionId && agents.get(request.sessionId);
      if (existing) {
        if (existing.session.header.cwd !== request.cwd) throw new Error('Existing session cwd conflicts');
        if (request.agentPreset !== undefined && existing.session.header.agentPreset !== request.agentPreset) throw new Error('Existing session preset conflicts');
        // Current DSH create() only reuses blank Sessions. A previously used
        // identity creates a new Session even after its turn has completed.
        if (!existing.startedTurn) return { sessionId: existing.id, agentPreset: existing.session.header.agentPreset };
      }
      createCount++;
      const session = ctx.sessions.create(`dsh-a2a-${createCount}`, { meta: { cwd: request.cwd, agentPreset: request.agentPreset ?? 'default-preset' } });
      const agent = makeAgent(session);
      return { sessionId: agent.id, agentPreset: agent.session.header.agentPreset };
    },
    resolveAgent: async id => {
      resolveCount++;
      return agents.has(id) ? { agent: agents.get(id) } : { error: new Error('DSH Agent is unavailable') };
    },
    prompt: async (request, signal) => {
      prompts.push({ request, signal });
      admitted.resolve();
      if (promptBehavior) return promptBehavior(request, signal);
      insert(agents.get(request.sessionId), request.requestId);
      return { accepted: true };
    },
  };
  const host = { sessionController: controller };
  const backend = new DshA2ABackend(host, diagnostics);
  t.after(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return {
    record: async (agent, requestId, turn, error) => {
      const id = await diagnostics.begin(identity({ sessionId: agent.id, turn, requestIds: [requestId] }));
      await diagnostics.submitted(id); await diagnostics.settle(id, error);
    },
    cwd, backend, ctx, agents, pending, cancels, prompts, creates, controller, admitted,
    get listenerCount() { return activeListeners; },
    get createCount() { return createCount; }, get resolveCount() { return resolveCount; },
    set promptBehavior(value) { promptBehavior = value; },
    user, insert, event,
    claim: (agent, requestId, turn) => {
      const message = user(requestId);
      pending.delete(message.id);
      agent.startedTurn = true;
      agent.activeTurn = turn;
      ctx.emit('agent/inbox/claimed', { agent, message, turn });
    },
    output: (agent, turn, text) => event(agent, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text }] } }),
    content: (agent, turn, content) => event(agent, 'assistant/message', { turn, step: 1, message: { content: JSON.parse(JSON.stringify(content)) } }),
    finish: (agent, turn, reason) => event(agent, 'turn/end', { turn, reason }),
  };
}

test('prepare creates a real DSH Session and adopts its original directory and preset', async t => {
  const f = await fixture(t);
  const created = await f.backend.prepare({ cwd: join(f.cwd, '.'), agentPreset: 'oneagents-acp-codex' });
  assert.deepEqual(targetIdentity(created), { sessionId: 'dsh-a2a-1', cwd: f.cwd, agentPreset: 'oneagents-acp-codex' });
  assert.equal(created.preflight.ok, true);
  assert.equal(f.agents.get(created.sessionId).session.header.cwd, f.cwd);
  const restored = await f.backend.prepare({ sessionId: created.sessionId });
  assert.deepEqual(targetIdentity(restored), targetIdentity(created));
  assert.equal(f.createCount, 1);
  assert.equal(f.creates.length, 1, 'even a blank saved Session is resumed without calling create again');
  assert.equal(f.resolveCount, 2);
  await assert.rejects(f.backend.prepare({ sessionId: created.sessionId, agentPreset: 'other' }), error => error.code === 'SESSION_CONFLICT' && /preset conflicts/.test(error.message));
  await assert.rejects(f.backend.prepare({ sessionId: created.sessionId, cwd: tmpdir() }), error => error.code === 'SESSION_CONFLICT' && /cwd conflicts/.test(error.message));
});

/** Adds DSH's native model catalog and selection to the fixture controller and records call order. */
function modelHost(f, groups = [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] }]) {
  const calls = [], selections = [];
  const { create, prompt } = f.controller;
  f.controller.create = async request => { calls.push('create'); return create(request); };
  f.controller.prompt = async (request, signal) => { calls.push('prompt'); return prompt(request, signal); };
  f.controller.modelCatalog = async () => { calls.push('catalog'); return { default: { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' }, routableProviders: groups.map(group => group.id), groups, failures: [] }; };
  f.controller.selectModel = async request => { calls.push('select'); selections.push(request); return { selected: { provider: request.provider, model: request.model } }; };
  return { calls, selections };
}

test('standard prepare selects the requested model after create and before the first prompt', async t => {
  const f = await fixture(t), host = modelHost(f);
  const target = await f.backend.prepare({ cwd: f.cwd, agentPreset: 'standard', provider: 'deepseek', model: 'deepseek-v4' });
  assert.equal(target.provider, 'deepseek');
  assert.equal(target.model, 'deepseek-v4');
  assert.deepEqual(host.selections, [{ sessionId: target.sessionId, provider: 'deepseek', model: 'deepseek-v4' }]);
  const agent = f.agents.get(target.sessionId);
  const run = f.backend.run(target, 'work', { requestId: 'work', signal: new AbortController().signal });
  await f.admitted.promise; f.claim(agent, 'work', 1); f.output(agent, 1, 'Done'); f.finish(agent, 1, { kind: 'completed' });
  assert.equal((await run).text, 'Done');
  assert.deepEqual(host.calls, ['catalog', 'create', 'select', 'prompt']);
  assert.deepEqual(f.prompts[0].request.content, [{ type: 'text', text: 'work' }], 'the model name is not sent as prompt text');
});

test('a model missing from the DSH catalog fails before a session is created and never falls back', async t => {
  const f = await fixture(t), host = modelHost(f);
  await assert.rejects(f.backend.prepare({ cwd: f.cwd, agentPreset: 'standard', provider: 'deepseek', model: 'unknown-model' }),
    error => error.code === 'MODEL_UNAVAILABLE' && /not in the DSH model catalog/.test(error.message));
  await assert.rejects(f.backend.prepare({ cwd: f.cwd, agentPreset: 'standard', provider: 'other', model: 'deepseek-v4' }), error => error.code === 'MODEL_UNAVAILABLE');
  assert.deepEqual(host.calls, ['catalog', 'catalog']);
  assert.equal(f.createCount, 0);
  f.controller.selectModel = async () => { throw new Error('session/model-unavailable'); };
  await assert.rejects(f.backend.prepare({ cwd: f.cwd, agentPreset: 'standard', provider: 'deepseek', model: 'deepseek-v4' }), error => error.code === 'MODEL_UNAVAILABLE');
});

test('omitted provider and model keep the host default without reading the catalog', async t => {
  const f = await fixture(t), host = modelHost(f);
  const target = await f.backend.prepare({ cwd: f.cwd, agentPreset: 'standard' });
  assert.deepEqual(targetIdentity(target), { sessionId: 'dsh-a2a-1', cwd: f.cwd, agentPreset: 'standard' });
  assert.deepEqual(host.calls, ['create']);
});

test('the same session keeps its model unless a new one is passed', async t => {
  const f = await fixture(t), host = modelHost(f, [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'V4' }, { id: 'deepseek-v4-pro', name: 'V4 Pro' }] }]);
  const target = await f.backend.prepare({ cwd: f.cwd, agentPreset: 'standard', provider: 'deepseek', model: 'deepseek-v4' });
  const reused = await f.backend.prepare({ sessionId: target.sessionId });
  assert.equal(reused.provider, undefined, 'no new selection; the executor reports the saved one');
  assert.equal(host.selections.length, 1);
  const switched = await f.backend.prepare({ sessionId: target.sessionId, provider: 'deepseek', model: 'deepseek-v4-pro' });
  assert.equal(switched.sessionId, target.sessionId);
  assert.equal(switched.model, 'deepseek-v4-pro');
  assert.deepEqual(host.selections.map(value => [value.sessionId, value.model]), [[target.sessionId, 'deepseek-v4'], [target.sessionId, 'deepseek-v4-pro']]);
  assert.equal(f.createCount, 1);
});

test('ACP presets reject provider and model before creating a session', async t => {
  const f = await fixture(t), host = modelHost(f);
  await assert.rejects(f.backend.prepare({ cwd: f.cwd, agentPreset: 'oneagents-acp-grok', provider: 'deepseek', model: 'deepseek-v4' }), error => error.code === 'MODEL_SELECTION_UNSUPPORTED');
  assert.deepEqual(host.calls, []);
  assert.equal(f.createCount, 0);
});

test('prepare rejects missing sessions and invalid remote directories before creating a session', async t => {
  const f = await fixture(t);
  const file = join(f.cwd, 'file.txt'); await writeFile(file, 'text');
  await assert.rejects(f.backend.prepare({ cwd: 'relative' }), /absolute directory/);
  await assert.rejects(f.backend.prepare({ cwd: file }), /point to a directory/);
  await assert.rejects(f.backend.prepare({ cwd: join(f.cwd, 'missing') }), /ENOENT/);
  await assert.rejects(f.backend.prepare({ sessionId: 'missing-session' }), error => error.code === 'SESSION_NOT_FOUND' && /not found/.test(error.message));
  assert.equal(f.createCount, 0);
});

test('host preflight and dispatch reject missing requirements before creating or prompting a session', async t => {
  const f = await fixture(t);
  const probe = await f.backend.preflight({ cwd: f.cwd, requiredFiles: [join(f.cwd, 'missing-input')] });
  assert.equal(probe.ok, false);
  assert.equal(f.createCount, 0);
  await assert.rejects(f.backend.prepare({ cwd: f.cwd, preflight: {
    node: { executable: process.execPath, modules: ['__a2a_missing_module__'] },
  } }), /A2A preflight failed.*Missing Node modules/);
  await assert.rejects(f.backend.prepare({ cwd: f.cwd, preflight: { jobDirectory: '/' } }), /workspace-write roots/);
  assert.equal(f.createCount, 0);
  assert.equal(f.prompts.length, 0);
});

test('prepare fails closed when inspection is absent or resolution changes the saved identity or metadata', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd, agentPreset: 'role' });
  const agent = f.agents.get(target.sessionId), inspect = f.controller.inspect;
  f.controller.inspect = async () => undefined;
  await assert.rejects(f.backend.prepare(targetIdentity(target)), /not found/);
  f.controller.inspect = async () => null;
  await assert.rejects(f.backend.prepare(targetIdentity(target)), /not found/);
  f.controller.inspect = async () => ({ meta: { ...agent.session.header, id: 'other-session' } });
  await assert.rejects(f.backend.prepare(targetIdentity(target)), /identity conflicts/);
  f.controller.inspect = inspect;
  f.controller.resolveAgent = async () => ({ error: new Error('Cannot restore saved session') });
  await assert.rejects(f.backend.prepare(targetIdentity(target)), /Cannot restore/);
  f.controller.resolveAgent = async () => ({ agent: { ...agent, id: 'other-session' } });
  await assert.rejects(f.backend.prepare(targetIdentity(target)), /identity conflicts/);
  f.controller.resolveAgent = async () => ({ agent: { ...agent, session: { id: 'other-session', header: agent.session.header } } });
  await assert.rejects(f.backend.prepare(targetIdentity(target)), /identity conflicts/);
  f.controller.resolveAgent = async () => ({ agent: { ...agent, session: { id: target.sessionId, header: { ...agent.session.header, cwd: tmpdir() } } } });
  await assert.rejects(f.backend.prepare(targetIdentity(target)), /cwd conflicts/);
  f.controller.resolveAgent = async () => ({ agent: { ...agent, session: { id: target.sessionId, header: { ...agent.session.header, agentPreset: 'different-role' } } } });
  await assert.rejects(f.backend.prepare(targetIdentity(target)), /preset conflicts/);
  assert.equal(f.createCount, 1, 'restoration failures must not silently create replacement Sessions');
  assert.equal(f.creates.length, 1);
});

test('preparing an active context preserves its Session and serializes the appended run behind the active turn', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd, agentPreset: 'role' });
  const agent = f.agents.get(target.sessionId);
  const first = f.backend.run(target, 'first', { requestId: 'first', signal: new AbortController().signal });
  await f.admitted.promise; f.claim(agent, 'first', 1);
  const appended = await f.backend.prepare(targetIdentity(target));
  assert.deepEqual(targetIdentity(appended), targetIdentity(target));
  assert.equal(f.createCount, 1);
  assert.equal(f.creates.length, 1);
  const second = f.backend.run(appended, 'revision', { requestId: 'revision', signal: new AbortController().signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.prompts.map(value => value.request.requestId), ['first'], 'the appended turn must not be admitted concurrently');
  f.output(agent, 1, 'First answer'); f.finish(agent, 1, { kind: 'completed' });
  assert.equal((await first).text, 'First answer');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.prompts.map(value => value.request.sessionId), [target.sessionId, target.sessionId]);
  f.claim(agent, 'revision', 2); f.output(agent, 2, 'Revised answer'); f.finish(agent, 2, { kind: 'completed' });
  assert.equal((await second).text, 'Revised answer');
  assert.equal(f.agents.size, 1);
  assert.equal(f.listenerCount, 0);
});

test('preparing a completed context resumes the same nonblank Session instead of creating another conversation', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const first = f.backend.run(target, 'first', { requestId: 'first', signal: new AbortController().signal });
  await f.admitted.promise; f.claim(agent, 'first', 1); f.output(agent, 1, 'Original answer'); f.finish(agent, 1, { kind: 'completed' });
  assert.equal((await first).text, 'Original answer');
  const resumed = await f.backend.prepare({ sessionId: target.sessionId });
  assert.deepEqual(targetIdentity(resumed), targetIdentity(target));
  assert.equal(f.createCount, 1);
  assert.equal(f.creates.length, 1);
  const second = f.backend.run(resumed, 'followup', { requestId: 'followup', signal: new AbortController().signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.prompts.map(value => value.request.sessionId), [target.sessionId, target.sessionId]);
  f.claim(agent, 'followup', 2); f.output(agent, 2, 'Followup answer'); f.finish(agent, 2, { kind: 'completed' });
  assert.equal((await second).text, 'Followup answer');
  assert.equal(f.agents.get(resumed.sessionId), agent);
  assert.equal(f.listenerCount, 0);
});

test('run follows only its claimed turn and returns the final assistant text without waiting for later UI work', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId), signal = new AbortController();
  const result = f.backend.run(target, 'A2A task', { requestId: 'task-1', signal: signal.signal });
  await f.admitted.promise;
  f.claim(agent, 'ui-request', 1); f.output(agent, 1, 'Unrelated output'); f.finish(agent, 1, { kind: 'completed' });
  f.claim(agent, 'task-1', 2); f.output(agent, 2, 'Thinking'); f.output(agent, 2, 'Final answer');
  f.finish(agent, 2, { kind: 'completed' });
  f.claim(agent, 'later-ui-request', 3);
  signal.abort();
  assert.deepEqual(await result, { outcome: 'completed', text: 'Final answer' });
  assert.equal(f.cancels.length, 0);
  assert.equal(f.listenerCount, 0);
  assert.equal(f.prompts[0].request.mode, 'queue');
  assert.equal(f.prompts[0].request.content[0].text, 'A2A task');
});

const phasedText = (turn, messagePhase, text, messageId = messagePhase) => ({
  type: 'text', text, acpStream: { turn, step: 1, requestId: 'dsh-managed-request', messagePhase, messageId },
});
const terminalText = (turn, finalAnswer) => ({
  type: 'text', text: '', acpResult: { turn, step: 1, requestId: 'dsh-managed-request', finalAnswer },
});

test('durable ACP phase metadata removes progress and tools while preserving all final text blocks', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const result = f.backend.run(target, 'task', { requestId: 'task', signal: new AbortController().signal });
  let settled = false; void result.then(() => { settled = true; });
  await f.admitted.promise; f.claim(agent, 'task', 5);
  f.content(agent, 5, [
    phasedText(5, 'commentary', 'I will read README.'),
    { type: 'text', text: '', acpTool: { turn: 5, tool: { title: 'Read README', rawOutput: 'contents', status: 'completed' } } },
    phasedText(5, 'final_answer', 'First final block.', 'final-1'),
    phasedText(5, 'final_answer', ' Second final block.', 'final-2'),
  ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'assistant output alone must not complete a task');
  f.finish(agent, 4, { kind: 'completed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'another turn must not complete a task');
  f.finish(agent, 5, { kind: 'completed' });
  assert.deepEqual(await result, { outcome: 'completed', text: 'First final block. Second final block.' });
});

test('matching ACP terminal answer overrides streamed progress and final text without adding a second log copy', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const result = f.backend.run(target, 'task', { requestId: 'task', signal: new AbortController().signal });
  await f.admitted.promise; f.claim(agent, 'task', 6);
  const content = [phasedText(6, 'commentary', 'Preparing.'), phasedText(6, 'final_answer', 'Earlier streamed answer'), terminalText(6, 'Authoritative report')];
  f.content(agent, 6, content);
  f.output(agent, 6, 'Late unclassified UI output');
  f.finish(agent, 6, { kind: 'completed' });
  assert.deepEqual(await result, { outcome: 'completed', text: 'Authoritative report' });
  assert.equal(content.filter(part => part.type === 'text').map(part => part.text).join(''), 'Preparing.Earlier streamed answer');
});

for (const [label, content] of [
  ['commentary-only', [phasedText(7, 'commentary', 'I will inspect README.')]],
  ['empty terminal', [phasedText(7, 'final_answer', 'Text overridden by empty terminal'), terminalText(7, '')]],
]) {
  test(`completed ACP ${label} fails without exposing progress as a final report`, async t => {
    const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
    const agent = f.agents.get(target.sessionId);
    const result = f.backend.run(target, 'task', { requestId: 'task', signal: new AbortController().signal });
    await f.admitted.promise; f.claim(agent, 'task', 7); f.content(agent, 7, content);
    f.output(agent, 7, 'Unclassified text must not restore a missing final answer');
    f.finish(agent, 7, { kind: 'completed' });
    const value = await result;
    assert.equal(value.outcome, 'failed'); assert.equal(value.text, ''); assert.match(value.detail, /without a final answer/);
    assert.equal(value.failureReason, 'missing-final-answer');
  });
}

test('ACP metadata from other turns is ignored and unphased DSH remains compatible', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const result = f.backend.run(target, 'task', { requestId: 'task', signal: new AbortController().signal });
  await f.admitted.promise; f.claim(agent, 'task', 8);
  f.content(agent, 8, [
    { type: 'text', text: 'Ordinary DSH answer' }, terminalText(100, 'Unrelated final answer'),
  ]);
  f.finish(agent, 8, { kind: 'completed' });
  assert.deepEqual(await result, { outcome: 'completed', text: 'Ordinary DSH answer' });
});

test('an unknown producer phase retains legacy answer behavior instead of requiring an explicit final phase', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const result = f.backend.run(target, 'task', { requestId: 'task', signal: new AbortController().signal });
  await f.admitted.promise; f.claim(agent, 'task', 8);
  f.content(agent, 8, [phasedText(8, 'vendor_hint', 'Legacy final answer')]);
  f.finish(agent, 8, { kind: 'completed' });
  assert.deepEqual(await result, { outcome: 'completed', text: 'Legacy final answer' });
});

for (const reason of [{ kind: 'max-tokens' }, { kind: 'aborted', reason: { kind: 'user' } }]) {
  test(`ACP final metadata preserves failed outcome for ${reason.kind}`, async t => {
    const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
    const agent = f.agents.get(target.sessionId);
    const result = f.backend.run(target, 'task', { requestId: 'task', signal: new AbortController().signal });
    await f.admitted.promise; f.claim(agent, 'task', 9); f.content(agent, 9, [terminalText(9, 'Partial final output')]);
    f.finish(agent, 9, reason);
    const value = await result;
    assert.equal(value.outcome, 'failed'); assert.equal(value.text, 'Partial final output');
    if (reason.kind === 'aborted') {
      assert.equal(value.failureReason, 'aborted');
      assert.equal(value.error.category, 'cancelled');
      assert.equal(value.error.code, 'ABORTED');
    } else assert.equal(value.failureReason, 'max-tokens');
  });
}

for (const [category, providerCode, outcomeUnknown] of [
  ['quota', 'usageLimitExceeded', false], ['auth', 'unauthorized', false], ['unknown', undefined, true],
]) {
  test(`aborted official turn joins its owned plugin ${category} failure with local identity`, async t => {
    const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
    const agent = f.agents.get(target.sessionId);
    const result = f.backend.run(target, 'task', { requestId: 'local-aborted-task', signal: new AbortController().signal });
    await f.admitted.promise; f.claim(agent, 'local-aborted-task', 12);
    await f.record(agent, 'local-aborted-task', 12, toSafeError({ category, providerCode, retryable: false, outcomeUnknown, origin: 'acp' }, { trustedProjection: true }));
    f.finish(agent, 12, { kind: 'aborted', reason: { kind: 'user' }, failure: {
      code: 'ABORTED', message: 'SYNTHETIC_HOST_SECRET_NOT_REAL',
      publicError: { category, providerCode, retryable: false, outcomeUnknown, origin: 'acp', operationId: 'SYNTHETIC_HOST_OPERATION_NOT_REAL' },
    } });
    const value = await result;
    assert.equal(value.failureReason, 'aborted');
    assert.equal(value.error.category, category);
    assert.equal(value.error.providerCode, providerCode);
    assert.equal(value.error.outcomeUnknown, outcomeUnknown);
    assert.equal(value.error.operationId, 'local-aborted-task');
    assert.ok(!JSON.stringify(value).includes('SYNTHETIC_'));
    assert.equal(f.listenerCount, 0);
  });
}

test('aborted host facts without canonical publicError do not assert a provider cause', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const result = f.backend.run(target, 'task', { requestId: 'local-aborted-task', signal: new AbortController().signal });
  await f.admitted.promise; f.claim(agent, 'local-aborted-task', 12);
  f.finish(agent, 12, { kind: 'aborted', reason: { kind: 'user' }, failure: {
    category: 'quota', code: 'usageLimitExceeded', providerCode: 'usageLimitExceeded',
    outcomeUnknown: false, operationId: 'SYNTHETIC_HOST_OPERATION_NOT_REAL',
  } });
  const value = await result;
  assert.equal(value.error.category, 'cancelled');
  assert.equal(value.error.outcomeUnknown, true);
  assert.equal(value.error.operationId, 'local-aborted-task');
  assert.ok(!JSON.stringify(value).includes('SYNTHETIC_'));
});

for (const [reason, outcome, detail] of [
  [{ kind: 'blocked' }, 'input-required', /blocked/],
  [{ kind: 'error', error: { message: 'Provider failed', code: 'UNKNOWN' } }, 'failed', /failed/i],
  [{ kind: 'max-tokens' }, 'failed', /token limit/],
  [{ kind: 'interrupted' }, 'failed', /interrupted/],
  [{ kind: 'forked' }, 'failed', /fork/],
  [{ kind: 'synthetic-unsupported' }, 'failed', /unsupported/],
]) {
  test(`run reports DSH ${reason.kind} from its exact turn`, async t => {
    const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
    const agent = f.agents.get(target.sessionId);
    const result = f.backend.run(target, 'task', { requestId: 'task', signal: new AbortController().signal });
    await f.admitted.promise;
    f.claim(agent, 'task', 5); f.finish(agent, 5, reason);
    const value = await result;
    assert.equal(value.outcome, outcome); assert.match(value.detail, detail);
    if (reason.kind === 'max-tokens' || reason.kind === 'interrupted' || reason.kind === 'forked') assert.equal(value.failureReason, reason.kind);
    if (reason.kind === 'synthetic-unsupported') assert.equal(value.failureReason, 'unsupported-ending');
    if (reason.kind === 'interrupted') assert.equal(value.error.outcomeUnknown, true);
    assert.equal(f.listenerCount, 0);
  });
}

for (const [label, raw, category, hostCode = 'ACP_TURN_FAILED'] of [
  ['quota', { code: -32603, data: { codexErrorInfo: 'usageLimitExceeded' } }, 'quota'],
  ['rate', { code: -32603, data: { codexErrorInfo: 'rateLimitExceeded' } }, 'rate_limit'],
  ['budget', { code: -32603, data: { codexErrorInfo: 'sessionBudgetExceeded' } }, 'budget'],
  ['auth', { code: -32603, data: { codexErrorInfo: 'unauthorized' } }, 'auth'],
  ['unknown', { code: 'UNKNOWN' }, 'unknown'],
  ['quota with unrelated host code', { data: { codexErrorInfo: 'usageLimitExceeded' } }, 'quota', 'HOST_EXECUTION_ERROR'],
  ['auth with cancellation-like host code', { data: { codexErrorInfo: 'unauthorized' } }, 'auth', 'ABORTED'],
  ['quota with conflicting provider-like host code', { data: { codexErrorInfo: 'usageLimitExceeded' } }, 'quota', 'unauthorized'],
]) {
  test(`DSH A2A ${label} failure retains owned diagnostic fields and local request identity`, async t => {
    const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
    const agent = f.agents.get(target.sessionId);
    const result = f.backend.run(target, 'task', { requestId: 'synthetic-task', signal: new AbortController().signal });
    await f.admitted.promise; f.claim(agent, 'synthetic-task', 5);
    const safe = toSafeError(raw, { origin: 'acp', operationId: 'synthetic-operation', outcomeUnknown: true });
    await f.record(agent, 'synthetic-task', 5, safe);
    f.finish(agent, 5, { kind: 'error', error: { code: hostCode, publicError: safe,
      message: 'SYNTHETIC_SECRET_CANARY_NOT_REAL',
      data: { token: 'SYNTHETIC_TOKEN_NOT_REAL', authUrl: 'https://example.invalid/authorize?token=SYNTHETIC_AUTH_CANARY_NOT_REAL' },
    } });
    const value = await result;
    assert.equal(value.outcome, 'failed');
    assert.equal(value.error.category, category);
    assert.equal(value.error.providerCode, safe.providerCode);
    assert.equal(value.error.retryable, safe.retryable);
    assert.equal(value.error.outcomeUnknown, true);
    assert.equal(value.error.origin, 'acp');
    assert.equal(value.error.operationId, 'synthetic-task');
    assert.equal(value.detail, value.error.message);
    for (const canary of ['SYNTHETIC_SECRET', 'SYNTHETIC_TOKEN', 'SYNTHETIC_AUTH', 'authorize?token=', 'authUrl']) assert.ok(!JSON.stringify(value).includes(canary));
    assert.equal(f.listenerCount, 0);
  });
}

for (const [label, error] of [
  ['provider-like host code', { code: 'usageLimitExceeded' }],
  ['native-shaped host data', { code: 'ACP_TURN_FAILED', data: { codexErrorInfo: 'usageLimitExceeded' } }],
  ['native-shaped host cause', { code: 'ACP_TURN_FAILED', cause: { code: 'unauthorized' } }],
]) {
  test(`DSH A2A missing canonical publicError keeps ${label} unknown`, async t => {
    const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
    const agent = f.agents.get(target.sessionId);
    const result = f.backend.run(target, 'task', { requestId: 'caller-owned-legacy-task', signal: new AbortController().signal });
    await f.admitted.promise; f.claim(agent, 'caller-owned-legacy-task', 9);
    f.finish(agent, 9, { kind: 'error', error: { ...error,
      message: 'SYNTHETIC_HOST_CODE_SECRET_NOT_REAL', operationId: 'SYNTHETIC_HOST_OPERATION_NOT_REAL',
    } });
    const value = await result;
    assert.equal(value.outcome, 'failed');
    assert.equal(value.error.category, 'unknown');
    assert.equal(value.error.providerCode, undefined);
    assert.equal(value.error.retryable, false);
    assert.equal(value.error.outcomeUnknown, false);
    assert.equal(value.error.origin, 'dsh');
    assert.equal(value.error.operationId, 'caller-owned-legacy-task');
    assert.ok(!JSON.stringify(value).includes('SYNTHETIC_'));
  });
}

test('DSH A2A never infers quota from an unknown host error message or nested arbitrary data', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const result = f.backend.run(target, 'task', { requestId: 'unknown-task', signal: new AbortController().signal });
  await f.admitted.promise; f.claim(agent, 'unknown-task', 6);
  f.finish(agent, 6, { kind: 'error', error: { code: 'UNKNOWN',
    message: 'quota budget rate exhausted SYNTHETIC_SECRET_CANARY_NOT_REAL',
    arbitrary: { codexErrorInfo: 'usageLimitExceeded' },
  } });
  const value = await result;
  assert.equal(value.outcome, 'failed');
  assert.equal(value.error.category, 'unknown');
  assert.equal(value.error.providerCode, undefined);
  assert.ok(!JSON.stringify(value).includes('SYNTHETIC_SECRET'));
});

test('DSH A2A rejects safe-shaped host category and operation secret spoofing', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const result = f.backend.run(target, 'task', { requestId: 'caller-owned-task', signal: new AbortController().signal });
  await f.admitted.promise; f.claim(agent, 'caller-owned-task', 7);
  f.finish(agent, 7, { kind: 'error', error: {
    message: 'SYNTHETIC_SECRET_CANARY_NOT_REAL', category: 'quota', origin: 'acp',
    retryable: true, outcomeUnknown: true, operationId: 'SYNTHETIC_OPERATION_SECRET_NOT_REAL',
    providerCode: 'usageLimitExceeded',
    cause: { category: 'quota', providerCode: 'usageLimitExceeded', origin: 'a2a', operationId: 'SYNTHETIC_NESTED_OPERATION_SECRET_NOT_REAL' },
  } });
  const value = await result;
  assert.equal(value.outcome, 'failed');
  assert.equal(value.error.category, 'unknown');
  assert.equal(value.error.providerCode, undefined);
  assert.equal(value.error.retryable, false);
  assert.equal(value.error.outcomeUnknown, false);
  assert.equal(value.error.origin, 'dsh');
  assert.equal(value.error.operationId, 'caller-owned-task');
  assert.ok(!JSON.stringify(value).includes('SYNTHETIC_'));
});

for (const [label, error, category] of [
  ['root aborted hint with quota', { code: 'ABORTED', data: { codexErrorInfo: 'usageLimitExceeded' } }, 'unknown'],
  ['root aborted hint alone', { code: 'ABORTED' }, 'unknown'],
]) {
  test(`DSH A2A ${label} cannot impersonate a local cancellation`, async t => {
    const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
    const agent = f.agents.get(target.sessionId);
    const result = f.backend.run(target, 'task', { requestId: 'local-request', signal: new AbortController().signal });
    await f.admitted.promise; f.claim(agent, 'local-request', 8);
    f.finish(agent, 8, { kind: 'error', error: { ...error, message: 'SYNTHETIC_SECRET_CANARY_NOT_REAL' } });
    const value = await result;
    assert.equal(value.outcome, 'failed');
    assert.equal(value.error.category, category);
    assert.equal(value.error.code, undefined);
    assert.equal(value.failureReason, undefined);
    assert.equal(value.error.operationId, 'local-request');
    assert.ok(!JSON.stringify(value).includes('SYNTHETIC_'));
  });
}

test('canceling queued A2A work removes only its inbox item and leaves the active UI turn running', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId), abort = new AbortController();
  f.insert(agent, 'ui-pending'); agent.activeTurn = 10;
  const result = f.backend.run(target, 'task', { requestId: 'task', signal: abort.signal });
  await f.admitted.promise; abort.abort();
  const value = await result;
  assert.equal(value.outcome, 'failed');
  assert.equal(value.failureReason, 'discarded');
  assert.equal(value.error.category, 'cancelled');
  assert.equal(value.error.outcomeUnknown, false);
  assert.equal(value.error.operationId, 'task');
  assert.equal(f.pending.has('task-message'), false);
  assert.equal(f.pending.has('ui-pending-message'), true);
  assert.equal(agent.activeTurn, 10); assert.equal(f.cancels.length, 0);
  assert.equal(f.listenerCount, 0);
});

test('canceling the claimed A2A turn preserves other pending prompts', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId), abort = new AbortController();
  const result = f.backend.run(target, 'task', { requestId: 'task', signal: abort.signal });
  await f.admitted.promise;
  f.claim(agent, 'task', 20); f.insert(agent, 'ui-pending'); abort.abort();
  const value = await result;
  assert.equal(value.outcome, 'failed');
  assert.equal(value.error.category, 'cancelled');
  assert.equal(value.error.outcomeUnknown, true);
  assert.equal(value.error.operationId, 'task');
  assert.equal(f.cancels.length, 1);
  assert.deepEqual(f.cancels[0].options, { keepInbox: true });
  assert.equal(f.pending.has('ui-pending-message'), true);
  assert.equal(f.listenerCount, 0);
});

test('cancellation during async prompt admission removes the late task without canceling an unrelated turn', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId), abort = new AbortController(), release = Promise.withResolvers();
  f.promptBehavior = async request => { await release.promise; f.insert(agent, request.requestId); return { accepted: true }; };
  agent.activeTurn = 4;
  const result = f.backend.run(target, 'task', { requestId: 'task', signal: abort.signal });
  await f.admitted.promise; abort.abort(); release.resolve();
  assert.equal((await result).outcome, 'failed');
  assert.equal(f.pending.size, 0); assert.equal(f.cancels.length, 0);
  assert.equal(f.listenerCount, 0);
});

test('two A2A tasks on one session are admitted in order and receive their separate turn results', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const first = f.backend.run(target, 'first', { requestId: 'first', signal: new AbortController().signal });
  const second = f.backend.run(target, 'second', { requestId: 'second', signal: new AbortController().signal });
  await f.admitted.promise;
  assert.deepEqual(f.prompts.map(value => value.request.requestId), ['first']);
  f.claim(agent, 'first', 1); f.output(agent, 1, 'First answer'); f.finish(agent, 1, { kind: 'completed' });
  assert.equal((await first).text, 'First answer');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.prompts.map(value => value.request.requestId), ['first', 'second']);
  f.claim(agent, 'second', 2); f.output(agent, 2, 'Second answer'); f.finish(agent, 2, { kind: 'completed' });
  assert.equal((await second).text, 'Second answer');
  assert.equal(f.listenerCount, 0);
});

test('canceling an A2A task waiting behind another run returns immediately without touching that run', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId), abort = new AbortController();
  const first = f.backend.run(target, 'first', { requestId: 'first', signal: new AbortController().signal });
  const second = f.backend.run(target, 'second', { requestId: 'second', signal: abort.signal });
  await f.admitted.promise; f.claim(agent, 'first', 1); abort.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(f.cancels.length, 0);
  assert.equal(f.prompts.length, 1);
  f.output(agent, 1, 'First answer'); f.finish(agent, 1, { kind: 'completed' });
  assert.equal((await first).text, 'First answer');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.prompts.length, 1);
  assert.equal(f.listenerCount, 0);
});

test('prompt rejection, Agent disposal, and pre-admission cancellation release every listener', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  f.promptBehavior = async () => { throw new Error('Admission failed'); };
  await assert.rejects(f.backend.run(target, 'task', { requestId: 'failed', signal: new AbortController().signal }), /Admission failed/);
  assert.equal(f.listenerCount, 0);
  f.promptBehavior = undefined;
  const result = f.backend.run(target, 'task', { requestId: 'disposed', signal: new AbortController().signal });
  await new Promise(resolve => setImmediate(resolve));
  f.ctx.emit('agent/disposed', { agent: f.agents.get(target.sessionId) });
  const disposed = await result;
  assert.match(disposed.detail, /disposed/);
  assert.equal(disposed.failureReason, 'disposed');
  assert.equal(f.listenerCount, 0);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.backend.run(target, 'task', { requestId: 'canceled', signal: abort.signal }), { name: 'AbortError' });
  assert.equal(f.listenerCount, 0);
});

for (const claimed of [false, true]) {
  test(`Agent disposal preserves uncertainty only after this task was claimed (${claimed})`, async t => {
    const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
    const requestId = `synthetic-disposed-${claimed}`;
    const result = f.backend.run(target, 'task', { requestId, signal: new AbortController().signal });
    await f.admitted.promise;
    const agent = f.agents.get(target.sessionId);
    if (claimed) f.claim(agent, requestId, 4);
    else f.claim(agent, 'synthetic-unrelated-ui-request', 3);
    f.ctx.emit('agent/disposed', { agent });
    const disposed = await result;
    const error = toSafeError(disposed.error, { origin: 'dsh', operationId: requestId, trustedProjection: true });
    assert.equal(error.outcomeUnknown, claimed);
    assert.equal(error.category, 'unknown');
    assert.equal(error.retryable, false);
    assert.equal(error.origin, 'dsh');
    assert.equal(error.operationId, requestId);
    assert.equal(disposed.failureReason, 'disposed');
    assert.equal(f.listenerCount, 0);
  });
}

test('official DSH loop preserves lifecycle and cannot authenticate provider-shaped fields without plugin diagnostics', {
  skip: process.env.DSH_SOURCE ? false : 'Set DSH_SOURCE to a built matching DSH checkout for the real loop smoke test',
  timeout: 10000,
}, async t => {
  const requireHost = createRequire(join(process.env.DSH_SOURCE, 'packages/core/agent-loop/package.json'));
  const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
  const [{ default: LlmRuntime, LlmAdapter, LlmError, createUserMessage }, { default: SessionProjections },
    { default: SystemPrompt }, { default: Tools }, { default: Agents }, { default: AgentLoop }] = await Promise.all([
    load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-system-prompt'),
    load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-agent-loop'),
  ]);
  const ctx = new Context(), started = Promise.withResolvers(), requests = [];
  let notifyHang = () => started.resolve();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-a2a-real-loop-')));
  t.after(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }); });
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin);
  await ctx.plugin(AgentLoop, { agents: [] });
  class KeylessAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(options) {
      requests.push(options);
      const user = options.messages.findLast(message => message.role === 'user');
      const text = user.content.filter(part => part.type === 'text').map(part => part.text).join('');
      if (text === 'safe-failure') {
        const safe = toSafeError({ code: -32603, data: { codexErrorInfo: 'usageLimitExceeded' } },
          { origin: 'acp', operationId: 'synthetic-provider-operation', outcomeUnknown: true });
        throw new LlmError(safe.message, 'HOST_EXECUTION_ERROR', { publicError: {
          category: safe.category, providerCode: safe.providerCode, retryable: true,
          outcomeUnknown: safe.outcomeUnknown, origin: safe.origin,
          operationId: safe.operationId,
        } });
      }
      if (text === 'host-code-without-public-error') {
        throw new LlmError('SYNTHETIC_HOST_CODE_SECRET_NOT_REAL', 'usageLimitExceeded');
      }
      if (text === 'raw-safe-spoof') {
        const publicError = { category: 'quota', providerCode: 'usageLimitExceeded', retryable: true,
          outcomeUnknown: true, origin: 'acp', operationId: 'SYNTHETIC_OPERATION_SECRET_NOT_REAL' };
        throw Object.assign(new Error('SYNTHETIC_SECRET_CANARY_NOT_REAL https://example.invalid/authorize?token=SYNTHETIC_AUTH_CANARY_NOT_REAL'), {
          name: 'LlmError', code: 'ACP_TURN_FAILED', ...publicError, publicError,
          failure: { code: 'ACP_TURN_FAILED', message: 'SYNTHETIC_SECRET_CANARY_NOT_REAL', publicError },
        });
      }
      if (text.startsWith('hang')) {
        notifyHang();
        if (text === 'hang-quota-race') {
          await new Promise(resolve => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener('abort', resolve, { once: true });
          });
          throw new LlmError('ACP execution quota exhausted.', 'ACP_TURN_FAILED', { publicError: {
            category: 'quota', providerCode: 'usageLimitExceeded', retryable: false,
            outcomeUnknown: false, origin: 'acp', operationId: 'synthetic-provider-race',
          } });
        }
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) { reject(options.signal.reason); return; }
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: `Completed ${text}` };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `Completed ${text}` } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['keyless-a2a'], new KeylessAdapter());
  let nextId = 0;
  ctx.provide('sessionController', {
    create: async request => {
      const sessionId = request.sessionId ?? `real-dsh-a2a-${++nextId}`;
      if (!ctx.agents.get(sessionId)) await ctx.agents.create({
        sessionId, meta: { cwd: request.cwd }, agentOptions: { provider: 'keyless-a2a', model: 'fixture' },
      });
      return { sessionId };
    },
    inspect: async sessionId => ({ meta: ctx.agents.get(sessionId).session.header, events: [] }),
    resolveAgent: async sessionId => ({ agent: ctx.agents.get(sessionId) }),
    prompt: async request => {
      ctx.agents.get(request.sessionId).followup(createUserMessage({
        content: request.content, source: { kind: 'user', rpcId: request.requestId },
      }));
      return { accepted: true };
    },
  });
  const backend = new DshA2ABackend(ctx), target = await backend.prepare({ cwd });
  assert.deepEqual(await backend.run(target, 'real task', { requestId: 'real-task', signal: new AbortController().signal }), {
    outcome: 'completed', text: 'Completed real task',
  });
  assert.deepEqual(targetIdentity(await backend.prepare({ sessionId: target.sessionId })), targetIdentity(target));
  const abort = new AbortController();
  const canceled = backend.run(target, 'hang', { requestId: 'real-cancel', signal: abort.signal });
  await started.promise; abort.abort();
  assert.equal((await canceled).outcome, 'failed');
  await ctx.agents.get(target.sessionId).whenIdle();
  const events = ctx.agents.get(target.sessionId).session.snapshotEvents();
  assert.deepEqual(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), ['completed', 'aborted']);
  assert.deepEqual(events.filter(event => event.type === 'user/message').map(event => event.data.source.rpcId), ['real-task', 'real-cancel']);
  assert.equal(requests.length, 2);

  const unloadingStarted = Promise.withResolvers();
  notifyHang = () => unloadingStarted.resolve();
  let unloadTask;
  const owner = await ctx.plugin({
    name: 'a2a-execution-owner',
    apply: pluginCtx => {
      const ownBackend = new DshA2ABackend(pluginCtx), abort = new AbortController();
      pluginCtx.effect(() => async () => { abort.abort(); await unloadTask; });
      unloadTask = ownBackend.run(target, 'hang-unload', { requestId: 'real-unload', signal: abort.signal });
    },
  });
  await unloadingStarted.promise;
  await owner.dispose();
  assert.equal((await unloadTask).outcome, 'failed');
  await ctx.agents.get(target.sessionId).whenIdle();
  assert.equal(ctx.agents.get(target.sessionId).session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted');
  assert.equal(requests.length, 3);

  const failed = await backend.run(target, 'safe-failure', { requestId: 'real-safe-failure', signal: new AbortController().signal });
  await ctx.agents.get(target.sessionId).whenIdle();
  const hostReason = ctx.agents.get(target.sessionId).session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason;
  assert.equal(hostReason.kind, 'error');
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.detail, failed.error.message);
  const optionalFields = ['category', 'providerCode', 'retryable', 'outcomeUnknown', 'origin', 'operationId'];
  t.diagnostic(JSON.stringify({ sentCode: 'HOST_EXECUTION_ERROR', hostCode: hostReason.error.code,
    hostErrorFields: Object.keys(hostReason.error).sort(),
    retainedSafeFields: optionalFields.filter(key => Object.hasOwn(hostReason.error.publicError ?? {}, key)) }));
  assert.equal(hostReason.error.publicError, undefined);
  assert.equal(hostReason.error.code, 'HOST_EXECUTION_ERROR');
  assert.equal(failed.error.category, 'unknown');
  assert.equal(failed.error.providerCode, undefined);
  assert.equal(failed.error.outcomeUnknown, false);
  assert.equal(failed.error.operationId, 'real-safe-failure');
  assert.equal(requests.length, 4);

  const spoofed = await backend.run(target, 'raw-safe-spoof', { requestId: 'real-spoof', signal: new AbortController().signal });
  await ctx.agents.get(target.sessionId).whenIdle();
  const spoofReason = ctx.agents.get(target.sessionId).session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason;
  assert.equal(spoofReason.error.publicError, undefined);
  assert.equal(spoofed.error.category, 'unknown');
  assert.equal(spoofed.error.retryable, false);
  assert.equal(spoofed.error.outcomeUnknown, false);
  assert.equal(spoofed.error.operationId, 'real-spoof');
  assert.ok(!JSON.stringify(spoofed).includes('SYNTHETIC_'));
  assert.equal(requests.length, 5);

  const legacyTarget = await backend.prepare({ cwd });
  const legacy = await backend.run(legacyTarget, 'host-code-without-public-error', {
    requestId: 'real-host-code-only', signal: new AbortController().signal,
  });
  await ctx.agents.get(legacyTarget.sessionId).whenIdle();
  const legacyReason = ctx.agents.get(legacyTarget.sessionId).session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason;
  assert.equal(legacyReason.error.code, 'usageLimitExceeded');
  assert.equal(legacyReason.error.publicError, undefined);
  assert.equal(legacy.error.category, 'unknown');
  assert.equal(legacy.error.providerCode, undefined);
  assert.equal(legacy.error.operationId, 'real-host-code-only');
  assert.ok(!JSON.stringify(legacy).includes('SYNTHETIC_'));
  assert.equal(requests.length, 6);

  const raceStarted = Promise.withResolvers(), raceAbort = new AbortController();
  notifyHang = () => raceStarted.resolve();
  const beforeRace = ctx.agents.get(target.sessionId).session.snapshotEvents().length;
  const raced = backend.run(target, 'hang-quota-race', { requestId: 'real-quota-abort-race', signal: raceAbort.signal });
  await raceStarted.promise; raceAbort.abort(new Error('SYNTHETIC_CANCEL_SECRET_NOT_REAL'));
  const raceResult = await raced;
  await ctx.agents.get(target.sessionId).whenIdle();
  const ownEvents = ctx.agents.get(target.sessionId).session.snapshotEvents().slice(beforeRace);
  const raceEnd = ownEvents.findLast(event => event.type === 'turn/end');
  assert.equal(raceEnd.data.reason.kind, 'aborted');
  const attempts = ownEvents.filter(event => event.type === 'assistant/attempt' && event.data.turn === raceEnd.data.turn);
  assert.equal(attempts.length, 1);
  assert.ok(attempts[0].data.stream.every(frame => frame.chunk?.reason?.failure?.publicError === undefined));
  t.diagnostic(JSON.stringify({ contract: 'host abort retains canonical current failure without admitting the chunk',
    turn: raceEnd.data.turn, attemptSeq: attempts[0].seq, admittedChunks: attempts[0].data.stream.length,
    turnEnd: raceEnd.data.reason.kind, resultError: raceResult.error }));
  assert.equal(raceEnd.data.reason.failure, undefined);
  assert.equal(raceResult.error.category, 'cancelled');
  assert.equal(raceResult.error.outcomeUnknown, true);
  assert.equal(raceResult.error.operationId, 'real-quota-abort-race');
  assert.ok(!JSON.stringify(raceResult).includes('SYNTHETIC_CANCEL_SECRET'));
  assert.equal(requests.length, 7);
});
