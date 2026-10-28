import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RemoteAgentGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import { createA2AServer } from '../src/a2a/server.js';
import type { A2ABackend, A2APrepareInput, A2APreflightInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';
import { AgentRegistry, AgentRegistryError, describeTaskDevelopment, projectWorkbenchAgents } from '../src/execution/agent-registry.js';
import { createHumanReview } from '../src/execution/human-review.js';
import { JobLedger } from '../src/execution/ledger.js';
import { createProcessRequest } from '../src/execution/process-request.js';
import { listWorkbenchAgents, listWorkbenchTasks, workbenchSnapshot } from '../src/execution/workbench.js';
import { testCapacity } from './capacity-fixture.js';

test('drafts stay per ACP agent until an explicit publish freezes that agent only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-registry-'));
  try {
    const registry = new AgentRegistry(root);
    const grok = registry.create({ name: '公众号草稿', acpAgent: 'grok-build', targetId: 'writer', modeId: 'bypassPermissions',
      options: [{ id: 'reasoningEffort', value: 'high' }, { id: 'model', value: 'grok-2', model: true }] });
    const codex = registry.create({ name: '审稿草稿', acpAgent: 'codex', targetId: 'reviewer', modeId: 'write',
      options: [{ id: 'verbosity', value: 'low' }, { id: 'model', value: 'codex-mini' }] });
    assert.equal(grok.options[0]!.id, 'model');
    assert.equal(grok.options[1]!.id, 'reasoningEffort');
    assert.deepEqual(registry.admit({ targetId: 'writer', kind: 'resident_agent', name: '文稿作者' }),
      { agentId: grok.agentId, name: '公众号草稿', phase: 'developing', channel: 'trial' });
    assert.equal(registry.admit({ targetId: 'reviewer', kind: 'agent_host', name: '审稿' })?.agentId, codex.agentId);
    assert.equal(registry.admit({ targetId: 'other', kind: 'agent_host', name: '临时' }), undefined);
    assert.throws(() => registry.create({ name: '公众号草稿', acpAgent: 'grok-build' }), (error: AgentRegistryError) => error.code === 'conflict');
    assert.throws(() => registry.create({ name: '坏选项', acpAgent: 'grok-build', options: [{ id: 'model', value: 'a' }, { id: 'model', value: 'b' }] }),
      (error: AgentRegistryError) => error.code === 'invalid');
    registry.update(grok.agentId, { modeId: 'acceptEdits', options: [{ id: 'model', value: 'grok-2-mini' }] });
    assert.equal(registry.snapshot().drafts.find(item => item.agentId === codex.agentId)?.modeId, 'write');
    assert.equal(registry.snapshot().drafts.find(item => item.agentId === codex.agentId)?.options[1]?.id, 'verbosity');
    assert.throws(() => registry.publish(grok.agentId, {}), (error: AgentRegistryError) => error.code === 'invalid');
    const release = registry.publish(grok.agentId, { releaseName: '公众号-grok' });
    assert.equal(release.modeId, 'acceptEdits');
    assert.deepEqual(release.options.map(option => option.value), ['grok-2-mini']);
    assert.equal(registry.snapshot().drafts.find(item => item.agentId === grok.agentId)?.targetId, undefined);
    assert.equal(registry.snapshot().drafts.find(item => item.agentId === codex.agentId)?.targetId, 'reviewer');
    assert.deepEqual(registry.admit({ targetId: 'writer', kind: 'resident_agent', name: '文稿作者' }),
      { agentId: 'release:公众号-grok', name: '公众号-grok', phase: 'published', channel: 'formal' });
    assert.throws(() => registry.publish(grok.agentId, { releaseName: '公众号-grok' }), /already exists/);
    registry.update(grok.agentId, { modeId: 'bypassPermissions', options: [{ id: 'model', value: 'grok-2' }, { id: 'reasoningEffort', value: 'low' }] });
    const replaced = registry.publish(grok.agentId, { releaseName: '公众号-grok', replace: true });
    assert.equal(replaced.modeId, 'bypassPermissions');
    assert.equal(replaced.options[1]!.value, 'low');
    assert.equal(registry.snapshot().releases.length, 1);
    const reloaded = new AgentRegistry(root);
    assert.equal(reloaded.snapshot().releases[0]?.releaseName, '公众号-grok');
    assert.equal(reloaded.snapshot().drafts.find(item => item.acpAgent === 'codex')?.options[0]?.value, 'codex-mini');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a corrupt registry is refused and an unstamped resident stays formal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-registry-bad-'));
  try {
    await writeFile(join(root, 'agent-registry.json'), '{"version":2,"drafts":[],"releases":[]}');
    assert.throws(() => new AgentRegistry(root));
    await writeFile(join(root, 'agent-registry.json'), '{');
    assert.throws(() => new AgentRegistry(root));
    const fresh = await mkdtemp(join(tmpdir(), 'agent-registry-empty-'));
    try { assert.deepEqual(new AgentRegistry(fresh).snapshot(), { drafts: [], releases: [] }); }
    finally { await rm(fresh, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
  const stamped = { channel: 'trial', phase: 'developing', agentId: 'agt-12345678', name: '公众号草稿' };
  assert.deepEqual(describeTaskDevelopment(stamped, { targetId: 'writer', resident: true, residentName: '常驻' }), stamped);
  assert.deepEqual(describeTaskDevelopment({ channel: 'formal' }, { targetId: 'writer', resident: true, residentName: '常驻' }),
    { channel: 'formal', phase: 'published', agentId: 'resident:writer', name: '常驻' });
  assert.deepEqual(describeTaskDevelopment(undefined, { targetId: 'legacy:host', resident: false }), { channel: 'standalone' });
});

test('trial and formal tasks share the pending queue and agent rows keep their own counts', () => {
  const ledger = new JobLedger(undefined, () => {});
  const trial = ledger.prepare({ originSessionId: 'root', title: '试跑一轮', input: { prompt: 'secret-prompt' }, targetSnapshot: {
    targetId: 'writer', targetKind: 'resident_agent', targetName: '文稿作者', cwd: '/secret/project',
    development: { channel: 'trial', phase: 'developing', agentId: 'agt-12345678', name: '公众号草稿' },
  } });
  ledger.markDispatching(trial.attempt.attemptId);
  ledger.accept(trial.attempt.attemptId, { taskId: 'trial-task', sessionId: 'trial-session' }, { executionStatus: 'working' });
  const formal = ledger.prepare({ originSessionId: 'root', title: '正式一轮', input: {}, targetSnapshot: {
    targetId: 'resident-role', targetKind: 'resident_agent', targetName: '常驻作者', roleId: 'writer-role',
  } });
  ledger.markDispatching(formal.attempt.attemptId);
  ledger.accept(formal.attempt.attemptId, { taskId: 'formal-task', sessionId: 'formal-session' }, { executionStatus: 'input_required' });
  const review = createHumanReview({ jobId: formal.job.jobId, attemptId: formal.attempt.attemptId, stage: 'summary', title: '正式稿',
    authorJobId: formal.job.jobId, authorAttemptId: formal.attempt.attemptId, authorSessionId: 'formal-session',
    reviewerId: 'owner', revision: 'v1', digest: 'a'.repeat(64),
    preview: { title: '正式', slides: Array.from({ length: 6 }, () => ({ title: '页', message: '事实', body: ['正文'], visual: '图', sources: ['README.md:1'], facts: ['事实'], notes: '' })) } });
  const request = createProcessRequest({ jobId: trial.job.jobId, attemptId: trial.attempt.attemptId, sessionId: 'trial-session', kind: 'question',
    questions: [{ id: '0', question: '用哪个模型？' }] });
  const snapshot = workbenchSnapshot({ ledger: ledger.snapshot(), runs: [], reviews: [review], processRequests: [request], actorId: 'owner' });
  const pending = listWorkbenchTasks(snapshot, { filter: 'pending' });
  assert.deepEqual(pending.items.map(item => item.channel).sort(), ['formal', 'trial']);
  assert.equal(pending.items.find(item => item.channel === 'trial')?.agentId, 'agt-12345678');
  assert.equal(pending.items.find(item => item.channel === 'formal')?.agentId, 'resident:resident-role');
  assert.equal(JSON.stringify({ ...snapshot, details: Object.fromEntries(Object.entries(snapshot.details).map(([id, { description: _d, ...rest }]) => [id, rest])) }).includes('secret-prompt'), false, 'only the description may carry the prompt');
  assert.equal(JSON.stringify(snapshot).includes('/secret/project'), false);
  const catalog = projectWorkbenchAgents({
    drafts: [{ agentId: 'agt-12345678', name: '公众号草稿', acpAgent: 'grok-build', targetId: 'writer', modeId: 'bypassPermissions', options: [{ id: 'model', value: 'grok-2', model: true }], updatedAt: '2026-10-27T00:00:00.000Z' }],
    releases: [],
    residents: [{ targetId: 'resident-role', name: '常驻作者', roleId: 'writer-role', agentPreset: 'oneagents-acp-grok-build' }, { targetId: 'writer', name: '被草稿占用', agentPreset: 'oneagents-acp-codex' }],
  }, snapshot.tasks);
  assert.equal(catalog.developing[0]?.pendingCount, 1);
  assert.equal(catalog.developing[0]?.taskCount, 1);
  assert.equal(catalog.published.find(row => row.agentId === 'resident:resident-role')?.pendingCount, 1);
  assert.equal(catalog.published.find(row => row.targetId === 'writer')?.taskCount, 0);
  assert.equal(catalog.published.find(row => row.targetId === 'writer')?.acpAgent, 'codex');
  assert.equal(catalog.published.find(row => row.agentId === 'resident:resident-role')?.acpAgent, 'grok-build');
  const listed = listWorkbenchAgents(snapshot, { drafts: [], releases: [] }, [{ targetId: 'resident-role', name: '常驻作者', roleId: 'writer-role' }]);
  assert.equal(listed.published[0]?.agentId, 'resident:resident-role');
});

class Backend implements A2ABackend {
  async preflight(input: A2APreflightInput) { return { ok: true, cwd: input.cwd, checkedAt: new Date().toISOString(), checks: [{ id: 'fixture-host', ok: true }] }; }
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    return { sessionId: input.sessionId ?? `session-${Math.random()}`, cwd: input.cwd!, agentPreset: input.agentPreset };
  }
  async run(_target: A2ATarget, _prompt: string): Promise<A2ARunResult> { return { text: 'done', outcome: 'completed' }; }
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('new calls follow the published name and a continuation keeps the trial stamp', async t => {
  const f = await gatewayFixture(t);
  const gateway = f.gateway();
  await gateway.invoke('execution_target_create', { targetId: 'writer', kind: 'resident_agent', name: '文稿作者', connectionId: 'remote:local', enabled: true,
    binding: { cwd: f.root, roleId: 'writer-role', agentPreset: 'oneagents-acp-grok-build' } });
  await gateway.invoke('execution_target_create', { targetId: 'reviewer', kind: 'resident_agent', name: '审稿', connectionId: 'remote:local', enabled: true,
    binding: { cwd: f.root, roleId: 'review-role', agentPreset: 'oneagents-acp-codex' } });
  const grok = gateway.agents.create({ name: '公众号草稿', acpAgent: 'grok-build', targetId: 'writer', modeId: 'bypassPermissions',
    options: [{ id: 'reasoningEffort', value: 'high' }, { id: 'model', value: 'grok-2' }] });
  const codex = gateway.agents.create({ name: '审稿草稿', acpAgent: 'codex', targetId: 'reviewer', modeId: 'write', options: [{ id: 'verbosity', value: 'low' }] });
  const trial = await gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'writer', input: { prompt: '试跑' } }) as { jobId: string; attemptId: string; error?: string };
  assert.equal(trial.error, undefined);
  assert.deepEqual(gateway.ledger.getAttempt(trial.attemptId).targetSnapshot.development, { agentId: grok.agentId, name: '公众号草稿', phase: 'developing', channel: 'trial' });
  const codexRun = await gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'reviewer', input: { prompt: '审稿试跑' } }) as { attemptId: string };
  assert.equal((gateway.ledger.getAttempt(codexRun.attemptId).targetSnapshot.development as { agentId: string }).agentId, codex.agentId);
  gateway.agents.publish(grok.agentId, { releaseName: '公众号-grok' });
  const formal = await gateway.invoke('execution_submit', { originSessionId: 'root', targetId: 'writer', clientRequestId: 'formal-1', input: { prompt: '正式' } }) as { jobId: string; attemptId: string; error?: string };
  assert.equal(formal.error, undefined);
  assert.equal((gateway.ledger.getAttempt(formal.attemptId).targetSnapshot.development as { channel: string }).channel, 'formal');
  assert.equal((gateway.ledger.getAttempt(formal.attemptId).targetSnapshot.development as { agentId: string }).agentId, 'release:公众号-grok');
  const continued = await gateway.invoke('execution_continue', { originSessionId: 'root', jobId: trial.jobId, clientRequestId: 'keep-trial', input: { prompt: '继续试跑' } }) as { attemptId: string; error?: string };
  assert.equal(continued.error, undefined);
  assert.deepEqual(gateway.ledger.getAttempt(continued.attemptId).targetSnapshot.development, { agentId: grok.agentId, name: '公众号草稿', phase: 'developing', channel: 'trial' });
  const detail = gateway.workbenchTask(trial.jobId);
  assert.equal(detail.channel, 'trial');
  assert.equal(detail.agentPhase, 'developing');
  assert.equal(gateway.workbenchTask(formal.jobId).channel, 'formal');
  assert.equal(JSON.stringify(gateway.workbenchAgents()).includes(f.root), false);
  const saved = await readFile(join(f.config.stateDirectory, 'agent-registry.json'), 'utf8');
  assert.equal(saved.includes(f.root), false);
  assert.equal(saved.includes('reasoningEffort'), true);
});

async function gatewayFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent-registry-gateway-'));
  const backend = new Backend();
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') host.cardHandler(req, res);
    else void host.handler(req, res);
  });
  const url = await listen(server);
  host = await createA2AServer({ backend, capacity: testCapacity(root), publicUrl: url, stateDirectory: join(root, 'host'), token: 'test-token' });
  const stateDirectory = join(root, 'client');
  const config: A2AGatewayConfig = { stateDirectory, port: 0, remotes: { local: { url, token: 'test-token' } }, pollIntervalMs: 60_000,
    workbench: { token: 'workbench-token', reviewerId: 'owner', allowedOrigins: ['root'] } };
  const gateways = new Set<RemoteAgentGateway>();
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    await host.close();
    const done = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await done;
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, gateway: () => { const gateway = new RemoteAgentGateway(config); gateways.add(gateway); return gateway; } };
}
