import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { RemoteAgentGateway } from '../src/a2a/gateway.js';
import { createA2AServer } from '../src/a2a/server.js';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';
import {
  assertCrossModelFamily,
  classifyFallbackTrigger,
  extractModelFamily,
  normalizeRoleRouting,
  RoutingInvariantError,
  selectDispatchCandidate,
  verifyRoutingCanaryGate,
} from '../src/roles/routing.js';
import { writeCrEvalReport } from '../src/rsi/gate.js';
import { loadCrEvalManifest, scoreCrEvalSuite, type CrEvalCase, type CrReviewResult } from '../src/rsi/pr-cr-eval.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const prDeliveryRoleDir = join(repoRoot, '.1agents/roles/pr-delivery');

class SimpleBackend implements A2ABackend {
  readonly seenRoutes: { provider?: string; model?: string; prompt: string }[] = [];
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    return { sessionId: input.sessionId ?? `sess-${Math.random().toString(36).slice(2)}`, cwd: input.cwd!, agentPreset: input.agentPreset };
  }
  async run(target: A2ATarget, prompt: string): Promise<A2ARunResult> {
    this.seenRoutes.push({ provider: target.provider, model: target.model, prompt });
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

test('routing v2 schema, model family normalization, cross-family hard invariant, and fallback trigger classification', async () => {
  // Real pr-delivery routing.json loads as v2 with primary + fallbacks[].
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

  // If ONLY same-family candidates exist, fail closed with SAME_MODEL_FAMILY.
  assert.throws(
    () => selectDispatchCandidate({
      slot: {
        primary: { provider: 'magpie', model: 'anthropic/claude-opus-4.5', deliveryMode: 'none', readOnly: true },
        fallbacks: [],
        fallbackOn: ['http_429'],
        maxFallbackDurationMs: 60_000,
      },
      attemptedKeys: new Set(),
      peerActualEndpoint: { provider: 'magpie', model: 'anthropic/claude-sonnet-4.5' },
    }),
    (err: unknown) => err instanceof RoutingInvariantError && err.code === 'SAME_MODEL_FAMILY',
  );

  // Trigger classification: 429 / quota / rate_limit / 5xx / timeout trigger; auth / 401 / 400 / semantic do NOT.
  assert.equal(classifyFallbackTrigger({ status: 429, message: 'Too Many Requests' }), 'http_429');
  assert.equal(classifyFallbackTrigger({ category: 'quota', message: 'quota exhausted' }), 'quota');
  assert.equal(classifyFallbackTrigger({ category: 'rate_limit', message: 'slow down' }), 'rate_limit');
  assert.equal(classifyFallbackTrigger({ status: 503, message: 'Service Unavailable' }), 'http_5xx');
  assert.equal(classifyFallbackTrigger(new Error('HTTP 504 Gateway Timeout')), 'http_5xx');
  assert.equal(classifyFallbackTrigger({ category: 'timeout', message: 'ETIMEDOUT' }), 'timeout');
  assert.equal(classifyFallbackTrigger({ status: 401, category: 'auth', message: 'Unauthorized' }), undefined);
  assert.equal(classifyFallbackTrigger({ status: 400, message: 'Bad Request' }), undefined);
  assert.equal(classifyFallbackTrigger(new Error('TypeError: undefined is not a function')), undefined);
});

test('429 injection drill on gateway auto-switches at dispatch boundary in <60s and continues on the exact same jobId', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'routing-v2-429-drill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remoteStateDir = join(dir, 'remote-a2a');
  const gatewayStateDir = join(dir, 'gateway');
  const workDir = join(dir, 'work');
  await mkdir(workDir, { recursive: true });

  const backend = new SimpleBackend();
  const capacity = testCapacity(dir);
  let a2a: Awaited<ReturnType<typeof createA2AServer>>;
  const attemptedModels: string[] = [];
  let injectStatus: number | undefined = 429;
  const proxyServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/.well-known/agent-card.json') {
      a2a.cardHandler(req, res);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks);
      const bodyStr = bodyBuf.toString('utf8');
      if (req.method === 'POST' && bodyStr) {
        try {
          const rpc = JSON.parse(bodyStr) as {
            method?: string;
            params?: {
              metadata?: { '1agents'?: { model?: string } };
              message?: { metadata?: { '1agents'?: { model?: string } } };
            };
          };
          const model = rpc.params?.metadata?.['1agents']?.model ?? rpc.params?.message?.metadata?.['1agents']?.model;
          if (model) {
            attemptedModels.push(model);
            if (model === 'grok/grok-4.7@500k' && injectStatus) {
              res.writeHead(injectStatus, { 'Content-Type': 'application/json' });
              const reason = injectStatus === 429 ? 'rate limit exceeded' : 'Unauthorized';
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: `HTTP ${injectStatus} ${reason} on ${model}` },
              }));
              return;
            }
          }
        } catch {
          // non-JSON request
        }
      }
      const forwarded = Object.assign(req, {
        async *[Symbol.asyncIterator]() { if (bodyBuf.length) yield bodyBuf; },
      });
      void a2a.handler(forwarded, res);
    });
  });
  const remoteUrl = await listen(proxyServer);
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
    await stop(proxyServer);
  });

  const gateway = new RemoteAgentGateway({
    stateDirectory: gatewayStateDir,
    remotes: { drill: { url: remoteUrl, token: 'remote-secret-token' } },
    pollIntervalMs: 50,
    capacityDirectory: capacity.directory,
  });
  t.after(() => gateway.close());

  const routing = normalizeRoleRouting(JSON.parse(await readFile(join(prDeliveryRoleDir, 'routing.json'), 'utf8')));
  const startedAt = Date.now();
  const submitted = await gateway.invoke('execution_submit', {
    originSessionId: 'origin-drill',
    targetId: 'legacy:drill',
    input: {
      cwd: workDir,
      prompt: 'Run PR implementation drill',
      agentPreset: 'standard',
      routingFallback: {
        slot: routing.worker,
        peerActualEndpoint: routing.reviewer.primary,
      },
    },
  }) as {
    jobId: string;
    attemptId: string;
    executionStatus: string;
    routing?: { selected: { model: string }; fallbacks: { from: string; to: string; trigger: string; elapsedMs: number }[]; elapsedMs: number };
  };
  const totalElapsedMs = Date.now() - startedAt;

  assert.ok(submitted.jobId, 'must return a durable jobId');
  assert.ok(totalElapsedMs < 60_000, `429 fallback took ${totalElapsedMs}ms, must be < 60000ms`);
  assert.deepEqual(attemptedModels, ['grok/grok-4.7@500k', 'openai/gpt-5.2-codex']);
  assert.equal(submitted.routing?.selected.model, 'openai/gpt-5.2-codex');
  assert.equal(submitted.routing?.fallbacks.length, 1);
  assert.equal(submitted.routing?.fallbacks[0]?.trigger, 'http_429');

  // Wait for completion and verify execution_continue keeps the EXACT SAME jobId!
  for (let i = 0; i < 40; i += 1) {
    const view = await gateway.invoke('execution_get', { originSessionId: 'origin-drill', jobId: submitted.jobId }) as { executionStatus: string };
    if (view.executionStatus === 'completed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  const continued = await gateway.invoke('execution_continue', {
    originSessionId: 'origin-drill',
    jobId: submitted.jobId,
    input: { prompt: 'Follow-up turn on same jobId' },
  }) as { jobId: string; attemptId: string };
  assert.equal(continued.jobId, submitted.jobId, 'continuation must preserve the exact same jobId');
  assert.notEqual(continued.attemptId, submitted.attemptId);

  // Non-fallback HTTP 401 auth error must NOT switch to fallback!
  attemptedModels.length = 0;
  injectStatus = 401;
  const authFailed = await gateway.invoke('execution_submit', {
    originSessionId: 'origin-drill',
    targetId: 'legacy:drill',
    input: {
      cwd: workDir,
      prompt: 'Auth failure must not fallback',
      agentPreset: 'standard',
      routingFallback: {
        slot: routing.worker,
        peerActualEndpoint: routing.reviewer.primary,
      },
    },
  }) as { error?: string };
  assert.ok(authFailed.error, '401 must fail dispatch');
  assert.deepEqual(attemptedModels, ['grok/grok-4.7@500k'], '401 auth failure must NOT try fallback candidates');
});

test('verifyRoutingCanaryGate blocks formal promotion when routing.json changes without fresh golden eval and passes after canary eval', async t => {
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

  // 2. Write fresh golden eval report bound to current routing.json -> canary gate passes!
  const manifest = await loadCrEvalManifest(roleCopy);
  const results = manifest.cases.map(passingResultFor);
  const score = scoreCrEvalSuite(manifest, results);
  await writeCrEvalReport({ roleDirectory: roleCopy, workspace, results, score });

  const passed = await verifyRoutingCanaryGate({ roleDirectory: roleCopy, workspace, repoRoot });
  assert.equal(passed.ok, true, passed.reasons.join('; '));
  assert.equal(passed.promotionReady, true);

  // 3. Modifying routing.json invalidates evalDigest/roleDigest -> canary gate blocks until re-run!
  const routingFile = join(roleCopy, 'routing.json');
  const mutated = JSON.parse(await readFile(routingFile, 'utf8')) as { worker: { fallbacks: unknown[] } };
  mutated.worker.fallbacks.pop();
  await writeFile(routingFile, JSON.stringify(mutated, null, 2));

  const stale = await verifyRoutingCanaryGate({ roleDirectory: roleCopy, workspace, repoRoot });
  assert.equal(stale.ok, false);
  assert.ok(stale.reasons.some(r => r.includes('已过期')));
});
