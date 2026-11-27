/**
 * Dual-ceiling Rubric calibration (Cohen's kappa, Krippendorff's alpha, Spearman's rho)
 * and digest binding for role `rubric.json`.
 *
 * Policy floors (cannot be lowered by the rubric being calibrated):
 * - POLICY_AUTO_ALPHA = 0.80
 * - POLICY_ADVISE_ALPHA = 0.67
 * - POLICY_MIN_AUTO_SAMPLES = 40 (counted over usable judge-vs-gold paired units)
 *
 * Dual-ceiling 3-band rule:
 * - `effectiveAlpha` requires a real `alpha_gold_vs_judge` (at least 2 usable judge-gold pairs);
 *   when `alpha_human_ceiling` is also available, `effectiveAlpha = min(alpha_human_ceiling, alpha_gold_vs_judge)`.
 * - `auto`:   effectiveAlpha >= bands.auto (>= 0.80) AND n >= 40
 * - `advise`: effectiveAlpha >= bands.advise (>= 0.67) AND (effectiveAlpha < bands.auto OR n < 40)
 * - `split`:  effectiveAlpha === null OR effectiveAlpha < bands.advise
 *
 * Enforcement invariant:
 * - ONLY `band === 'auto'` `must` criteria meeting their optional `gate.minAlpha` may auto-block (`canAutoBlock = true`).
 * - `advise` is advisory-only (`canAutoBlock = false`).
 * - `split` emits a mandatory split/rewrite warning (`action = 'split_or_rewrite'`, `canAutoBlock = false`).
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export type RubricBand = 'auto' | 'advise' | 'split';

export const POLICY_AUTO_ALPHA = 0.8;
export const POLICY_ADVISE_ALPHA = 0.67;
export const POLICY_MIN_AUTO_SAMPLES = 40;

const SAFE_ROLE_ID = /^[A-Za-z0-9._-]+$/;

const rubricCriterionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  polarity: z.enum(['positive', 'negative']).optional(),
  weight: z.number().optional(),
  severity: z.enum(['must', 'should']).optional(),
  scale: z.object({
    type: z.enum(['binary', 'ordinal']),
    min: z.number().optional(),
    max: z.number().optional(),
  }).passthrough(),
  gate: z.object({
    mode: z.enum(['observe', 'advise', 'block']).optional(),
    minAlpha: z.number().min(0).max(1).optional(),
    onLowAgreement: z.enum(['split', 'advise', 'observe']).optional(),
  }).passthrough().optional(),
}).passthrough();

const rubricFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  roleId: z.string().min(1),
  criteria: z.array(rubricCriterionSchema).min(1),
  aggregation: z.object({
    mustAllPass: z.array(z.string()).optional(),
    mustNotTrigger: z.array(z.string()).optional(),
    passScore: z.number().optional(),
  }).passthrough().optional(),
  calibration: z.object({
    bands: z.object({
      auto: z.number().min(0).max(1).optional(),
      advise: z.number().min(0).max(1).optional(),
      split: z.number().min(0).max(1).optional(),
    }).passthrough().optional(),
    minSamples: z.number().int().positive().optional(),
  }).passthrough().optional(),
}).passthrough();

const judgmentLineSchema = z.object({
  unit: z.string().min(1),
  criterion: z.string().min(1),
  rater: z.string().min(1),
  value: z.number().finite(),
}).passthrough();

const criterionCalibrationResultSchema = z.object({
  criterionId: z.string().min(1),
  n: z.number().int().nonnegative(),
  n_gold: z.number().int().nonnegative(),
  raters: z.number().int().nonnegative(),
  isMust: z.boolean(),
  declaredGateMode: z.enum(['observe', 'advise', 'block']),
  agreement: z.number().nullable(),
  kappa_gold_vs_judge: z.number().nullable(),
  alpha_human_ceiling: z.number().nullable(),
  alpha_gold_vs_judge: z.number().nullable(),
  effectiveAlpha: z.number().nullable(),
  rho: z.number().nullable(),
  ceilingLow: z.boolean(),
  band: z.enum(['auto', 'advise', 'split']),
  canAutoBlock: z.boolean(),
  effectiveEnforcement: z.enum(['block', 'observe']),
  action: z.enum(['allow_auto_block', 'advise_only', 'split_or_rewrite']),
  note: z.string().optional(),
}).strict();

export const rubricCalibrationReportSchema = z.object({
  schemaVersion: z.literal(1),
  roleId: z.string().min(1),
  rubricDigest: z.string().regex(/^[0-9a-f]{64}$/),
  calibratedAt: z.string().min(1),
  bands: z.object({
    auto: z.number().min(0).max(1),
    advise: z.number().min(0).max(1),
    minAutoSamples: z.number().int().positive(),
  }).strict(),
  perCriterion: z.record(z.string(), criterionCalibrationResultSchema),
  autoBlockAllowed: z.array(z.string()),
  advisoryOnly: z.array(z.string()),
  splitRequired: z.array(z.string()),
  blockedBy: z.array(z.string()),
  passed: z.boolean(),
}).strict();

export type RubricDefinition = z.infer<typeof rubricFileSchema>;
export type RubricJudgment = z.infer<typeof judgmentLineSchema>;
export type CriterionCalibrationResult = z.infer<typeof criterionCalibrationResultSchema>;
export type RubricCalibrationReport = z.infer<typeof rubricCalibrationReportSchema>;

function assertSafeRoleId(roleId: string): void {
  if (!SAFE_ROLE_ID.test(roleId) || roleId === '.' || roleId === '..' || roleId.includes('..')) {
    throw new Error(`Unsafe roleId for rubric calibration path: ${roleId.slice(0, 64)}`);
  }
}

export function rubricCalibrationPath(workspace: string, roleId: string): string {
  assertSafeRoleId(roleId);
  return path.join(path.resolve(workspace), roleId, 'rubric-calibration.json');
}

function round3(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 1000) / 1000;
}

function averageRanks(xs: readonly number[]): number[] {
  const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const r = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && xs[order[j + 1]!] === xs[order[i]!]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) r[order[k]!] = avg;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation coefficient with average tie ranks. Returns null when n < 3 or zero variance. */
export function spearmanRho(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const rx = averageRanks(x.slice(0, n));
  const ry = averageRanks(y.slice(0, n));
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = rx[i]! - mx;
    const dy = ry[i]! - my;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? null : num / den;
}

/** Multiclass & binary Cohen's kappa. Returns null when n === 0. */
export function cohenKappa(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n === 0) return null;
  let matches = 0;
  const countsA = new Map<number, number>();
  const countsB = new Map<number, number>();
  const categories = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    const va = a[i]!;
    const vb = b[i]!;
    if (va === vb) matches += 1;
    countsA.set(va, (countsA.get(va) ?? 0) + 1);
    countsB.set(vb, (countsB.get(vb) ?? 0) + 1);
    categories.add(va);
    categories.add(vb);
  }
  const po = matches / n;
  let pe = 0;
  for (const cat of categories) {
    pe += ((countsA.get(cat) ?? 0) / n) * ((countsB.get(cat) ?? 0) / n);
  }
  if (pe >= 1) return po === 1 ? 1.0 : 0.0;
  return (po - pe) / (1 - pe);
}

/**
 * Canonical Krippendorff's alpha for nominal or ordinal scales.
 *
 * For ordinal scales, uses Krippendorff's marginal-frequency difference function:
 *   delta^2_ord(c, k) = ( sum_{g=min(c,k)..max(c,k)} n_g - (n_c + n_k) / 2 )^2
 * where n_g is the marginal coincidence frequency of category g.
 */
export function krippendorffAlpha(units: readonly (readonly number[])[], ordinal: boolean): number | null {
  const coinc = new Map<string, { c: number; k: number; v: number }>();
  let nTotal = 0;
  for (const vals of units) {
    const m = vals.length;
    if (m < 2) continue;
    nTotal += m;
    const weight = 1 / (m - 1);
    for (let i = 0; i < m; i += 1) {
      for (let j = 0; j < m; j += 1) {
        if (i === j) continue;
        const c = vals[i]!;
        const k = vals[j]!;
        const key = `${c}\0${k}`;
        const prev = coinc.get(key);
        if (prev) prev.v += weight;
        else coinc.set(key, { c, k, v: weight });
      }
    }
  }
  if (nTotal < 2) return null;

  const nc = new Map<number, number>();
  for (const { c, v } of coinc.values()) {
    nc.set(c, (nc.get(c) ?? 0) + v);
  }
  const keys = [...nc.keys()].sort((a, b) => a - b);
  if (keys.length <= 1) return 1.0;

  const idx = new Map<number, number>(keys.map((k, i) => [k, i]));
  const freq = keys.map(k => nc.get(k)!);
  // Precompute prefix sums for O(1) canonical ordinal delta^2 lookups.
  const prefix = new Array<number>(keys.length + 1).fill(0);
  for (let i = 0; i < keys.length; i += 1) {
    prefix[i + 1] = prefix[i]! + freq[i]!;
  }

  const d2 = (c: number, k: number): number => {
    if (c === k) return 0;
    if (ordinal && keys.length > 2) {
      const ic = idx.get(c)!;
      const ik = idx.get(k)!;
      const lo = Math.min(ic, ik);
      const hi = Math.max(ic, ik);
      const sumBetween = prefix[hi + 1]! - prefix[lo]!;
      const delta = sumBetween - (freq[lo]! + freq[hi]!) / 2;
      return delta * delta;
    }
    return 1;
  };

  let doSum = 0;
  for (const { c, k, v } of coinc.values()) {
    const dist = d2(c, k);
    if (dist !== 0) doSum += v * dist;
  }
  const Do = doSum / nTotal;

  let deSum = 0;
  for (const c of keys) {
    for (const k of keys) {
      const dist = d2(c, k);
      if (dist !== 0) deSum += nc.get(c)! * nc.get(k)! * dist;
    }
  }
  const De = deSum / (nTotal * (nTotal - 1));
  if (De === 0) return null;
  return 1 - Do / De;
}

async function isFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function collectFiles(directory: string, root: string, files: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(full, root, files);
    else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
  }
}

/** Stable SHA-256 over `rubric.json`, `checklist.json`, and every regular file in `checks/`. */
export async function computeRubricDigest(roleDirectory: string, rubricPath?: string): Promise<string> {
  const root = path.resolve(roleDirectory);
  const resolvedRubric = rubricPath ? path.resolve(rubricPath) : path.join(root, 'rubric.json');
  const files: { label: string; fullPath: string }[] = [];
  if (await isFile(resolvedRubric)) {
    const rel = path.relative(root, resolvedRubric).split(path.sep).join('/');
    files.push({ label: rel.startsWith('..') ? path.basename(resolvedRubric) : rel, fullPath: resolvedRubric });
  }
  const checklistPath = path.join(root, 'checklist.json');
  if (await isFile(checklistPath)) {
    files.push({ label: 'checklist.json', fullPath: checklistPath });
  }
  const checkFiles: string[] = [];
  await collectFiles(path.join(root, 'checks'), root, checkFiles);
  for (const rel of checkFiles) {
    files.push({ label: rel, fullPath: path.join(root, rel) });
  }
  files.sort((a, b) => a.label.localeCompare(b.label));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.label);
    hash.update('\0');
    hash.update(await readFile(file.fullPath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function loadRubric(roleDirectory: string, rubricPath?: string): Promise<RubricDefinition> {
  const file = rubricPath ? path.resolve(rubricPath) : path.join(path.resolve(roleDirectory), 'rubric.json');
  const text = await readFile(file, 'utf8');
  return rubricFileSchema.parse(JSON.parse(text));
}

export async function loadRubricJudgments(judgmentsPath: string): Promise<RubricJudgment[]> {
  const text = await readFile(path.resolve(judgmentsPath), 'utf8');
  const out: RubricJudgment[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON in judgments file at line ${i + 1}`);
    }
    out.push(judgmentLineSchema.parse(parsed));
  }
  return out;
}

export function classifyBand(
  effectiveAlpha: number | null,
  nPairs: number,
  bands: { auto: number; advise: number; minAutoSamples: number },
): RubricBand {
  if (effectiveAlpha === null || nPairs <= 0) return 'split';
  if (effectiveAlpha >= bands.auto && nPairs >= bands.minAutoSamples) return 'auto';
  if (effectiveAlpha >= bands.advise) return 'advise';
  return 'split';
}

/**
 * Unbiased consensus for both humans and judges:
 * - Binary: strict majority; 50/50 tie returns null (excluded from pair).
 * - Ordinal: exact median; half-integer tie (e.g. 1.5) returns null (excluded from pair, no upward rounding bias).
 */
function consensusValue(values: readonly number[], ordinal: boolean): number | null {
  if (!values.length) return null;
  if (!ordinal) {
    const ones = values.reduce((s, v) => s + (v >= 0.5 ? 1 : 0), 0);
    if (ones * 2 > values.length) return 1;
    if (ones * 2 < values.length) return 0;
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  const med = (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Number.isInteger(med) ? med : null;
}

function resolvePolicyBands(rubric: RubricDefinition): { auto: number; advise: number; minAutoSamples: number } {
  const declaredAuto = rubric.calibration?.bands?.auto;
  const declaredAdvise = rubric.calibration?.bands?.advise;
  if (declaredAuto !== undefined && declaredAuto < POLICY_AUTO_ALPHA) {
    throw new Error(`rubric calibration.bands.auto (${declaredAuto}) cannot be below policy floor ${POLICY_AUTO_ALPHA}`);
  }
  if (declaredAdvise !== undefined && declaredAdvise < POLICY_ADVISE_ALPHA) {
    throw new Error(`rubric calibration.bands.advise (${declaredAdvise}) cannot be below policy floor ${POLICY_ADVISE_ALPHA}`);
  }
  const auto = declaredAuto ?? POLICY_AUTO_ALPHA;
  const advise = declaredAdvise ?? POLICY_ADVISE_ALPHA;
  if (advise > auto) {
    throw new Error(`rubric calibration.bands.advise (${advise}) cannot exceed bands.auto (${auto})`);
  }
  return { auto, advise, minAutoSamples: POLICY_MIN_AUTO_SAMPLES };
}

export function evaluateRubricJudgments(options: {
  rubric: RubricDefinition;
  judgments: readonly RubricJudgment[];
  rubricDigest: string;
  now?: () => Date;
}): RubricCalibrationReport {
  const bands = resolvePolicyBands(options.rubric);

  const mustSet = new Set<string>([
    ...(options.rubric.aggregation?.mustAllPass ?? []),
    ...(options.rubric.aggregation?.mustNotTrigger ?? []),
  ]);

  // criterion -> unit -> rater -> value (reject duplicate (unit, criterion, rater) records)
  const byCriterion = new Map<string, Map<string, Map<string, number>>>();
  for (const j of options.judgments) {
    let unitMap = byCriterion.get(j.criterion);
    if (!unitMap) { unitMap = new Map(); byCriterion.set(j.criterion, unitMap); }
    let raterMap = unitMap.get(j.unit);
    if (!raterMap) { raterMap = new Map(); unitMap.set(j.unit, raterMap); }
    if (raterMap.has(j.rater)) {
      throw new Error(`Duplicate judgment for unit="${j.unit}" criterion="${j.criterion}" rater="${j.rater}"`);
    }
    raterMap.set(j.rater, j.value);
  }

  const perCriterion: Record<string, CriterionCalibrationResult> = {};
  const autoBlockAllowed: string[] = [];
  const advisoryOnly: string[] = [];
  const splitRequired: string[] = [];
  const blockedBy: string[] = [];

  for (const criterion of options.rubric.criteria) {
    const cid = criterion.id;
    const declaredGateMode = criterion.gate?.mode ?? 'observe';
    const isMust = mustSet.has(cid) || criterion.severity === 'must' || declaredGateMode === 'block';
    const ordinal = criterion.scale.type === 'ordinal';
    const unitMap = byCriterion.get(cid);

    const goldUnits: [string, Map<string, number>][] = [];
    if (unitMap) {
      for (const [unitId, raters] of [...unitMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if ([...raters.keys()].some(r => r.startsWith('human:'))) {
          goldUnits.push([unitId, raters]);
        }
      }
    }

    if (!goldUnits.length) {
      const res: CriterionCalibrationResult = {
        criterionId: cid,
        n: 0,
        n_gold: 0,
        raters: 0,
        isMust,
        declaredGateMode,
        agreement: null,
        kappa_gold_vs_judge: null,
        alpha_human_ceiling: null,
        alpha_gold_vs_judge: null,
        effectiveAlpha: null,
        rho: null,
        ceilingLow: false,
        band: 'split',
        canAutoBlock: false,
        effectiveEnforcement: 'observe',
        action: 'split_or_rewrite',
        note: '没有人工金标，未校准，禁止自动阻断，需补充金标或拆改条目',
      };
      perCriterion[cid] = res;
      splitRequired.push(cid);
      if (declaredGateMode === 'block') blockedBy.push(cid);
      continue;
    }

    const humanMat: number[][] = [];
    const pairMat: number[][] = [];
    const goldDiscrete: number[] = [];
    const judgeDiscrete: number[] = [];
    const humanMeans: number[] = [];
    const judgeMeans: number[] = [];
    const rawMatches: number[] = [];
    const raterSet = new Set<string>();

    for (const [, raters] of goldUnits) {
      const hv: number[] = [];
      const jv: number[] = [];
      for (const [r, val] of raters.entries()) {
        raterSet.add(r);
        if (r.startsWith('human:')) hv.push(val);
        else jv.push(val);
      }
      if (hv.length >= 2) humanMat.push(hv);
      if (hv.length > 0 && jv.length > 0) {
        const hm = consensusValue(hv, ordinal);
        const jm = consensusValue(jv, ordinal);
        if (hm !== null && jm !== null) {
          pairMat.push([hm, jm]);
          goldDiscrete.push(hm);
          judgeDiscrete.push(jm);
          rawMatches.push(jm === hm ? 1 : 0);
        }
        humanMeans.push(hv.reduce((s, v) => s + v, 0) / hv.length);
        judgeMeans.push(jv.reduce((s, v) => s + v, 0) / jv.length);
      }
    }

    const alphaHumanCeiling = humanMat.length > 0 ? krippendorffAlpha(humanMat, ordinal) : null;
    const alphaGoldVsJudge = pairMat.length >= 2 ? krippendorffAlpha(pairMat, ordinal) : null;
    const kappaGoldVsJudge = goldDiscrete.length > 0 ? cohenKappa(goldDiscrete, judgeDiscrete) : null;
    const rho = humanMeans.length >= 3 ? spearmanRho(humanMeans, judgeMeans) : null;
    const agreement = rawMatches.length > 0 ? rawMatches.reduce((s, v) => s + v, 0) / rawMatches.length : null;

    // Dual-ceiling effective score: requires a real alpha_gold_vs_judge (>= 2 judge-gold pairs).
    // Never falls back to human-only ceiling or 1-sample kappa to enter auto/advise!
    const effectiveAlpha = alphaGoldVsJudge === null
      ? null
      : alphaHumanCeiling !== null
        ? Math.min(alphaGoldVsJudge, alphaHumanCeiling)
        : alphaGoldVsJudge;

    // n is strictly the count of usable judge-gold paired units!
    const nPairs = pairMat.length;
    const nGold = goldUnits.length;
    const band = classifyBand(effectiveAlpha, nPairs, bands);
    const ceilingLow = alphaHumanCeiling !== null && alphaHumanCeiling < bands.advise;
    const minAlpha = criterion.gate?.minAlpha;
    const meetsMinAlpha = minAlpha === undefined || (effectiveAlpha !== null && effectiveAlpha >= minAlpha);
    const canAutoBlock = band === 'auto' && isMust && meetsMinAlpha;
    const effectiveEnforcement: 'block' | 'observe' = canAutoBlock ? 'block' : 'observe';
    const action: CriterionCalibrationResult['action'] =
      canAutoBlock
        ? 'allow_auto_block'
        : band === 'split'
          ? 'split_or_rewrite'
          : 'advise_only';

    let note: string | undefined;
    if (band === 'split') {
      if (alphaGoldVsJudge === null) {
        note = `可用评委-金标配对不足（n=${nPairs} < 2），无法计算 alpha_gold_vs_judge，禁止自动阻断`;
      } else if (ceilingLow) {
        note = `人工互评上限过低（alpha_human_ceiling=${round3(alphaHumanCeiling)} < ${bands.advise}），必须拆改 Rubric 条目`;
      } else {
        note = `一致性过低（effectiveAlpha=${round3(effectiveAlpha)} < ${bands.advise}），强制提示拆改条目`;
      }
    } else if (!meetsMinAlpha && minAlpha !== undefined) {
      note = `未达到该条目自声明 gate.minAlpha（effectiveAlpha=${round3(effectiveAlpha)} < ${minAlpha}），禁止自动阻断`;
    } else if (band === 'advise') {
      if (declaredGateMode === 'block') {
        note = nPairs < bands.minAutoSamples && effectiveAlpha !== null && effectiveAlpha >= bands.auto
          ? `配对样本量不足（n=${nPairs} < ${bands.minAutoSamples}），该 block 条目暂落 advise 档，不能自动阻断并导致校准未通过`
          : `该 block 条目处于 advise 区间（${bands.advise} <= alpha < ${bands.auto}），不能自动阻断并导致校准未通过`;
      } else {
        note = nPairs < bands.minAutoSamples && effectiveAlpha !== null && effectiveAlpha >= bands.auto
          ? `配对样本量不足（n=${nPairs} < ${bands.minAutoSamples}），暂处 advise 档，仅建议不阻断`
          : `处于 advise 区间（${bands.advise} <= alpha < ${bands.auto}），仅建议不阻断`;
      }
    }

    perCriterion[cid] = {
      criterionId: cid,
      n: nPairs,
      n_gold: nGold,
      raters: raterSet.size,
      isMust,
      declaredGateMode,
      agreement: round3(agreement),
      kappa_gold_vs_judge: round3(kappaGoldVsJudge),
      alpha_human_ceiling: round3(alphaHumanCeiling),
      alpha_gold_vs_judge: round3(alphaGoldVsJudge),
      effectiveAlpha: round3(effectiveAlpha),
      rho: round3(rho),
      ceilingLow,
      band,
      canAutoBlock,
      effectiveEnforcement,
      action,
      ...(note ? { note } : {}),
    };

    if (canAutoBlock) autoBlockAllowed.push(cid);
    else if (band === 'split') splitRequired.push(cid);
    else advisoryOnly.push(cid);

    if (declaredGateMode === 'block' && !canAutoBlock) {
      blockedBy.push(cid);
    }
  }

  return {
    schemaVersion: 1,
    roleId: options.rubric.roleId,
    rubricDigest: options.rubricDigest,
    calibratedAt: (options.now ?? (() => new Date()))().toISOString(),
    bands,
    perCriterion,
    autoBlockAllowed,
    advisoryOnly,
    splitRequired,
    blockedBy,
    passed: blockedBy.length === 0,
  };
}

export async function calibrateRubric(options: {
  roleDirectory: string;
  judgmentsPath: string;
  rubricPath?: string;
  workspace?: string;
  now?: () => Date;
}): Promise<RubricCalibrationReport> {
  const roleDirectory = path.resolve(options.roleDirectory);
  const [rubric, judgments, rubricDigest, profileRaw] = await Promise.all([
    loadRubric(roleDirectory, options.rubricPath),
    loadRubricJudgments(options.judgmentsPath),
    computeRubricDigest(roleDirectory, options.rubricPath),
    readFile(path.join(roleDirectory, 'profile.json'), 'utf8').catch(() => undefined),
  ]);
  if (profileRaw !== undefined) {
    const profileId = z.object({ id: z.string().min(1) }).passthrough().parse(JSON.parse(profileRaw)).id;
    if (profileId !== rubric.roleId) {
      throw new Error(`rubric.json roleId "${rubric.roleId}" does not match profile.json id "${profileId}"`);
    }
  }
  const report = evaluateRubricJudgments({
    rubric,
    judgments,
    rubricDigest,
    ...(options.now ? { now: options.now } : {}),
  });
  if (options.workspace) {
    const outFile = rubricCalibrationPath(options.workspace, rubric.roleId);
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

export type LoadedRubricCalibration =
  | { state: 'missing' }
  | { state: 'invalid'; error: string }
  | { state: 'ok'; report: RubricCalibrationReport };

export async function readRubricCalibration(workspace: string, roleId: string): Promise<LoadedRubricCalibration> {
  let text: string;
  try {
    text = await readFile(rubricCalibrationPath(workspace, roleId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const report = rubricCalibrationReportSchema.parse(JSON.parse(text));
    if (report.roleId !== roleId) {
      return { state: 'invalid', error: `rubric-calibration.json roleId "${report.roleId}" does not match "${roleId}"` };
    }
    return { state: 'ok', report };
  } catch (error) {
    return { state: 'invalid', error: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadRubricCalibration(workspace: string, roleId: string): Promise<RubricCalibrationReport | undefined> {
  const loaded = await readRubricCalibration(workspace, roleId);
  return loaded.state === 'ok' ? loaded.report : undefined;
}

export function formatRubricCalibrationText(report: RubricCalibrationReport): string {
  const lines = [
    `Rubric 双上限校准：角色 ${report.roleId}，摘要 ${report.rubricDigest.slice(0, 12)}（auto >= ${report.bands.auto} 且 n >= ${report.bands.minAutoSamples}；advise >= ${report.bands.advise}；否则 split）`,
  ];
  for (const row of Object.values(report.perCriterion)) {
    lines.push(
      `  ${row.criterionId.padStart(4)} n=${String(row.n).padEnd(3)} (gold=${row.n_gold}) kappa=${row.kappa_gold_vs_judge ?? 'null'} a_ceil=${row.alpha_human_ceiling ?? 'null'} a_gold=${row.alpha_gold_vs_judge ?? 'null'} rho=${row.rho ?? 'null'} band=${row.band} autoBlock=${row.canAutoBlock}${row.note ? ` — ${row.note}` : ''}`,
    );
  }
  lines.push(`允许自动阻断：${report.autoBlockAllowed.join('、') || '无'} | 仅建议：${report.advisoryOnly.join('、') || '无'} | 强制拆改：${report.splitRequired.join('、') || '无'}`);
  lines.push(report.passed ? 'Rubric 校准通过。' : `Rubric 校准未通过（阻断项未达标：${report.blockedBy.join('、')}）。`);
  return lines.join('\n');
}
