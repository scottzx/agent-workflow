/**
 * Replays the current role checks over historical outlines. A positive sample is a run that passed;
 * a negative sample is a round QA sent back. Block failures on positive samples are false positives
 * and fail the report. Nothing under a historical work directory is written.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkResultSchema, type CheckResult } from '../execution/ticket.js';
import { effectiveEnforcement, loadChecklist, type NormalizedCheckItem } from './checklist.js';
import { loadWorkflow } from './engine.js';
import { type LedgerEntry, ledgerPath, type RoleVersion, roleVersion, type StopReason } from './outline-run.js';

const UNFINISHED: StopReason[] = ['not_completed', 'review_failed', 'host_error'];

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

export interface CalibrationReport {
  schemaVersion: 1;
  roleId: string;
  role: RoleVersion;
  /** SHA-256 of `checklist.json` plus every regular file under `checks/`, in sorted path order. */
  checksDigest: string;
  calibratedAt: string;
  /** Set when the replay only scored these item ids. */
  only?: string[];
  /** Historical accepted or passed artifacts that were replayed. */
  positiveSamples: number;
  /** Historical QA revise artifacts that were replayed. */
  negativeSamples: number;
  falsePositives: { runDir: string; artifactPath: string; failedChecks: string[]; evidence?: unknown }[];
  caughtHistoricalIssues: { runDir: string; round: number; artifactPath: string; caughtBy: string[]; qaSummary?: string }[];
  /** True exactly when no positive sample tripped a current block check. */
  passed: boolean;
}

const calibrationReportSchema = z.object({
  schemaVersion: z.literal(1),
  roleId: z.string().min(1),
  role: z.object({ commit: z.string().optional(), dirty: z.boolean() }).strict(),
  checksDigest: z.string().regex(/^[0-9a-f]{64}$/),
  calibratedAt: z.string().min(1),
  only: z.array(z.string()).optional(),
  positiveSamples: z.number().int().nonnegative(),
  negativeSamples: z.number().int().nonnegative(),
  falsePositives: z.array(z.object({
    runDir: z.string(), artifactPath: z.string(), failedChecks: z.array(z.string()), evidence: z.unknown().optional(),
  }).strict()),
  caughtHistoricalIssues: z.array(z.object({
    runDir: z.string(), round: z.number(), artifactPath: z.string(), caughtBy: z.array(z.string()), qaSummary: z.string().optional(),
  }).strict()),
  passed: z.boolean(),
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
  now?: () => Date;
  /** Replaces the role's check script. Tests inject this; the default replays read-only. */
  checkRunner?: CalibrationCheckRunner;
}

export const calibrationPath = (workspace: string, roleId: string) => path.join(path.resolve(workspace), roleId, 'calibration.json');

/** Stable SHA-256 over `checklist.json` and every regular file in `checks/`. */
export async function computeChecksDigest(roleDirectory: string): Promise<string> {
  const root = path.resolve(roleDirectory);
  const files = ['checklist.json'];
  await collectFiles(path.join(root, 'checks'), root, files);
  files.sort();
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

/** Reads a calibration report. Missing or unreadable files yield undefined rather than throwing. */
export async function loadCalibration(workspace: string, roleId: string): Promise<CalibrationReport | undefined> {
  try {
    const text = await readFile(calibrationPath(workspace, roleId), 'utf8');
    return calibrationReportSchema.parse(JSON.parse(text));
  } catch { return undefined; }
}

interface ReplaySample {
  kind: 'positive' | 'negative';
  runDir: string;
  round?: number;
  artifactPath: string;
  qaSummary?: string;
}

/**
 * Replays the role's current checks on the ledger's historical outlines and writes `calibration.json`.
 * Positive samples are finished runs with `passed: true`. Negative samples are rounds whose QA verdict
 * is `revise`. Runs that never reached a verdict are skipped, and each work directory is used once
 * (its latest ledger line).
 */
export async function calibrateRole(options: CalibrateRoleOptions): Promise<CalibrationReport> {
  const roleDirectory = path.resolve(options.roleDirectory);
  const now = options.now ?? (() => new Date());
  const python = options.python ?? 'python3';
  const only = options.only?.filter(Boolean);
  const onlySet = only?.length ? new Set(only) : undefined;
  const roleId = z.object({ id: z.string().min(1) }).passthrough().parse(JSON.parse(await readFile(path.join(roleDirectory, 'profile.json'), 'utf8'))).id;
  const [role, checksDigest, checklist, workflow] = await Promise.all([
    roleVersion(roleDirectory), computeChecksDigest(roleDirectory), loadChecklist(roleDirectory), loadWorkflow(roleDirectory),
  ]);
  const enforce = workflow.policies.formal.enforceObserveAsBlock;
  const known = new Map<string, NormalizedCheckItem>(checklist.items.map(item => [item.id, item]));
  const lines = await readLedger(options.workspace, roleId);
  const latest = lines.filter((entry, index) => !lines.slice(index + 1).some(later => later.workDirectory === entry.workDirectory));
  const runs = latest.filter(entry => !UNFINISHED.includes(entry.stopReason));
  const runner = options.checkRunner ?? defaultCheckRunner;
  const falsePositives: CalibrationReport['falsePositives'] = [];
  const caughtHistoricalIssues: CalibrationReport['caughtHistoricalIssues'] = [];
  let positiveSamples = 0, negativeSamples = 0;
  for (const run of runs) {
    for (const sample of await replaySamples(run)) {
      if (sample.kind === 'positive') positiveSamples++;
      else negativeSamples++;
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
      if (replay.kind === 'positive') falsePositives.push({ runDir: replay.runDir, artifactPath: replay.artifactPath, failedChecks: replay.failedChecks, ...(replay.evidence !== undefined ? { evidence: replay.evidence } : {}) });
      else caughtHistoricalIssues.push({
        runDir: replay.runDir, round: replay.round ?? 0, artifactPath: replay.artifactPath, caughtBy: replay.failedChecks,
        ...(replay.qaSummary ? { qaSummary: replay.qaSummary } : {}),
      });
    }
  }
  const report: CalibrationReport = {
    schemaVersion: 1, roleId, role, checksDigest, calibratedAt: now().toISOString(),
    ...(onlySet ? { only: [...onlySet] } : {}),
    positiveSamples, negativeSamples, falsePositives, caughtHistoricalIssues,
    passed: falsePositives.length === 0,
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
