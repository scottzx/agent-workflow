/**
 * Routing v2 (`primary + fallbacks[]`), dispatch-boundary fallback policy,
 * hard cross-model-family invariant (`family(reviewer) !== family(actualWorker)`),
 * and canary golden-eval gate before promoting `routing.json` to `formal`.
 *
 * Backward compatible with Routing v1 (`{ schemaVersion: 1, worker, reviewer }`).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { computeRoleDigest } from '../rsi/calibrate.js';
import { crEvalReportPath } from '../rsi/gate.js';
import {
  coerceCrEvalResults,
  computeCrEvalDigest,
  findRepoRoot,
  loadCrEvalManifest,
  scoreCrEvalSuite,
  verifyCrEvalCommits,
  type CrEvalScore,
  type CrReviewResult,
} from '../rsi/pr-cr-eval.js';

export const FALLBACK_TRIGGER_KINDS = ['quota', 'rate_limit', 'http_429', 'http_5xx', 'timeout'] as const;
export type FallbackTriggerKind = (typeof FALLBACK_TRIGGER_KINDS)[number];
export const DEFAULT_MAX_FALLBACK_DURATION_MS = 60_000;

export const routingEndpointSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  deliveryMode: z.string().min(1),
  readOnly: z.boolean().optional(),
  family: z.string().min(1).optional(),
}).strict();
export type RoutingEndpoint = z.infer<typeof routingEndpointSchema>;

export const routingSlotV2Schema = z.object({
  primary: routingEndpointSchema,
  fallbacks: z.array(routingEndpointSchema).default([]),
  fallbackOn: z.array(z.enum(FALLBACK_TRIGGER_KINDS)).min(1).default([...FALLBACK_TRIGGER_KINDS]),
  maxFallbackDurationMs: z.number().int().min(1000).max(DEFAULT_MAX_FALLBACK_DURATION_MS).default(DEFAULT_MAX_FALLBACK_DURATION_MS),
}).strict();
export type RoutingSlotV2 = z.infer<typeof routingSlotV2Schema>;

export const roleRoutingV1Schema = z.object({
  schemaVersion: z.literal(1),
  worker: routingEndpointSchema,
  reviewer: routingEndpointSchema,
}).strict();
export type RoleRoutingV1 = z.infer<typeof roleRoutingV1Schema>;

export const roleRoutingV2Schema = z.object({
  schemaVersion: z.literal(2),
  worker: routingSlotV2Schema,
  reviewer: routingSlotV2Schema,
  canary: z.object({
    required: z.boolean().default(true),
    minCases: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();
export type RoleRoutingV2 = z.infer<typeof roleRoutingV2Schema>;

export const roleRoutingSchema = z.union([roleRoutingV1Schema, roleRoutingV2Schema]);
export type RoleRouting = z.infer<typeof roleRoutingSchema>;

export type RoutingErrorCode =
  | 'SAME_MODEL_FAMILY'
  | 'NO_ELIGIBLE_FALLBACK'
  | 'FALLBACK_BUDGET_EXCEEDED'
  | 'CANARY_GATE_FAILED';

export class RoutingInvariantError extends Error {
  constructor(readonly code: RoutingErrorCode, message: string) {
    super(message);
    this.name = 'RoutingInvariantError';
  }
}

/**
 * Normalize model family so cross-model CR invariant cannot be bypassed by provider aliases
 * (e.g. `group/deepseek-v4.1` and `deepseek/deepseek-r1` both normalize to `deepseek`).
 */
export function extractModelFamily(endpoint: Pick<RoutingEndpoint, 'provider' | 'model' | 'family'>): string {
  if (endpoint.family?.trim()) return endpoint.family.trim().toLowerCase();
  const raw = endpoint.model.trim().toLowerCase();
  const known: [RegExp, string][] = [
    [/\bdeepseek\b|deepseek/, 'deepseek'],
    [/\bgrok\b|grok/, 'grok'],
    [/\bclaude\b|claude|anthropic/, 'claude'],
    [/\bgpt\b|gpt-|openai|codex|\bo[134]\b/, 'openai'],
    [/\bgemini\b|gemini|google/, 'gemini'],
    [/\bqwen\b|qwen/, 'qwen'],
    [/\bllama\b|llama|meta/, 'llama'],
    [/\bglm\b|glm-/, 'glm'],
    [/\bkimi\b|moonshot/, 'kimi'],
  ];
  for (const [pattern, family] of known) {
    if (pattern.test(raw)) return family;
  }
  const parts = raw.split('/').filter(Boolean);
  const head = parts[0] === 'group' && parts.length > 1 ? parts[1]! : parts[0]!;
  return head.split(/[-_@:]/)[0] || raw;
}

/** Hard invariant: reviewer model family MUST differ from actual worker model family. */
export function assertCrossModelFamily(
  worker: Pick<RoutingEndpoint, 'provider' | 'model' | 'family'>,
  reviewer: Pick<RoutingEndpoint, 'provider' | 'model' | 'family'>,
): void {
  const workerFamily = extractModelFamily(worker);
  const reviewerFamily = extractModelFamily(reviewer);
  if (workerFamily === reviewerFamily) {
    throw new RoutingInvariantError(
      'SAME_MODEL_FAMILY',
      `Cross-model-family invariant violated: reviewer (${reviewer.provider}/${reviewer.model}, family=${reviewerFamily}) matches actual worker (${worker.provider}/${worker.model}, family=${workerFamily})`,
    );
  }
}

/** Normalize Routing v1 or v2 into canonical v2 form and validate the primary cross-family invariant. */
export function normalizeRoleRouting(raw: unknown): RoleRoutingV2 {
  const parsed = roleRoutingSchema.parse(raw);
  const normalized: RoleRoutingV2 = parsed.schemaVersion === 2
    ? parsed
    : {
        schemaVersion: 2,
        worker: {
          primary: parsed.worker,
          fallbacks: [],
          fallbackOn: [...FALLBACK_TRIGGER_KINDS],
          maxFallbackDurationMs: DEFAULT_MAX_FALLBACK_DURATION_MS,
        },
        reviewer: {
          primary: parsed.reviewer,
          fallbacks: [],
          fallbackOn: [...FALLBACK_TRIGGER_KINDS],
          maxFallbackDurationMs: DEFAULT_MAX_FALLBACK_DURATION_MS,
        },
        canary: { required: true },
      };
  assertCrossModelFamily(normalized.worker.primary, normalized.reviewer.primary);
  return normalized;
}

export function endpointKey(endpoint: Pick<RoutingEndpoint, 'provider' | 'model'>): string {
  return `${endpoint.provider}\0${endpoint.model}`;
}

/**
 * Dispatch-boundary-only fallback trigger classifier.
 * Matches ONLY `quota` / `rate_limit` / HTTP 429 / HTTP 5xx / timeout errors.
 * Auth (401/403), client 4xx (400/404), conflict, and mid-execution semantic failures return `false`.
 */
export function classifyFallbackTrigger(
  failure: unknown,
  allowedTriggers: readonly FallbackTriggerKind[] = FALLBACK_TRIGGER_KINDS,
): FallbackTriggerKind | undefined {
  const allowed = new Set(allowedTriggers);
  const record = failure && typeof failure === 'object' ? (failure as Record<string, unknown>) : undefined;
  const status = typeof record?.status === 'number'
    ? record.status
    : (typeof record?.statusCode === 'number' ? record.statusCode : undefined);
  const category = typeof record?.category === 'string' ? record.category.toLowerCase() : undefined;
  const code = typeof record?.code === 'string' ? record.code.toUpperCase() : undefined;
  const detailCode = typeof record?.detailCode === 'string' ? record.detailCode.toUpperCase() : undefined;
  const message = failure instanceof Error
    ? failure.message
    : (typeof record?.message === 'string' ? record.message : (typeof failure === 'string' ? failure : ''));

  // Explicit non-fallback client/auth categories or HTTP 400/401/403/404 fail closed immediately.
  if (
    category === 'auth'
    || category === 'invalid_request'
    || category === 'validation'
    || status === 400 || status === 401 || status === 403 || status === 404
    || code === 'AUTH' || code === 'HTTP_401' || code === 'HTTP_403' || code === 'HTTP_400'
    || /\b(?:http[_\s-]*)?40[0134]\b/i.test(message)
  ) {
    return undefined;
  }

  if (status === 429 || code === 'HTTP_429' || detailCode === 'HTTP_429' || /\b(?:http[_\s-]*)?429\b/i.test(message)) {
    if (allowed.has('http_429')) return 'http_429';
    if (allowed.has('rate_limit')) return 'rate_limit';
  }
  if (category === 'quota' || code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || detailCode === 'QUOTA' || detailCode === 'ACCOUNT_QUOTA' || /\bquota\b/i.test(message)) {
    if (allowed.has('quota')) return 'quota';
  }
  if (category === 'rate_limit' || code === 'RATE_LIMIT' || detailCode === 'RATE_LIMIT' || /\brate[_\s-]?limit/i.test(message)) {
    if (allowed.has('rate_limit')) return 'rate_limit';
  }
  if ((status !== undefined && status >= 500 && status <= 599)
    || (code && /^HTTP_5\d\d$/.test(code))
    || (detailCode && /^HTTP_5\d\d$/.test(detailCode))
    || /\b(?:http[_\s-]*)?5(?:0[0-9]|1[0-1])\b/i.test(message)) {
    if (allowed.has('http_5xx')) return 'http_5xx';
  }
  if (category === 'timeout' || code === 'TIMEOUT' || code === 'ETIMEDOUT' || code === 'ABORT_ERR' || code === 'HTTP_408' || code === 'HTTP_504'
    || /\b(?:timed?\s*out|etimedout|timeout|econnreset)\b/i.test(message)) {
    if (allowed.has('timeout')) return 'timeout';
  }
  return undefined;
}

/**
 * Pick the next eligible dispatch candidate (`primary` then `fallbacks[]`), skipping already-attempted
 * routes and strictly rejecting any candidate whose model family collides with `peerActualEndpoint`.
 */
export function selectDispatchCandidate(options: {
  slot: RoutingSlotV2;
  attemptedKeys: ReadonlySet<string>;
  peerActualEndpoint?: Pick<RoutingEndpoint, 'provider' | 'model' | 'family'>;
}): { endpoint: RoutingEndpoint; index: number; skippedSameFamily: string[] } {
  const candidates = [options.slot.primary, ...options.slot.fallbacks];
  const peerFamily = options.peerActualEndpoint ? extractModelFamily(options.peerActualEndpoint) : undefined;
  const skippedSameFamily: string[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const key = endpointKey(candidate);
    if (options.attemptedKeys.has(key)) continue;
    const candidateFamily = extractModelFamily(candidate);
    if (peerFamily && candidateFamily === peerFamily) {
      skippedSameFamily.push(`${candidate.provider}/${candidate.model} (family=${candidateFamily})`);
      continue;
    }
    return { endpoint: candidate, index, skippedSameFamily };
  }

  if (skippedSameFamily.length > 0) {
    throw new RoutingInvariantError(
      'SAME_MODEL_FAMILY',
      `All remaining fallback candidates collide with peer model family "${peerFamily}": ${skippedSameFamily.join(', ')}`,
    );
  }
  throw new RoutingInvariantError('NO_ELIGIBLE_FALLBACK', 'All routing primary and fallback candidates have been exhausted');
}

export interface RoutingCanaryGateResult {
  ok: boolean;
  roleId: string;
  routingDigest: string;
  evalDigest: string;
  roleDigest: string;
  promotionReady: boolean;
  score?: CrEvalScore;
  reasons: string[];
}

export function computeRoutingDigest(routing: RoleRouting): string {
  return createHash('sha256').update(JSON.stringify(routing)).digest('hex');
}

/**
 * Canary golden-eval gate required before promoting a modified `routing.json` to `formal`.
 * Validates routing v2 schema, hard cross-model-family invariant, manifest commit ancestry,
 * and in-process golden CR evaluation bound to current `evalDigest` (which covers `routing.json`) & `roleDigest`.
 */
export async function verifyRoutingCanaryGate(options: {
  roleDirectory: string;
  workspace?: string;
  repoRoot?: string;
  canaryResults?: CrReviewResult[];
}): Promise<RoutingCanaryGateResult> {
  const roleDirectory = path.resolve(options.roleDirectory);
  const rawRouting = JSON.parse(await readFile(path.join(roleDirectory, 'routing.json'), 'utf8')) as unknown;
  const normalized = normalizeRoleRouting(rawRouting);
  const routingDigest = computeRoutingDigest(normalized);

  const reasons: string[] = [];
  const manifest = await loadCrEvalManifest(roleDirectory);
  const evalDigest = await computeCrEvalDigest(roleDirectory);
  const roleDigest = await computeRoleDigest(roleDirectory);
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : await findRepoRoot(roleDirectory);

  const commitCheck = await verifyCrEvalCommits(manifest, repoRoot);
  if (!commitCheck.ok) {
    reasons.push(`Canary 黄金集提交核验未通过：${commitCheck.errors.join('；')}`);
  }

  let resultsToScore: CrReviewResult[] | undefined = options.canaryResults;
  if (!resultsToScore) {
    if (!options.workspace) {
      reasons.push('修改 routing.json 晋升 formal 前须先通过 canary 黄金回放（未提供 canaryResults 或 workspace）');
      return { ok: false, roleId: manifest.roleId, routingDigest, evalDigest, roleDigest, promotionReady: false, reasons };
    }
    const reportFile = crEvalReportPath(options.workspace, manifest.roleId);
    try {
      const saved = JSON.parse(await readFile(reportFile, 'utf8')) as {
        evalDigest?: string;
        roleDigest?: string;
        results?: unknown;
      };
      if (saved.evalDigest !== evalDigest || saved.roleDigest !== roleDigest) {
        reasons.push('Canary 黄金回放结果已过期（routing.json 变更导致 evalDigest/roleDigest 不匹配），请对新路由重跑黄金回放');
        return { ok: false, roleId: manifest.roleId, routingDigest, evalDigest, roleDigest, promotionReady: false, reasons };
      }
      resultsToScore = coerceCrEvalResults(saved.results);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reasons.push(`缺少绑定当前 routing.json 的 canary 黄金回放报告（${detail}）`);
      return { ok: false, roleId: manifest.roleId, routingDigest, evalDigest, roleDigest, promotionReady: false, reasons };
    }
  }

  const score = scoreCrEvalSuite(manifest, resultsToScore);
  if (!score.promotionReady) {
    reasons.push(`Canary 黄金回放未达标（negativeRecall=${score.negativeRecall}，falsePositives=${score.falsePositives}，missing=${score.missingCases.length}）`);
  }

  const ok = reasons.length === 0 && commitCheck.ok && score.promotionReady;
  return {
    ok,
    roleId: manifest.roleId,
    routingDigest,
    evalDigest,
    roleDigest,
    promotionReady: ok,
    score,
    reasons,
  };
}
