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
  loadRubric,
  rubricCalibrationPath,
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

test('statistical primitives: cohenKappa, canonical Krippendorff ordinal alpha, and spearmanRho', () => {
  assert.equal(cohenKappa([1, 0, 1, 0, 1, 0], [1, 0, 1, 0, 1, 0]), 1);
  const kPartial = cohenKappa([1, 1, 1, 0, 0, 0], [1, 1, 0, 0, 0, 0]);
  assert.ok(kPartial !== null && Math.abs(kPartial - 0.6667) < 0.01);

  assert.equal(krippendorffAlpha([[1, 1], [0, 0], [1, 1], [0, 0]], false), 1);

  // M3 canonical Krippendorff ordinal alpha exact regression vectors (marginal-frequency weighted delta^2_ord):
  const vec7 = [[0, 0], [0, 0], [2, 0, 1], [0, 0], [2, 1], [2, 1, 1], [0, 0, 0]];
  const alpha7 = krippendorffAlpha(vec7, true);
  assert.ok(alpha7 !== null && Math.abs(alpha7 - 0.6742) < 0.001, `expected canonical ~0.6742, got ${alpha7}`);

  const vec40: number[][] = [
    ...Array.from({ length: 26 }, () => [0, 0]),
    [0, 0, 0],
    [1, 0],
    ...Array.from({ length: 3 }, () => [1, 1]),
    [1, 0, 1],
    ...Array.from({ length: 4 }, () => [0, 0, 1]),
    [0, 1, 1],
    ...Array.from({ length: 3 }, () => [2, 2, 2]),
  ];
  const alpha40 = krippendorffAlpha(vec40, true);
  assert.ok(alpha40 !== null && Math.abs(alpha40 - 0.6885) < 0.001, `expected canonical ~0.6885 (advise, not auto), got ${alpha40}`);

  const rhoPerfect = spearmanRho([0, 1, 2, 3], [0, 1, 2, 3]);
  assert.ok(rhoPerfect !== null && Math.abs(rhoPerfect - 1) < 1e-9);
  assert.equal(spearmanRho([1, 2], [1, 2]), null);
});

test('M1: loadRubric and CLI calibrate --rubric parse both real repository rubric.json files', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'rsi-real-rubric-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const outlineDir = join(repoRoot, '.1agents/roles/product-intro-outline');
  const pptDir = join(repoRoot, '.1agents/roles/ppt-beautifier');
  const outlineRubric = await loadRubric(outlineDir);
  const pptRubric = await loadRubric(pptDir);
  assert.equal(outlineRubric.roleId, 'product-intro-outline');
  assert.equal(pptRubric.roleId, 'ppt-beautifier');
  assert.ok(outlineRubric.criteria.some(c => c.gate?.mode === 'advise'));
  assert.ok(pptRubric.criteria.some(c => c.gate?.mode === 'advise'));

  // Run real calibrateRubric on product-intro-outline with 40 clean judgments for every criterion.
  const allJudgments: RubricJudgment[] = [];
  for (const c of outlineRubric.criteria) {
    allJudgments.push(...makeBinaryJudgments(c.id, 40));
  }
  const jPath = join(workspace, 'outline-gold.jsonl');
  await writeFile(jPath, `${allJudgments.map(j => JSON.stringify(j)).join('\n')}\n`);
  const rep = await calibrateRubric({ roleDirectory: outlineDir, judgmentsPath: jPath, workspace });
  assert.equal(rep.passed, true);
  assert.ok(rep.autoBlockAllowed.includes('R1'));
  assert.ok(rep.autoBlockAllowed.includes('R7'));
});

test('M2, M4, M5 & S1/S5/S9: pair-count n, minAlpha consistency, policy floors, tie handling, and duplicate rejection', () => {
  const bands = { auto: 0.8, advise: 0.67, minAutoSamples: 40 };
  assert.equal(classifyBand(0.9, 40, bands), 'auto');
  assert.equal(classifyBand(0.9, 39, bands), 'advise', 'n < 40 cannot enter auto band');
  assert.equal(classifyBand(0.75, 50, bands), 'advise');
  assert.equal(classifyBand(0.66, 50, bands), 'split');
  assert.equal(classifyBand(null, 0, bands), 'split');

  // M2: 40 human-only units + judge on only 1 or 2 units must NOT enter auto!
  const sparseRubric: RubricDefinition = {
    schemaVersion: 1,
    roleId: 'sparse-role',
    criteria: [{ id: 'R1', severity: 'must', scale: { type: 'binary' }, gate: { mode: 'block' } }],
    aggregation: { mustAllPass: ['R1'] },
    calibration: { bands: { auto: 0.8, advise: 0.67 } },
  };
  const sparse1: RubricJudgment[] = [];
  for (let i = 0; i < 40; i += 1) {
    sparse1.push({ unit: `u${i}`, criterion: 'R1', rater: 'human:a', value: i % 2 });
    if (i === 0) sparse1.push({ unit: `u${i}`, criterion: 'R1', rater: 'judge:llm', value: i % 2 });
  }
  const sparse1Rep = evaluateRubricJudgments({ rubric: sparseRubric, judgments: sparse1, rubricDigest: 'a'.repeat(64) });
  assert.equal(sparse1Rep.perCriterion.R1?.n, 1);
  assert.equal(sparse1Rep.perCriterion.R1?.n_gold, 40);
  assert.equal(sparse1Rep.perCriterion.R1?.band, 'split');
  assert.equal(sparse1Rep.perCriterion.R1?.canAutoBlock, false);
  assert.equal(sparse1Rep.passed, false);

  // M2 with 2 judge pairs out of 40 human units -> n=2 -> advise, NOT auto!
  const sparse2 = [...sparse1, { unit: 'u1', criterion: 'R1', rater: 'judge:llm', value: 1 }];
  const sparse2Rep = evaluateRubricJudgments({ rubric: sparseRubric, judgments: sparse2, rubricDigest: 'a'.repeat(64) });
  assert.equal(sparse2Rep.perCriterion.R1?.n, 2);
  assert.equal(sparse2Rep.perCriterion.R1?.band, 'advise');
  assert.equal(sparse2Rep.perCriterion.R1?.canAutoBlock, false);

  // M4: gate.minAlpha: 0.9 at alpha ~0.85 -> canAutoBlock MUST be false (no contradiction with passed: false).
  const strictMinAlphaRubric: RubricDefinition = {
    schemaVersion: 1,
    roleId: 'strict-min-alpha',
    criteria: [{ id: 'V1', severity: 'must', scale: { type: 'binary' }, gate: { mode: 'block', minAlpha: 0.9 } }],
    aggregation: { mustAllPass: ['V1'] },
  };
  const minAlphaJudgments = makeBinaryJudgments('V1', 40, { judgeDisagreeIndices: new Set([0, 1, 2]) });
  const minAlphaRep = evaluateRubricJudgments({ rubric: strictMinAlphaRubric, judgments: minAlphaJudgments, rubricDigest: 'b'.repeat(64) });
  assert.equal(minAlphaRep.perCriterion.V1?.band, 'auto');
  assert.equal(minAlphaRep.perCriterion.V1?.canAutoBlock, false, 'minAlpha 0.9 not met at alpha ~0.85');
  assert.equal(minAlphaRep.perCriterion.V1?.effectiveEnforcement, 'observe');
  assert.deepEqual(minAlphaRep.autoBlockAllowed, []);
  assert.deepEqual(minAlphaRep.blockedBy, ['V1']);
  assert.equal(minAlphaRep.passed, false);

  // M5: Rubric lowering bands.auto below policy floor 0.80 MUST be rejected!
  assert.throws(() => evaluateRubricJudgments({
    rubric: {
      schemaVersion: 1,
      roleId: 'cheating-rubric',
      criteria: [{ id: 'R1', scale: { type: 'binary' }, gate: { mode: 'block' } }],
      calibration: { bands: { auto: 0.5, advise: 0.4 } },
    },
    judgments: makeBinaryJudgments('R1', 40),
    rubricDigest: 'c'.repeat(64),
  }), /below policy floor 0.8/);

  // S9: Duplicate (unit, criterion, rater) throws instead of silently overwriting.
  assert.throws(() => evaluateRubricJudgments({
    rubric: sparseRubric,
    judgments: [
      { unit: 'u1', criterion: 'R1', rater: 'human:a', value: 1 },
      { unit: 'u1', criterion: 'R1', rater: 'human:a', value: 0 },
    ],
    rubricDigest: 'd'.repeat(64),
  }), /Duplicate judgment/);

  // Dual-ceiling low human-human alpha forces split even if judge agrees 100% with human majority.
  const dualRubric: RubricDefinition = {
    schemaVersion: 1,
    roleId: 'dual-test',
    criteria: [
      { id: 'R_AUTO', severity: 'must', scale: { type: 'binary' }, gate: { mode: 'block' } },
      { id: 'R_LOW_CEILING', severity: 'must', scale: { type: 'binary' }, gate: { mode: 'block' } },
      { id: 'R_ADVISORY', severity: 'should', scale: { type: 'binary' }, gate: { mode: 'advise' } },
    ],
    aggregation: { mustAllPass: ['R_AUTO', 'R_LOW_CEILING'] },
  };
  const dualRep = evaluateRubricJudgments({
    rubric: dualRubric,
    judgments: [
      ...makeBinaryJudgments('R_AUTO', 40),
      ...makeBinaryJudgments('R_LOW_CEILING', 40, { humanDisagreeIndices: new Set(Array.from({ length: 18 }, (_, i) => i)) }),
      ...makeBinaryJudgments('R_ADVISORY', 40),
    ],
    rubricDigest: 'e'.repeat(64),
  });
  assert.equal(dualRep.perCriterion.R_AUTO?.canAutoBlock, true);
  assert.equal(dualRep.perCriterion.R_LOW_CEILING?.ceilingLow, true);
  assert.equal(dualRep.perCriterion.R_LOW_CEILING?.band, 'split');
  assert.equal(dualRep.perCriterion.R_LOW_CEILING?.action, 'split_or_rewrite');
  assert.equal(dualRep.perCriterion.R_ADVISORY?.canAutoBlock, false);
});

test('rubric.json digest binding, corrupt report handling in checkGate, and CLI calibrate --rubric', async t => {
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
    criteria: [
      { id: 'R1', severity: 'must', scale: { type: 'binary' }, gate: { mode: 'block' } },
      { id: 'R2', severity: 'should', scale: { type: 'binary' }, gate: { mode: 'advise' } },
    ],
    aggregation: { mustAllPass: ['R1'] },
    calibration: { bands: { auto: 0.8, advise: 0.67 } },
  };
  await writeFile(rubricPath, JSON.stringify(rubricObj, null, 2));

  const git = (...args: string[]) => execFileSync('git', ['-C', roleDir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'v1');

  const digest1 = await computeChecksDigest(roleDir);
  const rubricDigest1 = await computeRubricDigest(roleDir);

  const judgmentsPath = join(dir, 'gold.jsonl');
  await writeFile(
    judgmentsPath,
    `${[...makeBinaryJudgments('R1', 40), ...makeBinaryJudgments('R2', 40)].map(j => JSON.stringify(j)).join('\n')}\n`,
  );

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

  // S8: combining --rubric with --only must fail cleanly.
  await assert.rejects(
    exec(process.execPath, ['--import', 'tsx', cli, 'rsi', 'calibrate', '--rubric', '--only', 'R1', '--role', roleDir, '--judgments', judgmentsPath]),
  );

  // S4: corrupt rubric-calibration.json does not crash checkGate (fails cleanly).
  await writeFile(rubricCalibrationPath(workspace, 'rubric-role'), JSON.stringify({ schemaVersion: 1, rubricDigest: rubricDigest1, passed: false }));
  const corruptGate = await checkGate({ roleDirectory: roleDir, workspace });
  assert.equal(corruptGate.rubricCalibration?.status, 'failed');
  assert.equal(corruptGate.ready, false);

  // Restore valid calibration, then edit rubric.json -> computeChecksDigest changes and checkGate marks stale.
  await calibrateRubric({ roleDirectory: roleDir, judgmentsPath, workspace });
  await writeFile(rubricPath, JSON.stringify({ ...rubricObj, version: '1.1' }, null, 2));
  const digest2 = await computeChecksDigest(roleDir);
  assert.notEqual(digest2, digest1, 'editing rubric.json must change computeChecksDigest');

  const staleGate = await checkGate({ roleDirectory: roleDir, workspace });
  assert.equal(staleGate.rubricCalibration?.status, 'stale');
  assert.equal(staleGate.ready, false);
  assert.match(staleGate.reasons.join('\n'), /Rubric 校准报告已过期/);
});
