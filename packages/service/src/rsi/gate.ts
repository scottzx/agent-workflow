/**
 * The gate from development to testing, decided from the role's ledger. Development is done when the current
 * committed role version has passed the development case several times in a row, each first draft passed the
 * program checks, and every proposal QA made to codify a check or change a locked item has been settled by a
 * person (accepted, rejected or done on the ticket). Any change to the role directory is a new version, so the
 * count starts again. Runs that never reached a verdict (the executor or QA task did not finish, e.g. the model
 * quota ran out, or the host itself failed) say nothing about the role and are left out.
 * Two further bars apply when the evidence exists: no self-check that disagreed with the program (L1), and a
 * current replay calibration when this version's checks differ from the previous passing version (L3).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Ticket } from '../execution/ticket.js';
import { computeChecksDigest, loadCalibration } from './calibrate.js';
import { type LedgerEntry, ledgerPath, roleVersion, type RoleVersion, type StopReason } from './outline-run.js';

const UNFINISHED: StopReason[] = ['not_completed', 'review_failed', 'host_error'];

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
  /** Replay calibration against the current checks. `not_required` when nothing to compare and nobody asked. */
  calibration: {
    required: boolean;
    status: 'passed' | 'failed' | 'missing' | 'stale' | 'not_required';
    checksDigest?: string;
    falsePositives?: number;
  };
}

export async function checkGate(options: { roleDirectory: string; workspace: string; required?: number;
  /** Block until `acp-service rsi calibrate` has a clean report for this version, even with no older run to compare. */
  requireCalibration?: boolean;
  /** The gateway, for the proposals' current state; without it every proposal in the ledger counts as open. */
  invoke?: (method: string, params: Record<string, unknown>) => Promise<unknown> }): Promise<GateReport> {
  const roleDirectory = path.resolve(options.roleDirectory), required = options.required ?? 2;
  const roleId = z.object({ id: z.string().min(1) }).passthrough().parse(JSON.parse(await readFile(path.join(roleDirectory, 'profile.json'), 'utf8'))).id;
  const role = await roleVersion(roleDirectory);
  const text = await readFile(ledgerPath(options.workspace, roleId), 'utf8').catch(() => '');
  const lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as LedgerEntry);
  // A resumed run appends a new line for the same work directory; its latest line is the run.
  const history = lines.filter((entry, index) => !lines.slice(index + 1).some(later => later.workDirectory === entry.workDirectory));
  const entries = history.filter(entry => role.commit && entry.role.commit === role.commit && !entry.role.dirty);
  const dev = entries.filter(entry => entry.phase === 'dev' && entry.caseKind === 'original');
  const unfinished = dev.filter(entry => UNFINISHED.includes(entry.stopReason));
  const devRuns = dev.filter(entry => !UNFINISHED.includes(entry.stopReason)).slice(-required);
  const reasons: string[] = [];
  let l1Mismatches = 0;
  if (role.dirty) reasons.push('角色目录有未提交的改动，先提交成一个版本');
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
  const casesDirectory = path.join(roleDirectory, 'cases');
  const testCases: GateReport['testCases'] = [];
  const names = (await readdir(casesDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const name of names) {
    const kase = JSON.parse(await readFile(path.join(casesDirectory, name, 'case.json'), 'utf8')) as { id: string; kind: string };
    const latestCase = entries.filter(entry => entry.phase === 'test' && entry.caseId === kase.id).at(-1);
    testCases.push({ caseId: kase.id, kind: kase.kind, result: !latestCase ? 'not_run' : latestCase.passed ? 'passed' : 'failed' });
  }
  const calibration = await calibrationGate({ roleDirectory, workspace: options.workspace, roleId, role, history, requireCalibration: options.requireCalibration === true });
  if (calibration.reason) reasons.push(calibration.reason);
  return { roleId, role, ready: reasons.length === 0, reasons, required, devRuns, unfinished, testCases, l1Mismatches, calibration: calibration.report };
}

/**
 * L3: a clean `calibration.json` bound to this commit and these checks. It is required when the caller asks, or
 * when an older passing version recorded a different checks digest. No such record and no report means a new role
 * (or a ledger from before digests) and does not block.
 */
async function calibrationGate(input: {
  roleDirectory: string; workspace: string; roleId: string; role: RoleVersion; history: LedgerEntry[]; requireCalibration: boolean;
}): Promise<{ report: GateReport['calibration']; reason?: string }> {
  let checksDigest: string | undefined;
  try { checksDigest = await computeChecksDigest(input.roleDirectory); }
  catch { checksDigest = undefined; }
  const previous = [...input.history].reverse().find(entry => entry.passed && !UNFINISHED.includes(entry.stopReason) && !entry.role.dirty
    && Boolean(entry.role.commit) && entry.role.commit !== input.role.commit);
  const digestChanged = Boolean(previous?.checksDigest && checksDigest && previous.checksDigest !== checksDigest);
  const saved = await loadCalibration(input.workspace, input.roleId);
  const base = { ...(checksDigest ? { checksDigest } : {}), ...(saved ? { falsePositives: saved.falsePositives.length } : {}) };
  const stale = saved !== undefined && (!checksDigest || saved.role.commit !== input.role.commit || saved.checksDigest !== checksDigest);
  const failed = saved !== undefined && !stale && (!saved.passed || saved.falsePositives.length > 0);
  let status: GateReport['calibration']['status'];
  if (stale) status = 'stale';
  else if (failed) status = 'failed';
  else if (saved) status = 'passed';
  else if (input.requireCalibration || digestChanged) status = 'missing';
  else status = 'not_required';
  const required = status !== 'not_required' && (status !== 'passed' || input.requireCalibration || digestChanged);
  const reason = status === 'stale'
    ? '回放校准已过期（角色版本或 checks 摘要与当前不一致），请重新运行 acp-service rsi calibrate'
    : status === 'failed'
      ? `回放校准未通过：历史正样本有 ${saved!.falsePositives.length} 条误报，先修正检查再运行 acp-service rsi calibrate`
      : status === 'missing'
        ? '还没有绑定当前版本的回放校准（acp-service rsi calibrate），不能放行'
        : undefined;
  return { report: { required, status, ...base }, ...(reason ? { reason } : {}) };
}
