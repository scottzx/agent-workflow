/**
 * The gate from development to testing, decided from the role's ledger. Development is done when the current
 * committed role version has passed the development case several times in a row, each first draft passed the
 * program checks, and every proposal QA made to codify a check or change a locked item has been settled by a
 * person (accepted, rejected or done on the ticket). Any change to the role directory is a new version, so the
 * count starts again. Runs that never reached a verdict (the executor or QA task did not finish, e.g. the model
 * quota ran out, or the host itself failed) say nothing about the role and are left out.
 * Two further bars apply when the evidence exists: no self-check that disagreed with the program (L1), and a
 * current bidirectional replay calibration when this version's role directory (including ROLE.md/QA.md/checks/skills)
 * differs from the previous passing version (L3).
 *
 * Roles without `cases/` that use `evals/manifest.json` (such as `pr-delivery`) do not throw ENOENT;
 * instead they verify `evals/manifest.json` commit ancestry and re-score the bound `eval-cr.json` results in-process
 * (never trusting a self-attested `promotionReady` boolean).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Ticket } from '../execution/ticket.js';
import { assertSafeRoleWorkspaceId, computeChecksDigest, computeRoleDigest, loadCalibration } from './calibrate.js';
import { type LedgerEntry, ledgerPath, roleVersion, type RoleVersion, type StopReason } from './outline-run.js';
import {
  coerceCrEvalResults,
  computeCrEvalDigest,
  crReviewResultSchema,
  findRepoRoot,
  loadCrEvalManifest,
  loadRoleHumanCalibration,
  scoreCrEvalSuite,
  verifyCrEvalCommits,
  type CrEvalScore,
  type CrReviewResult,
} from './pr-cr-eval.js';
import { computeRubricDigest, loadRubric, readRubricCalibration } from './rubric.js';
import {
  digestPairwiseVotes,
  evaluatePairwiseRegression,
  POLICY_MIN_PAIRWISE_JUDGES,
  POLICY_MIN_PAIRWISE_WIN_RATE,
  readPairwiseRegression,
} from './pairwise.js';

const execFileAsync = promisify(execFile);
const UNFINISHED: StopReason[] = ['not_completed', 'review_failed', 'host_error'];

const savedCrEvalReportSchema = z.object({
  schemaVersion: z.literal(1),
  roleId: z.string().min(1),
  evalDigest: z.string().regex(/^[0-9a-f]{64}$/),
  roleDigest: z.string().regex(/^[0-9a-f]{64}$/),
  resultsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  scoredAt: z.string().min(1),
  results: z.array(crReviewResultSchema).min(1),
}).passthrough();

export interface SavedCrEvalReport {
  schemaVersion: 1;
  roleId: string;
  evalDigest: string;
  roleDigest: string;
  resultsDigest: string;
  scoredAt: string;
  results: CrReviewResult[];
  score: CrEvalScore;
}

export interface CrEvalGateSummary {
  present: boolean;
  evalDigest?: string;
  roleDigest?: string;
  verified: boolean;
  checkedCommits: number;
  errors: string[];
  status: 'passed' | 'failed' | 'missing' | 'stale' | 'not_applicable';
  promotionReady?: boolean;
}

export interface GateReport {
  roleId: string; role: RoleVersion; ready: boolean; reasons: string[]; required: number;
  /** The latest development runs on this version, newest last. */
  devRuns: LedgerEntry[];
  /** Development runs on this version that never reached a verdict and so do not count. */
  unfinished: LedgerEntry[];
  /** Every case in the role, with its latest test result on this version. */
  testCases: { caseId: string; kind: string; result: 'passed' | 'failed' | 'not_run' }[];
  /** `self_vs_program` disagreements on the recent development runs whose tickets were read. Old runs stay at 0. */
  l1Mismatches: number;
  /** Replay calibration against the current checks & role directory. `not_required` when nothing to compare and nobody asked. */
  calibration: {
    required: boolean;
    status: 'passed' | 'failed' | 'missing' | 'stale' | 'not_required';
    checksDigest?: string;
    roleDigest?: string;
    falsePositives?: number;
    negativeRecall?: number | null;
    holdoutPassed?: boolean;
  };
  /** Eval-CR gate summary when the role contains `evals/manifest.json` (e.g. `pr-delivery`). */
  crEval?: CrEvalGateSummary;
  /** Dual-ceiling rubric calibration status when `rubric.json` is present. */
  rubricCalibration?: {
    present: boolean;
    status: 'passed' | 'failed' | 'stale' | 'not_required';
    rubricDigest?: string;
    blockedBy?: string[];
  };
  /** A/B position-swapped dual-judge pairwise regression status when `rubric.json` is present. */
  pairwiseRegression?: {
    present: boolean;
    status: 'passed' | 'failed' | 'stale' | 'missing' | 'not_required';
    rubricDigest?: string;
    winRate?: number;
    minWinRate?: number;
  };
}

export function crEvalReportPath(workspace: string, roleId: string): string {
  assertSafeRoleWorkspaceId(roleId);
  return path.join(path.resolve(workspace), roleId, 'eval-cr.json');
}

function digestCrResults(results: readonly CrReviewResult[]): string {
  return createHash('sha256').update(JSON.stringify(results)).digest('hex');
}

/**
 * Producer for `<workspace>/<roleId>/eval-cr.json` (called by `acp-service rsi eval-cr --results`).
 * Stores the normalized `results` array + `evalDigest` + `roleDigest` + `resultsDigest` so `checkGate`
 * can re-score the suite in-process instead of trusting a hand-written boolean.
 */
export async function writeCrEvalReport(options: {
  roleDirectory: string;
  workspace: string;
  results: CrReviewResult[];
  score: CrEvalScore;
  now?: () => Date;
}): Promise<{ path: string; report: SavedCrEvalReport }> {
  const roleDirectory = path.resolve(options.roleDirectory);
  const roleId = z.object({ id: z.string().min(1) }).passthrough().parse(JSON.parse(await readFile(path.join(roleDirectory, 'profile.json'), 'utf8'))).id;
  assertSafeRoleWorkspaceId(roleId);
  const [evalDigest, roleDigest] = await Promise.all([
    computeCrEvalDigest(roleDirectory),
    computeRoleDigest(roleDirectory),
  ]);
  const normalizedResults = options.results.map(item => crReviewResultSchema.parse(item));
  const report: SavedCrEvalReport = {
    schemaVersion: 1,
    roleId,
    evalDigest,
    roleDigest,
    resultsDigest: digestCrResults(normalizedResults),
    scoredAt: (options.now ?? (() => new Date()))().toISOString(),
    results: normalizedResults,
    score: options.score,
  };
  const outPath = crEvalReportPath(options.workspace, roleId);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { path: outPath, report };
}

export async function checkGate(options: {
  roleDirectory: string;
  workspace: string;
  required?: number;
  /** Block until `acp-service rsi calibrate` has a clean report for this version, even with no older run to compare. */
  requireCalibration?: boolean;
  /** Block until `acp-service rsi pairwise` has a passing A/B swapped dual-judge regression report bound to `rubricDigest`. */
  requirePairwise?: boolean;
  /** Optional git repository root for `evals/manifest.json` commit ancestry checks (defaults to nearest `.git` above roleDirectory). */
  repoRoot?: string;
  /** The gateway, for the proposals' current state; without it every proposal in the ledger counts as open. */
  invoke?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}): Promise<GateReport> {
  const roleDirectory = path.resolve(options.roleDirectory), required = options.required ?? 2;
  const roleId = z.object({ id: z.string().min(1) }).passthrough().parse(JSON.parse(await readFile(path.join(roleDirectory, 'profile.json'), 'utf8'))).id;
  assertSafeRoleWorkspaceId(roleId);
  const role = await roleVersion(roleDirectory);
  const text = await readFile(ledgerPath(options.workspace, roleId), 'utf8').catch(() => '');
  const lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as LedgerEntry);
  // A resumed run appends a new line for the same work directory; its latest line is the run.
  const history = lines.filter((entry, index) => !lines.slice(index + 1).some(later => later.workDirectory === entry.workDirectory));
  const entries = history.filter(entry => role.commit && entry.role.commit === role.commit && !entry.role.dirty);
  const dev = entries.filter(entry => entry.phase === 'dev' && entry.caseKind === 'original');
  const unfinished = dev.filter(entry => UNFINISHED.includes(entry.stopReason));
  const devRuns = dev.filter(entry => !UNFINISHED.includes(entry.stopReason)).slice(-required);

  const casesDirectory = path.join(roleDirectory, 'cases');
  let hasCasesDir = true;
  let caseEntries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    caseEntries = await readdir(casesDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      hasCasesDir = false;
    } else {
      throw error;
    }
  }

  const testCases: GateReport['testCases'] = [];
  const names = caseEntries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const name of names) {
    const kase = JSON.parse(await readFile(path.join(casesDirectory, name, 'case.json'), 'utf8')) as { id: string; kind: string };
    const latestCase = entries.filter(entry => entry.phase === 'test' && entry.caseId === kase.id).at(-1);
    testCases.push({ caseId: kase.id, kind: kase.kind, result: !latestCase ? 'not_run' : latestCase.passed ? 'passed' : 'failed' });
  }

  let roleDigest: string | undefined;
  try { roleDigest = await computeRoleDigest(roleDirectory); }
  catch { roleDigest = undefined; }

  const crEvalResult = await evalCrGate({
    roleDirectory,
    workspace: options.workspace,
    roleId,
    ...(roleDigest ? { roleDigest } : {}),
    ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
  });

  const reasons: string[] = [];
  let l1Mismatches = 0;
  if (role.dirty) reasons.push('角色目录有未提交的改动，先提交成一个版本');

  // Roles driven by evals/manifest.json without cases/ (e.g. pr-delivery) do not require outline devRuns.
  const isEvalCrOnlyRole = !hasCasesDir && crEvalResult.summary.present;
  if (!isEvalCrOnlyRole) {
    if (devRuns.length < required) reasons.push(`当前版本在开发题上有 ${devRuns.length} 次运行，需要连续 ${required} 次通过`);
    for (const run of devRuns) {
      const at = `${run.startedAt} ${run.caseId}`;
      if (!run.passed) reasons.push(`${at}：未通过（${run.stopReason}）`);
      if (!run.firstDraftPassed) reasons.push(`${at}：初稿没有一次通过程序检查`);
      if (run.mustIssues) reasons.push(`${at}：还有 ${run.mustIssues} 条必须改`);
      // Entries written before the ledger carried the job fall back to the run's own record.
      const jobId = run.jobId ?? await readFile(path.join(run.workDirectory, 'run.json'), 'utf8')
        .then(text => (JSON.parse(text) as { rounds?: { jobId?: string }[] }).rounds?.[0]?.jobId, () => undefined);
      const ticket = options.invoke && jobId
        ? await options.invoke('ticket_get', { originSessionId: run.originSessionId ?? 'rsi-cli', jobId }) as Ticket : undefined;
      const open = (ticket ? ticket.proposals.filter(p => p.state === 'open') : run.proposals.map((p, i) => ({ ...p, id: `#${i + 1}` })))
        .filter(p => p.kind === 'check' || p.kind === 'locked');
      if (open.length) reasons.push(`${at}：质检有 ${open.length} 条提议还没人处理（${open.map(p => `${p.id} ${p.kind}`).join('、')}）`
        + (jobId ? `，用 acp-service ticket proposal --job ${jobId} --id <编号> accept|reject|done 处理` : ''));
      // Only a ticket this call actually read can disagree with the program. Runs without one add nothing.
      if (options.invoke && ticket) {
        const mismatches = (ticket.items ?? []).filter(item => item.crossCheck?.kind === 'self_vs_program');
        l1Mismatches += mismatches.length;
        if (mismatches.length) reasons.push(`${at}：存在 ${mismatches.length} 条自检与机检不一致（L1 对校分歧）`);
      }
    }
  }

  for (const reason of crEvalResult.reasons) reasons.push(reason);

  const calibration = await calibrationGate({
    roleDirectory,
    workspace: options.workspace,
    roleId,
    role,
    history,
    ...(roleDigest ? { roleDigest } : {}),
    requireCalibration: options.requireCalibration === true,
  });
  if (calibration.reason) reasons.push(calibration.reason);
  const rubricCal = await rubricCalibrationGate({ roleDirectory, workspace: options.workspace, roleId });
  if (rubricCal.reason) reasons.push(rubricCal.reason);
  const pairwiseReg = await pairwiseRegressionGate({
    roleDirectory,
    workspace: options.workspace,
    roleId,
    requirePairwise: options.requirePairwise === true,
  });
  if (pairwiseReg.reason) reasons.push(pairwiseReg.reason);
  return {
    roleId,
    role,
    ready: reasons.length === 0,
    reasons,
    required,
    devRuns,
    unfinished,
    testCases,
    l1Mismatches,
    calibration: calibration.report,
    ...(crEvalResult.summary.present ? { crEval: crEvalResult.summary } : {}),
    ...(rubricCal.report ? { rubricCalibration: rubricCal.report } : {}),
    ...(pairwiseReg.report ? { pairwiseRegression: pairwiseReg.report } : {}),
  };
}

async function isFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function evalCrGate(input: {
  roleDirectory: string;
  workspace: string;
  roleId: string;
  roleDigest?: string;
  repoRoot?: string;
}): Promise<{ summary: CrEvalGateSummary; reasons: string[] }> {
  const manifestPath = path.join(input.roleDirectory, 'evals', 'manifest.json');
  if (!await isFile(manifestPath)) {
    return {
      summary: { present: false, verified: false, checkedCommits: 0, errors: [], status: 'not_applicable' },
      reasons: [],
    };
  }
  const reasons: string[] = [];
  let manifest;
  let evalDigest: string;
  let verified = false;
  let checkedCommits = 0;
  let errors: string[] = [];
  try {
    manifest = await loadCrEvalManifest(input.roleDirectory);
    evalDigest = await computeCrEvalDigest(input.roleDirectory);
    const repoRoot = input.repoRoot ? path.resolve(input.repoRoot) : await findRepoRoot(input.roleDirectory);
    const verification = await verifyCrEvalCommits(manifest, repoRoot);
    verified = verification.ok;
    checkedCommits = verification.checkedCommits;
    errors = verification.errors;
    if (!verification.ok) {
      reasons.push(`CR 黄金回放提交核验未通过：${verification.errors.join('；')}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors = [message];
    reasons.push(`CR 黄金回放清单无效：${message}`);
    return {
      summary: { present: true, verified: false, checkedCommits: 0, errors, status: 'failed' },
      reasons,
    };
  }

  const reportFile = crEvalReportPath(input.workspace, input.roleId);
  let rawText: string;
  try {
    rawText = await readFile(reportFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      reasons.push(`缺少绑定当前 evalDigest 的 CR 黄金回放结果，请运行 acp-service rsi eval-cr --role ${input.roleDirectory} --results <file> --workspace ${input.workspace}`);
      return {
        summary: { present: true, evalDigest, ...(input.roleDigest ? { roleDigest: input.roleDigest } : {}), verified, checkedCommits, errors, status: 'missing' },
        reasons,
      };
    }
    throw error;
  }

  let saved: z.infer<typeof savedCrEvalReportSchema>;
  try {
    saved = savedCrEvalReportSchema.parse(JSON.parse(rawText));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reasons.push(`CR 黄金回放报告格式无效（必须包含 evalDigest、roleDigest、resultsDigest 与完整 results，不采信手写布尔值）：${message}`);
    return {
      summary: { present: true, evalDigest, ...(input.roleDigest ? { roleDigest: input.roleDigest } : {}), verified, checkedCommits, errors, status: 'failed', promotionReady: false },
      reasons,
    };
  }

  if (saved.roleId !== input.roleId || saved.resultsDigest !== digestCrResults(saved.results)) {
    reasons.push('CR 黄金回放报告完整性校验失败（roleId 或 resultsDigest 不匹配），请重新运行 acp-service rsi eval-cr --results');
    return {
      summary: { present: true, evalDigest, ...(input.roleDigest ? { roleDigest: input.roleDigest } : {}), verified, checkedCommits, errors, status: 'failed', promotionReady: false },
      reasons,
    };
  }

  const digestStale = saved.evalDigest !== evalDigest || !input.roleDigest || saved.roleDigest !== input.roleDigest;
  if (digestStale) {
    reasons.push('CR 黄金回放结果已过期（evalDigest 或角色目录摘要 roleDigest 已变更，包括 ROLE.md/QA.md/skills），请重新运行 acp-service rsi eval-cr --results');
    return {
      summary: { present: true, evalDigest, ...(input.roleDigest ? { roleDigest: input.roleDigest } : {}), verified, checkedCommits, errors, status: 'stale' },
      reasons,
    };
  }

  // Re-score the stored CR review results in-process against the live manifest (and role human-calibration.json when present) — never trust a stored boolean!
  let rescored: CrEvalScore;
  try {
    const humanCalibration = await loadRoleHumanCalibration(input.roleDirectory, input.roleId);
    rescored = scoreCrEvalSuite(manifest, coerceCrEvalResults(saved.results), {
      ...(humanCalibration ? { humanCalibration } : {}),
      requireHumanCalibration: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reasons.push(`CR 黄金回放进程内重算打分失败：${message}`);
    return {
      summary: { present: true, evalDigest, roleDigest: input.roleDigest, verified, checkedCommits, errors, status: 'failed', promotionReady: false },
      reasons,
    };
  }

  if (!rescored.promotionReady) {
    const kappaNote = rescored.judgeCalibration && !rescored.judgeCalibration.passed
      ? `，人工校准 κ=${rescored.judgeCalibration.kappa ?? 'null'} < ${rescored.judgeCalibration.minKappa}`
      : '';
    reasons.push(`CR 黄金回放未达到晋升门槛（负样本召回 ${rescored.negativeRecall}，缺陷召回 ${rescored.defectRecall}，误报 ${rescored.falsePositives}，缺样本 ${rescored.missingCases.length}${kappaNote}）`);
    return {
      summary: { present: true, evalDigest, roleDigest: input.roleDigest, verified, checkedCommits, errors, status: 'failed', promotionReady: false },
      reasons,
    };
  }

  return {
    summary: {
      present: true,
      evalDigest,
      roleDigest: input.roleDigest,
      verified,
      checkedCommits,
      errors,
      status: verified ? 'passed' : 'failed',
      promotionReady: verified && rescored.promotionReady,
    },
    reasons,
  };
}

async function rubricCalibrationGate(input: {
  roleDirectory: string;
  workspace: string;
  roleId: string;
}): Promise<{ report?: GateReport['rubricCalibration']; reason?: string }> {
  const hasRubric = await stat(path.join(input.roleDirectory, 'rubric.json')).then(s => s.isFile(), () => false);
  if (!hasRubric) return {};
  const rubricDigest = await computeRubricDigest(input.roleDirectory);
  const loaded = await readRubricCalibration(input.workspace, input.roleId);
  if (loaded.state === 'missing') {
    return { report: { present: true, status: 'not_required', rubricDigest } };
  }
  if (loaded.state === 'invalid') {
    return {
      report: { present: true, status: 'failed', rubricDigest },
      reason: `Rubric 校准报告损坏或格式无效（${loaded.error}），请重新运行 acp-service rsi calibrate --rubric`,
    };
  }
  const saved = loaded.report;
  if (saved.rubricDigest !== rubricDigest) {
    return {
      report: { present: true, status: 'stale', rubricDigest, blockedBy: saved.blockedBy },
      reason: 'Rubric 校准报告已过期（rubric.json 或 checks 摘要已变更），请重新运行 acp-service rsi calibrate --rubric',
    };
  }
  if (!saved.passed) {
    return {
      report: { present: true, status: 'failed', rubricDigest, blockedBy: saved.blockedBy },
      reason: `Rubric 校准未通过（未达标阻断项：${saved.blockedBy.join('、')}），请调整或拆改条目后重跑 acp-service rsi calibrate --rubric`,
    };
  }
  return { report: { present: true, status: 'passed', rubricDigest, blockedBy: [] } };
}

async function pairwiseRegressionGate(input: {
  roleDirectory: string;
  workspace: string;
  roleId: string;
  requirePairwise: boolean;
}): Promise<{ report?: GateReport['pairwiseRegression']; reason?: string }> {
  const hasRubric = await stat(path.join(input.roleDirectory, 'rubric.json')).then(s => s.isFile(), () => false);
  if (!hasRubric) return {};
  let rubricDigest: string;
  try {
    rubricDigest = await computeRubricDigest(input.roleDirectory);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      report: { present: true, status: 'failed' },
      reason: `无法计算 rubric 摘要以核验 Pairwise 回归（${msg}）`,
    };
  }
  const loaded = await readPairwiseRegression(input.workspace, input.roleId);
  if (loaded.state === 'missing') {
    if (input.requirePairwise) {
      return {
        report: { present: true, status: 'missing', rubricDigest },
        reason: '缺少绑定当前 rubricDigest 的 Pairwise A/B 换位双评回归报告，请运行 acp-service rsi pairwise',
      };
    }
    return { report: { present: true, status: 'not_required', rubricDigest } };
  }
  if (loaded.state === 'invalid') {
    return {
      report: { present: true, status: 'failed', rubricDigest },
      reason: `Pairwise 回归报告损坏或格式无效（${loaded.error}），请重新运行 acp-service rsi pairwise`,
    };
  }
  const saved = loaded.report;
  if (saved.rubricDigest !== rubricDigest) {
    return {
      report: { present: true, status: 'stale', rubricDigest, winRate: saved.winRate, minWinRate: saved.config.minWinRate },
      reason: 'Pairwise 回归报告已过期（rubric.json 或 checks 摘要已变更），请重新运行 acp-service rsi pairwise',
    };
  }
  // Never trust a self-attested boolean: enforce policy floors + invariant checks AND re-evaluate votes in-process.
  if (
    !saved.config.swapPositions
    || !saved.config.tieOnDisagreement
    || saved.config.minJudges < POLICY_MIN_PAIRWISE_JUDGES
    || saved.config.minWinRate < POLICY_MIN_PAIRWISE_WIN_RATE
    || !saved.votes?.length
    || !saved.votesDigest
    || saved.votesDigest !== digestPairwiseVotes(saved.votes)
  ) {
    return {
      report: { present: true, status: 'failed', rubricDigest, winRate: saved.winRate, minWinRate: saved.config.minWinRate },
      reason: 'Pairwise 回归报告策略不变量或投票摘要校验失败（不采信手写 passed 布尔值），请重新运行 acp-service rsi pairwise',
    };
  }
  let reevaluated;
  try {
    const rubric = await loadRubric(input.roleDirectory);
    reevaluated = evaluatePairwiseRegression({
      rubric,
      rubricDigest,
      votes: saved.votes,
      ...(saved.candidateVersion ? { candidateVersion: saved.candidateVersion } : {}),
      ...(saved.baselineVersion ? { baselineVersion: saved.baselineVersion } : {}),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      report: { present: true, status: 'failed', rubricDigest },
      reason: `Pairwise 回归进程内重算失败（${msg}），请重新运行 acp-service rsi pairwise`,
    };
  }
  if (!reevaluated.passed || !reevaluated.promotionReady || reevaluated.winRate < POLICY_MIN_PAIRWISE_WIN_RATE) {
    return {
      report: { present: true, status: 'failed', rubricDigest, winRate: reevaluated.winRate, minWinRate: reevaluated.config.minWinRate },
      reason: `Pairwise A/B 换位双评回归未通过（winRate=${reevaluated.winRate} < ${reevaluated.config.minWinRate} 或存在未完成样本：${reevaluated.failureReasons.join('；')}）`,
    };
  }
  return {
    report: { present: true, status: 'passed', rubricDigest, winRate: reevaluated.winRate, minWinRate: reevaluated.config.minWinRate },
  };
}

/**
 * Checks whether any file in the role directory changed between two commits.
 * When `previousHasDigest` is true or `fromCommit` exists in git, git errors fail closed (`true`).
 * Legacy ledger entries without digests whose commit is absent in git do not retroactively block.
 */
async function roleDirectoryChangedBetween(
  roleDirectory: string,
  fromCommit: string,
  toCommit: string,
  previousHasDigest: boolean,
): Promise<boolean> {
  if (!previousHasDigest) {
    try {
      await execFileAsync('git', ['-C', roleDirectory, 'cat-file', '-e', `${fromCommit}^{commit}`], { encoding: 'utf8' });
    } catch {
      return false;
    }
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', roleDirectory, 'diff', '--name-only', fromCommit, toCommit, '--', '.'], {
      encoding: 'utf8',
    });
    return stdout.trim().length > 0;
  } catch {
    // Fail-closed: if git cannot prove the role directory is unchanged between real commits, require calibration.
    return true;
  }
}

/**
 * L3: a clean bidirectional `calibration.json` bound to this commit, checks digest, and full role digest.
 * It is required when the caller asks, or when an older passing version had a different checks digest or
 * modified any role file (including `ROLE.md` / `QA.md` / `skills/`).
 */
async function calibrationGate(input: {
  roleDirectory: string;
  workspace: string;
  roleId: string;
  role: RoleVersion;
  history: LedgerEntry[];
  roleDigest?: string;
  requireCalibration: boolean;
}): Promise<{ report: GateReport['calibration']; reason?: string }> {
  let checksDigest: string | undefined;
  try { checksDigest = await computeChecksDigest(input.roleDirectory); }
  catch { checksDigest = undefined; }
  const previous = [...input.history].reverse().find(entry => entry.passed && !UNFINISHED.includes(entry.stopReason) && !entry.role.dirty
    && Boolean(entry.role.commit) && entry.role.commit !== input.role.commit);
  const digestChanged = Boolean(previous?.checksDigest && checksDigest && previous.checksDigest !== checksDigest);
  const roleDirChanged = Boolean(
    previous?.role.commit && input.role.commit
    && await roleDirectoryChangedBetween(input.roleDirectory, previous.role.commit, input.role.commit, Boolean(previous.checksDigest)),
  );
  const saved = await loadCalibration(input.workspace, input.roleId);
  const base: Partial<GateReport['calibration']> = {
    ...(checksDigest ? { checksDigest } : {}),
    ...(input.roleDigest ? { roleDigest: input.roleDigest } : {}),
    ...(saved ? { falsePositives: saved.falsePositives.length } : {}),
    ...(saved && saved.schemaVersion === 2 ? { negativeRecall: saved.negativeRecall, holdoutPassed: saved.holdout.passed } : {}),
  };

  const roleDigestMismatch = saved !== undefined && saved.schemaVersion === 2 && Boolean(input.roleDigest) && saved.roleDigest !== input.roleDigest;
  const stale = saved !== undefined && (
    !checksDigest
    || saved.role.commit !== input.role.commit
    || saved.checksDigest !== checksDigest
    || roleDigestMismatch
  );
  const partialOnly = saved !== undefined && Boolean(saved.only?.length);
  const failed = saved !== undefined && !stale && (
    partialOnly
    || !saved.passed
    || saved.falsePositives.length > 0
    || (saved.schemaVersion === 2 && saved.negativeSamples > 0 && (saved.negativeRecall ?? 0) <= 0)
    || (saved.schemaVersion === 2 && !saved.holdout.passed)
  );
  let status: GateReport['calibration']['status'];
  if (stale) status = 'stale';
  else if (failed) status = 'failed';
  else if (saved) status = 'passed';
  else if (input.requireCalibration || digestChanged || roleDirChanged) status = 'missing';
  else status = 'not_required';
  const required = status !== 'not_required' && (status !== 'passed' || input.requireCalibration || digestChanged || roleDirChanged);

  let reason: string | undefined;
  if (status === 'stale') {
    reason = '回放校准已过期（角色版本、checks 摘要或角色目录摘要与当前不一致），请重新运行 acp-service rsi calibrate';
  } else if (status === 'failed') {
    if (partialOnly) {
      reason = '局部 --only 校准报告不能替代全量校准，请去掉 --only 重新运行 acp-service rsi calibrate';
    } else if (saved && saved.falsePositives.length > 0) {
      reason = `回放校准未通过：历史正样本有 ${saved.falsePositives.length} 条误报，先修正检查再运行 acp-service rsi calibrate`;
    } else if (saved && saved.schemaVersion === 2 && saved.failureReasons.length > 0) {
      reason = `回放校准未通过：${saved.failureReasons.join('；')}，请修正检查再运行 acp-service rsi calibrate`;
    } else {
      reason = '回放校准未通过（负样本召回或 holdout 未达标），请重新运行 acp-service rsi calibrate';
    }
  } else if (status === 'missing') {
    reason = '还没有绑定当前版本的回放校准（acp-service rsi calibrate），不能放行';
  }

  return { report: { required, status, ...base }, ...(reason ? { reason } : {}) };
}
