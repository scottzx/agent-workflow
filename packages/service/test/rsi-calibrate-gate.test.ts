import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { calibrateRole, calibrationPath, computeChecksDigest, loadCalibration, type CalibrationCheckRunner } from '../src/rsi/calibrate.js';
import { checkGate } from '../src/rsi/gate.js';
import type { LedgerEntry } from '../src/rsi/outline-run.js';

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
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.roleId, 'demo-role');
  assert.equal(report.role.commit, commit);
  assert.equal(report.role.dirty, false);
  assert.equal(report.checksDigest, await computeChecksDigest(f.role));
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
