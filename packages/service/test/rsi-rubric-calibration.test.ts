import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { computeChecksDigest } from '../src/rsi/calibrate.js';
import { checkGate } from '../src/rsi/gate.js';
import {
  calibrateRubric,
  classifyBand,
  cohenKappa,
  computeRubricDigest,
  evaluateRubricJudgments,
  krippendorffAlpha,
  spearmanRho,
  type RubricDefinition,
  type RubricJudgment,
} from '../src/rsi/rubric.js';

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../..');

function makeBinaryJudgments(
  criterion: string,
  count: number,
  options: { humanDisagreeIndices?: Set<number>; judgeDisagreeIndices?: Set<number> } = {},
): RubricJudgment[] {
  const out: RubricJudgment[] = [];
  for (let i = 0; i < count; i += 1) {
    const unit = `u${String(i + 1).padStart(3, '0')}`;
    const gold = i % 2;
    const h1 = gold;
    const h2 = options.humanDisagreeIndices?.has(i) ? 1 - gold : gold;
    const h3 = gold;
    const judge = options.judgeDisagreeIndices?.has(i) ? 1 - gold : gold;
    out.push(
      { unit, criterion, rater: 'human:a', value: h1 },
      { unit, criterion, rater: 'human:b', value: h2 },
      { unit, criterion, rater: 'human:c', value: h3 },
      { unit, criterion, rater: 'judge:llm', value: judge },
    );
  }
  return out;
}

test('statistical primitives: cohenKappa, krippendorffAlpha (nominal & ordinal), spearmanRho', () => {
  assert.equal(cohenKappa([1, 0, 1, 0, 1, 0], [1, 0, 1, 0, 1, 0]), 1);
  const kPartial = cohenKappa([1, 1, 1, 0, 0, 0], [1, 1, 0, 0, 0, 0]);
  assert.ok(kPartial !== null && Math.abs(kPartial - 0.6667) < 0.01);

  assert.equal(krippendorffAlpha([[1, 1], [0, 0], [1, 1], [0, 0]], false), 1);
  const ordHigh = krippendorffAlpha([[0, 0], [1, 1], [2, 2], [3, 3], [2, 3]], true);
  assert.ok(ordHigh !== null && ordHigh > 0.85, `expected high ordinal alpha, got ${ordHigh}`);

  const rhoPerfect = spearmanRho([0, 1, 2, 3], [0, 1, 2, 3]);
  assert.ok(rhoPerfect !== null && Math.abs(rhoPerfect - 1) < 1e-9);
  assert.equal(spearmanRho([1, 2], [1, 2]), null);
});

test('dual-ceiling 3-band classification enforces auto/advise/split and only auto must criteria can auto-block', () => {
  const bands = { auto: 0.8, advise: 0.67, minAutoSamples: 40 };
  assert.equal(classifyBand(0.9, 40, bands), 'auto');
  assert.equal(classifyBand(0.9, 39, bands), 'advise', 'n < 40 cannot enter auto band');
  assert.equal(classifyBand(0.75, 50, bands), 'advise');
  assert.equal(classifyBand(0.66, 50, bands), 'split');
  assert.equal(classifyBand(null, 0, bands), 'split');

  const rubric: RubricDefinition = {
    schemaVersion: 1,
    roleId: 'demo-rubric',
    criteria: [
      { id: 'R_AUTO', scale: { type: 'binary' }, gate: { mode: 'block' } },
      { id: 'R_SMALL_N', scale: { type: 'binary' }, gate: { mode: 'observe' } },
      { id: 'R_LOW_CEILING', scale: { type: 'binary' }, gate: { mode: 'block' } },
      { id: 'R_ADVISORY_ONLY', scale: { type: 'binary' }, gate: { mode: 'observe' } },
    ],
    pass_rule: { mustAllPass: ['R_AUTO', 'R_SMALL_N', 'R_LOW_CEILING'] },
    calibration: { bands: { auto: 0.8, advise: 0.67 }, minAutoSamples: 40 },
  };

  // R_AUTO: n=40, perfect human & judge agreement -> band=auto, canAutoBlock=true
  // R_SMALL_N: n=20, perfect agreement -> band=advise (n < 40), canAutoBlock=false
  // R_LOW_CEILING: n=40, judge matches human majority 100%, BUT human:b disagrees on 18/40 -> alpha_human_ceiling < 0.67 -> band=split!
  // R_ADVISORY_ONLY: n=40, perfect agreement, NOT must and observe -> band=auto, canAutoBlock=false
  const judgments: RubricJudgment[] = [
    ...makeBinaryJudgments('R_AUTO', 40),
    ...makeBinaryJudgments('R_SMALL_N', 20),
    ...makeBinaryJudgments('R_LOW_CEILING', 40, {
      humanDisagreeIndices: new Set(Array.from({ length: 18 }, (_, i) => i)),
    }),
    ...makeBinaryJudgments('R_ADVISORY_ONLY', 40),
  ];

  const report = evaluateRubricJudgments({
    rubric,
    judgments,
    rubricDigest: 'a'.repeat(64),
    now: () => new Date('2026-11-27T00:00:00.000Z'),
  });

  assert.equal(report.perCriterion.R_AUTO?.band, 'auto');
  assert.equal(report.perCriterion.R_AUTO?.canAutoBlock, true);
  assert.equal(report.perCriterion.R_AUTO?.effectiveEnforcement, 'block');

  assert.equal(report.perCriterion.R_SMALL_N?.band, 'advise');
  assert.equal(report.perCriterion.R_SMALL_N?.canAutoBlock, false);
  assert.equal(report.perCriterion.R_SMALL_N?.effectiveEnforcement, 'observe');

  assert.equal(report.perCriterion.R_LOW_CEILING?.alpha_gold_vs_judge, 1);
  assert.equal(report.perCriterion.R_LOW_CEILING?.ceilingLow, true);
  assert.equal(report.perCriterion.R_LOW_CEILING?.band, 'split');
  assert.equal(report.perCriterion.R_LOW_CEILING?.canAutoBlock, false);
  assert.equal(report.perCriterion.R_LOW_CEILING?.action, 'split_or_rewrite');

  assert.equal(report.perCriterion.R_ADVISORY_ONLY?.band, 'auto');
  assert.equal(report.perCriterion.R_ADVISORY_ONLY?.canAutoBlock, false, 'non-must observe criterion does not auto-block');

  assert.deepEqual(report.autoBlockAllowed, ['R_AUTO']);
  assert.deepEqual(report.splitRequired, ['R_LOW_CEILING']);
  assert.deepEqual(report.blockedBy, ['R_LOW_CEILING']);
  assert.equal(report.passed, false);
});

test('rubric.json is included in computeChecksDigest, invalidates gate on edit, and CLI calibrate --rubric works', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-rubric-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roleDir = join(dir, 'role');
  const workspace = join(dir, 'workspace');
  await mkdir(join(roleDir, 'checks'), { recursive: true });
  await mkdir(join(roleDir, 'cases'), { recursive: true });
  await writeFile(join(roleDir, 'profile.json'), JSON.stringify({ id: 'rubric-role' }));
  await writeFile(join(roleDir, 'checklist.json'), JSON.stringify({
    schemaVersion: 2, roleId: 'rubric-role', artifacts: ['outline.json'],
    items: [{ id: 'P1', kind: 'program', severity: 'must', locked: true, rule: 'schema' }],
  }));
  const rubricPath = join(roleDir, 'rubric.json');
  const rubricObj = {
    schemaVersion: 1,
    roleId: 'rubric-role',
    criteria: [{ id: 'R1', scale: { type: 'binary' }, gate: { mode: 'block' } }],
    pass_rule: { mustAllPass: ['R1'] },
    calibration: { bands: { auto: 0.8, advise: 0.67 }, minAutoSamples: 40 },
  };
  await writeFile(rubricPath, JSON.stringify(rubricObj, null, 2));

  const git = (...args: string[]) => execFileSync('git', ['-C', roleDir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'v1');

  const digest1 = await computeChecksDigest(roleDir);
  const rubricDigest1 = await computeRubricDigest(roleDir);

  const judgmentsPath = join(dir, 'gold.jsonl');
  await writeFile(judgmentsPath, `${makeBinaryJudgments('R1', 40).map(j => JSON.stringify(j)).join('\n')}\n`);

  const cli = join(repoRoot, 'packages/service/bin/acp-service.ts');
  const { stdout } = await exec(
    process.execPath,
    ['--import', 'tsx', cli, 'rsi', 'calibrate', '--rubric', '--role', roleDir, '--judgments', judgmentsPath, '--workspace', workspace, '--json'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { passed: boolean; rubricDigest: string; perCriterion: { R1: { band: string; canAutoBlock: boolean } } };
  assert.equal(parsed.passed, true);
  assert.equal(parsed.rubricDigest, rubricDigest1);
  assert.equal(parsed.perCriterion.R1.band, 'auto');
  assert.equal(parsed.perCriterion.R1.canAutoBlock, true);

  // Editing rubric.json changes computeChecksDigest AND marks saved rubric calibration stale in checkGate.
  await writeFile(rubricPath, JSON.stringify({ ...rubricObj, version: '1.1' }, null, 2));
  const digest2 = await computeChecksDigest(roleDir);
  assert.notEqual(digest2, digest1, 'editing rubric.json must change computeChecksDigest');

  const gate = await checkGate({ roleDirectory: roleDir, workspace });
  assert.equal(gate.rubricCalibration?.status, 'stale');
  assert.equal(gate.ready, false);
  assert.match(gate.reasons.join('\n'), /Rubric 校准报告已过期/);

  // Re-running calibrateRubric updates the bound report.
  const refreshed = await calibrateRubric({ roleDirectory: roleDir, judgmentsPath, workspace });
  assert.equal(refreshed.passed, true);
  assert.notEqual(refreshed.rubricDigest, rubricDigest1);
});
