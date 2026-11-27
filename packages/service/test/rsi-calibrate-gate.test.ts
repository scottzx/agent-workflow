import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { calibrateRole, calibrationPath, computeChecksDigest, computeRoleDigest, holdoutPath, loadCalibration, sampleKeyOf, type CalibrationCheckRunner } from '../src/rsi/calibrate.js';
import { auditChecklistProvenance, effectiveEnforcementWithCoverage, parseChecklist } from '../src/rsi/checklist.js';
import { defaultOutlineWorkflow, runRoundDag } from '../src/rsi/engine.js';
import { checkGate, crEvalReportPath } from '../src/rsi/gate.js';
import { computeCrEvalDigest, loadCrEvalManifest, type CrReviewResult } from '../src/rsi/pr-cr-eval.js';
import type { LedgerEntry } from '../src/rsi/outline-run.js';

const execAsync = promisify(execFile);

async function roleFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-calibrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const role = join(root, 'role'), workspace = join(root, 'workspace');
  await mkdir(join(role, 'checks'), { recursive: true });
  await mkdir(join(role, 'cases'), { recursive: true });
  await writeFile(join(role, 'profile.json'), JSON.stringify({ id: 'demo-role' }));
  await writeFile(join(role, 'checklist.json'), JSON.stringify({
    schemaVersion: 2, roleId: 'demo-role', artifacts: ['outline.json'],
    items: [
      { id: 'P14', kind: 'program', severity: 'must', locked: true, rule: '不重复' },
      { id: 'P15', kind: 'program', severity: 'must', locked: true, rule: '收尾要有链接' },
    ],
  }));
  await writeFile(join(role, 'checks', 'rule.txt'), 'v1\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', role, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'v1');
  return { root, role, workspace, git };
}

/** A work directory the replayer can read: features.json, project/, and an outline. */
async function sampleDir(root: string, name: string, doc: unknown): Promise<string> {
  const dir = join(root, 'runs', name);
  await mkdir(join(dir, 'project'), { recursive: true });
  await mkdir(join(dir, 'reviews'), { recursive: true });
  await writeFile(join(dir, 'features.json'), '{"features":[]}\n');
  await writeFile(join(dir, 'project', 'README.md'), '# demo\n');
  await writeFile(join(dir, 'outline.json'), JSON.stringify(doc));
  return dir;
}

let seq = 0;
function entry(commit: string, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    startedAt: '2026-11-01T00:00:00.000Z', phase: 'dev', caseId: 'demo', caseKind: 'original',
    role: { commit, dirty: false }, passed: true, stopReason: 'passed', firstDraftPassed: true,
    bounces: 0, revisions: 0, scores: [], mustIssues: 0, proposals: [],
    workDirectory: `/missing-${++seq}`, ticketPath: '/t', ...over,
  };
}

async function writeLedger(workspace: string, entries: LedgerEntry[]) {
  await mkdir(join(workspace, 'demo-role'), { recursive: true });
  await writeFile(join(workspace, 'demo-role', 'ledger.jsonl'), entries.map(line => JSON.stringify(line)).join('\n') + '\n');
}

function scriptedRunner(seen: { artifacts: string[]; only: string[][] }): CalibrationCheckRunner {
  return async input => {
    seen.artifacts.push(input.artifactPath);
    seen.only.push(input.only ?? []);
    const doc = JSON.parse(await readFile(input.artifactPath, 'utf8')) as { fail?: string[] };
    const fail = new Set(doc.fail ?? []);
    return ['P14', 'P15'].map(itemId => ({ itemId, pass: !fail.has(itemId), evidence: fail.has(itemId) ? [{ message: `${itemId} failed` }] : [] }));
  };
}

test('checks digest is stable, and changes when checklist.json or checks/ changes', async t => {
  const f = await roleFixture(t);
  const first = await computeChecksDigest(f.role);
  assert.equal(await computeChecksDigest(f.role), first);
  await mkdir(join(f.role, 'checks', 'nested'), { recursive: true });
  await writeFile(join(f.role, 'checks', 'nested', 'extra.txt'), 'x');
  const withExtra = await computeChecksDigest(f.role);
  assert.notEqual(withExtra, first);
  await writeFile(join(f.role, 'checklist.json'), await readFile(join(f.role, 'checklist.json'), 'utf8') + '\n');
  assert.notEqual(await computeChecksDigest(f.role), withExtra);
});

test('calibrateRole passes when positive samples are clean and a historical revise round is caught', async t => {
  const f = await roleFixture(t), commit = f.git('rev-parse', 'HEAD');
  const passDir = await sampleDir(f.root, 'passed', { fail: ['P15'] });
  const good = join(passDir, 'reviews', 'outline-final.json'), bad = join(passDir, 'reviews', 'outline-r1.json');
  await writeFile(good, JSON.stringify({ fail: [] }));
  await writeFile(bad, JSON.stringify({ fail: ['P15'] }));
  await writeFile(join(passDir, 'run.json'), JSON.stringify({ rounds: [
    { round: 1, review: { outlineCopy: bad, review: { verdict: 'revise', summary: '收尾没有地址' } } },
    { round: 2, review: { outlineCopy: good, review: { verdict: 'pass', summary: '通过' } } },
  ] }));
  const junk = await sampleDir(f.root, 'unfinished', { fail: ['P15'] });
  const dup = await sampleDir(f.root, 'dup', { fail: ['P15'] });
  const bare = join(f.root, 'runs', 'bare');
  await mkdir(bare, { recursive: true });
  await writeFile(join(bare, 'outline.json'), JSON.stringify({ fail: ['P15'] }));
  await writeLedger(f.workspace, [
    entry(commit, { workDirectory: junk, stopReason: 'not_completed', passed: true }),
    entry(commit, { workDirectory: dup }),
    entry(commit, { workDirectory: dup, stopReason: 'review_failed', passed: false }),
    entry(commit, { workDirectory: bare }),
    entry(commit, { workDirectory: passDir }),
  ]);
  const before = await readFile(bad, 'utf8');
  const seen = { artifacts: [] as string[], only: [] as string[][] };
  const report = await calibrateRole({ roleDirectory: f.role, workspace: f.workspace, now: () => new Date('2026-11-26T00:00:00.000Z'), checkRunner: scriptedRunner(seen) });
  assert.equal(report.passed, true);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.roleId, 'demo-role');
  assert.equal(report.role.commit, commit);
  assert.equal(report.role.dirty, false);
  assert.equal(report.checksDigest, await computeChecksDigest(f.role));
  assert.equal(report.roleDigest, await computeRoleDigest(f.role));
  assert.equal(report.negativeRecall, 1);
  assert.equal(report.holdout.frozen, false, 'small sample set without explicit holdoutKeys does not claim frozen');
  assert.equal(report.holdout.passed, true);
  assert.equal(report.calibratedAt, '2026-11-26T00:00:00.000Z');
  assert.equal(report.positiveSamples, 1);
  assert.equal(report.negativeSamples, 1);
  assert.deepEqual(report.falsePositives, []);
  assert.deepEqual(report.caughtHistoricalIssues, [{ runDir: passDir, round: 1, artifactPath: bad, caughtBy: ['P15'], qaSummary: '收尾没有地址' }]);
  assert.deepEqual(seen.artifacts, [bad, good], 'unfinished, superseded and unreadable runs are not replayed');
  assert.deepEqual(await loadCalibration(f.workspace, 'demo-role'), report);
  assert.equal(calibrationPath(f.workspace, 'demo-role'), join(f.workspace, 'demo-role', 'calibration.json'));
  assert.equal(await readFile(bad, 'utf8'), before, 'replay does not modify the historical artifact');
  await writeFile(calibrationPath(f.workspace, 'demo-role'), '{');
  assert.equal(await loadCalibration(f.workspace, 'demo-role'), undefined);
  assert.equal(await loadCalibration(f.workspace, 'absent-role'), undefined);
});

test('a new block check that kills a historical pass is a false positive', async t => {
  const f = await roleFixture(t), commit = f.git('rev-parse', 'HEAD');
  const dir = await sampleDir(f.root, 'accepted', { fail: ['P15'] });
  await writeLedger(f.workspace, [entry(commit, { workDirectory: dir })]);
  const seen = { artifacts: [] as string[], only: [] as string[][] };
  const report = await calibrateRole({ roleDirectory: f.role, workspace: f.workspace, checkRunner: scriptedRunner(seen) });
  assert.equal(report.passed, false);
  assert.equal(report.positiveSamples, 1);
  assert.equal(report.negativeSamples, 0);
  assert.deepEqual(report.falsePositives, [{
    runDir: dir, artifactPath: join(dir, 'outline.json'), failedChecks: ['P15'],
    evidence: [{ itemId: 'P15', evidence: [{ message: 'P15 failed' }] }],
  }]);
  assert.deepEqual(report.caughtHistoricalIssues, []);
});

test('--only scores just the named checks', async t => {
  const f = await roleFixture(t), commit = f.git('rev-parse', 'HEAD');
  const dir = await sampleDir(f.root, 'mixed', { fail: ['P15'] });
  const bad = join(dir, 'reviews', 'outline-r1.json');
  await writeFile(bad, JSON.stringify({ fail: ['P15'] }));
  await writeFile(join(dir, 'run.json'), JSON.stringify({ rounds: [
    { round: 1, review: { outlineCopy: bad, review: { verdict: 'revise', summary: '缺链接' } } },
  ] }));
  await writeLedger(f.workspace, [entry(commit, { workDirectory: dir })]);
  const ignored = { artifacts: [] as string[], only: [] as string[][] };
  const narrow = await calibrateRole({ roleDirectory: f.role, workspace: f.workspace, only: ['P14'], checkRunner: scriptedRunner(ignored) });
  assert.equal(narrow.passed, true, 'a P15 failure is outside --only P14');
  assert.deepEqual(narrow.only, ['P14']);
  assert.deepEqual(narrow.falsePositives, []);
  assert.deepEqual(narrow.caughtHistoricalIssues, []);
  assert.deepEqual(ignored.only, [['P14'], ['P14']]);
  const focused = { artifacts: [] as string[], only: [] as string[][] };
  const hit = await calibrateRole({ roleDirectory: f.role, workspace: f.workspace, only: ['P15', 'P14'], checkRunner: scriptedRunner(focused) });
  assert.equal(hit.passed, false);
  assert.deepEqual(hit.falsePositives.map(item => item.failedChecks), [['P15']]);
  assert.deepEqual(hit.caughtHistoricalIssues.map(item => item.caughtBy), [['P15']]);
  assert.deepEqual(focused.only, [['P15', 'P14'], ['P15', 'P14']]);
});

test('checkGate blocks on an L1 self_vs_program disagreement and ignores runs whose ticket was not read', async t => {
  const f = await roleFixture(t), commit = f.git('rev-parse', 'HEAD');
  const runs = [
    entry(commit, { jobId: 'job-ok', originSessionId: 'rsi-test', startedAt: '2026-11-01T00:00:00.000Z', workDirectory: '/ok' }),
    entry(commit, { jobId: 'job-bad', originSessionId: 'rsi-test', startedAt: '2026-11-02T00:00:00.000Z', workDirectory: '/bad' }),
  ];
  await writeLedger(f.workspace, runs);
  const open = await checkGate({ roleDirectory: f.role, workspace: f.workspace });
  assert.equal(open.ready, true, 'no ticket was read, so an old run cannot invent an L1 conflict');
  assert.equal(open.l1Mismatches, 0);
  assert.equal(open.calibration.status, 'not_required');
  assert.equal(open.calibration.required, false);
  const invoke = async (method: string, params: Record<string, unknown>) => {
    assert.equal(method, 'ticket_get');
    if (params.jobId !== 'job-bad') return { proposals: [], items: [{ id: 'X1-A1', crossCheck: { kind: 'self_vs_qa', checkId: 'A1' } }] };
    return { proposals: [], items: [
      { id: 'P2-P15', crossCheck: { kind: 'self_vs_program', checkId: 'P15', claimedState: 'pass', actualVerdict: 'fail' } },
      { id: 'X2-A1', crossCheck: { kind: 'self_vs_qa', checkId: 'A1', claimedState: 'pass', actualVerdict: 'disagree' } },
    ] };
  };
  const blocked = await checkGate({ roleDirectory: f.role, workspace: f.workspace, invoke });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.l1Mismatches, 1);
  assert.match(blocked.reasons.join('\n'), /2026-11-02T00:00:00.000Z demo：存在 1 条自检与机检不一致（L1 对校分歧）/);
  assert.doesNotMatch(blocked.reasons.join('\n'), /2026-11-01/);
});

test('checkGate requires calibration when checks changed since the previous passing version', async t => {
  const f = await roleFixture(t);
  const digest1 = await computeChecksDigest(f.role), v1 = f.git('rev-parse', 'HEAD');
  await writeFile(join(f.role, 'checks', 'rule.txt'), 'v2\n');
  f.git('add', '.'); f.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'v2');
  const digest2 = await computeChecksDigest(f.role), v2 = f.git('rev-parse', 'HEAD');
  assert.notEqual(digest1, digest2);
  const pos1 = await sampleDir(f.root, 'pos-1', { fail: [] });
  const pos2 = await sampleDir(f.root, 'pos-2', { fail: [] });
  const neg = await sampleDir(f.root, 'neg', { fail: ['P15'] });
  await writeFile(join(neg, 'run.json'), JSON.stringify({ rounds: [
    { round: 2, review: { outlineCopy: join(neg, 'outline.json'), review: { verdict: 'revise', summary: '历史缺陷' } } },
  ] }));
  await writeLedger(f.workspace, [
    entry(v1, { checksDigest: digest1, workDirectory: '/previous-version', startedAt: '2026-11-01T00:00:00.000Z' }),
    entry(v2, { passed: false, stopReason: 'stalled', workDirectory: neg, startedAt: '2026-11-02T00:00:00.000Z' }),
    entry(v2, { workDirectory: pos1, startedAt: '2026-11-03T00:00:00.000Z' }),
    entry(v2, { workDirectory: pos2, startedAt: '2026-11-04T00:00:00.000Z' }),
  ]);
  const missing = await checkGate({ roleDirectory: f.role, workspace: f.workspace });
  assert.equal(missing.ready, false);
  assert.equal(missing.calibration.status, 'missing');
  assert.equal(missing.calibration.required, true);
  assert.equal(missing.calibration.checksDigest, digest2);
  assert.match(missing.reasons.join('\n'), /acp-service rsi calibrate/);

  const staleReport = { schemaVersion: 1, roleId: 'demo-role', role: { commit: v2, dirty: false }, checksDigest: digest1,
    calibratedAt: '2026-11-05T00:00:00.000Z', positiveSamples: 1, negativeSamples: 0, falsePositives: [], caughtHistoricalIssues: [], passed: true };
  await writeFile(calibrationPath(f.workspace, 'demo-role'), JSON.stringify(staleReport));
  const stale = await checkGate({ roleDirectory: f.role, workspace: f.workspace });
  assert.equal(stale.ready, false);
  assert.equal(stale.calibration.status, 'stale');
  assert.match(stale.reasons.join('\n'), /重新运行 acp-service rsi calibrate/);

  const failedReport = { ...staleReport, checksDigest: digest2, passed: false, falsePositives: [{ runDir: pos1, artifactPath: join(pos1, 'outline.json'), failedChecks: ['P15'] }] };
  await writeFile(calibrationPath(f.workspace, 'demo-role'), JSON.stringify(failedReport));
  const failed = await checkGate({ roleDirectory: f.role, workspace: f.workspace });
  assert.equal(failed.ready, false);
  assert.equal(failed.calibration.status, 'failed');
  assert.equal(failed.calibration.falsePositives, 1);
  assert.match(failed.reasons.join('\n'), /1 条误报/);

  const seen = { artifacts: [] as string[], only: [] as string[][] };
  const replay = await calibrateRole({ roleDirectory: f.role, workspace: f.workspace, checkRunner: scriptedRunner(seen) });
  assert.equal(replay.passed, true);
  assert.equal(replay.positiveSamples, 2);
  assert.equal(replay.negativeSamples, 1);
  assert.deepEqual(replay.caughtHistoricalIssues.map(item => item.caughtBy), [['P15']]);
  const open = await checkGate({ roleDirectory: f.role, workspace: f.workspace });
  assert.equal(open.calibration.status, 'passed');
  assert.equal(open.calibration.required, true, 'the checks changed, so the clean report was required');
  assert.equal(open.calibration.falsePositives, 0);
  assert.equal(open.ready, true, open.reasons.join('\n'));
});

test('requireCalibration blocks when the role has no older version to compare', async t => {
  const f = await roleFixture(t), commit = f.git('rev-parse', 'HEAD');
  await writeLedger(f.workspace, [
    entry(commit, { startedAt: '2026-11-03T00:00:00.000Z', workDirectory: '/a' }),
    entry(commit, { startedAt: '2026-11-04T00:00:00.000Z', workDirectory: '/b' }),
  ]);
  const asked = await checkGate({ roleDirectory: f.role, workspace: f.workspace, requireCalibration: true });
  assert.equal(asked.ready, false);
  assert.equal(asked.calibration.status, 'missing');
  assert.equal(asked.calibration.required, true);
});

test('bidirectional L3 fails when checks are relaxed to catch nothing, and verifies frozen holdout tamper detection', async t => {
  const f = await roleFixture(t), commit = f.git('rev-parse', 'HEAD');
  const posDir = await sampleDir(f.root, 'pos', { fail: [] });
  const negDir = await sampleDir(f.root, 'neg', { fail: ['P15'] });
  const negCopy = join(negDir, 'reviews', 'outline-r1.json');
  await writeFile(negCopy, JSON.stringify({ fail: ['P15'] }));
  await writeFile(join(negDir, 'run.json'), JSON.stringify({ rounds: [
    { round: 1, review: { outlineCopy: negCopy, review: { verdict: 'revise', summary: '缺少链接' } } },
  ] }));
  await writeLedger(f.workspace, [
    entry(commit, { workDirectory: posDir, passed: true }),
    entry(commit, { workDirectory: negDir, passed: false, stopReason: 'stalled' }),
  ]);

  // Relaxed runner passes EVERYTHING (catches 0 negative samples) -> MUST fail bidirectional calibration.
  const relaxedRunner: CalibrationCheckRunner = async () => [
    { itemId: 'P14', pass: true, evidence: [] },
    { itemId: 'P15', pass: true, evidence: [] },
  ];
  const holdoutKey = sampleKeyOf({ kind: 'negative', runDir: negDir, round: 1, artifactPath: negCopy });
  const relaxed = await calibrateRole({
    roleDirectory: f.role,
    workspace: f.workspace,
    holdoutKeys: [holdoutKey],
    checkRunner: relaxedRunner,
  });
  assert.equal(relaxed.passed, false, 'relaxing checks to catch 0 negatives must fail');
  assert.equal(relaxed.negativeRecall, 0);
  assert.equal(relaxed.holdout.frozen, true);
  assert.equal(relaxed.holdout.passed, false);
  assert.match(relaxed.failureReasons.join('\n'), /负样本召回率为 0/);

  // Real runner catches the negative sample -> passes overall and frozen holdout.
  const seen = { artifacts: [] as string[], only: [] as string[][] };
  const good = await calibrateRole({
    roleDirectory: f.role,
    workspace: f.workspace,
    checkRunner: scriptedRunner(seen),
  });
  assert.equal(good.passed, true);
  assert.equal(good.negativeRecall, 1);
  assert.equal(good.holdout.passed, true);
  assert.deepEqual(good.holdout.sampleKeys, [holdoutKey]);

  // Deleting a frozen holdout sample's run.json must fail closed (never pass on empty intersection).
  await rm(join(negDir, 'run.json'));
  const missingHoldout = await calibrateRole({
    roleDirectory: f.role,
    workspace: f.workspace,
    checkRunner: scriptedRunner(seen),
  });
  assert.equal(missingHoldout.passed, false, 'missing frozen holdout keys must fail closed');
  assert.equal(missingHoldout.holdout.passed, false);
  assert.deepEqual(missingHoldout.holdout.missingKeys, [holdoutKey]);
  assert.match(missingHoldout.failureReasons.join('\n'), /holdout 样本缺失/);

  // Tampering with frozen holdout.json causes fail-closed failure.
  const rawHoldout = JSON.parse(await readFile(holdoutPath(f.workspace, 'demo-role'), 'utf8')) as { sampleKeys: string[] };
  rawHoldout.sampleKeys = [];
  await writeFile(holdoutPath(f.workspace, 'demo-role'), JSON.stringify(rawHoldout));
  const tampered = await calibrateRole({
    roleDirectory: f.role,
    workspace: f.workspace,
    checkRunner: scriptedRunner(seen),
  });
  assert.equal(tampered.passed, false);
  assert.equal(tampered.holdout.tampered, true);
  assert.match(tampered.failureReasons.join('\n'), /holdout/);
});

test('production calibrateRole auto-detects new block checks missing source, downgrades 0-coverage checks into runRoundDag, and isolates --only', async t => {
  const f = await roleFixture(t), commit1 = f.git('rev-parse', 'HEAD');
  const posDir = await sampleDir(f.root, 'pos-prod', { fail: ['P16_NEW'] });
  const negDir = await sampleDir(f.root, 'neg-prod', { fail: ['P15'] });
  const negCopy = join(negDir, 'reviews', 'outline-r1.json');
  await writeFile(negCopy, JSON.stringify({ fail: ['P15'] }));
  await writeFile(join(negDir, 'run.json'), JSON.stringify({ rounds: [
    { round: 1, review: { outlineCopy: negCopy, review: { verdict: 'revise', summary: '缺少链接' } } },
  ] }));
  await writeLedger(f.workspace, [
    entry(commit1, { workDirectory: posDir, passed: true }),
    entry(commit1, { workDirectory: negDir, passed: false, stopReason: 'stalled' }),
  ]);

  // M3: Add a new block check WITHOUT source (no existingItemIds passed) -> auto-detected from git baseline and fails!
  const checklistPath = join(f.role, 'checklist.json');
  const baseChecklist = JSON.parse(await readFile(checklistPath, 'utf8')) as { items: Record<string, unknown>[] };
  await writeFile(checklistPath, JSON.stringify({
    ...baseChecklist,
    items: [
      ...baseChecklist.items,
      { id: 'P16_NEW', kind: 'program', severity: 'must', locked: false, rule: '新增无溯源规则' },
    ],
  }, null, 2));
  const multiRunner: CalibrationCheckRunner = async input => {
    const doc = JSON.parse(await readFile(input.artifactPath, 'utf8')) as { fail?: string[] };
    const fail = new Set(doc.fail ?? []);
    return ['P14', 'P15', 'P16_NEW'].map(itemId => ({ itemId, pass: !fail.has(itemId), evidence: [] }));
  };
  const noSourceReport = await calibrateRole({ roleDirectory: f.role, workspace: f.workspace, checkRunner: multiRunner });
  assert.equal(noSourceReport.passed, false, 'new block check without source must fail in production path');
  assert.deepEqual(noSourceReport.missingSource, ['P16_NEW']);

  // M5: Add source to P16_NEW, still 0 negative coverage -> downgraded to observe in calibration AND in runRoundDag!
  await writeFile(checklistPath, JSON.stringify({
    ...baseChecklist,
    items: [
      ...baseChecklist.items,
      { id: 'P16_NEW', kind: 'program', severity: 'must', locked: false, source: 'PR #26 CR-M1', rule: '有溯源但零负样本覆盖' },
    ],
  }, null, 2));
  const downgradedReport = await calibrateRole({ roleDirectory: f.role, workspace: f.workspace, checkRunner: multiRunner });
  assert.deepEqual(downgradedReport.missingSource, []);
  assert.deepEqual(downgradedReport.downgradedToObserve, ['P16_NEW']);
  assert.equal(downgradedReport.effectiveModes.P16_NEW, 'observe');
  assert.equal(downgradedReport.falsePositives.length, 0, 'downgraded observe check does not trigger positive block false positive');
  assert.equal(downgradedReport.passed, true);

  // Wire effectiveModes into runRoundDag in formal mode: failing P16_NEW must NOT block!
  const dagDir = join(f.root, 'dag-runtime');
  const dag = await runRoundDag({
    workflow: defaultOutlineWorkflow(),
    round: 1,
    workDirectory: dagDir,
    mode: 'formal',
    checklist: parseChecklist(JSON.parse(await readFile(checklistPath, 'utf8'))),
    effectiveModes: downgradedReport.effectiveModes,
    nodes: [{ id: 'check_new', type: 'program_check', checks: ['P16_NEW'] }],
    handlersById: {
      check_new: async () => ({ results: [{ itemId: 'P16_NEW', pass: false, evidence: ['zero-coverage rule failed'] }] }),
    },
  });
  assert.equal(dag.blocked, false, 'downgraded zero-coverage check must run as observe (non-blocking) at runtime');

  // M4: --only must NEVER overwrite official calibration.json, and checkGate must reject any report with `only`.
  const officialBefore = await readFile(calibrationPath(f.workspace, 'demo-role'), 'utf8');
  await calibrateRole({ roleDirectory: f.role, workspace: f.workspace, only: ['P14'], checkRunner: multiRunner });
  assert.equal(await readFile(calibrationPath(f.workspace, 'demo-role'), 'utf8'), officialBefore, '--only must not overwrite calibration.json');

  // Even if someone manually writes a report with `only` into calibration.json, checkGate rejects it.
  f.git('add', '.'); f.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'with P16_NEW');
  const v2 = f.git('rev-parse', 'HEAD');
  const fullV2 = await calibrateRole({ roleDirectory: f.role, workspace: f.workspace, checkRunner: multiRunner });
  await writeFile(calibrationPath(f.workspace, 'demo-role'), JSON.stringify({ ...fullV2, only: ['P14'] }));
  await writeLedger(f.workspace, [
    entry(v2, { workDirectory: posDir, startedAt: '2026-11-01T00:00:00.000Z' }),
    entry(v2, { workDirectory: posDir, startedAt: '2026-11-02T00:00:00.000Z' }),
  ]);
  const rejectedPartial = await checkGate({ roleDirectory: f.role, workspace: f.workspace });
  assert.equal(rejectedPartial.ready, false);
  assert.equal(rejectedPartial.calibration.status, 'failed');
  assert.match(rejectedPartial.reasons.join('\n'), /--only/);
});

test('new block checks require source provenance and downgrade to observe when negative coverage is zero', () => {
  const checklist = parseChecklist({
    schemaVersion: 2,
    roleId: 'demo-role',
    artifacts: ['outline.json'],
    items: [
      { id: 'P1', kind: 'program', severity: 'must', locked: true, rule: '既有规则' },
      { id: 'P2', kind: 'program', severity: 'must', locked: false, rule: '无溯源新规则' },
      { id: 'P3', kind: 'program', severity: 'must', locked: false, source: 'PR #25 CR-M1', rule: '有溯源但零负样本覆盖' },
      { id: 'P4', kind: 'program', severity: 'must', locked: false, source: 'PR #26 CR-M2', rule: '有溯源且命中负样本' },
    ],
  });

  const audit = auditChecklistProvenance(checklist, {
    existingItemIds: new Set(['P1']),
    negativeCoverageByItem: { P1: 2, P2: 1, P3: 0, P4: 3 },
  });
  assert.deepEqual(audit.missingSource, ['P2']);
  assert.deepEqual(audit.downgradedToObserve.sort(), ['P2', 'P3']);
  assert.equal(audit.effectiveModes.P1, 'block');
  assert.equal(audit.effectiveModes.P2, 'observe');
  assert.equal(audit.effectiveModes.P3, 'observe');
  assert.equal(audit.effectiveModes.P4, 'block');

  const downgraded = effectiveEnforcementWithCoverage(checklist.items[2]!, 'formal', { negativeCoverage: 0 });
  assert.equal(downgraded.enforcement, 'observe');
  assert.equal(downgraded.downgradedReason, 'zero_negative_coverage');
});

test('editing ROLE.md or QA.md changes roleDigest and triggers recalibration in checkGate', async t => {
  const f = await roleFixture(t);
  await writeFile(join(f.role, 'ROLE.md'), '# Role v1\n');
  await writeFile(join(f.role, 'QA.md'), '# QA v1\n');
  f.git('add', '.'); f.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'with docs');
  const v1 = f.git('rev-parse', 'HEAD');
  const checksDigest1 = await computeChecksDigest(f.role);
  const roleDigest1 = await computeRoleDigest(f.role);

  await writeFile(join(f.role, 'QA.md'), '# QA v2 tighter rubric\n');
  f.git('add', 'QA.md'); f.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'edit QA.md only');
  const v2 = f.git('rev-parse', 'HEAD');
  assert.equal(await computeChecksDigest(f.role), checksDigest1, 'checksDigest unchanged when only QA.md edited');
  assert.notEqual(await computeRoleDigest(f.role), roleDigest1, 'roleDigest must change when QA.md edited');

  await writeLedger(f.workspace, [
    entry(v1, { checksDigest: checksDigest1, workDirectory: '/prev-v1', startedAt: '2026-11-01T00:00:00.000Z' }),
    entry(v2, { checksDigest: checksDigest1, workDirectory: '/curr-1', startedAt: '2026-11-02T00:00:00.000Z' }),
    entry(v2, { checksDigest: checksDigest1, workDirectory: '/curr-2', startedAt: '2026-11-03T00:00:00.000Z' }),
  ]);

  const gate = await checkGate({ roleDirectory: f.role, workspace: f.workspace });
  assert.equal(gate.ready, false);
  assert.equal(gate.calibration.status, 'missing', 'editing QA.md without recalibrating must require calibration');
  assert.equal(gate.calibration.required, true);
});

test('checkGate works on pr-delivery without ENOENT /cases, wires real eval-cr CLI producer, and rejects forged booleans', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'rsi-gate-pr-delivery-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const repoRoot = join(import.meta.dirname, '../../..');
  const prDeliveryRole = join(repoRoot, '.1agents/roles/pr-delivery');

  // Must NOT throw ENOENT /cases.
  const withoutReport = await checkGate({ roleDirectory: prDeliveryRole, workspace, repoRoot });
  assert.equal(withoutReport.roleId, 'pr-delivery');
  assert.deepEqual(withoutReport.testCases, []);
  assert.equal(withoutReport.crEval?.present, true);
  assert.equal(withoutReport.crEval?.verified, true);
  assert.equal(withoutReport.crEval?.status, 'missing');
  assert.equal(withoutReport.ready, false);

  // M2 anti-cheat: hand-writing { evalDigest, roleDigest, promotionReady: true } WITHOUT valid results MUST be rejected!
  const evalDigest = await computeCrEvalDigest(prDeliveryRole);
  const roleDigest = await computeRoleDigest(prDeliveryRole);
  await mkdir(join(workspace, 'pr-delivery'), { recursive: true });
  await writeFile(crEvalReportPath(workspace, 'pr-delivery'), JSON.stringify({
    evalDigest,
    roleDigest,
    promotionReady: true,
  }));
  const forgedBoolean = await checkGate({ roleDirectory: prDeliveryRole, workspace, repoRoot });
  assert.equal(forgedBoolean.ready, false, 'hand-written promotionReady boolean must never pass gate');
  assert.equal(forgedBoolean.crEval?.status, 'failed');

  // M1 real producer: run `acp-service rsi eval-cr --role ... --results ... --workspace ...` and verify checkGate re-scores it!
  const manifest = await loadCrEvalManifest(prDeliveryRole);
  const passingResults: CrReviewResult[] = manifest.cases.map(item => {
    if (item.kind === 'positive') {
      return { caseId: item.id, verdict: 'PASS', must: [] };
    }
    return {
      caseId: item.id,
      verdict: 'CHANGES_REQUESTED',
      must: (item.requiredDefects ?? []).map(d => ({
        id: d.id,
        file: d.anyFilePatterns[0],
        summary: `${d.anyFilePatterns[0]}: ${d.anyTextPatterns[0]}`,
      })),
    };
  });
  const resultsFile = join(workspace, 'results.json');
  await writeFile(resultsFile, JSON.stringify(passingResults, null, 2));
  const cli = join(repoRoot, 'packages/service/bin/acp-service.ts');
  const { stdout } = await execAsync(
    process.execPath,
    ['--import', 'tsx', cli, 'rsi', 'eval-cr', '--role', prDeliveryRole, '--repo', repoRoot, '--results', resultsFile, '--workspace', workspace, '--json'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  const cliOut = JSON.parse(stdout) as { ok: boolean; reportPath: string; roleDigest: string };
  assert.equal(cliOut.ok, true);
  assert.equal(cliOut.reportPath, crEvalReportPath(workspace, 'pr-delivery'));
  assert.equal(cliOut.roleDigest, roleDigest);

  const withRealReport = await checkGate({ roleDirectory: prDeliveryRole, workspace, repoRoot });
  assert.equal(withRealReport.crEval?.status, 'passed');
  assert.equal(withRealReport.crEval?.promotionReady, true);
  if (!withRealReport.role.dirty) {
    assert.equal(withRealReport.ready, true, withRealReport.reasons.join('\n'));
  }

  // Tampering results inside eval-cr.json (e.g. changing negative case to PASS while leaving promotionReady: true) is caught by re-scoring!
  const saved = JSON.parse(await readFile(crEvalReportPath(workspace, 'pr-delivery'), 'utf8')) as {
    results: CrReviewResult[];
    resultsDigest: string;
    roleDigest: string;
  };
  const tamperedResults = saved.results.map((r, i) => (i === 0 ? { caseId: r.caseId, verdict: 'PASS' as const, must: [] } : r));
  await writeFile(crEvalReportPath(workspace, 'pr-delivery'), JSON.stringify({ ...saved, results: tamperedResults }));
  const tamperedGate = await checkGate({ roleDirectory: prDeliveryRole, workspace, repoRoot });
  assert.equal(tamperedGate.ready, false);
  assert.equal(tamperedGate.crEval?.status, 'failed');

  // Stale roleDigest (e.g. ROLE.md or skills edited) marks eval-cr stale.
  await writeFile(crEvalReportPath(workspace, 'pr-delivery'), JSON.stringify({ ...saved, roleDigest: '0'.repeat(64) }));
  const staleRole = await checkGate({ roleDirectory: prDeliveryRole, workspace, repoRoot });
  assert.equal(staleRole.crEval?.status, 'stale');
  assert.equal(staleRole.ready, false);
});

test('M1: calibrating clean committed existing roles in a fresh workspace treats committed items as baseline', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'rsi-clean-existing-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const repoRoot = join(import.meta.dirname, '../../..');

  for (const roleId of ['product-intro-outline', 'ppt-beautifier']) {
    const rep = await calibrateRole({
      roleDirectory: join(repoRoot, '.1agents/roles', roleId),
      workspace,
    });
    assert.deepEqual(rep.missingSource, [], `${roleId} already-committed checks must not be flagged as new`);
    assert.equal(rep.passed, true, `${roleId} clean calibration must pass: ${rep.failureReasons.join('; ')}`);
  }
});
