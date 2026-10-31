/**
 * The gate from development to testing, decided from the role's ledger. Development is done when the current
 * committed role version has passed the development case several times in a row, each first draft passed the
 * program checks, and every proposal QA made to codify a check or change a locked item has been settled by a
 * person (accepted, rejected or done on the ticket). Any change to the role directory is a new version, so the
 * count starts again. Runs that never reached a verdict (the executor or QA task did not finish, e.g. the model
 * quota ran out) say nothing about the role and are left out.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Ticket } from '../execution/ticket.js';
import { type LedgerEntry, ledgerPath, roleVersion, type RoleVersion, type StopReason } from './outline-run.js';

const UNFINISHED: StopReason[] = ['not_completed', 'review_failed'];

export interface GateReport {
  roleId: string; role: RoleVersion; ready: boolean; reasons: string[]; required: number;
  /** The latest development runs on this version, newest last. */
  devRuns: LedgerEntry[];
  /** Development runs on this version that never reached a verdict and so do not count. */
  unfinished: LedgerEntry[];
  /** Every case in the role, with its latest test result on this version. */
  testCases: { caseId: string; kind: string; result: 'passed' | 'failed' | 'not_run' }[];
}

export async function checkGate(options: { roleDirectory: string; workspace: string; required?: number;
  /** The gateway, for the proposals' current state; without it every proposal in the ledger counts as open. */
  invoke?: (method: string, params: Record<string, unknown>) => Promise<unknown> }): Promise<GateReport> {
  const roleDirectory = path.resolve(options.roleDirectory), required = options.required ?? 2;
  const roleId = z.object({ id: z.string().min(1) }).passthrough().parse(JSON.parse(await readFile(path.join(roleDirectory, 'profile.json'), 'utf8'))).id;
  const role = await roleVersion(roleDirectory);
  const text = await readFile(ledgerPath(options.workspace, roleId), 'utf8').catch(() => '');
  const entries = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as LedgerEntry)
    .filter(entry => role.commit && entry.role.commit === role.commit && !entry.role.dirty);
  const dev = entries.filter(entry => entry.phase === 'dev' && entry.caseKind === 'original');
  const unfinished = dev.filter(entry => UNFINISHED.includes(entry.stopReason));
  const devRuns = dev.filter(entry => !UNFINISHED.includes(entry.stopReason)).slice(-required);
  const reasons: string[] = [];
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
  }
  const casesDirectory = path.join(roleDirectory, 'cases');
  const testCases: GateReport['testCases'] = [];
  const names = (await readdir(casesDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const name of names) {
    const kase = JSON.parse(await readFile(path.join(casesDirectory, name, 'case.json'), 'utf8')) as { id: string; kind: string };
    const latest = entries.filter(entry => entry.phase === 'test' && entry.caseId === kase.id).at(-1);
    testCases.push({ caseId: kase.id, kind: kase.kind, result: !latest ? 'not_run' : latest.passed ? 'passed' : 'failed' });
  }
  return { roleId, role, ready: reasons.length === 0, reasons, required, devRuns, unfinished, testCases };
}
