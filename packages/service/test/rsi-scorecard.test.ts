import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runRsiCli } from '../bin/rsi.js';
import { checkGate } from '../src/rsi/gate.js';
import type { LedgerEntry } from '../src/rsi/outline-run.js';
import { buildScorecardFromEntries, computeRoleScorecard, formatRouteKey, formatScorecardText, passPowK, percentile } from '../src/rsi/scorecard.js';

let seq = 0;
function makeEntry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    startedAt: '2026-11-27T01:00:00.000Z',
    phase: 'dev',
    caseId: 'demo',
    caseKind: 'original',
    role: { commit: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', dirty: false },
    passed: true,
    stopReason: 'passed',
    firstDraftPassed: true,
    bounces: 0,
    revisions: 0,
    scores: [],
    mustIssues: 0,
    proposals: [],
    workDirectory: `/work-${++seq}`,
    ticketPath: '/ticket.json',
    ...over,
  };
}

async function roleFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-scorecard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const role = join(root, 'role');
  const workspace = join(root, 'workspace');
  await mkdir(join(role, 'checks'), { recursive: true });
  await mkdir(join(role, 'cases'), { recursive: true });
  await writeFile(join(role, 'profile.json'), JSON.stringify({ id: 'demo-role' }));
  await writeFile(join(role, 'checklist.json'), JSON.stringify({
    schemaVersion: 2, roleId: 'demo-role', artifacts: ['outline.json'],
    items: [{ id: 'P1', kind: 'program', severity: 'must', locked: true, rule: 'ok' }],
  }));
  const git = (...args: string[]) => execFileSync('git', ['-C', role, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const commit = git('rev-parse', 'HEAD');
  return { root, role, workspace, commit };
}

test('percentile and unbiased pass^k math handle edge cases cleanly', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([7], 90), 7);
  assert.equal(percentile([0, 1, 2, 3, 4], 50), 2);
  assert.equal(percentile([0, 1, 2, 3, 4], 90), 3.6);
  assert.equal(passPowK(1, 1, 2), null);
  assert.equal(passPowK(2, 2, 3), null);
  assert.equal(passPowK(4, 4, 2), 1);
  assert.equal(passPowK(4, 4, 3), 1);
  assert.equal(passPowK(2, 4, 2), Number((2 / 12).toFixed(6)));
  assert.equal(passPowK(2, 4, 3), 0);
  assert.equal(formatRouteKey(undefined), 'unknown');
  assert.equal(formatRouteKey({ provider: 'magpie', model: 'group/deepseek-v4.1' }), 'magpie/group/deepseek-v4.1');
  assert.equal(formatRouteKey({ provider: 'openai' }), 'openai');
  assert.equal(formatRouteKey({ model: 'gpt-5' }), 'gpt-5');
});

test('scorecard reads legacy rows without metrics, deduplicates resumed runs, groups by roleVersion x route, and supports --since', () => {
  const v1 = '1111111111111111111111111111111111111111';
  const v2 = '2222222222222222222222222222222222222222';
  const entries: LedgerEntry[] = [
    // Legacy row (no route/usage/durationMs/env/reworkRounds)
    makeEntry({ startedAt: '2026-11-25T00:00:00.000Z', role: { commit: v1, dirty: false }, workDirectory: '/w1', passed: true, firstDraftPassed: true }),
    // Resumed run on same workDirectory: earlier unfinished line must be superseded by later passed line
    makeEntry({ startedAt: '2026-11-26T00:00:00.000Z', role: { commit: v2, dirty: false }, workDirectory: '/w2', passed: false, stopReason: 'not_completed', firstDraftPassed: false }),
    makeEntry({
      startedAt: '2026-11-26T00:00:00.000Z', role: { commit: v2, dirty: false }, workDirectory: '/w2',
      passed: true, stopReason: 'passed', firstDraftPassed: true, bounces: 0, revisions: 0, reworkRounds: 0, mustIssues: 0,
      route: { provider: 'magpie', model: 'deepseek' }, usage: { promptTokens: 1000, completionTokens: 200, costUsd: 0.02 }, durationMs: 1200,
    }),
    makeEntry({
      startedAt: '2026-11-27T01:00:00.000Z', role: { commit: v2, dirty: false }, workDirectory: '/w3',
      passed: true, stopReason: 'passed', firstDraftPassed: false, bounces: 1, revisions: 1, reworkRounds: 2, mustIssues: 0,
      route: { provider: 'magpie', model: 'deepseek' }, usage: { promptTokens: 2000, completionTokens: 500, costUsd: 0.05 }, durationMs: 3600,
    }),
    makeEntry({
      startedAt: '2026-11-27T02:00:00.000Z', role: { commit: v2, dirty: false }, workDirectory: '/w4',
      passed: false, stopReason: 'max_bounces', firstDraftPassed: false, bounces: 2, revisions: 0, reworkRounds: 2, mustIssues: 2,
      route: { provider: 'magpie', model: 'deepseek' }, usage: { promptTokens: 1500, completionTokens: 300, costUsd: 0.08 }, durationMs: 4800,
    }),
    makeEntry({
      startedAt: '2026-11-27T03:00:00.000Z', role: { commit: v2, dirty: false }, workDirectory: '/w5',
      passed: true, stopReason: 'passed', firstDraftPassed: true, bounces: 0, revisions: 0, reworkRounds: 0, mustIssues: 0,
      route: { provider: 'anthropic', model: 'claude' }, usage: { costUsd: 0.12 }, durationMs: 2500,
    }),
  ];

  const full = buildScorecardFromEntries({ roleId: 'demo-role', ledgerFile: '/ledger.jsonl', entries });
  assert.equal(full.totalEntries, 5);
  assert.equal(full.groups.length, 3);

  const legacyGroup = full.groups.find(g => g.roleVersion === v1 && g.route === 'unknown')!;
  assert.equal(legacyGroup.runs, 1);
  assert.equal(legacyGroup.passRate, 1);
  assert.equal(legacyGroup.passPowK['2'], null);
  assert.deepEqual(legacyGroup.cost, { p50: null, p90: null, samples: 0 });
  assert.deepEqual(legacyGroup.durationMs, { p50: null, p90: null, samples: 0 });

  const deepseekGroup = full.groups.find(g => g.roleVersion === v2 && g.route === 'magpie/deepseek')!;
  assert.equal(deepseekGroup.runs, 3);
  assert.equal(deepseekGroup.passed, 2);
  assert.equal(deepseekGroup.firstDraftPassRate, Number((1 / 3).toFixed(6)));
  assert.equal(deepseekGroup.passRate, Number((2 / 3).toFixed(6)));
  assert.equal(deepseekGroup.passPowK['2'], Number((1 / 3).toFixed(6)));
  assert.equal(deepseekGroup.passPowK['3'], 0);
  assert.deepEqual(deepseekGroup.bounces, { p50: 1, p90: 1.8 });
  assert.deepEqual(deepseekGroup.revisions, { p50: 0, p90: 0.8 });
  assert.deepEqual(deepseekGroup.cost, { p50: 0.05, p90: 0.074, samples: 3 });
  assert.deepEqual(deepseekGroup.durationMs, { p50: 3600, p90: 4560, samples: 3 });
  assert.deepEqual(deepseekGroup.stopReasons, { passed: 2, max_bounces: 1 });
  assert.equal(deepseekGroup.mustIssues.mean, Number((2 / 3).toFixed(6)));

  const sinceCommit = buildScorecardFromEntries({ roleId: 'demo-role', ledgerFile: '/ledger.jsonl', entries, since: '22222222' });
  assert.equal(sinceCommit.totalEntries, 4);
  assert.equal(sinceCommit.groups.some(g => g.roleVersion === v1), false);

  const sinceDate = buildScorecardFromEntries({ roleId: 'demo-role', ledgerFile: '/ledger.jsonl', entries, since: '2026-11-27' });
  assert.equal(sinceDate.totalEntries, 3);

  const sinceMissing = buildScorecardFromEntries({ roleId: 'demo-role', ledgerFile: '/ledger.jsonl', entries, since: 'deadbeef' });
  assert.equal(sinceMissing.totalEntries, 0);
  assert.deepEqual(sinceMissing.groups, []);

  assert.match(formatScorecardText(full), /运行评分卡（observe-only/);
});

test('CLI rsi scorecard --role --json works end-to-end and rsi gate output is unchanged by new ledger metrics', async t => {
  const f = await roleFixture(t);
  await mkdir(join(f.workspace, 'demo-role'), { recursive: true });
  const legacyEntries = [
    makeEntry({ startedAt: '2026-11-27T01:00:00.000Z', role: { commit: f.commit, dirty: false }, workDirectory: '/g1' }),
    makeEntry({ startedAt: '2026-11-27T02:00:00.000Z', role: { commit: f.commit, dirty: false }, workDirectory: '/g2' }),
  ];
  const ledgerFile = join(f.workspace, 'demo-role', 'ledger.jsonl');
  await writeFile(ledgerFile, legacyEntries.map(row => JSON.stringify(row)).join('\n') + '\n');
  const gateBefore = await checkGate({ roleDirectory: f.role, workspace: f.workspace });

  const enrichedEntries = legacyEntries.map((row, idx) => ({
    ...row,
    route: { provider: 'magpie', model: 'group/deepseek-v4.1' },
    usage: { promptTokens: 1000 * (idx + 1), completionTokens: 200 * (idx + 1), costUsd: 0.03 * (idx + 1) },
    durationMs: 1500 * (idx + 1),
    env: { harnessVersion: '1.1.1', nodeVersion: process.version, timeoutMs: 60000 },
    reworkRounds: 0,
  }));
  await writeFile(ledgerFile, enrichedEntries.map(row => JSON.stringify(row)).join('\n') + '\n');
  const gateAfter = await checkGate({ roleDirectory: f.role, workspace: f.workspace });

  // Zero behavioral change in rsi gate decisions or reasons.
  assert.equal(gateAfter.ready, gateBefore.ready);
  assert.deepEqual(gateAfter.reasons, gateBefore.reasons);
  assert.equal(gateAfter.l1Mismatches, gateBefore.l1Mismatches);
  assert.deepEqual(gateAfter.calibration, gateBefore.calibration);
  assert.deepEqual(gateAfter.testCases, gateBefore.testCases);

  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  try {
    await runRsiCli(['scorecard', '--role', f.role, '--workspace', f.workspace, '--json']);
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output.join('\n')) as Awaited<ReturnType<typeof computeRoleScorecard>>;
  assert.equal(parsed.roleId, 'demo-role');
  assert.equal(parsed.totalEntries, 2);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0]!.route, 'magpie/group/deepseek-v4.1');
  assert.equal(parsed.groups[0]!.passRate, 1);
  assert.equal(parsed.groups[0]!.passPowK['2'], 1);
  assert.equal(parsed.groups[0]!.cost.p50, 0.045);

  // Confirm scorecard is read-only and never mutates ledger.jsonl.
  assert.equal(await readFile(ledgerFile, 'utf8'), enrichedEntries.map(row => JSON.stringify(row)).join('\n') + '\n');

  // Missing ledger returns empty scorecard cleanly without failing.
  const empty = await computeRoleScorecard({ roleDirectory: f.role, workspace: join(f.root, 'empty-ws') });
  assert.equal(empty.totalEntries, 0);
  assert.deepEqual(empty.groups, []);
  assert.equal(resolve(empty.ledgerPath), resolve(f.root, 'empty-ws', 'demo-role', 'ledger.jsonl'));
});
