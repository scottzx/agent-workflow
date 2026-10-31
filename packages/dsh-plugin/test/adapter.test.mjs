import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agent as acpAgent, RequestError } from '@agentclientprotocol/sdk';
import { WebSocketServer } from 'ws';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { bindA2AExecution, currentA2AExecution, unbindA2AExecution } from '@1agents/acp-service/a2a';
import { AcpAdapter, validateSessionPolicies } from '../dist/adapter.js';
import { stream, object } from '../dist/transport.js';
import { State } from '../dist/state.js';
import { diagnosticsFixture } from './helpers/diagnostics.mjs';
import { toSafeError } from '@1agents/acp-service/runtime';

function safeFields(error) {
  return Object.fromEntries(['category', 'providerCode', 'retryable', 'outcomeUnknown', 'origin', 'operationId']
    .filter(key => error[key] !== undefined).map(key => [key, error[key]]));
}

async function fixture(t, disconnect = false, interaction = 'permission', beforeNew = async () => {}, toolUpdates = [], streamConfig = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-acp-test-'));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.once('listening', r));
  let creations = 0, executions = 0, permissions = 0, dropped = false;
  const attaches = [];
  const records = new Map();
  const replay = new Map();
  const waiting = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const prompts = [];
  const changes = [];
  const creationsInput = [];
  const closedSessions = [];
  const permissionResults = [];
  const deletedSessions = [];
  const commands = new Map();
  let model = 'native-a';
  const configOptions = () => [{ id: 'native-model', name: 'Native model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'native-a', name: 'Native A' }, { value: 'native-b', name: 'Native B' }] }];
  wss.on('connection', (ws, request) => {
    const agentName = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname.split('/').filter(Boolean).pop() ?? '');
    let connection;
    const app = acpAgent()
      .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, _meta: { '1agents': { version: 1 } } } }))
      .onRequest('session/new', async ({ params }) => {
        attaches.push({ method: 'session/new' });
        creationsInput.push(params);
        await beforeNew();
        const sessionId = 'remote-' + (++creations);
        await connection.client.notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Native review', input: { hint: 'Scope' } }, { name: 'model', description: 'Native model' }] } });
        if (streamConfig.onNew) return streamConfig.onNew({ params, sessionId, agentName });
        return { sessionId, configOptions: configOptions(), modes: { currentModeId: 'read', availableModes: [{ id: 'read', name: 'Read' }, { id: 'write', name: 'Write' }] } };
      })
      .onRequest('_1agents/session/import', object, () => {
        if (streamConfig.importError) throw new RequestError(streamConfig.importError.code, streamConfig.importError.message, streamConfig.importError.data);
        return { sessionId: 'synthetic-imported-session' };
      })
      .onRequest('session/set_config_option', async ({ params }) => {
        if (streamConfig.onConfig) { changes.push(params); return streamConfig.onConfig({ params, agentName }); }
        assert.equal(params.configId, 'native-model');
        assert.ok(['native-a', 'native-b'].includes(params.value));
        changes.push(params); model = params.value;
        await connection.client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'status', description: 'Native status' }] } });
        return { configOptions: configOptions() };
      })
      .onRequest('session/set_mode', ({ params }) => {
        changes.push(params);
        if (streamConfig.modeError) throw new RequestError(streamConfig.modeError.code, streamConfig.modeError.message, streamConfig.modeError.data);
        return {};
      })
      .onRequest('session/close', async ({ params }) => {
        closedSessions.push(params.sessionId);
        await streamConfig.beforeClose?.();
        if (streamConfig.closeError) throw new RequestError(streamConfig.closeError.code, streamConfig.closeError.message, streamConfig.closeError.data);
        return {};
      })
      .onRequest('session/delete', ({ params }) => { deletedSessions.push(params.sessionId); return {}; })
      .onRequest('session/load', async ({ params }) => {
        attaches.push({ method: 'session/load', sessionId: params.sessionId });
        if (streamConfig.loadError) throw new RequestError(streamConfig.loadError.code, streamConfig.loadError.message, streamConfig.loadError.data);
        for (const update of replay.get(params.sessionId) ?? []) await connection.client.notify('session/update', { sessionId: params.sessionId, update });
        return {};
      })
      .onRequest('session/resume', async ({ params }) => {
        attaches.push({ method: 'session/resume', sessionId: params.sessionId });
        if (streamConfig.loadError) throw new RequestError(streamConfig.loadError.code, streamConfig.loadError.message, streamConfig.loadError.data);
        return {};
      })
      .onNotification('session/cancel', () => cancelled.resolve())
      .onRequest('session/prompt', async ({ params }) => {
        prompts.push(params.prompt);
        const turnId = params._meta['1agents'].turnId;
        const key = params.sessionId + turnId;
        const seen = records.get(key);
        if (!seen) { executions++; records.set(key, true); }
        const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ACP' }, _meta: { '1agents': { turnId, sequence: 1 } } };
        if (!seen) {
          const updates = (streamConfig.updates ?? [update, ...toolUpdates]).map((u, i) => ({ ...u, _meta: { ...u._meta, '1agents': { ...u._meta?.['1agents'], turnId, sequence: i + 1 } } }));
          replay.set(params.sessionId, updates);
          for (const update of updates) await connection.client.notify('session/update', { sessionId: params.sessionId, update });
        }
        if (disconnect && !dropped) { dropped = true; ws.terminate(); return new Promise(() => {}); }
        if (streamConfig.error) {
          await streamConfig.beforeError?.();
          throw new RequestError(streamConfig.error.code, streamConfig.error.message, streamConfig.error.data);
        }
        if (interaction === 'question') {
          const result = await connection.client.request('_x.ai/ask_user_question', { questions: [{ question: 'Choose targets', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] });
          assert.deepEqual(result, { outcome: 'accepted', answers: { 'Choose targets': ['A', 'B'] } });
          const plan = await connection.client.request('_x.ai/exit_plan_mode', { planContent: 'Read the project' });
          assert.deepEqual(plan, { outcome: 'approved' });
          return streamConfig.result ?? { stopReason: 'end_turn' };
        }
        const permission = await connection.client.request('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'edit', title: 'Edit file', rawInput: { path: '/tmp/example' } }, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
        permissionResults.push(permission.outcome);
        if (interaction !== 'pending') assert.equal(permission.outcome.optionId, 'once');
        return streamConfig.result ?? { stopReason: 'end_turn' };
      });
    connection = app.connect(stream(ws));
  });
  const local = { id: 'dsh-session', session: { header: { cwd: directory, agentPreset: 'oneagents-acp-codex' }, boundary: { openTurnStartSeq: null, lastTurn: 0 } }, ctx: { commands: { register: definition => { commands.set(definition.name, definition); return () => commands.delete(definition.name); } } } };
  local.session.append = () => { throw new Error('Remote tools must use existing stream records'); };
  const scopedCommands = local.ctx.commands;
  delete local.ctx.commands;
  local.ctx.inject = async (deps, apply) => { assert.deepEqual(deps, ['commands']); apply({ commands: scopedCommands, effect: () => {} }); return { dispose: async () => {} }; };
  const sent = []; local.followup = m => sent.push(m);
  const ctx = { sessionProjections: { stateOf: (session, key) => key === 'turnBoundary' ? session.boundary : session.header.agentPreset }, agents: { get: id => id === local.id ? local : undefined }, approval: { request: async request => {
    permissions++; assert.equal(request.agent, local);
    if (interaction === 'pending') {
      waiting.resolve();
      await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
      return 'cancelled';
    }
    if (interaction === 'reconnect-permission' && permissions === 1) {
      const aborted = new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
      for (const ws of wss.clients) ws.terminate();
      await aborted;
      return 'cancelled';
    }
    return 'allowed-once';
  } }, userQuestions: { ask: async request => {
    assert.equal(request.agent, local);
    if (streamConfig.questionHold) {
      (streamConfig.asks ??= []).push(request);
      if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    const q = request.questions[0];
    if (q.id === 'plan') {
      assert.equal(q.detail, 'Read the project');
      return { answers: [{ id: q.id, selected: ['批准'] }] };
    }
    assert.equal(q.multiSelect, true);
    return { answers: [{ id: q.id, selected: ['A', 'B'] }] };
  } } };
  const config = { serviceUrl: `http://127.0.0.1:${wss.address().port}`, agents: ['codex', 'grok-build'], stateDirectory: directory, reconnectAttempts: 2, reconnectDelayMs: 1 };
  const adapter = new AcpAdapter(ctx, config, streamConfig.diagnostics, streamConfig.processRequests);
  t.after(async () => { await adapter.dispose(); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); rmSync(directory, { recursive: true, force: true }); });
  const options = id => ({ provider: '1agents-acp', model: 'codex', sessionId: local.id, messages: [{ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }] });
  return { adapter, options, config, ctx, local, sent, prompts, changes, creationsInput, closedSessions, deletedSessions, permissionResults, commands, attaches, waiting: waiting.promise, cancelled: cancelled.promise, counts: () => ({ creations, executions, permissions }) };
}
async function collect(adapter, options) { const chunks = []; for await (const c of adapter.stream(options)) chunks.push(c); return chunks; }

test('workspace policy sets advertised native mode and does not send bridge permissionMode', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.config.sessionPolicies = validateSessionPolicies([{ cwd: f.local.session.header.cwd, agent: 'codex', permissionMode: 'approve-all', initialModeId: 'write' }]);
  const capabilities = await f.adapter.describe(f.local);
  assert.equal(capabilities.modes.currentModeId, 'write');
  assert.equal(f.creationsInput[0]._meta, undefined);
  assert.deepEqual(f.changes, [{ sessionId: 'remote-1', modeId: 'write' }]);
  assert.equal(f.prompts.length, 0);
  await f.adapter.describe(f.local);
  assert.equal(f.changes.length, 1);
  assert.deepEqual(f.closedSessions, []);
});

for (const mismatch of ['workspace', 'agent']) {
  test(`workspace policy does not affect a different ${mismatch}`, { timeout: 5000 }, async t => {
    const f = await fixture(t);
    f.config.sessionPolicies = validateSessionPolicies([{ cwd: mismatch === 'workspace' ? join(f.local.session.header.cwd, 'other') : f.local.session.header.cwd, agent: mismatch === 'agent' ? 'grok-build' : 'codex', permissionMode: 'approve-all', initialModeId: 'write' }]);
    const capabilities = await f.adapter.describe(f.local);
    assert.equal(capabilities.modes.currentModeId, 'read');
    assert.equal(f.creationsInput[0]._meta, undefined);
    assert.deepEqual(f.changes, []);
  });
}

test('workbench answers complete the live question and plan, and DSH answers close the card', { timeout: 10000 }, async t => {
  const execution = { jobId: 'job-1', attemptId: 'attempt-1' };
  t.after(() => unbindA2AExecution('dsh-session', execution));
  const workbenchCalls = [];
  const workbench = {
    async open(input) { workbenchCalls.push({ op: 'open', input }); return { requestId: input.requestId, deadlineAt: new Date(Date.now() + 60_000).toISOString(), status: 'pending' }; },
    async wait(input) {
      const opened = workbenchCalls.find(call => call.op === 'open' && call.input.requestId === input.requestId);
      if (opened.input.kind === 'plan') return { requestId: input.requestId, jobId: opened.input.jobId, kind: 'plan', status: 'answered', deadlineAt: opened.deadlineAt ?? '', answer: { clientRequestId: 'wb-plan', outcome: 'approved' } };
      return { requestId: input.requestId, jobId: 'job-1', kind: 'question', status: 'answered', deadlineAt: '', answer: { clientRequestId: 'wb-q', outcome: 'accepted', answers: { 'Choose targets': ['A', 'B'] } } };
    },
    async report(input) { workbenchCalls.push({ op: 'report', input }); },
  };
  const held = { processRequests: workbench, questionHold: true, asks: [] };
  const workbenchWins = await fixture(t, false, 'question', async () => {}, [], held);
  bindA2AExecution(workbenchWins.local.id, execution);
  await collect(workbenchWins.adapter, workbenchWins.options('workbench-wins'));
  assert.equal(held.asks.length, 2);
  assert.equal(held.asks.every(request => request.signal.aborted), true);
  assert.equal(workbenchCalls.some(call => call.op === 'report'), false);
  assert.equal(workbenchCalls.filter(call => call.op === 'open').map(call => call.input.kind).join(','), 'question,plan');
  unbindA2AExecution(workbenchWins.local.id, execution);

  const dshCalls = [];
  const dsh = {
    async open(input) { dshCalls.push({ op: 'open', input }); return { requestId: input.requestId, deadlineAt: new Date(Date.now() + 60_000).toISOString(), status: 'pending' }; },
    async wait(input) { await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })); },
    async report(input) { dshCalls.push({ op: 'report', input }); },
  };
  const dshWins = await fixture(t, false, 'question', async () => {}, [], { processRequests: dsh });
  bindA2AExecution(dshWins.local.id, execution);
  await collect(dshWins.adapter, dshWins.options('dsh-wins'));
  const reports = dshCalls.filter(call => call.op === 'report').map(call => call.input);
  assert.deepEqual(reports.map(item => item.outcome), ['accepted', 'approved']);
  assert.deepEqual(reports[0].answers, { 'Choose targets': ['A', 'B'] });
  assert.equal(reports[1].answers, undefined);
  unbindA2AExecution(dshWins.local.id, execution);

  let opened = false;
  const unbound = await fixture(t, false, 'question', async () => {}, [], { processRequests: { async open() { opened = true; throw new Error('unused'); }, async wait() { throw new Error('unused'); }, async report() {} } });
  await collect(unbound.adapter, unbound.options('no-binding'));
  assert.equal(opened, false);
  assert.equal(currentA2AExecution(unbound.local.id), undefined);

  let failedOpen = false;
  const failed = await fixture(t, false, 'question', async () => {}, [], { processRequests: { async open() { failedOpen = true; throw new Error('gateway down'); }, async wait() { throw new Error('unused'); }, async report() {} } });
  bindA2AExecution(failed.local.id, execution);
  await collect(failed.adapter, failed.options('open-failed'));
  assert.equal(failedOpen, true);
  unbindA2AExecution(failed.local.id, execution);
});

test('tool permission goes to the workbench for an A2A turn; either answer completes it', { timeout: 10000 }, async t => {
  const execution = { jobId: 'job-perm', attemptId: 'attempt-perm' };
  t.after(() => unbindA2AExecution('dsh-session', execution));
  const opened = [];
  const workbench = {
    async open(input) { opened.push(input); return { requestId: input.requestId, deadlineAt: new Date(Date.now() + 60_000).toISOString(), status: 'pending' }; },
    async wait(input) { return { requestId: input.requestId, jobId: 'job-perm', kind: 'permission', status: 'answered', deadlineAt: '', answer: { clientRequestId: 'wb-perm', outcome: 'approved' } }; },
    async report() { throw new Error('the workbench answered first'); },
  };
  // The local DSH approval stays pending until the workbench answer aborts it.
  const workbenchWins = await fixture(t, false, 'pending', async () => {}, [], { processRequests: workbench });
  bindA2AExecution(workbenchWins.local.id, execution);
  await collect(workbenchWins.adapter, workbenchWins.options('perm-workbench'));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].kind, 'permission');
  assert.equal(opened[0].toolTitle, 'Edit file');
  assert.match(opened[0].toolDetail, /\/tmp\/example/);
  assert.deepEqual(workbenchWins.permissionResults, [{ outcome: 'selected', optionId: 'once' }]);
  unbindA2AExecution(workbenchWins.local.id, execution);

  const reports = [];
  const dsh = {
    async open(input) { return { requestId: input.requestId, deadlineAt: new Date(Date.now() + 60_000).toISOString(), status: 'pending' }; },
    async wait(input) { await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })); },
    async report(input) { reports.push(input); },
  };
  const dshWins = await fixture(t, false, 'permission', async () => {}, [], { processRequests: dsh });
  bindA2AExecution(dshWins.local.id, execution);
  await collect(dshWins.adapter, dshWins.options('perm-dsh'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reports.map(item => item.outcome), ['approved']);
  assert.deepEqual(dshWins.permissionResults, [{ outcome: 'selected', optionId: 'once' }]);
  unbindA2AExecution(dshWins.local.id, execution);
});

test('unadvertised initial mode fails before prompting', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.config.sessionPolicies = validateSessionPolicies([{ cwd: f.local.session.header.cwd, agent: 'codex', permissionMode: 'approve-all', initialModeId: 'unknown' }]);
  await assert.rejects(f.adapter.describe(f.local), /not advertised/);
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.closedSessions, ['remote-1']);
  assert.equal(new State(f.config.stateDirectory).get(f.local.id), undefined);
});

test('failed initial mode RPC closes only the newly created remote session', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    modeError: { code: -32603, message: 'Initial mode rejected' },
  });
  f.config.sessionPolicies = [{ cwd: f.local.session.header.cwd, agent: 'codex', permissionMode: 'approve-all', initialModeId: 'write' }];
  await assert.rejects(f.adapter.describe(f.local), /Initial mode rejected/);
  assert.deepEqual(f.closedSessions, ['remote-1']);
  assert.equal(new State(f.config.stateDirectory).get(f.local.id), undefined);
  assert.equal(f.prompts.length, 0);
});

test('initialization failure waits for remote close acknowledgement', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(); const finish = Promise.withResolvers();
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    beforeClose: async () => { entered.resolve(); await finish.promise; },
  });
  f.config.sessionPolicies = [{ cwd: f.local.session.header.cwd, agent: 'codex', permissionMode: 'approve-all', initialModeId: 'unknown' }];
  let settled = false;
  const description = f.adapter.describe(f.local).finally(() => { settled = true; });
  const rejected = assert.rejects(description, /not advertised/);
  await entered.promise;
  assert.equal(settled, false);
  finish.resolve(); await rejected;
  assert.deepEqual(f.closedSessions, ['remote-1']);
});

test('failed local binding save closes the just-created remote session', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  t.mock.method(f.adapter.state, 'save', () => { throw new Error('Synthetic local save failure'); });
  await assert.rejects(f.adapter.describe(f.local), /Synthetic local save failure/);
  assert.deepEqual(f.closedSessions, ['remote-1']);
  assert.equal(new State(f.config.stateDirectory).get(f.local.id), undefined);
});

test('failed remote cleanup preserves a guarded identity across adapter restart and preset changes', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    modeError: { code: -32603, message: 'SYNTHETIC_PRIVATE_MODE_FAILURE' },
    closeError: { code: -32603, message: 'SYNTHETIC_PRIVATE_CLOSE_FAILURE' },
  });
  f.config.sessionPolicies = [{ cwd: f.local.session.header.cwd, agent: 'codex', permissionMode: 'approve-all', initialModeId: 'write' }];
  const recoveryError = error => {
    assert.match(error.message, /remote cleanup could not be confirmed; host recovery is required/);
    assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE/);
    return true;
  };
  await assert.rejects(f.adapter.describe(f.local), recoveryError);
  const binding = new State(f.config.stateDirectory).get(f.local.id);
  assert.equal(binding.sessionId, 'remote-1');
  assert.equal(binding.initializationCleanupPending, true);
  await assert.rejects(f.adapter.describe(f.local), recoveryError);
  await f.adapter.dispose();
  const restored = new AcpAdapter(f.ctx, f.config);
  try {
    await assert.rejects(restored.describe(f.local), recoveryError);
    f.local.session.header.agentPreset = 'oneagents-acp-grok-build';
    await assert.rejects(restored.describe(f.local), recoveryError);
    assert.equal(f.counts().creations, 1);
    assert.deepEqual(f.closedSessions, ['remote-1']);
  } finally { await restored.dispose(); }
});

test('failed cleanup and unavailable state storage still block repeated creation in the same adapter', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    closeError: { code: -32603, message: 'Synthetic close failure' },
  });
  f.config.sessionPolicies = [{ cwd: f.local.session.header.cwd, agent: 'codex', permissionMode: 'approve-all', initialModeId: 'unknown' }];
  t.mock.method(f.adapter.state, 'save', () => { throw new Error('Synthetic local save failure'); });
  await assert.rejects(f.adapter.describe(f.local), /host recovery is required/);
  await assert.rejects(f.adapter.describe(f.local), /host recovery is required/);
  assert.equal(f.counts().creations, 1);
  assert.deepEqual(f.closedSessions, ['remote-1']);
});

test('failed configuration of an existing binding retains its session', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    modeError: { code: -32603, message: 'Mode change rejected' },
  });
  await f.adapter.describe(f.local);
  await assert.rejects(f.adapter.configure(f.local, '$mode', 'write'), /Mode change rejected/);
  assert.deepEqual(f.closedSessions, []);
  assert.equal(new State(f.config.stateDirectory).get(f.local.id).sessionId, 'remote-1');
  assert.equal(f.counts().creations, 1);
});

test('workspace policies reject wildcard, relative, invalid and duplicate declarations', () => {
  const valid = { cwd: '/tmp/video', agent: 'codex', permissionMode: 'approve-all', initialModeId: 'write' };
  assert.deepEqual(validateSessionPolicies(), []);
  for (const invalid of [{ ...valid, cwd: '*' }, { ...valid, agent: '*' }, { ...valid, permissionMode: 'bypass' }, { ...valid, initialModeId: '' }]) {
    assert.throws(() => validateSessionPolicies([invalid]), /Invalid workspace-scoped/);
  }
  assert.throws(() => validateSessionPolicies([valid, { ...valid, cwd: '/tmp/video/' }]), /Duplicate workspace-scoped/);
});

test('main session streams ACP output, surfaces approval, and retains remote identity', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const first = await collect(f.adapter, f.options('message-1'));
  assert.equal(first.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Hello ACP');
  assert.equal(first.at(-1).reason.kind, 'stop');
  assert.ok(!first.some(c => c.type === 'tool-call-delta'));
  await collect(f.adapter, f.options('message-2'));
  assert.deepEqual(f.counts(), { creations: 1, executions: 2, permissions: 2 });
  await assert.rejects(collect(f.adapter, { ...f.options('message-3'), model: 'grok-build' }), /matching Agent preset/);
});

test('full access allows ACP tool permissions without asking DSH approval', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const stateOf = f.ctx.sessionProjections.stateOf;
  f.ctx.sessionProjections.stateOf = (session, key) => key === 'sandboxMode' ? 'danger-full-access' : stateOf(session, key);
  await collect(f.adapter, f.options('message-1'));
  assert.deepEqual(f.permissionResults, [{ outcome: 'selected', optionId: 'once' }]);
  assert.equal(f.counts().permissions, 0);
});

test('reconnect replays missing output and reuses the prompt id without duplicate execution', { timeout: 5000 }, async t => {
  const f = await fixture(t, true);
  const output = await collect(f.adapter, f.options('message-1'));
  assert.equal(output.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Hello ACP');
  assert.deepEqual(f.counts(), { creations: 1, executions: 1, permissions: 1 });
});

const secretCanary = 'SYNTHETIC_SECRET_CANARY_NOT_REAL';
const authCanary = 'https://example.invalid/authorize?token=SYNTHETIC_AUTH_CANARY_NOT_REAL';
const providerFailure = (data, message = 'Internal error') => ({ code: -32603, message, data });

for (const [label, error, category, providerCode] of [
  ['native quota cause', providerFailure({ codexErrorInfo: 'usageLimitExceeded', message: secretCanary, additionalDetails: authCanary }), 'quota', 'usageLimitExceeded'],
  ['known nested cause', providerFailure({ cause: { codexErrorInfo: 'usageLimitExceeded', message: secretCanary } }), 'quota', 'usageLimitExceeded'],
  ['untrusted aborted code with quota cause', providerFailure({ code: 'ABORTED', codexErrorInfo: 'usageLimitExceeded' }), 'quota', 'usageLimitExceeded'],
  ['untrusted aborted code alone', providerFailure({ code: 'ABORTED' }), 'unknown', undefined],
  ['rate limit', providerFailure({ codexErrorInfo: 'rateLimitExceeded', message: secretCanary }), 'rate_limit', 'rateLimitExceeded'],
  ['session budget', providerFailure({ codexErrorInfo: 'sessionBudgetExceeded' }), 'budget', 'sessionBudgetExceeded'],
  ['authentication', providerFailure({ codexErrorInfo: 'unauthorized', additionalDetails: authCanary }), 'auth', 'unauthorized'],
  ['unknown provider code', providerFailure({ codexErrorInfo: 'unknownSyntheticCode', message: secretCanary }), 'unknown', undefined],
  ['quota prose alone', providerFailure({ message: `quota rate budget ${secretCanary}` }), 'unknown', undefined],
  ['internal error alone', providerFailure(undefined), 'unknown', undefined],
  ['conflicting structured codes', providerFailure({ codexErrorInfo: 'usageLimitExceeded', code: 'unauthorized' }), 'unknown', undefined],
  ['unrelated nested code', providerFailure({ arbitrary: { codexErrorInfo: 'usageLimitExceeded' } }), 'unknown', undefined],
  ['auth link alone', providerFailure({ message: authCanary }), 'unknown', undefined],
]) {
  test(`ACP adapter sanitizes actual RPC ${label} and does not resubmit it`, { timeout: 5000 }, async t => {
    const f = await fixture(t, false, 'permission', async () => {}, [], { error });
    let failure;
    await assert.rejects(collect(f.adapter, f.options(`safe-${label}`)), value => { failure = value; return value instanceof Error; });
    assert.ok(failure instanceof LlmError);
    assert.equal(failure.category, category);
    assert.equal(failure.providerCode, providerCode);
    assert.equal(failure.outcomeUnknown, false);
    assert.equal(typeof failure.retryable, 'boolean');
    assert.match(failure.operationId, /^dsh-[a-f0-9]{64}$/);
    assert.equal(failure.data, undefined);
    assert.equal(failure.cause, undefined);
    assert.deepEqual(safeFields(failure), {
      category, retryable: failure.retryable, outcomeUnknown: false, origin: failure.origin,
      operationId: failure.operationId, ...(providerCode ? { providerCode } : {}),
    });
    const ordinaryLog = `${failure.stack} ${JSON.stringify(failure)}`;
    for (const canary of [secretCanary, authCanary, 'unknownSyntheticCode']) assert.ok(!ordinaryLog.includes(canary));
    assert.deepEqual(f.counts(), { creations: 1, executions: 1, permissions: 0 });
  });
}

test('transport loss after prompt delivery is safe and explicitly uncertain when reconnects are exhausted', { timeout: 5000 }, async t => {
  const f = await fixture(t, true);
  f.config.reconnectAttempts = 0;
  await assert.rejects(collect(f.adapter, f.options('uncertain-delivery')), error => {
    assert.equal(error.category, 'unknown');
    assert.equal(error.origin, 'transport');
    assert.equal(error.outcomeUnknown, true);
    assert.match(error.operationId, /^dsh-/);
    assert.equal(error.data, undefined);
    return true;
  });
  assert.equal(f.counts().executions, 1);
});

test('the owned service direct RequestError data preserves canonical safe fields with the local request identity', { timeout: 5000 }, async t => {
  const safe = toSafeError({ code: -32603, data: { codexErrorInfo: 'usageLimitExceeded' } },
    { operationId: 'synthetic-service-operation', outcomeUnknown: true });
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    error: { code: -32000, message: safe.message, data: { ...safe, retryable: true } },
  });
  await assert.rejects(collect(f.adapter, f.options('owned-projection')), error => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.category, 'quota');
    assert.equal(error.providerCode, 'usageLimitExceeded');
    assert.equal(error.origin, 'acp');
    assert.equal(error.retryable, true);
    assert.equal(error.outcomeUnknown, true);
    assert.match(error.operationId, /^dsh-[a-f0-9]{64}$/);
    assert.notEqual(error.operationId, 'synthetic-service-operation');
    assert.equal(error.data, undefined);
    assert.equal(error.retryable, true);
    assert.equal(error.outcomeUnknown, true);
    assert.equal(error.operationId, error.operationId);
    return true;
  });
  assert.equal(f.counts().executions, 1);
});

for (const [category, outcomeUnknown] of [['quota', false], ['auth', false], ['unknown', true]]) {
  test(`a closing response socket preserves canonical ${category} outcomeUnknown=${outcomeUnknown}`, { timeout: 5000 }, async t => {
    const safe = toSafeError(undefined, { trustedProjection: true });
    const projected = { ...safe, category, origin: 'acp', outcomeUnknown, retryable: false,
      operationId: 'synthetic-service-operation' };
    const f = await fixture(t, false, 'permission', async () => {}, [], {
      error: { code: -32000, message: secretCanary, data: { ...projected, raw: authCanary } },
    });
    const link = await f.adapter.connection(f.local);
    let closing = false;
    // Close the real client socket in the error frame's event turn, before the
    // SDK's pending rejection resumes the adapter. The RPC error stays genuine.
    link.ws.on('message', raw => {
      if (JSON.parse(raw.toString()).error?.code === -32000) { closing = true; link.ws.close(); }
    });
    await assert.rejects(collect(f.adapter, f.options(`closing-response-${category}`)), error => {
      assert.ok(error instanceof LlmError);
      assert.equal(closing, true);
      assert.notEqual(link.ws.readyState, 1);
      assert.equal(error.category, category);
      assert.equal(error.origin, 'acp');
      assert.equal(error.outcomeUnknown, outcomeUnknown);
      assert.match(error.operationId, /^dsh-[a-f0-9]{64}$/);
      for (const canary of [secretCanary, authCanary, 'synthetic-service-operation']) {
        assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(canary));
      }
      return true;
    });
    assert.equal(f.counts().executions, 1);
  });
}

for (const [label, raw, origin, outcomeUnknown] of [
  ['quota', { data: { codexErrorInfo: 'usageLimitExceeded' } }, 'acp', false],
  ['auth', { data: { codexErrorInfo: 'unauthorized' } }, 'acp', false],
  ['uncertain transport', undefined, 'transport', true],
]) {
  test(`local abort does not mask the owned service ${label} rejection`, { timeout: 5000 }, async t => {
    const controller = new AbortController();
    const safe = toSafeError(raw, { origin, outcomeUnknown, operationId: 'synthetic-service-operation' });
    const f = await fixture(t, false, 'permission', async () => {}, [], {
      error: { code: -32000, message: secretCanary, data: { ...safe, raw: authCanary } },
      beforeError: () => controller.abort(new Error('SYNTHETIC_CANCEL_SECRET_NOT_REAL')),
    });
    await assert.rejects(collect(f.adapter, { ...f.options(`racing-${label}`), signal: controller.signal }), error => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.category, safe.category);
      assert.equal(error.providerCode, safe.providerCode);
      assert.equal(error.origin, origin);
      assert.equal(error.outcomeUnknown, outcomeUnknown);
      assert.match(error.operationId, /^dsh-[a-f0-9]{64}$/);
      for (const canary of [secretCanary, authCanary, 'SYNTHETIC_CANCEL_SECRET_NOT_REAL', 'synthetic-service-operation']) {
        assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(canary));
      }
      return true;
    });
    assert.equal(f.counts().executions, 1);
  });
}

test('native safe-shaped and nested category metadata cannot spoof the adapter projection', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    error: providerFailure({ message: secretCanary, category: 'quota', providerCode: 'usageLimitExceeded', origin: 'a2a', retryable: true,
      outcomeUnknown: true, operationId: 'SYNTHETIC_OPERATION_SECRET_NOT_REAL', cause: { category: 'quota' } }),
  });
  await assert.rejects(collect(f.adapter, f.options('untrusted-projection')), error => {
    assert.equal(error.category, 'unknown');
    assert.equal(error.retryable, false);
    assert.equal(error.outcomeUnknown, false);
    assert.equal(error.origin, 'acp');
    assert.match(error.operationId, /^dsh-[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(error).includes('SYNTHETIC_OPERATION_SECRET'));
    assert.ok(!JSON.stringify(error).includes(secretCanary));
    return true;
  });
});

test('malformed owned-service error data falls back to the raw numerical wrapper', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    error: { code: -32000, message: secretCanary, data: { category: 'quota', origin: 'a2a',
      operationId: 'SYNTHETIC_OPERATION_SECRET_NOT_REAL', cause: { category: 'quota' } } },
  });
  await assert.rejects(collect(f.adapter, f.options('malformed-projection')), error => {
    assert.equal(error.category, 'unknown');
    assert.equal(error.origin, 'acp');
    assert.equal(error.retryable, false);
    assert.equal(error.outcomeUnknown, false);
    assert.match(error.operationId, /^dsh-[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(error).includes('SYNTHETIC_'));
    return true;
  });
});

test('a known pending native writer keeps a fixed actionable message without provider restoration text', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    importError: { code: -32000, message: `SYNTHETIC_RESTORE_SECRET_NOT_REAL ${authCanary}` },
  });
  f.config.reconnectAttempts = 0;
  const endpoint = new URL('/agents/codex', f.config.serviceUrl); endpoint.protocol = 'ws:';
  new State(f.config.stateDirectory).save(f.local.id, {
    agent: 'codex', cwd: f.local.session.header.cwd, endpoint: endpoint.href, restoreMethod: 'session/resume',
    imported: { provider: 'codex', nativeSessionId: 'synthetic-native-session', messageIds: [] },
  });
  await assert.rejects(collect(f.adapter, f.options('pending-writer')), error => {
    assert.match(error.message, /active writer/);
    assert.equal(error.category, 'unknown');
    assert.equal(error.outcomeUnknown, false);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes('SYNTHETIC_RESTORE_SECRET'));
    assert.ok(!JSON.stringify(error).includes(authCanary));
    assert.equal(error.data, undefined);
    return true;
  });
  assert.deepEqual(f.counts(), { creations: 0, executions: 0, permissions: 0 });
});

const textUpdate = (text, messagePhase, messageId) => ({
  sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
  _meta: { '1agents': { messagePhase, messageId } },
});
const promptResult = (finalAnswer, stopReason = 'end_turn') => ({ stopReason, _meta: { '1agents': { finalAnswer } } });

test('ACP progress, tools and final messages keep durable identities across replay without repeating final output', { timeout: 5000 }, async t => {
  const finalAnswer = 'First final block. Second final block.';
  const f = await fixture(t, true, 'permission', async () => {}, [], {
    updates: [
      textUpdate('I will ', 'commentary', 'progress-1'), textUpdate('read README.', 'commentary', 'progress-1'),
      { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read README', kind: 'read', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: 'README content' },
      textUpdate('First final ', 'final_answer', 'final-1'), textUpdate('block.', 'final_answer', 'final-1'),
      textUpdate(' Second final block.', 'final_answer', 'final-2'),
    ],
    result: promptResult(finalAnswer),
  });
  f.local.session.boundary = { lastTurn: 7, lastStepStartSeq: 3 };
  f.local.session.eventAt = () => ({ type: 'step/start', data: { turn: 7, step: 2 } });
  const chunks = await collect(f.adapter, f.options('phased-answer'));
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), `I will read README.${finalAnswer}`);
  const blocks = JSON.parse(JSON.stringify(chunks.filter(c => c.type === 'block-end').map(c => c.block)));
  const visible = blocks.filter(b => b.text);
  assert.deepEqual(visible.map(b => [b.text, b.acpStream.messagePhase, b.acpStream.messageId]), [
    ['I will read README.', 'commentary', 'progress-1'],
    ['First final block.', 'final_answer', 'final-1'],
    [' Second final block.', 'final_answer', 'final-2'],
  ]);
  assert.ok(visible.every(b => b.acpStream.turn === 7 && b.acpStream.step === 2 && b.acpStream.requestId.startsWith('dsh-')));
  const terminals = blocks.filter(b => b.acpResult);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].text, '');
  assert.deepEqual(terminals[0].acpResult, { turn: 7, step: 2, requestId: visible[0].acpStream.requestId, finalAnswer });
  assert.equal(chunks.at(-1).type, 'finish');
  assert.ok(chunks.at(-2).block.acpResult);
  assert.deepEqual(f.counts(), { creations: 1, executions: 1, permissions: 1 });
});

test('a terminal answer missing from the phased stream is displayed once after progress, including after replay', { timeout: 5000 }, async t => {
  for (const disconnect of [false, true]) {
    for (const finalAnswer of ['Only the final report', '']) {
      const f = await fixture(t, disconnect, 'permission', async () => {}, [], {
        updates: [textUpdate('Preparing the task.', 'commentary', 'progress')], result: promptResult(finalAnswer),
      });
      const chunks = await collect(f.adapter, f.options(`terminal-${finalAnswer}`));
      assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), `Preparing the task.${finalAnswer}`);
      const visible = chunks.filter(c => c.type === 'block-end' && c.block.text);
      assert.deepEqual(visible.map(c => c.block.acpStream.messagePhase), finalAnswer ? ['commentary', 'final_answer'] : ['commentary']);
      assert.equal(chunks.filter(c => c.block?.acpResult).length, 1);
      assert.equal(chunks.find(c => c.block?.acpResult).block.acpResult.finalAnswer, finalAnswer);
      assert.deepEqual(f.counts(), { creations: 1, executions: 1, permissions: 1 });
    }
  }
});

test('an unphased legacy stream keeps its existing transcript without appending a terminal answer twice', { timeout: 5000 }, async t => {
  const f = await fixture(t, true, 'permission', async () => {}, [], { result: promptResult('Hello ACP') });
  const chunks = await collect(f.adapter, f.options('legacy-terminal'));
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Hello ACP');
  assert.equal(chunks.filter(c => c.type === 'block-end' && c.block.text).length, 1);
  assert.equal(chunks.find(c => c.block?.acpResult).block.acpResult.finalAnswer, 'Hello ACP');
});

test('an unknown producer phase stays unphased and does not append another terminal copy', { timeout: 5000 }, async t => {
  const f = await fixture(t, true, 'permission', async () => {}, [], {
    updates: [textUpdate('Legacy final answer', 'vendor_hint', 'legacy')], result: promptResult('Legacy final answer'),
  });
  const chunks = await collect(f.adapter, f.options('unknown-phase'));
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Legacy final answer');
  const visible = chunks.find(c => c.type === 'block-end' && c.block.text).block;
  assert.equal(visible.acpStream.messagePhase, undefined);
  assert.equal(visible.acpStream.messageId, 'legacy');
});

test('a terminal-only answer is displayed once and recorded before finish', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'permission', async () => {}, [], { updates: [], result: promptResult('Restored final answer') });
  const chunks = await collect(f.adapter, f.options('terminal-only'));
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Restored final answer');
  assert.equal(chunks.find(c => c.block?.text === 'Restored final answer').block.acpStream.messagePhase, 'final_answer');
  assert.equal(chunks.filter(c => c.block?.acpResult).length, 1);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('confirmed remote cancellation rejects through the official host error with owned plugin fields path', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'permission', async () => {}, [], { result: promptResult('Partial answer', 'cancelled') });
  const chunks = [];
  await assert.rejects(async () => { for await (const chunk of f.adapter.stream(f.options('remote-cancelled'))) chunks.push(chunk); }, error => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, 'ABORTED');
    assert.deepEqual(safeFields(error), {
      category: 'cancelled', retryable: false, outcomeUnknown: false, origin: 'acp', operationId: error.operationId,
    });
    assert.match(error.operationId, /^dsh-[a-f0-9]{64}$/);
    return true;
  });
  assert.equal(chunks.find(c => c.block?.acpResult).block.acpResult.finalAnswer, 'Partial answer');
  assert.ok(!chunks.some(chunk => chunk.type === 'finish'));
  assert.equal(f.counts().executions, 1);
});

for (const [stopReason, origin] of [['cancelled', 'acp'], ['end_turn', 'dsh'], ['max_tokens', 'dsh']]) {
  test(`confirmed ${stopReason} reply racing local abort stays certain without post-abort metadata`, { timeout: 5000 }, async t => {
    const controller = new AbortController();
    const postAbortAnswer = 'SYNTHETIC_POST_ABORT_ANSWER_NOT_REAL';
    const f = await fixture(t, false, 'permission', async () => {}, [], { result: promptResult(postAbortAnswer, stopReason) });
    const link = await f.adapter.connection(f.local);
    let confirmed = false;
    // Abort in the genuine result frame's event turn, before the SDK resumes the
    // adapter. Earlier streamed text remains open to expose post-abort block-end.
    link.ws.on('message', raw => {
      if (JSON.parse(raw.toString()).result?.stopReason === stopReason) {
        confirmed = true;
        controller.abort(new Error('SYNTHETIC_CANCEL_SECRET_NOT_REAL'));
      }
    });
    const chunks = [];
    await assert.rejects(async () => {
      for await (const chunk of f.adapter.stream({ ...f.options('confirmed-local-race'), signal: controller.signal })) {
        chunks.push({ chunk, afterAbort: controller.signal.aborted });
      }
    }, error => {
      assert.equal(confirmed, true);
      assert.ok(error instanceof LlmError);
      assert.deepEqual(safeFields(error), {
        category: 'cancelled', retryable: false, outcomeUnknown: false, origin, operationId: error.operationId,
      });
      assert.match(error.operationId, /^dsh-[a-f0-9]{64}$/);
      assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes('SYNTHETIC_CANCEL_SECRET'));
      return true;
    });
    assert.equal(chunks.filter(entry => entry.chunk.type === 'text-delta').map(entry => entry.chunk.text).join(''), 'Hello ACP');
    assert.ok(!chunks.some(entry => entry.afterAbort));
    assert.ok(!JSON.stringify(chunks).includes(postAbortAnswer));
    assert.ok(!chunks.some(entry => entry.chunk.block?.acpResult || entry.chunk.type === 'finish'));
    assert.equal(f.counts().executions, 1);
  });
}

test('a pre-delivery local abort has no uncertain native outcome or leaked reason', async t => {
  const f = await fixture(t), controller = new AbortController();
  controller.abort(new Error('SYNTHETIC_CANCEL_SECRET_NOT_REAL'));
  await assert.rejects(collect(f.adapter, { ...f.options('before-delivery'), signal: controller.signal }), error => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.category, 'cancelled');
    assert.equal(error.outcomeUnknown, false);
    assert.equal(error.origin, 'dsh');
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes('SYNTHETIC_CANCEL_SECRET'));
    return true;
  });
  assert.deepEqual(f.counts(), { creations: 0, executions: 0, permissions: 0 });
});

test('a peer cancellation rejection after local abort stays typed and conservative', async t => {
  const controller = new AbortController();
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    error: { code: -32800, message: secretCanary, data: { raw: authCanary } },
    beforeError: () => controller.abort(new Error('SYNTHETIC_CANCEL_SECRET_NOT_REAL')),
  });
  await assert.rejects(collect(f.adapter, { ...f.options('peer-cancel'), signal: controller.signal }), error => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.category, 'cancelled');
    assert.equal(error.outcomeUnknown, true);
    assert.equal(error.origin, 'dsh');
    for (const canary of [secretCanary, authCanary, 'SYNTHETIC_CANCEL_SECRET_NOT_REAL']) {
      assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(canary));
    }
    return true;
  });
  assert.equal(f.counts().executions, 1);
});

for (const [stopReason, finishKind] of [['max_tokens', 'max-tokens']]) {
  test(`terminal metadata does not turn ACP ${stopReason} into success`, { timeout: 5000 }, async t => {
    const f = await fixture(t, false, 'permission', async () => {}, [], { result: promptResult('Partial answer', stopReason) });
    const chunks = await collect(f.adapter, f.options(stopReason));
    assert.equal(chunks.at(-1).reason.kind, finishKind);
    assert.equal(chunks.find(c => c.block?.acpResult).block.acpResult.finalAnswer, 'Partial answer');
  });
}

test('remote tool updates are durable observations, retain omitted fields, and never pollute reasoning or execute locally', { timeout: 5000 }, async t => {
  const updates = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspect the directory.' } },
    { sessionUpdate: 'tool_call', toolCallId: 'exec-1', title: 'ls -la', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls -la' }, _meta: { '1agents': { toolName: 'Bash' } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', content: [{ type: 'content', content: { type: 'text', text: 'README.md' } }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'completed', rawOutput: 'README.md' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'completed' },
    { sessionUpdate: 'tool_call', toolCallId: 'exec-2', title: 'Read missing file', kind: 'read', status: 'pending', rawInput: { path: '/missing' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-2', status: 'failed', rawOutput: 'File missing' },
  ];
  const f = await fixture(t, true, 'permission', async () => {}, updates);
  f.local.session.boundary = { lastTurn: 3, lastStepStartSeq: 10 };
  f.local.session.eventAt = () => ({ type: 'step/start', data: { turn: 3, step: 2 } });
  const chunks = await collect(f.adapter, f.options('tools-1'));
  assert.equal(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), 'Inspect the directory.');
  assert.ok(!chunks.some(c => c.type === 'tool-call-delta' || c.block?.type === 'tool-call'));
  const observations = chunks.filter(c => c.type === 'block-end' && c.block.acpTool).map(c => c.block.acpTool);
  assert.equal(observations.length, 6); // Replay did not duplicate any observation.
  assert.ok(observations.every(e => e.turn === 3 && e.step === 2));
  const completed = observations[3].tool;
  assert.equal(completed.title, 'ls -la');
  assert.equal(completed.name, 'Bash');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.rawInput, { command: 'ls -la' });
  assert.equal(completed.content[0].content.text, 'README.md');
  assert.equal(observations.at(-1).tool.status, 'failed');
  assert.deepEqual(f.counts(), { creations: 1, executions: 1, permissions: 1 });
  const next = await collect(f.adapter, f.options('tools-2'));
  assert.notEqual(observations[0].requestId, next.find(c => c.block?.acpTool).block.acpTool.requestId);
  assert.ok(chunks.filter(c => c.block?.acpTool).every(c => c.block.type === 'text' && c.block.text === ''));
});

test('binding survives a new adapter instance', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await collect(f.adapter, f.options('message-1'));
  const state = new State(f.config.stateDirectory);
  assert.equal(state.get('dsh-session').sessionId, 'remote-1');
  assert.equal(state.get('different-session'), undefined);
  await f.adapter.dispose();
  const restored = new AcpAdapter(f.ctx, f.config);
  try { await collect(restored, f.options('message-2')); assert.equal(f.counts().creations, 1); }
  finally { await restored.dispose(); }
});

test('workspace policy never changes the native mode of an existing session', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.adapter.describe(f.local);
  assert.equal(f.counts().creations, 1);
  await f.adapter.dispose();
  f.config.sessionPolicies = validateSessionPolicies([{ cwd: f.local.session.header.cwd, agent: 'codex', permissionMode: 'approve-all', initialModeId: 'write' }]);
  const restored = new AcpAdapter(f.ctx, f.config);
  try {
    await restored.describe(f.local);
    assert.equal(f.counts().creations, 1);
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 0);
  } finally { await restored.dispose(); }
});

test('Grok questions and plan review use DSH interactions', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'question');
  const result = await collect(f.adapter, f.options('message-1'));
  assert.equal(result.at(-1).reason.kind, 'stop');
});

test('stopping while permission is pending retains the confirmed terminal reply', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'pending');
  const controller = new AbortController();
  const link = await f.adapter.connection(f.local);
  let receivedEndTurn = false;
  link.ws.on('message', raw => {
    if (JSON.parse(raw.toString()).result?.stopReason === 'end_turn') receivedEndTurn = true;
  });
  const output = collect(f.adapter, { ...f.options('message-1'), signal: controller.signal });
  await f.waiting;
  controller.abort(new Error('SYNTHETIC_CANCEL_SECRET_NOT_REAL'));
  await assert.rejects(output, error => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, 'ABORTED');
    assert.equal(error.category, 'cancelled');
    assert.equal(receivedEndTurn, true);
    assert.equal(error.outcomeUnknown, false);
    assert.equal(error.origin, 'dsh');
    assert.match(error.operationId, /^dsh-[a-f0-9]{64}$/);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes('SYNTHETIC_CANCEL_SECRET'));
    return true;
  });
  await f.cancelled;
});

test('connection loss withdraws the old approval and presents the replayed request', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'reconnect-permission');
  const result = await collect(f.adapter, f.options('message-1'));
  assert.equal(result.at(-1).reason.kind, 'stop');
  assert.equal(result.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Hello ACP');
  assert.deepEqual(f.counts(), { creations: 1, executions: 1, permissions: 2 });
});

test('ACP routes are absent from the model catalog and cannot run under a standard preset', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.listModels('1agents-acp'), []);
  f.local.session.header.agentPreset = 'standard';
  assert.equal(await f.adapter.describe(f.local), null);
  await assert.rejects(collect(f.adapter, f.options('message-1')), /matching Agent preset/);
  assert.equal(f.counts().creations, 0);
});

test('only user-authored messages reach ACP, excluding DSH instructions and runtime context', async t => {
  const f = await fixture(t);
  const options = f.options('message-1');
  options.messages.push({ id: 'injected', role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'DSH injected instructions' }] });
  options.messages.push({ id: 'runtime', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'DSH runtime context' }] });
  await collect(f.adapter, options);
  assert.deepEqual(f.prompts, [[{ type: 'text', text: 'hello' }]]);
});

test('native commands, models and modes are discovered before prompting and stay session-local', async t => {
  const f = await fixture(t);
  const info = await f.adapter.describe(f.local);
  assert.equal(info.configOptions[0].currentValue, 'native-a');
  assert.equal(info.commands[0].name, 'review');
  assert.ok(!f.commands.has('model'));
  await f.commands.get('review').handler({ rawInput: '  current changes' });
  assert.equal(f.sent[0].content[0].text, '/review  current changes');
  assert.equal(f.sent[0].source.kind, 'user');
  const updated = await f.adapter.configure(f.local, 'native-model', 'native-b');
  assert.equal(updated.configOptions[0].currentValue, 'native-b');
  assert.ok(f.commands.has('status'));
  assert.ok(!f.commands.has('review'));
  assert.equal((await f.adapter.configure(f.local, '$mode', 'write')).modes.currentModeId, 'write');
  await collect(f.adapter, f.options('message-1'));
  assert.equal(f.counts().creations, 1);
  assert.deepEqual(f.changes.map(c => c.sessionId), ['remote-1', 'remote-1']);
});

test('pinned settings stay with their own agent and a changed catalog fails before prompting', async t => {
  const grokModes = { currentModeId: 'acceptEdits', availableModes: [{ id: 'acceptEdits', name: 'Accept Edits' }, { id: 'bypassPermissions', name: 'Always Approve' }] };
  const codexModes = { currentModeId: 'read', availableModes: [{ id: 'read', name: 'Read' }, { id: 'write', name: 'Write' }] };
  const grokModel = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'grok-2', options: [{ group: 'Grok', name: 'Grok', options: [{ value: 'grok-2', name: 'Grok 2' }, { value: 'grok-2-mini', name: 'Mini' }] }] };
  const grokEffort = { id: 'reasoningEffort', name: 'Reasoning', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] };
  const codexModel = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'codex-mini', options: [{ value: 'codex-mini', name: 'Mini' }, { value: 'codex-max', name: 'Max' }] };
  const codexVerbosity = { id: 'verbosity', name: 'Verbosity', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] };
  let dropGrokEffort = false;
  const catalog = agentName => agentName === 'codex'
    ? [structuredClone(codexModel), structuredClone(codexVerbosity)]
    : [structuredClone(grokModel), structuredClone(dropGrokEffort ? { ...grokEffort, options: [{ value: 'low', name: 'Low' }] } : grokEffort)];
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    onNew: ({ sessionId, agentName }) => ({ sessionId, configOptions: catalog(agentName), modes: agentName === 'codex' ? codexModes : grokModes }),
    onConfig: ({ params, agentName }) => ({ configOptions: catalog(agentName).map(option => option.id === params.configId ? { ...option, currentValue: params.value } : option) }),
  });
  const agents = new Map([[f.local.id, f.local]]);
  f.ctx.agents.get = id => agents.get(id);
  const spawn = (id, preset) => {
    const agent = { id, session: { header: { cwd: f.local.session.header.cwd, agentPreset: preset }, boundary: { openTurnStartSeq: null, lastTurn: 0 } }, ctx: f.local.ctx, followup: f.local.followup };
    agents.set(id, agent);
    return agent;
  };
  const grok = spawn('dsh-grok', 'oneagents-acp-grok-build');
  await f.adapter.describe(grok);
  await f.adapter.configure(grok, 'reasoningEffort', 'high');
  await f.adapter.configure(grok, 'model', 'grok-2-mini');
  await f.adapter.configure(grok, '$mode', 'bypassPermissions');
  const codex = spawn('dsh-codex', 'oneagents-acp-codex');
  await f.adapter.describe(codex);
  await f.adapter.configure(codex, 'verbosity', 'high');
  await f.adapter.configure(codex, 'model', 'codex-max');
  await f.adapter.configure(codex, '$mode', 'write');
  f.changes.length = 0;
  f.config.sessionPolicies = validateSessionPolicies([{ cwd: f.local.session.header.cwd, agent: 'grok-build', initialModeId: 'acceptEdits' }]);
  const replayGrok = spawn('dsh-grok-next', 'oneagents-acp-grok-build');
  await f.adapter.describe(replayGrok);
  assert.deepEqual(f.changes.map(change => [change.configId ?? change.modeId, change.value ?? change.modeId]), [
    ['model', 'grok-2-mini'], ['reasoningEffort', 'high'], ['bypassPermissions', 'bypassPermissions'],
  ]);
  await f.adapter.describe(replayGrok);
  assert.equal(f.changes.length, 3);
  const replayCodex = spawn('dsh-codex-next', 'oneagents-acp-codex');
  await f.adapter.describe(replayCodex);
  assert.deepEqual(f.changes.slice(3).map(change => change.configId ?? change.modeId), ['model', 'verbosity', 'write']);
  assert.equal(f.prompts.length, 0);
  dropGrokEffort = true;
  const mismatched = spawn('dsh-grok-mismatch', 'oneagents-acp-grok-build');
  await assert.rejects(f.adapter.describe(mismatched), /Pinned ACP option "reasoningEffort" value "high" is not advertised by grok-build/);
  assert.equal(f.prompts.length, 0);
  assert.equal(new State(f.config.stateDirectory).get(mismatched.id), undefined);
  assert.ok(f.closedSessions.includes('remote-' + f.counts().creations));
});

test('unstarted sessions switch ACP agents and replace native commands', async t => {
  const f = await fixture(t);
  f.local.session.header.agentPreset = 'oneagents-acp-grok-build';
  await f.adapter.describe(f.local);
  await f.adapter.configure(f.local, 'native-model', 'native-b');
  assert.ok(f.commands.has('status'));
  f.local.session.header.agentPreset = 'oneagents-acp-codex';
  assert.equal((await f.adapter.describe(f.local)).agent, 'codex');
  assert.ok(!f.commands.has('status'));
  assert.ok(f.commands.has('review'));
  await collect(f.adapter, f.options('first-message'));
  assert.deepEqual(f.counts(), { creations: 2, executions: 1, permissions: 1 });
  assert.equal(new State(f.config.stateDirectory).get(f.local.id).agent, 'codex');
});

test('started sessions reject a different ACP binding', async t => {
  const f = await fixture(t);
  await collect(f.adapter, f.options('first-message'));
  f.local.session.boundary.lastTurn = 1;
  f.local.session.header.agentPreset = 'oneagents-acp-grok-build';
  await assert.rejects(f.adapter.describe(f.local), /bound to another ACP/);
  assert.equal(f.counts().creations, 1);
});

test('switching while discovery is pending serializes the replacement connection', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, false, 'permission', async () => { entered.resolve(); await release.promise; });
  f.local.session.header.agentPreset = 'oneagents-acp-grok-build';
  const first = f.adapter.describe(f.local);
  await entered.promise;
  f.local.session.header.agentPreset = 'oneagents-acp-codex';
  const second = f.adapter.describe(f.local);
  release.resolve();
  await first;
  assert.equal((await second).agent, 'codex');
  await collect(f.adapter, f.options('first-message'));
  assert.deepEqual(f.counts(), { creations: 2, executions: 1, permissions: 1 });
});

test('draft switching preserves endpoint protection and requires known turn state', async t => {
  const f = await fixture(t);
  await f.adapter.describe(f.local);
  f.local.session.header.agentPreset = 'oneagents-acp-grok-build';
  f.local.session.boundary = undefined;
  await assert.rejects(f.adapter.describe(f.local), /bound to another ACP/);
  f.local.session.boundary = { openTurnStartSeq: null, lastTurn: 0 };
  const state = new State(f.config.stateDirectory);
  state.save(f.local.id, { ...state.get(f.local.id), endpoint: 'ws://other.example/agents/codex' });
  await assert.rejects(f.adapter.describe(f.local), /bound to another ACP/);
  assert.equal(f.counts().creations, 1);
});

test('diagnostics bind only messages admitted in the current official turn, excluding older failed inputs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-acp-diagnostic-turn-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { diagnostics } = await diagnosticsFixture(t, directory);
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    diagnostics, error: providerFailure({ codexErrorInfo: 'usageLimitExceeded' }),
  });
  const old = f.options('old-message').messages[0]; old.source.rpcId = 'old-request';
  const current = f.options('current-message').messages[0]; current.source.rpcId = 'current-request';
  f.local.session.boundary = { openTurnStartSeq: 5, lastTurn: 2 };
  f.local.session.snapshotEvents = () => [
    { type: 'user/message', seq: 1, data: old }, { type: 'turn/start', seq: 5, data: { turn: 2 } },
    { type: 'user/message', seq: 6, data: current },
  ];
  await assert.rejects(collect(f.adapter, { ...f.options('unused'), messages: [old, current] }));
  assert.equal(diagnostics.find(f.local.id, 'old-request'), undefined);
  assert.equal(diagnostics.find(f.local.id, 'current-request').category, 'quota');
});

test('a saved binding reattaches with its restore method and the same ACP session', async t => {
  for (const method of ['session/load', 'session/resume']) {
    const f = await fixture(t);
    const endpoint = new URL('/agents/codex', f.config.serviceUrl);
    endpoint.protocol = 'ws:';
    new State(f.config.stateDirectory).save(f.local.id, {
      agent: 'codex', cwd: f.local.session.header.cwd, endpoint: endpoint.href,
      sessionId: 'remote-kept', restoreMethod: method,
    });
    await collect(f.adapter, f.options('again'));
    assert.equal(f.counts().creations, 0);
    assert.deepEqual(f.attaches, [{ method, sessionId: 'remote-kept' }]);
    assert.equal(new State(f.config.stateDirectory).get(f.local.id).sessionId, 'remote-kept');
  }
});

test('a deleted ACP session is not replaced with session/new', async t => {
  const f = await fixture(t, false, 'permission', async () => {}, [], {
    loadError: { code: -32003, message: 'Session was deleted' },
  });
  const endpoint = new URL('/agents/codex', f.config.serviceUrl);
  endpoint.protocol = 'ws:';
  new State(f.config.stateDirectory).save(f.local.id, {
    agent: 'codex', cwd: f.local.session.header.cwd, endpoint: endpoint.href,
    sessionId: 'remote-kept', restoreMethod: 'session/load',
  });
  await assert.rejects(collect(f.adapter, f.options('again')), error => {
    assert.equal(error.code, 'SESSION_DELETED');
    assert.match(error.message, /Session was deleted/);
    return true;
  });
  assert.equal(f.counts().creations, 0);
  assert.deepEqual(f.attaches.map(item => item.method), ['session/load']);
});

test('release keeps the binding and delete reaches a detached session without reattaching it', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await collect(f.adapter, f.options('message-1'));
  assert.deepEqual(await f.adapter.sessionStatus('dsh-session'), { attached: true, activeTurn: false });
  assert.deepEqual(await f.adapter.releaseSession('dsh-session'), { processReleased: 'pending', acp: true });
  assert.deepEqual(f.closedSessions, ['remote-1']);
  assert.deepEqual(await f.adapter.sessionStatus('dsh-session'), { attached: false, activeTurn: false });
  const attaches = f.attaches.length;
  assert.deepEqual(await f.adapter.deleteSession('dsh-session'), { processReleased: true, acp: true });
  assert.deepEqual(f.deletedSessions, ['remote-1']);
  assert.equal(f.attaches.length, attaches);
  await assert.rejects(f.adapter.deleteSession('missing'), error => error.code === 'SESSION_NOT_FOUND');
});
