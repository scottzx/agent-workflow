/**
 * Dual-ceiling Rubric calibration (Cohen's kappa, Krippendorff's alpha, Spearman's rho)
 * and digest binding for role `rubric.json`.
 *
 * Dual-ceiling 3-band rule:
 * - `effectiveAlpha = min(alpha_human_ceiling, alpha_gold_vs_judge)` (falls back to whichever exists, then kappa)
 * - `auto`:   effectiveAlpha >= bands.auto (default 0.80) AND n >= minAutoSamples (default 40)
 * - `advise`: effectiveAlpha >= bands.advise (default 0.67) AND (effectiveAlpha < bands.auto OR n < minAutoSamples)
 * - `split`:  effectiveAlpha < bands.advise (or n === 0 / missing human gold)
 *
 * Enforcement invariant:
 * - ONLY `band === 'auto'` `must` criteria (in `pass_rule.mustAllPass` / `mustNotTrigger` or `gate.mode === 'block'`)
 *   are permitted to auto-block.
 * - `advise` is strictly advisory-only (`canAutoBlock = false`).
 * - `split` emits a mandatory split/rewrite warning (`action = 'split_or_rewrite'`, `canAutoBlock = false`).
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export type RubricBand = 'auto' | 'advise' | 'split';

const rubricCriterionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  polarity: z.enum(['positive', 'negative']).optional(),
  weight: z.number().optional(),
  scale: z.object({
    type: z.enum(['binary', 'ordinal']),
    min: z.number().optional(),
    max: z.number().optional(),
  }).passthrough(),
  gate: z.object({
    mode: z.enum(['observe', 'block', 'skip']).optional(),
    minAlpha: z.number().min(0).max(1).optional(),
  }).passthrough().optional(),
}).passthrough();

const rubricFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  roleId: z.string().min(1),
  criteria: z.array(rubricCriterionSchema).min(1),
  pass_rule: z.object({
    mustAllPass: z.array(z.string()).optional(),
    mustNotTrigger: z.array(z.string()).optional(),
    minNormalizedScore: z.number().optional(),
  }).passthrough().optional(),
  calibration: z.object({
    bands: z.object({
      auto: z.number().min(0).max(1).default(0.8),
      advise: z.number().min(0).max(1).default(0.67),
    }).passthrough().optional(),
    minAutoSamples: z.number().int().positive().optional(),
  }).passthrough().optional(),
}).passthrough();

const judgmentLineSchema = z.object({
  unit: z.string().min(1),
  criterion: z.string().min(1),
  rater: z.string().min(1),
  value: z.number().finite(),
}).passthrough();

export type RubricDefinition = z.infer<typeof rubricFileSchema>;
export type RubricJudgment = z.infer<typeof judgmentLineSchema>;

export interface CriterionCalibrationResult {
  criterionId: string;
  n: number;
  raters: number;
  isMust: boolean;
  declaredGateMode: 'observe' | 'block' | 'skip';
  agreement: number | null;
  kappa_gold_vs_judge: number | null;
  alpha_human_ceiling: number | null;
  alpha_gold_vs_judge: number | null;
  effectiveAlpha: number | null;
  rho: number | null;
  ceilingLow: boolean;
  band: RubricBand;
  canAutoBlock: boolean;
  effectiveEnforcement: 'block' | 'observe' | 'skip';
  action: 'allow_auto_block' | 'advise_only' | 'split_or_rewrite';
  note?: string;
}

export interface RubricCalibrationReport {
  schemaVersion: 1;
  roleId: string;
  rubricDigest: string;
  calibratedAt: string;
  bands: { auto: number; advise: number; minAutoSamples: number };
  perCriterion: Record<string, CriterionCalibrationResult>;
  autoBlockAllowed: string[];
  advisoryOnly: string[];
  splitRequired: string[];
  blockedBy: string[];
  passed: boolean;
}

export const rubricCalibrationPath = (workspace: string, roleId: string) =>
  path.join(path.resolve(workspace), roleId, 'rubric-calibration.json');

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
 * Krippendorff's alpha for nominal (binary/categorical) or ordinal scales.
 * Each unit is an array of rater values (>=2 raters contribute to the coincidence matrix).
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
  const d2 = (c: number, k: number): number => {
    if (c === k) return 0;
    if (ordinal && keys.length > 2) {
      const diff = idx.get(c)! - idx.get(k)!;
      return diff * diff;
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
  n: number,
  bands: { auto: number; advise: number; minAutoSamples: number },
): RubricBand {
  if (effectiveAlpha === null || n <= 0) return 'split';
  if (effectiveAlpha >= bands.auto && n >= bands.minAutoSamples) return 'auto';
  if (effectiveAlpha >= bands.advise) return 'advise';
  return 'split';
}

function humanConsensus(values: readonly number[], ordinal: boolean): number | null {
  if (!values.length) return null;
  if (!ordinal) {
    const ones = values.reduce((s, v) => s + (v >= 0.5 ? 1 : 0), 0);
    if (ones * 2 > values.length) return 1;
    if (ones * 2 < values.length) return 0;
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(med);
}

export function evaluateRubricJudgments(options: {
  rubric: RubricDefinition;
  judgments: readonly RubricJudgment[];
  rubricDigest: string;
  minAutoSamples?: number;
  now?: () => Date;
}): RubricCalibrationReport {
  const autoThreshold = options.rubric.calibration?.bands?.auto ?? 0.8;
  const adviseThreshold = options.rubric.calibration?.bands?.advise ?? 0.67;
  const minAutoSamples = options.minAutoSamples ?? options.rubric.calibration?.minAutoSamples ?? 40;
  const bands = { auto: autoThreshold, advise: adviseThreshold, minAutoSamples };

  const mustSet = new Set<string>([
    ...(options.rubric.pass_rule?.mustAllPass ?? []),
    ...(options.rubric.pass_rule?.mustNotTrigger ?? []),
  ]);

  // criterion -> unit -> rater -> value
  const byCriterion = new Map<string, Map<string, Map<string, number>>>();
  for (const j of options.judgments) {
    let unitMap = byCriterion.get(j.criterion);
    if (!unitMap) { unitMap = new Map(); byCriterion.set(j.criterion, unitMap); }
    let raterMap = unitMap.get(j.unit);
    if (!raterMap) { raterMap = new Map(); unitMap.set(j.unit, raterMap); }
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
    const isMust = mustSet.has(cid) || declaredGateMode === 'block';
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
        effectiveEnforcement: declaredGateMode === 'skip' ? 'skip' : 'observe',
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
        const hm = humanConsensus(hv, ordinal);
        const jmMean = jv.reduce((s, v) => s + v, 0) / jv.length;
        const jmRounded = Math.round(jmMean);
        if (hm !== null) {
          pairMat.push([hm, jmRounded]);
          goldDiscrete.push(hm);
          judgeDiscrete.push(jmRounded);
          rawMatches.push(jmRounded === hm ? 1 : 0);
        }
        humanMeans.push(hv.reduce((s, v) => s + v, 0) / hv.length);
        judgeMeans.push(jmMean);
      }
    }

    const alphaHumanCeiling = humanMat.length > 0 ? krippendorffAlpha(humanMat, ordinal) : null;
    const alphaGoldVsJudge = pairMat.length >= 2 ? krippendorffAlpha(pairMat, ordinal) : null;
    const kappaGoldVsJudge = goldDiscrete.length > 0 ? cohenKappa(goldDiscrete, judgeDiscrete) : null;
    const rho = humanMeans.length >= 3 ? spearmanRho(humanMeans, judgeMeans) : null;
    const agreement = rawMatches.length > 0 ? rawMatches.reduce((s, v) => s + v, 0) / rawMatches.length : null;

    // Dual-ceiling effective score: bounded by BOTH judge-vs-gold AND human-human ceiling!
    const candidates = [alphaGoldVsJudge, alphaHumanCeiling].filter((v): v is number => v !== null);
    const effectiveAlpha = candidates.length > 0
      ? Math.min(...candidates)
      : kappaGoldVsJudge;

    const n = goldUnits.length;
    const band = classifyBand(effectiveAlpha, n, bands);
    const ceilingLow = alphaHumanCeiling !== null && alphaHumanCeiling < bands.advise;
    const canAutoBlock = band === 'auto' && isMust && declaredGateMode !== 'skip';
    const effectiveEnforcement: 'block' | 'observe' | 'skip' =
      declaredGateMode === 'skip' ? 'skip' : (canAutoBlock ? 'block' : 'observe');
    const action: CriterionCalibrationResult['action'] =
      band === 'auto'
        ? (canAutoBlock ? 'allow_auto_block' : 'advise_only')
        : band === 'advise'
          ? 'advise_only'
          : 'split_or_rewrite';

    let note: string | undefined;
    if (band === 'split') {
      note = ceilingLow
        ? `人工互评上限过低（alpha_human_ceiling=${round3(alphaHumanCeiling)} < ${bands.advise}），必须拆改 Rubric 条目`
        : `一致性过低（effectiveAlpha=${round3(effectiveAlpha)} < ${bands.advise}），强制提示拆改条目`;
    } else if (band === 'advise') {
      note = n < bands.minAutoSamples && effectiveAlpha !== null && effectiveAlpha >= bands.auto
        ? `样本量不足（n=${n} < ${bands.minAutoSamples}），降档为 advise 仅建议，禁止自动阻断`
        : `处于 advise 区间（${bands.advise} <= alpha < ${bands.auto}），仅建议不阻断`;
    }

    perCriterion[cid] = {
      criterionId: cid,
      n,
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

    if (declaredGateMode === 'block') {
      if (band !== 'auto') {
        blockedBy.push(cid);
      } else if (criterion.gate?.minAlpha !== undefined && effectiveAlpha !== null && effectiveAlpha < criterion.gate.minAlpha) {
        blockedBy.push(cid);
      }
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
  minAutoSamples?: number;
  now?: () => Date;
}): Promise<RubricCalibrationReport> {
  const roleDirectory = path.resolve(options.roleDirectory);
  const [rubric, judgments, rubricDigest] = await Promise.all([
    loadRubric(roleDirectory, options.rubricPath),
    loadRubricJudgments(options.judgmentsPath),
    computeRubricDigest(roleDirectory, options.rubricPath),
  ]);
  const report = evaluateRubricJudgments({
    rubric,
    judgments,
    rubricDigest,
    ...(options.minAutoSamples !== undefined ? { minAutoSamples: options.minAutoSamples } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (options.workspace) {
    const outFile = rubricCalibrationPath(options.workspace, rubric.roleId);
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

export async function loadRubricCalibration(workspace: string, roleId: string): Promise<RubricCalibrationReport | undefined> {
  try {
    const raw = JSON.parse(await readFile(rubricCalibrationPath(workspace, roleId), 'utf8')) as RubricCalibrationReport;
    if (raw?.schemaVersion === 1 && typeof raw.rubricDigest === 'string' && typeof raw.passed === 'boolean') {
      return raw;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function formatRubricCalibrationText(report: RubricCalibrationReport): string {
  const lines = [
    `Rubric 双上限校准：角色 ${report.roleId}，摘要 ${report.rubricDigest.slice(0, 12)}（auto >= ${report.bands.auto} 且 n >= ${report.bands.minAutoSamples}；advise >= ${report.bands.advise}；否则 split）`,
  ];
  for (const row of Object.values(report.perCriterion)) {
    lines.push(
      `  ${row.criterionId.padStart(4)} n=${String(row.n).padEnd(3)} kappa=${row.kappa_gold_vs_judge ?? 'null'} a_ceil=${row.alpha_human_ceiling ?? 'null'} a_gold=${row.alpha_gold_vs_judge ?? 'null'} rho=${row.rho ?? 'null'} band=${row.band} autoBlock=${row.canAutoBlock}${row.note ? ` — ${row.note}` : ''}`,
    );
  }
  lines.push(`允许自动阻断：${report.autoBlockAllowed.join('、') || '无'} | 仅建议：${report.advisoryOnly.join('、') || '无'} | 强制拆改：${report.splitRequired.join('、') || '无'}`);
  lines.push(report.passed ? 'Rubric 校准通过。' : `Rubric 校准未通过（阻断项未达标：${report.blockedBy.join('、')}）。`);
  return lines.join('\n');
}
