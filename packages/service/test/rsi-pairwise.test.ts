import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { qualityReviewSchema } from '../src/execution/ticket.js';
import { checkGate } from '../src/rsi/gate.js';
import {
  digestPairwiseVotes,
  evaluatePairwiseRegression,
  pairwiseRegressionPath,
  readPairwiseRegression,
  runPairwiseRegression,
  translateDisplayWinner,
  type PairwiseVote,
} from '../src/rsi/pairwise.js';
import {
  computeRubricDigest,
  loadRubric,
  normalizedScoreToLegacyScore,
  scoreRubricEvaluation,
} from '../src/rsi/rubric.js';

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../..');
const serviceDir = join(repoRoot, 'packages/service');
const outlineRoleDir = join(repoRoot, '.1agents/roles/product-intro-outline');
const pptRoleDir = join(repoRoot, '.1agents/roles/ppt-beautifier');
const cli = join(serviceDir, 'bin/acp-service.ts');

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const res = await exec(process.execPath, args, { cwd: serviceDir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
    return { status: 0, stdout: res.stdout, stderr: res.stderr ?? '' };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { status: typeof failed.code === 'number' ? failed.code : 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

test('normalizedScoreToLegacyScore maps 0 / 0.5 / 1 boundaries and derived scores pass qualityReviewSchema.parse', async () => {
  assert.equal(normalizedScoreToLegacyScore(0), 1);
  assert.equal(normalizedScoreToLegacyScore(0.5), 3);
  assert.equal(normalizedScoreToLegacyScore(1), 5);
  assert.equal(normalizedScoreToLegacyScore(-0.4), 1);
  assert.equal(normalizedScoreToLegacyScore(1.8), 5);
  assert.throws(() => normalizedScoreToLegacyScore(Number.NaN), /must be finite/);

  for (const boundary of [0, 0.5, 1]) {
    const score = normalizedScoreToLegacyScore(boundary);
    const parsed = qualityReviewSchema.parse({
      verdict: boundary === 1 ? 'pass' : 'revise',
      summary: `boundary ${boundary}`,
      scores: { 吸引力: score, 具体: score, 受众: score, 结构: score, 可信: score, 行动: score },
      issues: boundary === 1 ? [] : [{ where: 'sections/positioning/slides/0', problem: 'test', suggestion: 'fix', severity: 'must' }],
      rubric: { roleId: 'product-intro-outline', normalizedScore: boundary, items: [] },
    });
    assert.equal(parsed.scores['吸引力'], score);
  }

  // Real product-intro-outline rubric: full pass vs R7 (-4) fabrication breaking pass line to 0.571 < 0.80.
  const outlineRubric = await loadRubric(outlineRoleDir);
  const allGood = scoreRubricEvaluation(outlineRubric, [
    { id: 'R1', met: true },
    { id: 'R2', score: 2 },
    { id: 'R3', met: true },
    { id: 'R4', met: true },
    { id: 'R5', met: true },
    { id: 'R6', met: true },
    { id: 'R7', met: false },
    { id: 'R8', met: false },
  ]);
  assert.equal(allGood.normalizedScore, 1);
  assert.equal(allGood.passed, true);
  assert.deepEqual(allGood.legacyScores, { 具体: 5, 可信: 5, 吸引力: 5, 受众: 5, 结构: 5, 行动: 5 });
  assert.doesNotThrow(() => qualityReviewSchema.parse({
    verdict: 'pass',
    summary: 'all rubric criteria passed',
    scores: allGood.legacyScores,
    issues: [],
  }));

  const fabricated = scoreRubricEvaluation(outlineRubric, [
    { id: 'R1', met: true },
    { id: 'R2', score: 1 }, // half -> 1/2 * 2 = 1
    { id: 'R3', met: true },
    { id: 'R4', met: true },
    { id: 'R5', met: true },
    { id: 'R6', met: true },
    { id: 'R7', met: true }, // -4 mustNotTrigger
    { id: 'R8', met: false },
  ]);
  assert.equal(fabricated.passed, false);
  assert.deepEqual(fabricated.mustNotTriggerFired, ['R7']);
  assert.ok(fabricated.normalizedScore < 0.8);
  assert.equal(fabricated.legacyScores['吸引力'], 3);
  assert.equal(fabricated.legacyScores['可信'], 1);
  assert.doesNotThrow(() => qualityReviewSchema.parse({
    verdict: 'revise',
    summary: 'R7 triggered',
    scores: fabricated.legacyScores,
    issues: [{ where: 'sections/features/slides/0', problem: '[R7] fabricated capability', suggestion: 'remove', severity: 'must' }],
  }));

  // Real ppt-beautifier QA.md and ROLE.md exist and align with split-modality rubric.json.
  const pptRubric = await loadRubric(pptRoleDir);
  const pptQa = await readFile(join(pptRoleDir, 'QA.md'), 'utf8');
  const pptRole = await readFile(join(pptRoleDir, 'ROLE.md'), 'utf8');
  assert.match(pptQa, /check_pptx\.py/);
  assert.match(pptQa, /V1/);
  assert.match(pptQa, /V11/);
  assert.match(pptQa, /Math\.round\(clamp\(1 \+ 4 \* normalizedScore, 1, 5\)\)/);
  assert.match(pptRole, /check_pptx\.py/);
  assert.match(pptRole, /QA\.md/);
  const pptEval = scoreRubricEvaluation(pptRubric, [
    { id: 'V1', met: true }, { id: 'V2', met: true }, { id: 'V3', met: true }, { id: 'V4', met: true },
    { id: 'V5', score: 3 }, { id: 'V6', score: 3 }, { id: 'V7', met: true }, { id: 'V8', met: true },
    { id: 'V9', met: true }, { id: 'V10', met: true }, { id: 'V11', met: false }, { id: 'V12', met: false },
  ]);
  assert.equal(pptEval.passed, true);
  assert.deepEqual(pptEval.legacyScores, { program: 5, visual: 5, narrative: 5 });
  assert.doesNotThrow(() => qualityReviewSchema.parse({
    verdict: 'pass',
    summary: 'ppt rubric passed',
    scores: pptEval.legacyScores,
    issues: [],
  }));
});

function makeConsistentCase(caseId: string, winner: 'candidate' | 'baseline' | 'tie', judges = ['anthropic:claude', 'openai:gpt']): PairwiseVote[] {
  const abWinner: PairwiseVote['winner'] = winner === 'candidate' ? 'A' : winner === 'baseline' ? 'B' : 'tie';
  const baWinner: PairwiseVote['winner'] = winner === 'candidate' ? 'B' : winner === 'baseline' ? 'A' : 'tie';
  return judges.flatMap(judgeId => [
    { caseId, judgeId, order: 'AB' as const, winner: abWinner },
    { caseId, judgeId, order: 'BA' as const, winner: baWinner },
  ]);
}

test('evaluatePairwiseRegression enforces AB/BA swap, dual-judge tie on disagreement, abstainOn, and winRate >= 0.6', async () => {
  assert.equal(translateDisplayWinner('AB', 'A'), 'candidate');
  assert.equal(translateDisplayWinner('BA', 'A'), 'baseline');
  assert.equal(translateDisplayWinner('BA', 'B'), 'candidate');

  const rubric = await loadRubric(outlineRoleDir);
  const digest = await computeRubricDigest(outlineRoleDir);

  // 3 wins, 1 baseline loss, 1 tie -> winRate = 3/5 = 0.6 -> PASS.
  // Also include R7 votes that must be abstained per outline rubric.pairwise.abstainOn = ['R7'].
  const passVotes: PairwiseVote[] = [
    ...makeConsistentCase('c1', 'candidate'),
    ...makeConsistentCase('c2', 'candidate'),
    ...makeConsistentCase('c3', 'candidate'),
    ...makeConsistentCase('c4', 'baseline'),
    ...makeConsistentCase('c5', 'tie'),
    { caseId: 'c1', judgeId: 'anthropic:claude', order: 'AB', winner: 'B', criterionId: 'R7' },
    { caseId: 'c1', judgeId: 'anthropic:claude', order: 'BA', winner: 'A', criterionId: 'R7' },
  ];
  const passReport = evaluatePairwiseRegression({ rubric, rubricDigest: digest, votes: passVotes });
  assert.equal(passReport.passed, true);
  assert.equal(passReport.promotionReady, true);
  assert.equal(passReport.candidateWins, 3);
  assert.equal(passReport.baselineWins, 1);
  assert.equal(passReport.ties, 1);
  assert.equal(passReport.abstainedVotes, 2);
  assert.equal(passReport.winRate, 0.6);

  // Position-swap bias (judge picks position A in BOTH AB and BA) -> forced tie -> drops winRate to 2/5 = 0.4 -> FAIL.
  const biasedVotes: PairwiseVote[] = [
    ...makeConsistentCase('c1', 'candidate'),
    ...makeConsistentCase('c2', 'candidate'),
    // c3: claude has position bias (A in AB = candidate, A in BA = baseline -> flip -> tie)
    { caseId: 'c3', judgeId: 'anthropic:claude', order: 'AB', winner: 'A' },
    { caseId: 'c3', judgeId: 'anthropic:claude', order: 'BA', winner: 'A' },
    { caseId: 'c3', judgeId: 'openai:gpt', order: 'AB', winner: 'A' },
    { caseId: 'c3', judgeId: 'openai:gpt', order: 'BA', winner: 'B' },
    // c4: cross-judge disagreement (claude=candidate, gpt=baseline) -> forced tie
    { caseId: 'c4', judgeId: 'anthropic:claude', order: 'AB', winner: 'A' },
    { caseId: 'c4', judgeId: 'anthropic:claude', order: 'BA', winner: 'B' },
    { caseId: 'c4', judgeId: 'openai:gpt', order: 'AB', winner: 'B' },
    { caseId: 'c4', judgeId: 'openai:gpt', order: 'BA', winner: 'A' },
    ...makeConsistentCase('c5', 'baseline'),
  ];
  const biasedReport = evaluatePairwiseRegression({ rubric, rubricDigest: digest, votes: biasedVotes });
  assert.equal(biasedReport.passed, false);
  assert.equal(biasedReport.positionFlips, 1);
  assert.equal(biasedReport.judgeDisagreements, 2);
  assert.equal(biasedReport.ties, 2);
  assert.equal(biasedReport.winRate, 0.4);

  // Single judge, missing BA direction, cross-criterion splice, or cherry-picking a single criterion subset (R1 only, missing R2..R6,R8) all fail closed.
  const incompleteReport = evaluatePairwiseRegression({
    rubric,
    rubricDigest: digest,
    votes: [
      ...makeConsistentCase('c-one-judge', 'candidate', ['anthropic:claude']),
      { caseId: 'c-missing-ba', judgeId: 'anthropic:claude', order: 'AB', winner: 'A' },
      { caseId: 'c-missing-ba', judgeId: 'openai:gpt', order: 'AB', winner: 'A' },
      { caseId: 'c-cross-crit-splice', judgeId: 'anthropic:claude', order: 'AB', winner: 'A', criterionId: 'R1' },
      { caseId: 'c-cross-crit-splice', judgeId: 'anthropic:claude', order: 'BA', winner: 'B', criterionId: 'R2' },
      { caseId: 'c-cross-crit-splice', judgeId: 'openai:gpt', order: 'AB', winner: 'A', criterionId: 'R1' },
      { caseId: 'c-cross-crit-splice', judgeId: 'openai:gpt', order: 'BA', winner: 'B', criterionId: 'R2' },
      { caseId: 'c-single-crit-subset', judgeId: 'anthropic:claude', order: 'AB', winner: 'A', criterionId: 'R1' },
      { caseId: 'c-single-crit-subset', judgeId: 'anthropic:claude', order: 'BA', winner: 'B', criterionId: 'R1' },
      { caseId: 'c-single-crit-subset', judgeId: 'openai:gpt', order: 'AB', winner: 'A', criterionId: 'R1' },
      { caseId: 'c-single-crit-subset', judgeId: 'openai:gpt', order: 'BA', winner: 'B', criterionId: 'R1' },
    ],
  });
  assert.equal(incompleteReport.passed, false);
  assert.deepEqual(incompleteReport.incompleteCases.sort(), ['c-cross-crit-splice', 'c-missing-ba', 'c-one-judge', 'c-single-crit-subset']);

  // Unknown criterionId (not in rubric.criteria) throws immediately.
  assert.throws(() => evaluatePairwiseRegression({
    rubric,
    rubricDigest: digest,
    votes: [
      { caseId: 'x1', judgeId: 'anthropic:claude', order: 'AB', winner: 'A', criterionId: 'R9' },
      { caseId: 'x1', judgeId: 'anthropic:claude', order: 'BA', winner: 'B', criterionId: 'R9' },
      { caseId: 'x1', judgeId: 'openai:gpt', order: 'AB', winner: 'A', criterionId: 'R9' },
      { caseId: 'x1', judgeId: 'openai:gpt', order: 'BA', winner: 'B', criterionId: 'R9' },
    ],
  }), /unknown rubric criterion "R9"/);

  // Duplicate vote throws; rubric trying to lower minWinRate below 0.6 throws.
  assert.throws(() => evaluatePairwiseRegression({
    rubric,
    rubricDigest: digest,
    votes: [
      { caseId: 'c1', judgeId: 'anthropic:claude', order: 'AB', winner: 'A' },
      { caseId: 'c1', judgeId: 'anthropic:claude', order: 'AB', winner: 'B' },
    ],
  }), /Duplicate pairwise vote/);

  const weakRubric = structuredClone(rubric);
  weakRubric.pairwise = { ...(weakRubric.pairwise ?? {}), minWinRate: 0.4 };
  assert.throws(() => evaluatePairwiseRegression({ rubric: weakRubric, rubricDigest: digest, votes: passVotes }), /below policy floor/);
});

test('pairwise CLI, report persistence, and checkGate rubricDigest binding', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-pairwise-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roleCopy = join(dir, 'role');
  const workspace = join(dir, 'ws');
  await cp(outlineRoleDir, roleCopy, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const votesFile = join(dir, 'votes.jsonl');
  const votes = [
    ...makeConsistentCase('c1', 'candidate'),
    ...makeConsistentCase('c2', 'candidate'),
    ...makeConsistentCase('c3', 'candidate'),
    ...makeConsistentCase('c4', 'tie'),
    ...makeConsistentCase('c5', 'candidate'),
  ];
  await writeFile(votesFile, `${votes.map(v => JSON.stringify(v)).join('\n')}\n`);

  const res = await runCli([
    '--import', 'tsx', cli, 'rsi', 'pairwise',
    '--role', roleCopy,
    '--votes', votesFile,
    '--workspace', workspace,
    '--candidate', 'v2-trial',
    '--baseline', 'v1-formal',
    '--json',
  ]);
  assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout) as { passed: boolean; winRate: number; roleId: string };
  assert.equal(parsed.passed, true);
  assert.equal(parsed.winRate, 0.8);

  const loaded = await readPairwiseRegression(workspace, 'product-intro-outline');
  assert.equal(loaded.state, 'ok');

  const gateOk = await checkGate({ roleDirectory: roleCopy, workspace, requirePairwise: true });
  assert.equal(gateOk.pairwiseRegression?.status, 'passed');
  assert.equal(gateOk.pairwiseRegression?.winRate, 0.8);

  // M2a: tampering config invariants is rejected by guard.
  const savedPath = pairwiseRegressionPath(workspace, 'product-intro-outline');
  const savedOriginal = JSON.parse(await readFile(savedPath, 'utf8')) as Record<string, unknown>;
  const tamperedInvariants = {
    ...savedOriginal,
    config: { swapPositions: false, tieOnDisagreement: false, minWinRate: 0.1, minJudges: 1, abstainOn: [] },
    candidateWins: 1,
    baselineWins: 9,
    winRate: 0.1,
    passed: true,
    promotionReady: true,
    failureReasons: [],
  };
  await writeFile(savedPath, JSON.stringify(tamperedInvariants, null, 2));
  const gateTampered = await checkGate({ roleDirectory: roleCopy, workspace, requirePairwise: true });
  assert.equal(gateTampered.pairwiseRegression?.status, 'failed');
  assert.ok(gateTampered.reasons.some(r => r.includes('策略不变量或投票摘要校验失败')));

  // M2b: valid config invariants + validly re-signed votesDigest on ALL-LOSING votes + forged passed=true MUST fail via in-process re-evaluation!
  const losingVotes: PairwiseVote[] = [
    ...makeConsistentCase('loss-1', 'baseline'),
    ...makeConsistentCase('loss-2', 'baseline'),
  ];
  const forgedReeval = {
    ...savedOriginal,
    votes: losingVotes,
    votesDigest: digestPairwiseVotes(losingVotes),
    passed: true,
    promotionReady: true,
    failureReasons: [],
  };
  await writeFile(savedPath, JSON.stringify(forgedReeval, null, 2));
  const gateForgedReeval = await checkGate({ roleDirectory: roleCopy, workspace, requirePairwise: true });
  assert.equal(gateForgedReeval.pairwiseRegression?.status, 'failed');
  assert.equal(gateForgedReeval.pairwiseRegression?.winRate, 0);
  assert.ok(gateForgedReeval.reasons.some(r => r.includes('Pairwise A/B 换位双评回归未通过')));

  // M2c: broken votesDigest is rejected.
  const badDigest = { ...savedOriginal, votesDigest: '0'.repeat(64) };
  await writeFile(savedPath, JSON.stringify(badDigest, null, 2));
  const gateBadDigest = await checkGate({ roleDirectory: roleCopy, workspace, requirePairwise: true });
  assert.equal(gateBadDigest.pairwiseRegression?.status, 'failed');
  assert.ok(gateBadDigest.reasons.some(r => r.includes('策略不变量或投票摘要校验失败')));

  // Restore clean report before staleness test.
  await writeFile(savedPath, JSON.stringify(savedOriginal, null, 2));

  // Modifying rubric.json invalidates pairwise-regression.json in checkGate.
  const rubricPath = join(roleCopy, 'rubric.json');
  const rawRubric = JSON.parse(await readFile(rubricPath, 'utf8')) as { aggregation: { note?: string } };
  rawRubric.aggregation.note = 'mutated for staleness test';
  await writeFile(rubricPath, JSON.stringify(rawRubric, null, 2));
  const gateStale = await checkGate({ roleDirectory: roleCopy, workspace, requirePairwise: true });
  assert.equal(gateStale.pairwiseRegression?.status, 'stale');
  assert.ok(gateStale.reasons.some(r => r.includes('Pairwise 回归报告已过期')));

  // Corrupt report fails closed in checkGate without throwing.
  await writeFile(pairwiseRegressionPath(workspace, 'product-intro-outline'), '{broken');
  const gateInvalid = await checkGate({ roleDirectory: roleCopy, workspace, requirePairwise: true });
  assert.equal(gateInvalid.pairwiseRegression?.status, 'failed');
  assert.ok(gateInvalid.reasons.some(r => r.includes('Pairwise 回归报告损坏')));

  // Direct API runPairwiseRegression with failing winRate exits 1 via CLI.
  const failVotes = join(dir, 'fail.jsonl');
  await writeFile(failVotes, `${[...makeConsistentCase('c1', 'baseline'), ...makeConsistentCase('c2', 'baseline')].map(v => JSON.stringify(v)).join('\n')}\n`);
  const failRes = await runCli(['--import', 'tsx', cli, 'rsi', 'pairwise', '--role', roleCopy, '--votes', failVotes, '--workspace', workspace, '--json']);
  assert.equal(failRes.status, 1);
  const direct = await runPairwiseRegression({ roleDirectory: roleCopy, votesPath: failVotes });
  assert.equal(direct.passed, false);
});
