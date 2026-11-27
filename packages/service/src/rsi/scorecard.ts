/**
 * Observe-only role scorecard computed from `<workspace>/<role>/ledger.jsonl`.
 * Reads legacy and metric-enriched ledger rows without modifying the ledger or affecting `rsi gate`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ledgerPath, type LedgerEntry, type RunRoute, type StopReason } from './outline-run.js';

const UNFINISHED: ReadonlySet<StopReason> = new Set(['not_completed', 'review_failed', 'host_error']);
const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

export interface QuantileStats { p50: number; p90: number }
export interface OptionalQuantileStats { p50: number | null; p90: number | null; samples: number }
export interface PassPowK { '2': number | null; '3': number | null }

export interface ScorecardMetrics {
  runs: number;
  passed: number;
  unfinishedRuns: number;
  firstDraftPassRate: number;
  passRate: number;
  passPowK: PassPowK;
  bounces: QuantileStats;
  revisions: QuantileStats;
  reworkRounds: QuantileStats;
  mustIssues: { mean: number };
  cost: OptionalQuantileStats;
  durationMs: OptionalQuantileStats;
  stopReasons: Record<string, number>;
}

export interface ScorecardGroup extends ScorecardMetrics {
  roleVersion: string;
  dirty: boolean;
  route: string;
}

export interface ScorecardReport {
  schemaVersion: 1;
  roleId: string;
  ledgerPath: string;
  since?: string;
  totalEntries: number;
  overall: ScorecardMetrics;
  groups: ScorecardGroup[];
}

export function formatRouteKey(route?: RunRoute): string {
  const provider = route?.provider?.trim();
  const model = route?.model?.trim();
  if (provider && model) return `${provider}/${model}`;
  if (provider) return provider;
  if (model) return model;
  return 'unknown';
}

/** Linear-interpolated (R-7) percentile over finite numbers; returns 0 on empty input. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return roundMetric(sorted[0]!);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank), high = Math.ceil(rank);
  const interpolated = sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
  return roundMetric(interpolated);
}

/** Unbiased τ-bench pass^k = C(passed, k) / C(runs, k); returns null when runs < k. */
export function passPowK(passed: number, runs: number, k: number): number | null {
  if (runs < k || k <= 0) return null;
  if (passed < k) return 0;
  let ratio = 1;
  for (let i = 0; i < k; i++) ratio *= (passed - i) / (runs - i);
  return roundMetric(ratio);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function optionalQuantiles(values: number[]): OptionalQuantileStats {
  if (!values.length) return { p50: null, p90: null, samples: 0 };
  return { p50: percentile(values, 50), p90: percentile(values, 90), samples: values.length };
}

function aggregateMetrics(entries: LedgerEntry[]): ScorecardMetrics {
  const runs = entries.length;
  const passed = entries.filter(entry => entry.passed).length;
  const unfinishedRuns = entries.filter(entry => UNFINISHED.has(entry.stopReason)).length;
  const firstDraftPassed = entries.filter(entry => entry.firstDraftPassed).length;
  const bounces = entries.map(entry => typeof entry.bounces === 'number' && Number.isFinite(entry.bounces) ? entry.bounces : 0);
  const revisions = entries.map(entry => typeof entry.revisions === 'number' && Number.isFinite(entry.revisions) ? entry.revisions : 0);
  const reworkRounds = entries.map(entry =>
    typeof entry.reworkRounds === 'number' && Number.isFinite(entry.reworkRounds)
      ? entry.reworkRounds
      : (entry.bounces ?? 0) + (entry.revisions ?? 0),
  );
  const mustIssues = entries.map(entry => typeof entry.mustIssues === 'number' && Number.isFinite(entry.mustIssues) ? entry.mustIssues : 0);
  const costs = entries
    .map(entry => entry.usage?.costUsd)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const durations = entries
    .map(entry => entry.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const stopReasons: Record<string, number> = {};
  for (const entry of entries) {
    const key = entry.stopReason || 'unknown';
    stopReasons[key] = (stopReasons[key] ?? 0) + 1;
  }
  return {
    runs,
    passed,
    unfinishedRuns,
    firstDraftPassRate: runs ? roundMetric(firstDraftPassed / runs) : 0,
    passRate: runs ? roundMetric(passed / runs) : 0,
    passPowK: { '2': passPowK(passed, runs, 2), '3': passPowK(passed, runs, 3) },
    bounces: { p50: percentile(bounces, 50), p90: percentile(bounces, 90) },
    revisions: { p50: percentile(revisions, 50), p90: percentile(revisions, 90) },
    reworkRounds: { p50: percentile(reworkRounds, 50), p90: percentile(reworkRounds, 90) },
    mustIssues: { mean: runs ? roundMetric(mustIssues.reduce((sum, value) => sum + value, 0) / runs) : 0 },
    cost: optionalQuantiles(costs),
    durationMs: optionalQuantiles(durations),
    stopReasons,
  };
}

/** Deduplicate resumed runs by keeping the latest ledger row per workDirectory, matching gate.ts semantics. */
function deduplicateLedger(entries: LedgerEntry[]): LedgerEntry[] {
  return entries.filter((entry, index) =>
    !entry.workDirectory || !entries.slice(index + 1).some(later => later.workDirectory === entry.workDirectory),
  );
}

/**
 * Filter deduplicated ledger entries by `--since <ver>`:
 * - ISO date/timestamp prefix (YYYY-MM-DD...): keeps rows with `startedAt >= since`
 * - Commit SHA / prefix: keeps rows from the first matching commit onward in chronological ledger order
 */
function filterSince(entries: LedgerEntry[], since?: string): LedgerEntry[] {
  const token = since?.trim();
  if (!token) return entries;
  if (ISO_PREFIX_RE.test(token)) {
    const threshold = Date.parse(token);
    return Number.isFinite(threshold)
      ? entries.filter(entry => {
        const ts = Date.parse(entry.startedAt);
        return Number.isFinite(ts) ? ts >= threshold : entry.startedAt >= token;
      })
      : entries.filter(entry => entry.startedAt >= token);
  }
  const normalized = token.toLowerCase();
  const startIndex = entries.findIndex(entry => entry.role?.commit?.toLowerCase().startsWith(normalized));
  return startIndex === -1 ? [] : entries.slice(startIndex);
}

export function buildScorecardFromEntries(input: {
  roleId: string;
  ledgerFile: string;
  entries: LedgerEntry[];
  since?: string;
}): ScorecardReport {
  const deduplicated = deduplicateLedger(input.entries);
  const filtered = filterSince(deduplicated, input.since);
  const buckets = new Map<string, { roleVersion: string; dirty: boolean; route: string; entries: LedgerEntry[] }>();
  for (const entry of filtered) {
    const roleVersion = entry.role?.commit ?? 'uncommitted';
    const dirty = Boolean(entry.role?.dirty);
    const route = formatRouteKey(entry.route);
    const key = `${roleVersion}\0${dirty ? '1' : '0'}\0${route}`;
    const existing = buckets.get(key);
    if (existing) existing.entries.push(entry);
    else buckets.set(key, { roleVersion, dirty, route, entries: [entry] });
  }
  const groups: ScorecardGroup[] = [...buckets.values()]
    .sort((a, b) => a.roleVersion.localeCompare(b.roleVersion, 'en') || Number(a.dirty) - Number(b.dirty) || a.route.localeCompare(b.route, 'en'))
    .map(bucket => ({
      roleVersion: bucket.roleVersion,
      dirty: bucket.dirty,
      route: bucket.route,
      ...aggregateMetrics(bucket.entries),
    }));
  return {
    schemaVersion: 1,
    roleId: input.roleId,
    ledgerPath: input.ledgerFile,
    ...(input.since?.trim() ? { since: input.since.trim() } : {}),
    totalEntries: filtered.length,
    overall: aggregateMetrics(filtered),
    groups,
  };
}

export async function computeRoleScorecard(options: {
  roleDirectory: string;
  workspace: string;
  since?: string;
}): Promise<ScorecardReport> {
  const roleDirectory = path.resolve(options.roleDirectory);
  const roleId = z.object({ id: z.string().min(1) }).passthrough().parse(JSON.parse(await readFile(path.join(roleDirectory, 'profile.json'), 'utf8'))).id;
  const ledgerFile = ledgerPath(options.workspace, roleId);
  const text = await readFile(ledgerFile, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  const entries = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as LedgerEntry);
  return buildScorecardFromEntries({ roleId, ledgerFile, entries, since: options.since });
}

export function formatScorecardText(report: ScorecardReport): string {
  const pct = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  const num = (value: number | null, suffix = '') => value === null ? 'n/a' : `${value}${suffix}`;
  const lines = [
    `角色 ${report.roleId} 运行评分卡（observe-only，样本 ${report.totalEntries}${report.since ? `，since=${report.since}` : ''}）`,
    `总计：通过 ${report.overall.passed}/${report.overall.runs}（${pct(report.overall.passRate)}），首稿通过 ${pct(report.overall.firstDraftPassRate)}，pass^2=${pct(report.overall.passPowK['2'])}，pass^3=${pct(report.overall.passPowK['3'])}`,
    `  bounces p50/p90=${report.overall.bounces.p50}/${report.overall.bounces.p90}，revisions p50/p90=${report.overall.revisions.p50}/${report.overall.revisions.p90}，mustIssues mean=${report.overall.mustIssues.mean}`,
    `  cost p50/p90=${num(report.overall.cost.p50, ' USD')}/${num(report.overall.cost.p90, ' USD')}（n=${report.overall.cost.samples}），durationMs p50/p90=${num(report.overall.durationMs.p50)}/${num(report.overall.durationMs.p90)}（n=${report.overall.durationMs.samples}）`,
  ];
  for (const group of report.groups) {
    const version = group.roleVersion === 'uncommitted' ? '未提交' : `${group.roleVersion.slice(0, 8)}${group.dirty ? '*' : ''}`;
    lines.push(
      `  [${version} | ${group.route}] runs=${group.runs} pass=${pct(group.passRate)} firstDraft=${pct(group.firstDraftPassRate)} pass^2=${pct(group.passPowK['2'])} pass^3=${pct(group.passPowK['3'])} bounces=${group.bounces.p50}/${group.bounces.p90} revisions=${group.revisions.p50}/${group.revisions.p90} cost=${num(group.cost.p50)}/${num(group.cost.p90)}`,
    );
  }
  return lines.join('\n');
}
