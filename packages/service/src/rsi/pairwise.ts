/**
 * A/B position-swapped dual-judge pairwise regression for trial -> formal promotion.
 *
 * Anti-gaming & anti-inflation invariants:
 * - Policy floor `POLICY_MIN_PAIRWISE_WIN_RATE = 0.6` cannot be lowered by `rubric.json`.
 * - Each `(caseId, judgeId)` must be evaluated in both `AB` (candidate first) and `BA` (baseline first)
 *   positions when `swapPositions` is enabled; position flips resolve to `tie`.
 * - Each case requires at least 2 distinct non-abstain judges; any cross-judge disagreement resolves to `tie`.
 * - Strict win rate `candidateWins / evaluatedCases` keeps ties in the denominator so bias or disagreement
 *   cannot inflate the win rate.
 * - Criteria listed in `rubric.pairwise.abstainOn` (e.g. `R7`) are excluded from win/loss counts.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { computeRubricDigest, loadRubric, type RubricDefinition } from './rubric.js';

export const POLICY_MIN_PAIRWISE_WIN_RATE = 0.6;
export const POLICY_MIN_PAIRWISE_JUDGES = 2;

const SAFE_ROLE_ID = /^[A-Za-z0-9._-]+$/;

export const pairwiseVoteSchema = z.object({
  caseId: z.string().min(1),
  judgeId: z.string().min(1),
  order: z.enum(['AB', 'BA']),
  /** Display-position winner: in AB, A=candidate B=baseline; in BA, A=baseline B=candidate. */
  winner: z.enum(['A', 'B', 'tie', 'abstain']),
  criterionId: z.string().min(1).optional(),
  evidence: z.string().min(1).optional(),
}).strict();

export type PairwiseVote = z.infer<typeof pairwiseVoteSchema>;
export type LogicalWinner = 'candidate' | 'baseline' | 'tie' | 'abstain';

const judgeCaseOutcomeSchema = z.object({
  judgeId: z.string().min(1),
  abWinner: z.enum(['candidate', 'baseline', 'tie', 'abstain']).nullable(),
  baWinner: z.enum(['candidate', 'baseline', 'tie', 'abstain']).nullable(),
  positionInconsistent: z.boolean(),
  incomplete: z.boolean(),
  outcome: z.enum(['candidate', 'baseline', 'tie', 'abstain', 'incomplete']),
}).strict();

const pairwiseCaseOutcomeSchema = z.object({
  caseId: z.string().min(1),
  outcome: z.enum(['candidate', 'baseline', 'tie', 'abstain', 'incomplete']),
  judges: z.array(judgeCaseOutcomeSchema),
  positionFlips: z.number().int().nonnegative(),
  judgeDisagreement: z.boolean(),
  reason: z.string().optional(),
}).strict();

export const pairwiseRegressionReportSchema = z.object({
  schemaVersion: z.literal(1),
  roleId: z.string().min(1),
  rubricDigest: z.string().regex(/^[0-9a-f]{64}$/),
  evaluatedAt: z.string().min(1),
  candidateVersion: z.string().min(1).optional(),
  baselineVersion: z.string().min(1).optional(),
  config: z.object({
    swapPositions: z.boolean(),
    tieOnDisagreement: z.boolean(),
    minWinRate: z.number().min(0).max(1),
    minJudges: z.number().int().positive(),
    abstainOn: z.array(z.string()),
  }).strict(),
  totalVotes: z.number().int().nonnegative(),
  abstainedVotes: z.number().int().nonnegative(),
  totalCases: z.number().int().nonnegative(),
  evaluatedCases: z.number().int().nonnegative(),
  abstainedCases: z.number().int().nonnegative(),
  incompleteCases: z.array(z.string()),
  candidateWins: z.number().int().nonnegative(),
  baselineWins: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  positionFlips: z.number().int().nonnegative(),
  judgeDisagreements: z.number().int().nonnegative(),
  winRate: z.number().min(0).max(1),
  decisiveWinRate: z.number().min(0).max(1).nullable(),
  passed: z.boolean(),
  promotionReady: z.boolean(),
  failureReasons: z.array(z.string()),
  cases: z.array(pairwiseCaseOutcomeSchema),
  /** Optional stored vote list + SHA-256 digest so `gate.ts` can verify integrity and re-evaluate in-process. */
  votesDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  votes: z.array(pairwiseVoteSchema).optional(),
}).strict();

export type PairwiseJudgeOutcome = z.infer<typeof judgeCaseOutcomeSchema>;
export type PairwiseCaseOutcome = z.infer<typeof pairwiseCaseOutcomeSchema>;
export type PairwiseRegressionReport = z.infer<typeof pairwiseRegressionReportSchema>;

function assertSafeRoleId(roleId: string): void {
  if (!SAFE_ROLE_ID.test(roleId) || roleId === '.' || roleId === '..' || roleId.includes('..')) {
    throw new Error(`Unsafe roleId for pairwise regression path: ${roleId.slice(0, 64)}`);
  }
}

export function pairwiseRegressionPath(workspace: string, roleId: string): string {
  assertSafeRoleId(roleId);
  return path.join(path.resolve(workspace), roleId, 'pairwise-regression.json');
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Translate display-position winner (`A`/`B`) to logical winner (`candidate`/`baseline`). */
export function translateDisplayWinner(order: 'AB' | 'BA', winner: PairwiseVote['winner']): LogicalWinner {
  if (winner === 'tie' || winner === 'abstain') return winner;
  if (order === 'AB') return winner === 'A' ? 'candidate' : 'baseline';
  return winner === 'A' ? 'baseline' : 'candidate';
}

export function digestPairwiseVotes(votes: readonly PairwiseVote[]): string {
  return createHash('sha256').update(JSON.stringify(votes)).digest('hex');
}

export async function loadPairwiseVotes(filePath: string): Promise<PairwiseVote[]> {
  const text = await readFile(path.resolve(filePath), 'utf8');
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    let jsonOk = false;
    try {
      parsed = JSON.parse(trimmed);
      jsonOk = true;
    } catch {
      // Multi-line JSONL starts with `{` on line 1; fall through to line-by-line JSONL parser.
    }
    if (jsonOk) {
      if (Array.isArray(parsed)) return parsed.map(item => pairwiseVoteSchema.parse(item));
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { votes?: unknown }).votes)) {
        return (parsed as { votes: unknown[] }).votes.map(item => pairwiseVoteSchema.parse(item));
      }
      return [pairwiseVoteSchema.parse(parsed)];
    }
  }
  const votes: PairwiseVote[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith('#')) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch { throw new Error(`Invalid JSON on line ${index + 1} of ${filePath}`); }
    votes.push(pairwiseVoteSchema.parse(raw));
  }
  return votes;
}

export function evaluatePairwiseRegression(options: {
  rubric: RubricDefinition;
  rubricDigest: string;
  votes: readonly PairwiseVote[];
  candidateVersion?: string;
  baselineVersion?: string;
  now?: () => Date;
}): PairwiseRegressionReport {
  const pw = options.rubric.pairwise;
  const swapPositions = pw?.swapPositions ?? true;
  const tieOnDisagreement = pw?.tieOnDisagreement ?? true;
  const declaredMinWinRate = pw?.minWinRate ?? POLICY_MIN_PAIRWISE_WIN_RATE;
  if (declaredMinWinRate < POLICY_MIN_PAIRWISE_WIN_RATE) {
    throw new Error(
      `rubric.json pairwise.minWinRate (${declaredMinWinRate}) is below policy floor (${POLICY_MIN_PAIRWISE_WIN_RATE})`,
    );
  }
  if (!swapPositions) {
    throw new Error('Policy requires pairwise.swapPositions to remain true to guard against position bias');
  }
  if (!tieOnDisagreement) {
    throw new Error('Policy requires pairwise.tieOnDisagreement to remain true');
  }
  const minWinRate = declaredMinWinRate;
  const minJudges = POLICY_MIN_PAIRWISE_JUDGES;
  const knownCriteria = new Set(options.rubric.criteria.map(c => c.id));
  const abstainOn = [...new Set(pw?.abstainOn ?? [])];
  for (const cid of abstainOn) {
    if (!knownCriteria.has(cid)) {
      throw new Error(`rubric.json pairwise.abstainOn references unknown criterion "${cid}"`);
    }
  }
  const abstainSet = new Set(abstainOn);
  const requiredCriteria = options.rubric.criteria.map(c => c.id).filter(id => !abstainSet.has(id));

  const normalizedVotes = options.votes.map(vote => pairwiseVoteSchema.parse(vote));
  const seenKeys = new Set<string>();
  const activeVotes: PairwiseVote[] = [];
  let abstainedVotes = 0;

  for (const vote of normalizedVotes) {
    if (vote.criterionId !== undefined && !knownCriteria.has(vote.criterionId)) {
      throw new Error(`Pairwise vote references unknown rubric criterion "${vote.criterionId}"`);
    }
    const key = `${vote.caseId}\0${vote.judgeId}\0${vote.order}\0${vote.criterionId ?? ''}`;
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate pairwise vote for (${vote.caseId}, ${vote.judgeId}, ${vote.order}${vote.criterionId ? `, ${vote.criterionId}` : ''})`);
    }
    seenKeys.add(key);
    if (vote.criterionId && abstainSet.has(vote.criterionId)) {
      abstainedVotes += 1;
      continue;
    }
    activeVotes.push(vote);
  }

  // Group active votes by caseId -> judgeId -> criterionKey ('' for holistic) -> { AB, BA }.
  // Requiring AB and BA per criterionKey prevents cross-criterion splice (e.g. AB on R1 + BA on R2) from passing as swapped!
  const byCase = new Map<string, Map<string, Map<string, { AB?: LogicalWinner; BA?: LogicalWinner }>>>();
  for (const vote of activeVotes) {
    let judgeMap = byCase.get(vote.caseId);
    if (!judgeMap) {
      judgeMap = new Map();
      byCase.set(vote.caseId, judgeMap);
    }
    let critMap = judgeMap.get(vote.judgeId);
    if (!critMap) {
      critMap = new Map();
      judgeMap.set(vote.judgeId, critMap);
    }
    const critKey = vote.criterionId ?? '';
    let pair = critMap.get(critKey);
    if (!pair) {
      pair = {};
      critMap.set(critKey, pair);
    }
    pair[vote.order] = translateDisplayWinner(vote.order, vote.winner);
  }

  const collapseDirection = (votes: LogicalWinner[]): LogicalWinner | null => {
    if (!votes.length) return null;
    const nonAbstain = votes.filter(v => v !== 'abstain');
    if (!nonAbstain.length) return 'abstain';
    const distinct = new Set(nonAbstain);
    if (distinct.size === 1) return [...distinct][0]!;
    return 'tie';
  };

  const cases: PairwiseCaseOutcome[] = [];
  const incompleteCases: string[] = [];
  let candidateWins = 0;
  let baselineWins = 0;
  let ties = 0;
  let abstainedCases = 0;
  let totalPositionFlips = 0;
  let totalJudgeDisagreements = 0;

  for (const caseId of [...byCase.keys()].sort()) {
    const judgeMap = byCase.get(caseId)!;
    const judges: PairwiseJudgeOutcome[] = [];
    let casePositionFlips = 0;
    let hasIncompleteJudge = false;

    const caseHasCriterionVotes = [...judgeMap.values()].some(cm => [...cm.keys()].some(k => k !== ''));
    const caseHasHolisticVotes = [...judgeMap.values()].some(cm => cm.has(''));

    for (const judgeId of [...judgeMap.keys()].sort()) {
      const critMap = judgeMap.get(judgeId)!;
      const abAll: LogicalWinner[] = [];
      const baAll: LogicalWinner[] = [];
      const critOutcomes: LogicalWinner[] = [];
      let judgeIncomplete = false;
      let judgeFlipped = false;

      // Mixing holistic and per-criterion votes within the same case fails closed as incomplete.
      if (caseHasCriterionVotes && caseHasHolisticVotes) {
        judgeIncomplete = true;
      }
      // When per-criterion votes are used, every judge must cover ALL non-abstained rubric criteria in both AB and BA.
      if (caseHasCriterionVotes) {
        for (const reqCid of requiredCriteria) {
          const reqPair = critMap.get(reqCid);
          if (!reqPair || reqPair.AB === undefined || reqPair.BA === undefined) {
            judgeIncomplete = true;
          }
        }
      }

      for (const [, pair] of [...critMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (pair.AB !== undefined) abAll.push(pair.AB);
        if (pair.BA !== undefined) baAll.push(pair.BA);
        if (pair.AB === undefined || pair.BA === undefined) {
          judgeIncomplete = true;
          continue;
        }
        if (pair.AB === 'abstain' && pair.BA === 'abstain') {
          critOutcomes.push('abstain');
          continue;
        }
        if (pair.AB !== pair.BA) {
          judgeFlipped = true;
          critOutcomes.push('tie');
          continue;
        }
        critOutcomes.push(pair.AB);
      }

      const abWinner = collapseDirection(abAll);
      const baWinner = collapseDirection(baAll);

      if (judgeIncomplete) {
        hasIncompleteJudge = true;
        judges.push({
          judgeId,
          abWinner,
          baWinner,
          positionInconsistent: judgeFlipped,
          incomplete: true,
          outcome: 'incomplete',
        });
        continue;
      }

      if (judgeFlipped) {
        casePositionFlips += 1;
        judges.push({
          judgeId,
          abWinner,
          baWinner,
          positionInconsistent: true,
          incomplete: false,
          outcome: 'tie',
        });
        continue;
      }

      const finalJudgeOutcome = collapseDirection(critOutcomes) ?? 'abstain';
      judges.push({
        judgeId,
        abWinner,
        baWinner,
        positionInconsistent: false,
        incomplete: false,
        outcome: finalJudgeOutcome,
      });
    }

    totalPositionFlips += casePositionFlips;

    if (hasIncompleteJudge) {
      incompleteCases.push(caseId);
      cases.push({
        caseId,
        outcome: 'incomplete',
        judges,
        positionFlips: casePositionFlips,
        judgeDisagreement: false,
        reason: 'Missing AB or BA swapped evaluation for one or more judges',
      });
      continue;
    }

    const completeJudges = judges.filter(j => j.outcome !== 'abstain');
    if (completeJudges.length === 0) {
      abstainedCases += 1;
      cases.push({
        caseId,
        outcome: 'abstain',
        judges,
        positionFlips: casePositionFlips,
        judgeDisagreement: false,
      });
      continue;
    }

    if (completeJudges.length < minJudges) {
      incompleteCases.push(caseId);
      cases.push({
        caseId,
        outcome: 'incomplete',
        judges,
        positionFlips: casePositionFlips,
        judgeDisagreement: false,
        reason: `Requires at least ${minJudges} distinct non-abstain judges (got ${completeJudges.length})`,
      });
      continue;
    }

    const distinctOutcomes = new Set(completeJudges.map(j => j.outcome));
    if (distinctOutcomes.size === 1) {
      const unanimous = [...distinctOutcomes][0]!;
      if (unanimous === 'candidate') candidateWins += 1;
      else if (unanimous === 'baseline') baselineWins += 1;
      else ties += 1;
      cases.push({
        caseId,
        outcome: unanimous as 'candidate' | 'baseline' | 'tie',
        judges,
        positionFlips: casePositionFlips,
        judgeDisagreement: false,
      });
    } else {
      ties += 1;
      totalJudgeDisagreements += 1;
      cases.push({
        caseId,
        outcome: 'tie',
        judges,
        positionFlips: casePositionFlips,
        judgeDisagreement: true,
        reason: 'Judges disagreed; resolved to tie',
      });
    }
  }

  const evaluatedCases = candidateWins + baselineWins + ties;
  const decisiveCases = candidateWins + baselineWins;
  const winRate = evaluatedCases === 0 ? 0 : round3(candidateWins / evaluatedCases);
  const decisiveWinRate = decisiveCases === 0 ? null : round3(candidateWins / decisiveCases);

  const failureReasons: string[] = [];
  if (evaluatedCases === 0) {
    failureReasons.push('没有有效的双评委换位对比样本（evaluatedCases = 0）');
  }
  if (incompleteCases.length > 0) {
    failureReasons.push(`存在未完成换位或不足 ${minJudges} 位评委的样本：${incompleteCases.join('、')}`);
  }
  if (evaluatedCases > 0 && candidateWins / evaluatedCases < minWinRate) {
    failureReasons.push(`严格胜率 ${winRate} 低于晋升门槛 ${minWinRate}（胜 ${candidateWins} / 负 ${baselineWins} / 平 ${ties}）`);
  }
  if (baselineWins > candidateWins) {
    failureReasons.push(`候选版本败场（${baselineWins}）多于胜场（${candidateWins}）`);
  }

  const passed = failureReasons.length === 0;

  return {
    schemaVersion: 1,
    roleId: options.rubric.roleId,
    rubricDigest: options.rubricDigest,
    evaluatedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(options.candidateVersion ? { candidateVersion: options.candidateVersion } : {}),
    ...(options.baselineVersion ? { baselineVersion: options.baselineVersion } : {}),
    config: {
      swapPositions,
      tieOnDisagreement,
      minWinRate,
      minJudges,
      abstainOn,
    },
    totalVotes: normalizedVotes.length,
    abstainedVotes,
    totalCases: cases.length,
    evaluatedCases,
    abstainedCases,
    incompleteCases,
    candidateWins,
    baselineWins,
    ties,
    positionFlips: totalPositionFlips,
    judgeDisagreements: totalJudgeDisagreements,
    winRate,
    decisiveWinRate,
    passed,
    promotionReady: passed,
    failureReasons,
    cases,
    votesDigest: digestPairwiseVotes(normalizedVotes),
    votes: normalizedVotes,
  };
}

export async function runPairwiseRegression(options: {
  roleDirectory: string;
  votesPath: string;
  rubricPath?: string;
  workspace?: string;
  candidateVersion?: string;
  baselineVersion?: string;
  now?: () => Date;
}): Promise<PairwiseRegressionReport> {
  const roleDirectory = path.resolve(options.roleDirectory);
  const [rubric, votes, rubricDigest, profileRaw] = await Promise.all([
    loadRubric(roleDirectory, options.rubricPath),
    loadPairwiseVotes(options.votesPath),
    computeRubricDigest(roleDirectory, options.rubricPath),
    readFile(path.join(roleDirectory, 'profile.json'), 'utf8').catch(() => undefined),
  ]);
  if (profileRaw !== undefined) {
    const profileId = z.object({ id: z.string().min(1) }).passthrough().parse(JSON.parse(profileRaw)).id;
    if (profileId !== rubric.roleId) {
      throw new Error(`rubric.json roleId "${rubric.roleId}" does not match profile.json id "${profileId}"`);
    }
  }
  const report = evaluatePairwiseRegression({
    rubric,
    rubricDigest,
    votes,
    ...(options.candidateVersion ? { candidateVersion: options.candidateVersion } : {}),
    ...(options.baselineVersion ? { baselineVersion: options.baselineVersion } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (options.workspace) {
    const outFile = pairwiseRegressionPath(options.workspace, rubric.roleId);
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

export type LoadedPairwiseRegression =
  | { state: 'missing' }
  | { state: 'invalid'; error: string }
  | { state: 'ok'; report: PairwiseRegressionReport };

export async function readPairwiseRegression(workspace: string, roleId: string): Promise<LoadedPairwiseRegression> {
  let text: string;
  try {
    text = await readFile(pairwiseRegressionPath(workspace, roleId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const report = pairwiseRegressionReportSchema.parse(JSON.parse(text));
    if (report.roleId !== roleId) {
      return { state: 'invalid', error: `pairwise-regression.json roleId "${report.roleId}" does not match "${roleId}"` };
    }
    return { state: 'ok', report };
  } catch (error) {
    const summary = error instanceof z.ZodError
      ? error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).slice(0, 3).join('; ')
      : (error instanceof Error ? error.message.split(/\r?\n/, 1)[0] || 'invalid report' : String(error));
    return { state: 'invalid', error: summary };
  }
}

export function formatPairwiseRegressionText(report: PairwiseRegressionReport): string {
  const lines = [
    `Pairwise A/B 换位双评回归：角色 ${report.roleId}，摘要 ${report.rubricDigest.slice(0, 12)}（门槛 winRate >= ${report.config.minWinRate}，至少 ${report.config.minJudges} 位评委）`,
    `样本 ${report.evaluatedCases}（胜 ${report.candidateWins} / 负 ${report.baselineWins} / 平 ${report.ties}，位置翻转 ${report.positionFlips}，评委分歧 ${report.judgeDisagreements}，弃权票 ${report.abstainedVotes}）`,
    `严格胜率：${report.winRate}${report.decisiveWinRate !== null ? `（决胜局胜率 ${report.decisiveWinRate}）` : ''}`,
  ];
  if (report.failureReasons.length) {
    lines.push(`未通过：${report.failureReasons.join('；')}`);
  } else {
    lines.push('Pairwise 回归通过，满足 trial → formal 晋升防通胀门槛。');
  }
  return lines.join('\n');
}
