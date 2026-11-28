import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { RemoteAgentGateway } from '../src/a2a/gateway.js';
import { createA2AServer } from '../src/a2a/server.js';
import { A2ADispatchRejectedError, type A2ABackend, type A2APrepareInput, type A2ARunResult, type A2ATarget } from '../src/a2a/types.js';
import {
  assertCrossModelFamily,
  classifyFallbackTrigger,
  extractModelFamily,
  normalizeRoleRouting,
  RoutingInvariantError,
  selectDispatchCandidate,
  verifyRoutingCanaryGate,
} from '../src/roles/routing.js';
import { checkGate, writeCrEvalReport } from '../src/rsi/gate.js';
import { loadCrEvalManifest, scoreCrEvalSuite, type CrEvalCase, type CrReviewResult } from '../src/rsi/pr-cr-eval.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const prDeliveryRoleDir = join(repoRoot, '.1agents/roles/pr-delivery');

class RouteAwareBackend implements A2ABackend {
  readonly checkedRoutes: { provider?: string; model?: string }[] = [];
  readonly executedRoutes: { provider?: string; model?: string; prompt: string }[] = [];
  rejectMode: 'quota_429' | 'http_503' | 'auth_401' | 'none' = 'none';
  rejectModel = 'grok/grok-4.7@500k';

  async checkRouteAvailability(input: { provider?: string; model?: string }): Promise<void> {
    this.checkedRoutes.push({ provider: input.provider, model: input.model });
    if (input.model !== this.rejectModel || this.rejectMode === 'none') return;
    if (this.rejectMode === 'quota_429') {
      throw new A2ADispatchRejectedError(429, 'ACCOUNT_QUOTA', 'quota', `HTTP 429 ACCOUNT_QUOTA exhausted on ${input.model}`);
    }
    if (this.rejectMode === 'http_503') {
      throw new A2ADispatchRejectedError(503, 'HTTP_503', 'http_5xx', `HTTP 503 Service Unavailable on ${input.model}`);
    }
    if (this.rejectMode === 'auth_401') {
      throw new A2ADispatchRejectedError(401, 'HTTP_401', 'http_429', 'HTTP 401 Unauthorized');
    }
  }

  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    return {
      sessionId: input.sessionId ?? `sess-${Math.random().toString(36).slice(2)}`,
      cwd: input.cwd!,
      agentPreset: input.agentPreset,
      provider: input.provider,
      model: input.model,
    };
  }

  async run(target: A2ATarget, prompt: string): Promise<A2ARunResult> {
    this.executedRoutes.push({ provider: target.provider, model: target.model, prompt });
    return { outcome: 'completed', text: `completed on ${target.model ?? 'default'}` };
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  return `http://127.0.0.1:${addr.port}`;
}

async function stop(server: Server): Promise<void> {
  const done = new Promise<void>(r => server.close(() => r()));
  server.closeAllConnections();
  await done;
}

function passingResultFor(kase: CrEvalCase): CrReviewResult {
  if (kase.kind === 'positive') return { caseId: kase.id, verdict: 'PASS', must: [] };
  return {
    caseId: kase.id,
    verdict: 'CHANGES_REQUESTED',
    must: (kase.requiredDefects ?? []).map(d => ({
      id: d.id, file: d.anyFilePatterns[0], summary: `${d.description} ${d.anyTextPatterns[0]}`,
    })),
  };
}

test('routing v2 schema, model family single-source assertion (M3), cross-family invariant, and strict fallback classification (S3)', async () => {
  const raw = JSON.parse(await readFile(join(prDeliveryRoleDir, 'routing.json'), 'utf8')) as unknown;
  const normalized = normalizeRoleRouting(raw);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.worker.primary.model, 'grok/grok-4.7@500k');
  assert.equal(normalized.reviewer.primary.model, 'group/deepseek-v4.1');
  assert.ok(normalized.worker.fallbacks.length >= 2);
  assert.ok(normalized.reviewer.fallbacks.length >= 2);

  // V1 backward compatibility.
  const v1 = normalizeRoleRouting({
    schemaVersion: 1,
    worker: { provider: 'magpie-responses', model: 'grok/grok-4.7@500k', deliveryMode: 'workspace_git' },
    reviewer: { provider: 'magpie', model: 'group/deepseek-v4.1', deliveryMode: 'none', readOnly: true },
  });
  assert.equal(v1.worker.primary.model, 'grok/grok-4.7@500k');
  assert.deepEqual(v1.worker.fallbacks, []);

  // M3: Forged `family` field contradicting `model` MUST fail closed with INVALID_MODEL_FAMILY!
  assert.throws(
    () => extractModelFamily({ provider: 'magpie', model: 'anthropic/claude-sonnet-4.5', family: 'grok' }),
    (err: unknown) => err instanceof RoutingInvariantError && err.code === 'INVALID_MODEL_FAMILY',
  );
  assert.throws(
    () => assertCrossModelFamily(
      { provider: 'magpie', model: 'anthropic/claude-sonnet-4.5', family: 'grok' },
      { provider: 'magpie', model: 'anthropic/claude-opus-4.5', family: 'deepseek' },
    ),
    (err: unknown) => err instanceof RoutingInvariantError && err.code === 'INVALID_MODEL_FAMILY',
  );
  assert.throws(
    () => normalizeRoleRouting({
      schemaVersion: 2,
      worker: {
        primary: { provider: 'magpie', model: 'anthropic/claude-sonnet-4.5', deliveryMode: 'workspace_git', family: 'grok' },
        fallbacks: [],
      },
      reviewer: {
        primary: { provider: 'magpie', model: 'anthropic/claude-opus-4.5', deliveryMode: 'none', readOnly: true, family: 'deepseek' },
        fallbacks: [],
      },
    }),
    (err: unknown) => err instanceof RoutingInvariantError && err.code === 'INVALID_MODEL_FAMILY',
  );

  // Model family extraction defeats provider/group aliases.
  assert.equal(extractModelFamily({ provider: 'magpie', model: 'group/deepseek-v4.1' }), 'deepseek');
  assert.equal(extractModelFamily({ provider: 'direct', model: 'deepseek/deepseek-r1' }), 'deepseek');
  assert.equal(extractModelFamily({ provider: 'magpie', model: 'anthropic/claude-sonnet-4.5' }), 'claude');
  assert.throws(
    () => assertCrossModelFamily(
      { provider: 'magpie', model: 'deepseek/deepseek-r1' },
      { provider: 'magpie', model: 'group/deepseek-v4.1' },
    ),
    (err: unknown) => err instanceof RoutingInvariantError && err.code === 'SAME_MODEL_FAMILY',
  );

  // When actual worker used claude, reviewer fallback MUST skip claude and select gemini!
  const picked = selectDispatchCandidate({
    slot: {
      primary: { provider: 'magpie', model: 'anthropic/claude-opus-4.5', deliveryMode: 'none', readOnly: true },
      fallbacks: [
        { provider: 'magpie', model: 'google/gemini-2.5-pro', deliveryMode: 'none', readOnly: true },
      ],
      fallbackOn: ['quota', 'rate_limit', 'http_429', 'http_5xx', 'timeout'],
      maxFallbackDurationMs: 60_000,
    },
    attemptedKeys: new Set(),
    peerActualEndpoint: { provider: 'magpie', model: 'anthropic/claude-sonnet-4.5' },
  });
  assert.equal(picked.endpoint.model, 'google/gemini-2.5-pro');
  assert.equal(picked.skippedSameFamily.length, 1);

  // S3: Strict classification — structured/transport errors trigger; semantic text containing "quota" does NOT!
  assert.equal(classifyFallbackTrigger({ status: 429, message: 'Too Many Requests' }), 'http_429');
  assert.equal(classifyFallbackTrigger({ category: 'quota', message: 'quota exhausted' }), 'quota');
  assert.equal(classifyFallbackTrigger({ category: 'rate_limit', message: 'slow down' }), 'rate_limit');
  assert.equal(classifyFallbackTrigger({ status: 503, message: 'Service Unavailable' }), 'http_5xx');
  assert.equal(classifyFallbackTrigger(new Error('HTTP 504 Gateway Timeout')), 'http_5xx');
  assert.equal(classifyFallbackTrigger({ category: 'timeout', message: 'ETIMEDOUT' }), 'timeout');
  assert.equal(classifyFallbackTrigger({ status: 401, category: 'auth', message: 'Unauthorized' }), undefined);
  assert.equal(classifyFallbackTrigger({ status: 400, message: 'Bad Request' }), undefined);
  assert.equal(classifyFallbackTrigger(new Error('TypeError: undefined is not a function')), undefined);
  assert.equal(
    classifyFallbackTrigger({ message: 'validation failed: analysis quota of statements exceeded' }),
    undefined,
    'free-text semantic validation mentioning "quota" must NOT trigger dispatch fallback',
  );
});

test('real createA2AServer 429/quota admission rejection + production routingSlot auto-load + ledger route persistence + peerJobId cross-family + zero-orphan pre-validation (M1/M2/M4/M5)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'routing-v2-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remoteStateDir = join(dir, 'remote-a2a');
  const gatewayStateDir = join(dir, 'gateway');
  const workDir = join(dir, 'work');
  // Put real pr-delivery routing.json inside workDir/.1agents/roles/pr-delivery/routing.json!
  await mkdir(join(workDir, '.1agents', 'roles', 'pr-delivery'), { recursive: true });
  await cp(join(prDeliveryRoleDir, 'routing.json'), join(workDir, '.1agents', 'roles', 'pr-delivery', 'routing.json'));

  const backend = new RouteAwareBackend();
  const capacity = testCapacity(dir);
  let a2a: Awaited<ReturnType<typeof createA2AServer>>;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/.well-known/agent-card.json') {
      a2a.cardHandler(req, res);
      return;
    }
    void a2a.handler(req, res);
  });
  const remoteUrl = await listen(server);
  a2a = await createA2AServer({
    backend,
    capacity,
    publicUrl: remoteUrl,
    stateDirectory: remoteStateDir,
    token: 'remote-secret-token',
    defaultAgentPreset: 'standard',
  });
  t.after(async () => {
    await a2a.close();
    await stop(server);
  });

  const gateway = new RemoteAgentGateway({
    stateDirectory: gatewayStateDir,
    remotes: { drill: { url: remoteUrl, token: 'remote-secret-token' } },
    pollIntervalMs: 50,
    capacityDirectory: capacity.directory,
  });
  t.after(() => gateway.close());

  // M4: Invalid routingFallback (missing deliveryMode) MUST fail BEFORE ledger.prepare -> 0 orphan jobs!
  await assert.rejects(
    gateway.invoke('execution_submit', {
      originSessionId: 'origin-drill',
      targetId: 'legacy:drill',
      input: {
        cwd: workDir,
        prompt: 'Bad routing slot',
        agentPreset: 'standard',
        routingFallback: {
          slot: {
            primary: { provider: 'magpie', model: 'grok/grok-4.7@500k' }, // missing deliveryMode
            fallbacks: [],
          },
        },
      },
    }),
  );
  const afterInvalid = await gateway.invoke('execution_list', { originSessionId: 'origin-drill' }) as { jobs: unknown[] };
  assert.equal(afterInvalid.jobs.length, 0, 'invalid routingFallback must NOT leave an orphan/unknown attempt in the ledger');

  // M1 + M5: Production dispatch via `routingRoleId: 'pr-delivery'` + `routingSlot: 'worker'` (NO manual routingFallback!)
  // Real createA2AServer rejects grok with HTTP 429 ACCOUNT_QUOTA -> auto-switches to openai/gpt-5.2-codex in <60s!
  backend.rejectMode = 'quota_429';
  backend.rejectModel = 'grok/grok-4.7@500k';
  const startedAt = Date.now();
  const workerSubmitted = await gateway.invoke('execution_submit', {
    originSessionId: 'origin-drill',
    targetId: 'legacy:drill',
    input: {
      cwd: workDir,
      routingRoleId: 'pr-delivery',
      routingSlot: 'worker',
      prompt: 'Run PR implementation drill',
      agentPreset: 'standard',
    },
  }) as {
    jobId: string;
    attemptId: string;
    routing?: { selected: { model: string; deliveryMode?: string }; fallbacks: { from: string; to: string; trigger: string; elapsedMs: number }[]; elapsedMs: number };
  };
  const elapsedMs = Date.now() - startedAt;
  assert.ok(workerSubmitted.jobId);
  assert.ok(elapsedMs < 60_000, `429 fallback took ${elapsedMs}ms, must be < 60000ms`);
  assert.deepEqual(backend.checkedRoutes.map(r => r.model), ['grok/grok-4.7@500k', 'openai/gpt-5.2-codex']);
  assert.equal(workerSubmitted.routing?.selected.model, 'openai/gpt-5.2-codex');
  assert.equal(workerSubmitted.routing?.selected.deliveryMode, 'workspace_git');
  assert.equal(workerSubmitted.routing?.fallbacks.length, 1);
  assert.equal(workerSubmitted.routing?.fallbacks[0]?.trigger, 'http_429');

  // M2 + S2: execution_get durably returns actual executed route from ledger (NOT primary!)
  let workerView: { executionStatus: string; routing?: { selected: { model: string } } } | undefined;
  for (let i = 0; i < 40; i += 1) {
    workerView = await gateway.invoke('execution_get', { originSessionId: 'origin-drill', jobId: workerSubmitted.jobId }) as {
      executionStatus: string;
      routing?: { selected: { model: string } };
    };
    if (workerView.executionStatus === 'completed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(workerView?.routing?.selected.model, 'openai/gpt-5.2-codex', 'ledger execution_get must persist actual executed model');

  // Continuation preserves exact same jobId!
  const continued = await gateway.invoke('execution_continue', {
    originSessionId: 'origin-drill',
    jobId: workerSubmitted.jobId,
    input: { prompt: 'Follow-up turn on same jobId' },
  }) as { jobId: string; attemptId: string };
  assert.equal(continued.jobId, workerSubmitted.jobId);
  assert.notEqual(continued.attemptId, workerSubmitted.attemptId);

  // M2: Dispatch reviewer via `routingSlot: 'reviewer'` + `peerJobId: workerSubmitted.jobId`
  // Gateway reads Worker's actual route (`openai/gpt-5.2-codex`) from ledger; reviewer picks deepseek with deliveryMode='none' + readOnly=true!
  backend.checkedRoutes.length = 0;
  backend.rejectMode = 'none';
  const reviewerSubmitted = await gateway.invoke('execution_submit', {
    originSessionId: 'origin-drill',
    targetId: 'legacy:drill',
    input: {
      cwd: workDir,
      routingRoleId: 'pr-delivery',
      routingSlot: 'reviewer',
      peerJobId: workerSubmitted.jobId,
      prompt: 'Run independent read-only CR',
      agentPreset: 'standard',
    },
  }) as {
    jobId: string;
    routing?: { selected: { model: string; deliveryMode?: string; readOnly?: boolean } };
  };
  assert.equal(reviewerSubmitted.routing?.selected.model, 'group/deepseek-v4.1');
  assert.equal(reviewerSubmitted.routing?.selected.deliveryMode, 'none');
  assert.equal(reviewerSubmitted.routing?.selected.readOnly, true);

  // M2 + M4: If a reviewer slot ONLY offers candidates from the SAME model family as the actual worker in ledger,
  // dispatch MUST fail closed BEFORE ledger.prepare with SAME_MODEL_FAMILY and leave ZERO orphan jobs!
  const countBeforeSameFamily = (await gateway.invoke('execution_list', { originSessionId: 'origin-drill' }) as { jobs: unknown[] }).jobs.length;
  await assert.rejects(
    gateway.invoke('execution_submit', {
      originSessionId: 'origin-drill',
      targetId: 'legacy:drill',
      input: {
        cwd: workDir,
        prompt: 'Same-family reviewer must fail closed',
        agentPreset: 'standard',
        routingFallback: {
          slot: {
            primary: { provider: 'magpie', model: 'openai/gpt-5.2', deliveryMode: 'none', readOnly: true },
            fallbacks: [],
          },
          peerJobId: workerSubmitted.jobId, // actual worker ran openai/gpt-5.2-codex!
        },
      },
    }),
    (err: unknown) => err instanceof RoutingInvariantError && err.code === 'SAME_MODEL_FAMILY',
  );
  const countAfterSameFamily = (await gateway.invoke('execution_list', { originSessionId: 'origin-drill' }) as { jobs: unknown[] }).jobs.length;
  assert.equal(countAfterSameFamily, countBeforeSameFamily, 'SAME_MODEL_FAMILY failure must leave 0 orphan jobs');

  // Non-fallback HTTP 401 auth error must NOT switch to fallback!
  backend.checkedRoutes.length = 0;
  backend.rejectMode = 'auth_401';
  backend.rejectModel = 'grok/grok-4.7@500k';
  const authFailed = await gateway.invoke('execution_submit', {
    originSessionId: 'origin-drill',
    targetId: 'legacy:drill',
    input: {
      cwd: workDir,
      routingRoleId: 'pr-delivery',
      routingSlot: 'worker',
      prompt: 'Auth failure must not fallback',
      agentPreset: 'standard',
    },
  }) as { error?: string };
  assert.ok(authFailed.error, '401 must fail dispatch');
  assert.deepEqual(backend.checkedRoutes.map(r => r.model), ['grok/grok-4.7@500k'], '401 auth failure must NOT try fallback candidates');
});

test('verifyRoutingCanaryGate & checkGate enforce routing.json v2 invariants and digest-bound golden eval', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'routing-v2-canary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roleCopy = join(dir, 'pr-delivery');
  const workspace = join(dir, 'ws');
  await cp(prDeliveryRoleDir, roleCopy, { recursive: true });
  await mkdir(workspace, { recursive: true });

  // 1. Missing eval-cr.json blocks canary gate.
  const missing = await verifyRoutingCanaryGate({ roleDirectory: roleCopy, workspace, repoRoot });
  assert.equal(missing.ok, false);
  assert.ok(missing.reasons.some(r => r.includes('缺少绑定当前 routing.json')));

  // 2. Write fresh golden eval report bound to current routing.json -> both verifyRoutingCanaryGate and checkGate pass!
  const manifest = await loadCrEvalManifest(roleCopy);
  const results = manifest.cases.map(passingResultFor);
  const score = scoreCrEvalSuite(manifest, results);
  await writeCrEvalReport({ roleDirectory: roleCopy, workspace, results, score });

  const passed = await verifyRoutingCanaryGate({ roleDirectory: roleCopy, workspace, repoRoot });
  assert.equal(passed.ok, true, passed.reasons.join('; '));
  assert.equal(passed.promotionReady, true);

  // 3. Modifying routing.json invalidates evalDigest/roleDigest -> canary gate & checkGate block until re-run!
  const routingFile = join(roleCopy, 'routing.json');
  const mutated = JSON.parse(await readFile(routingFile, 'utf8')) as { worker: { fallbacks: unknown[] }; canary?: { required?: boolean; minCases?: number } };
  mutated.worker.fallbacks.pop();
  await writeFile(routingFile, JSON.stringify(mutated, null, 2));

  const stale = await verifyRoutingCanaryGate({ roleDirectory: roleCopy, workspace, repoRoot });
  assert.equal(stale.ok, false);
  assert.ok(stale.reasons.some(r => r.includes('已过期')));

  // 4. S1: checkGate rejects routing.json with canary.minCases > manifest.cases.length!
  mutated.canary = { required: true, minCases: 999 };
  await writeFile(routingFile, JSON.stringify(mutated, null, 2));
  const refreshedScore = scoreCrEvalSuite(manifest, results);
  await writeCrEvalReport({ roleDirectory: roleCopy, workspace, results, score: refreshedScore });
  const gateMinCases = await checkGate({ roleDirectory: roleCopy, workspace, repoRoot });
  assert.equal(gateMinCases.crEval?.status, 'failed');
  assert.ok(gateMinCases.reasons.some(r => r.includes('canary 要求至少 999 条黄金样本')));
});
