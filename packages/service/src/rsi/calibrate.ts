/**
 * Replays the current role checks over historical outlines. A positive sample is a run that passed;
 * a negative sample is a round QA sent back.
 *
 * Schema v2 (bidirectional L3):
 * - Positive samples must have 0 block false positives.
 * - Negative samples must achieve non-zero recall (relaxing checks so they catch nothing fails).
 * - Frozen holdout split (`holdout.json`) prevents overfitting/tuning on all historical samples.
 * - `roleDigest` covers the full role directory (`ROLE.md`, `QA.md`, `checklist.json`, `checks/`, etc.).
 * - Nothing under a historical work directory is written.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkResultSchema, type CheckResult } from '../execution/ticket.js';
import { auditChecklistProvenance, effectiveEnforcement, loadChecklist, type NormalizedCheckItem } from './checklist.js';
import { loadWorkflow } from './engine.js';
import { type LedgerEntry, ledgerPath, type RoleVersion, roleVersion, type StopReason } from './outline-run.js';

const UNFINISHED: StopReason[] = ['not_completed', 'review_failed', 'host_error'];
const ROLE_DIGEST_FILES = ['profile.json', 'ROLE.md', 'QA.md', 'checklist.json', 'workflow.json', 'routing.json', 'evals/manifest.json'] as const;

/** One historical artifact after the current checks have been replayed on it. */
export interface CalibrationSampleResult {
  kind: 'positive' | 'negative';
  runDir: string;
  round?: number;
  artifactPath: string;
  failedChecks: string[];
  evidence?: unknown;
  qaSummary?: string;
}

export interface CalibrationHoldoutSummary {
  frozen: boolean;
  ratio: number;
  digest: string;
  sampleKeys: string[];
  positiveSamples: number;
  negativeSamples: number;
  falsePositives: number;
  negativeRecall: number | null;
  passed: boolean;
  tampered?: boolean;
}

export interface CalibrationReportV1 {
  schemaVersion: 1;
  roleId: string;
  role: RoleVersion;
  /** SHA-256 of `checklist.json` plus every regular file under `checks/`, in sorted path order. */
  checksDigest: string;
  calibratedAt: string;
  only?: string[];
  positiveSamples: number;
  negativeSamples: number;
  falsePositives: { runDir: string; artifactPath: string; failedChecks: string[]; evidence?: unknown }[];
  caughtHistoricalIssues: { runDir: string; round: number; artifactPath: string; caughtBy: string[]; qaSummary?: string }[];
  passed: boolean;
}

export interface CalibrationReportV2 {
  schemaVersion: 2;
  roleId: string;
  role: RoleVersion;
  /** SHA-256 of `checklist.json` plus every regular file under `checks/`, in sorted path order. */
  checksDigest: string;
  /** SHA-256 of the role directory including ROLE.md, QA.md, checklist.json, checks/, workflow.json, routing.json, evals/manifest.json. */
  roleDigest: string;
  calibratedAt: string;
  /** Set when the replay only scored these item ids. */
  only?: string[];
  /** Historical accepted or passed artifacts that were replayed. */
  positiveSamples: number;
  /** Historical QA revise artifacts that were replayed. */
  negativeSamples: number;
  /** Ratio of caught historical negative samples (`caught / negativeSamples`), or `null` when `negativeSamples === 0`. */
  negativeRecall: number | null;
  /** Frozen holdout subset metrics (loaded from or frozen into `<workspace>/<roleId>/holdout.json`). */
  holdout: CalibrationHoldoutSummary;
  falsePositives: { runDir: string; artifactPath: string; failedChecks: string[]; evidence?: unknown }[];
  caughtHistoricalIssues: { runDir: string; round: number; artifactPath: string; caughtBy: string[]; qaSummary?: string }[];
  /** Newly added block checks missing required `source` provenance. */
  missingSource: string[];
  /** Block program checks downgraded to `observe` due to 0 negative sample coverage or missing provenance. */
  downgradedToObserve: string[];
  /** Human-readable reasons when `passed === false`. */
  failureReasons: string[];
  /** True when positive false positives == 0, bidirectional negative recall holds, and frozen holdout passes. */
  passed: boolean;
}

export type CalibrationReport = CalibrationReportV1 | CalibrationReportV2;
export type AnyCalibrationReport = CalibrationReport;

const falsePositiveSchema = z.object({
  runDir: z.string(), artifactPath: z.string(), failedChecks: z.array(z.string()), evidence: z.unknown().optional(),
}).strict();

const caughtIssueSchema = z.object({
  runDir: z.string(), round: z.number(), artifactPath: z.string(), caughtBy: z.array(z.string()), qaSummary: z.string().optional(),
}).strict();

const holdoutSummarySchema = z.object({
  frozen: z.boolean(),
  ratio: z.number().min(0).max(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  sampleKeys: z.array(z.string()),
  positiveSamples: z.number().int().nonnegative(),
  negativeSamples: z.number().int().nonnegative(),
  falsePositives: z.number().int().nonnegative(),
  negativeRecall: z.number().min(0).max(1).nullable(),
  passed: z.boolean(),
  tampered: z.boolean().optional(),
}).strict();

const calibrationReportV1Schema = z.object({
  schemaVersion: z.literal(1),
  roleId: z.string().min(1),
  role: z.object({ commit: z.string().optional(), dirty: z.boolean() }).strict(),
  checksDigest: z.string().regex(/^[0-9a-f]{64}$/),
  calibratedAt: z.string().min(1),
  only: z.array(z.string()).optional(),
  positiveSamples: z.number().int().nonnegative(),
  negativeSamples: z.number().int().nonnegative(),
  falsePositives: z.array(falsePositiveSchema),
  caughtHistoricalIssues: z.array(caughtIssueSchema),
  passed: z.boolean(),
}).strict();

const calibrationReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  roleId: z.string().min(1),
  role: z.object({ commit: z.string().optional(), dirty: z.boolean() }).strict(),
  checksDigest: z.string().regex(/^[0-9a-f]{64}$/),
  roleDigest: z.string().regex(/^[0-9a-f]{64}$/),
  calibratedAt: z.string().min(1),
  only: z.array(z.string()).optional(),
  positiveSamples: z.number().int().nonnegative(),
  negativeSamples: z.number().int().nonnegative(),
  negativeRecall: z.number().min(0).max(1).nullable(),
  holdout: holdoutSummarySchema,
  falsePositives: z.array(falsePositiveSchema),
  caughtHistoricalIssues: z.array(caughtIssueSchema),
  missingSource: z.array(z.string()),
  downgradedToObserve: z.array(z.string()),
  failureReasons: z.array(z.string()),
  passed: z.boolean(),
}).strict();

const anyCalibrationReportSchema = z.discriminatedUnion('schemaVersion', [
  calibrationReportV1Schema,
  calibrationReportV2Schema,
]);

const holdoutManifestSchema = z.object({
  schemaVersion: z.literal(1),
  roleId: z.string().min(1),
  frozen: z.literal(true),
  ratio: z.number().min(0).max(1),
  frozenAt: z.string().min(1),
  sampleKeys: z.array(z.string()),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const runFileSchema = z.object({
  rounds: z.array(z.object({
    round: z.number(),
    review: z.object({
      outlineCopy: z.string().optional(),
      review: z.object({ verdict: z.string().optional(), summary: z.string().optional() }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough()).optional(),
}).passthrough();

export interface CalibrationCheckInput {
  roleDirectory: string;
  workDirectory: string;
  artifactPath: string;
  python: string;
  only?: string[];
}

export type CalibrationCheckRunner = (input: CalibrationCheckInput) => Promise<CheckResult[]>;

export interface CalibrateRoleOptions {
  roleDirectory: string;
  workspace: string;
  python?: string;
  /** Score only these checklist item ids. Other failures are ignored. */
  only?: string[];
  /** Minimum negative recall threshold when negative samples exist (default requires > 0). */
  minNegativeRecall?: number;
  /** Fraction of historical samples frozen into the holdout split when creating a new holdout (default 0.2). */
  holdoutRatio?: number;
  /** Explicit sample keys to freeze as holdout (mainly for deterministic tests or curated holdouts). */
  holdoutKeys?: string[];
  /** Baseline checklist item ids from previous version; items outside this set must carry `source`. */
  existingItemIds?: ReadonlySet<string>;
  now?: () => Date;
  /** Replaces the role's check script. Tests inject this; the default replays read-only. */
  checkRunner?: CalibrationCheckRunner;
}

export const calibrationPath = (workspace: string, roleId: string) => path.join(path.resolve(workspace), roleId, 'calibration.json');
export const holdoutPath = (workspace: string, roleId: string) => path.join(path.resolve(workspace), roleId, 'holdout.json');

/** Stable SHA-256 over `checklist.json` and every regular file in `checks/`. */
export async function computeChecksDigest(roleDirectory: string): Promise<string> {
  const root = path.resolve(roleDirectory);
  const files = ['checklist.json'];
  await collectFiles(path.join(root, 'checks'), root, files);
  files.sort();
  return digestFiles(root, files);
}

/** Stable SHA-256 over the role directory (`ROLE.md`, `QA.md`, `checklist.json`, `checks/`, `workflow.json`, `routing.json`, `profile.json`, `evals/manifest.json`). */
export async function computeRoleDigest(roleDirectory: string): Promise<string> {
  const root = path.resolve(roleDirectory);
  const files: string[] = [];
  for (const rel of ROLE_DIGEST_FILES) {
    if (await isFile(path.join(root, rel))) files.push(rel);
  }
  await collectFiles(path.join(root, 'checks'), root, files);
  const unique = [...new Set(files)].sort();
  return digestFiles(root, unique);
}

async function digestFiles(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await readFile(path.join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
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

/** Reads a calibration report (v1 or v2). Missing or unreadable files yield undefined rather than throwing. */
export async function loadCalibration(workspace: string, roleId: string): Promise<AnyCalibrationReport | undefined> {
  try {
    const text = await readFile(calibrationPath(workspace, roleId), 'utf8');
    return anyCalibrationReportSchema.parse(JSON.parse(text));
  } catch { return undefined; }
}

interface ReplaySample {
  kind: 'positive' | 'negative';
  runDir: string;
  round?: number;
  artifactPath: string;
  qaSummary?: string;
}

export function sampleKeyOf(sample: Pick<ReplaySample, 'kind' | 'runDir' | 'round' | 'artifactPath'>): string {
  return `${sample.kind}:${sample.runDir}:${sample.round ?? ''}:${sample.artifactPath}`;
}

function holdoutKeysDigest(keys: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...keys].sort())).digest('hex');
}

async function resolveFrozenHoldout(options: {
  workspace: string;
  roleId: string;
  samples: readonly ReplaySample[];
  ratio: number;
  explicitKeys?: readonly string[];
  now: () => Date;
}): Promise<{ sampleKeys: string[]; ratio: number; digest: string; tampered: boolean }> {
  const file = holdoutPath(options.workspace, options.roleId);
  let rawExisting: string | undefined;
  try {
    rawExisting = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (rawExisting !== undefined) {
    try {
      const parsed = holdoutManifestSchema.parse(JSON.parse(rawExisting));
      const expectedDigest = holdoutKeysDigest(parsed.sampleKeys);
      if (parsed.roleId !== options.roleId || parsed.digest !== expectedDigest) {
        return { sampleKeys: parsed.sampleKeys, ratio: parsed.ratio, digest: parsed.digest, tampered: true };
      }
      return { sampleKeys: parsed.sampleKeys, ratio: parsed.ratio, digest: parsed.digest, tampered: false };
    } catch {
      return { sampleKeys: [], ratio: options.ratio, digest: holdoutKeysDigest([]), tampered: true };
    }
  }

  let selected: string[];
  if (options.explicitKeys !== undefined) {
    selected = [...new Set(options.explicitKeys)].sort();
  } else if (options.samples.length < 5 || options.ratio <= 0) {
    selected = [];
  } else {
    const allKeys = options.samples.map(sampleKeyOf);
    const sortedByHash = [...allKeys].sort((a, b) => {
      const ha = createHash('sha256').update(`${options.roleId}:${a}`).digest('hex');
      const hb = createHash('sha256').update(`${options.roleId}:${b}`).digest('hex');
      return ha.localeCompare(hb);
    });
    const count = Math.max(1, Math.round(allKeys.length * options.ratio));
    selected = sortedByHash.slice(0, count).sort();
  }

  const digest = holdoutKeysDigest(selected);
  if (selected.length > 0 || options.explicitKeys !== undefined) {
    const manifest = {
      schemaVersion: 1 as const,
      roleId: options.roleId,
      frozen: true as const,
      ratio: options.ratio,
      frozenAt: options.now().toISOString(),
      sampleKeys: selected,
      digest,
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { sampleKeys: selected, ratio: options.ratio, digest, tampered: false };
}

/**
 * Replays the role's current checks on the ledger's historical outlines and writes `calibration.json` (v2).
 * Positive samples are finished runs with `passed: true`. Negative samples are rounds whose QA verdict
 * is `revise`. Runs that never reached a verdict are skipped, and each work directory is used once
 * (its latest ledger line).
 */
export async function calibrateRole(options: CalibrateRoleOptions): Promise<CalibrationReportV2> {
  const roleDirectory = path.resolve(options.roleDirectory);
  const now = options.now ?? (() => new Date());
  const python = options.python ?? 'python3';
  const only = options.only?.filter(Boolean);
  const onlySet = only?.length ? new Set(only) : undefined;
  const roleId = z.object({ id: z.string().min(1) }).passthrough().parse(JSON.parse(await readFile(path.join(roleDirectory, 'profile.json'), 'utf8'))).id;
  const [role, checksDigest, roleDigest, checklist, workflow] = await Promise.all([
    roleVersion(roleDirectory), computeChecksDigest(roleDirectory), computeRoleDigest(roleDirectory), loadChecklist(roleDirectory), loadWorkflow(roleDirectory),
  ]);
  const enforce = workflow.policies.formal.enforceObserveAsBlock;
  const known = new Map<string, NormalizedCheckItem>(checklist.items.map(item => [item.id, item]));
  const lines = await readLedger(options.workspace, roleId);
  const latest = lines.filter((entry, index) => !lines.slice(index + 1).some(later => later.workDirectory === entry.workDirectory));
  const runs = latest.filter(entry => !UNFINISHED.includes(entry.stopReason));
  const runner = options.checkRunner ?? defaultCheckRunner;

  const allSamples: ReplaySample[] = [];
  for (const run of runs) {
    allSamples.push(...await replaySamples(run));
  }

  const holdoutInfo = await resolveFrozenHoldout({
    workspace: options.workspace,
    roleId,
    samples: allSamples,
    ratio: options.holdoutRatio ?? 0.2,
    ...(options.holdoutKeys ? { explicitKeys: options.holdoutKeys } : {}),
    now,
  });
  const holdoutSet = new Set(holdoutInfo.sampleKeys);

  const falsePositives: CalibrationReportV2['falsePositives'] = [];
  const caughtHistoricalIssues: CalibrationReportV2['caughtHistoricalIssues'] = [];
  const negativeCoverageByItem: Record<string, number> = {};
  let positiveSamples = 0, negativeSamples = 0;
  let holdoutPos = 0, holdoutNeg = 0, holdoutFp = 0, holdoutCaught = 0;

  for (const sample of allSamples) {
    const key = sampleKeyOf(sample);
    const inHoldout = holdoutSet.has(key);
    if (sample.kind === 'positive') {
      positiveSamples++;
      if (inHoldout) holdoutPos++;
    } else {
      negativeSamples++;
      if (inHoldout) holdoutNeg++;
    }
    const results = await runner({ roleDirectory, workDirectory: sample.runDir, artifactPath: sample.artifactPath, python, ...(onlySet ? { only: [...onlySet] } : {}) });
    const failed = results.filter(result => failureCounts(result, sample.kind, known, enforce, onlySet));
    if (!failed.length) continue;
    const evidence = failed.map(result => ({ itemId: result.itemId, evidence: result.evidence }));
    const replay: CalibrationSampleResult = {
      kind: sample.kind, runDir: sample.runDir, artifactPath: sample.artifactPath, failedChecks: failed.map(result => result.itemId),
      ...(sample.round !== undefined ? { round: sample.round } : {}),
      ...(evidence.length ? { evidence } : {}),
      ...(sample.qaSummary ? { qaSummary: sample.qaSummary } : {}),
    };
    if (replay.kind === 'positive') {
      if (inHoldout) holdoutFp++;
      falsePositives.push({ runDir: replay.runDir, artifactPath: replay.artifactPath, failedChecks: replay.failedChecks, ...(replay.evidence !== undefined ? { evidence: replay.evidence } : {}) });
    } else {
      if (inHoldout) holdoutCaught++;
      for (const itemId of replay.failedChecks) {
        negativeCoverageByItem[itemId] = (negativeCoverageByItem[itemId] ?? 0) + 1;
      }
      caughtHistoricalIssues.push({
        runDir: replay.runDir, round: replay.round ?? 0, artifactPath: replay.artifactPath, caughtBy: replay.failedChecks,
        ...(replay.qaSummary ? { qaSummary: replay.qaSummary } : {}),
      });
    }
  }

  const negativeRecall = negativeSamples > 0 ? Number((caughtHistoricalIssues.length / negativeSamples).toFixed(4)) : null;
  const holdoutNegativeRecall = holdoutNeg > 0 ? Number((holdoutCaught / holdoutNeg).toFixed(4)) : null;
  const enforceBidirectional = !onlySet?.size || options.minNegativeRecall !== undefined;
  const minRecall = options.minNegativeRecall;
  const recallFailed = enforceBidirectional && negativeSamples > 0 && (
    minRecall !== undefined
      ? (negativeRecall ?? 0) < minRecall
      : caughtHistoricalIssues.length === 0
  );
  const holdoutRecallFailed = enforceBidirectional && holdoutNeg > 0 && (
    minRecall !== undefined
      ? (holdoutNegativeRecall ?? 0) < minRecall
      : holdoutCaught === 0
  );
  const holdoutPassed = !holdoutInfo.tampered && holdoutFp === 0 && !holdoutRecallFailed;

  const provenance = auditChecklistProvenance(checklist, {
    mode: 'formal',
    enforceObserveAsBlock: enforce,
    ...(options.existingItemIds ? { existingItemIds: options.existingItemIds } : { existingItemIds: new Set(checklist.items.map(i => i.id)) }),
    ...(negativeSamples > 0 ? { negativeCoverageByItem } : {}),
  });

  const failureReasons: string[] = [];
  if (falsePositives.length > 0) {
    failureReasons.push(`历史正样本存在 ${falsePositives.length} 条误报`);
  }
  if (recallFailed) {
    failureReasons.push(
      minRecall !== undefined
        ? `历史负样本召回率 ${negativeRecall} 低于门槛 ${minRecall}`
        : `历史负样本召回率为 0（${negativeSamples} 个负样本未拦住任何一条，检查可能被过度放宽）`,
    );
  }
  if (holdoutInfo.tampered) {
    failureReasons.push('冻结 holdout 清单摘要校验失败（文件被篡改或损坏）');
  } else if (!holdoutPassed) {
    if (holdoutFp > 0) failureReasons.push(`冻结 holdout 正样本存在 ${holdoutFp} 条误报`);
    if (holdoutRecallFailed) failureReasons.push(`冻结 holdout 负样本召回未达标（${holdoutNegativeRecall}）`);
  }
  if (options.existingItemIds && provenance.missingSource.length > 0) {
    failureReasons.push(`新增 block 检查缺少必填 source 溯源：${provenance.missingSource.join('、')}`);
  }

  const report: CalibrationReportV2 = {
    schemaVersion: 2,
    roleId,
    role,
    checksDigest,
    roleDigest,
    calibratedAt: now().toISOString(),
    ...(onlySet ? { only: [...onlySet] } : {}),
    positiveSamples,
    negativeSamples,
    negativeRecall,
    holdout: {
      frozen: true,
      ratio: holdoutInfo.ratio,
      digest: holdoutInfo.digest,
      sampleKeys: holdoutInfo.sampleKeys,
      positiveSamples: holdoutPos,
      negativeSamples: holdoutNeg,
      falsePositives: holdoutFp,
      negativeRecall: holdoutNegativeRecall,
      passed: holdoutPassed,
      ...(holdoutInfo.tampered ? { tampered: true } : {}),
    },
    falsePositives,
    caughtHistoricalIssues,
    missingSource: provenance.missingSource,
    downgradedToObserve: provenance.downgradedToObserve,
    failureReasons,
    passed: failureReasons.length === 0,
  };
  const file = calibrationPath(options.workspace, roleId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  return report;
}

function failureCounts(result: CheckResult, kind: 'positive' | 'negative', known: Map<string, NormalizedCheckItem>, enforceObserveAsBlock: boolean, only?: Set<string>): boolean {
  if (result.pass) return false;
  if (only && !only.has(result.itemId)) return false;
  const item = known.get(result.itemId);
  // A result the checklist does not name (the checker crashed, or the outline was unreadable) fails closed.
  if (!item) return true;
  const enforcement = effectiveEnforcement(item, 'formal', enforceObserveAsBlock);
  if (enforcement === 'skip') return false;
  return kind === 'negative' || enforcement === 'block';
}

async function readLedger(workspace: string, roleId: string): Promise<LedgerEntry[]> {
  const text = await readFile(ledgerPath(workspace, roleId), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as LedgerEntry);
}

/** Final passed outline, then each QA `revise` copy. Samples the checker cannot read are left out. */
async function replaySamples(run: LedgerEntry): Promise<ReplaySample[]> {
  const runDir = run.workDirectory;
  if (!runDir || !await hasReplayInputs(runDir)) return [];
  const recorded = await readRun(runDir);
  const rounds = recorded?.rounds ?? [];
  const samples: ReplaySample[] = [];
  for (const round of rounds) {
    if (round.review?.review?.verdict !== 'revise' || !round.review.outlineCopy) continue;
    const artifactPath = path.resolve(runDir, round.review.outlineCopy);
    if (!await isFile(artifactPath)) continue;
    samples.push({ kind: 'negative', runDir, round: round.round, artifactPath, ...(round.review.review.summary ? { qaSummary: round.review.review.summary } : {}) });
  }
  if (run.passed) {
    const last = rounds.at(-1)?.review?.outlineCopy;
    const preferred = last ? path.resolve(runDir, last) : '';
    const artifactPath = preferred && await isFile(preferred) ? preferred : path.join(runDir, 'outline.json');
    if (await isFile(artifactPath)) samples.push({ kind: 'positive', runDir, artifactPath });
  }
  return samples;
}

async function readRun(workDirectory: string): Promise<z.infer<typeof runFileSchema> | undefined> {
  try {
    const parsed = runFileSchema.safeParse(JSON.parse(await readFile(path.join(workDirectory, 'run.json'), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

async function hasReplayInputs(workDirectory: string): Promise<boolean> {
  return await isFile(path.join(workDirectory, 'features.json')) && await isDir(path.join(workDirectory, 'project'));
}

async function isFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function isDir(directory: string): Promise<boolean> {
  try { return (await stat(directory)).isDirectory(); } catch { return false; }
}

/** Runs the role's check script against one artifact. The script is the role's current copy, not the work directory's. */
export async function defaultCheckRunner(input: CalibrationCheckInput): Promise<CheckResult[]> {
  const checklist = await loadChecklist(input.roleDirectory);
  const features = path.join(input.workDirectory, 'features.json');
  const project = path.join(input.workDirectory, 'project');
  if (checklist.program?.run) {
    return runCheckScript(input.python, path.resolve(input.roleDirectory, checklist.program.run), [input.artifactPath, features, project], input.roleDirectory);
  }
  const runners = new Map<string, NonNullable<(typeof checklist.items)[number]['runner']>>();
  for (const item of checklist.items) {
    if (item.kind === 'program' && item.runner && !runners.has(item.runner.id)) runners.set(item.runner.id, item.runner);
  }
  if (!runners.size) {
    const fallback = path.join(input.roleDirectory, 'checks', 'check_outline.py');
    if (await isFile(fallback)) return runCheckScript(input.python, fallback, [input.artifactPath, features, project], input.roleDirectory);
    return [{ itemId: 'P0', pass: false, evidence: [{ message: '角色目录没有程序检查脚本' }] }];
  }
  const vars: Record<string, string> = {
    python: input.python, work: input.workDirectory, artifact: input.artifactPath, role: input.roleDirectory, features, project,
  };
  const results: CheckResult[] = [];
  for (const runner of runners.values()) {
    const cmd = runner.cmd.map(part => part.replace(/\$\{(\w+)\}/g, (_, key: string) => vars[key] ?? `\${${key}}`));
    results.push(...parseResults(await run(cmd[0]!, cmd.slice(1), { cwd: input.roleDirectory, timeoutMs: runner.timeoutMs })));
  }
  return results;
}

function runCheckScript(python: string, script: string, args: string[], cwd: string): Promise<CheckResult[]> {
  return run(python, ['-I', script, ...args], { cwd }).then(parseResults);
}

function parseResults(result: { stdout: string; stderr: string }): CheckResult[] {
  try { return z.array(checkResultSchema).parse(JSON.parse(result.stdout)); }
  catch { return [{ itemId: 'P0', pass: false, evidence: [{ message: '检查程序没有输出可读的结果', stderr: result.stderr.slice(-2000) }] }]; }
}

function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { if (timer) clearTimeout(timer); reject(error); });
    child.once('close', code => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}
