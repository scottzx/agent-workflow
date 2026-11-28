/**
 * Offline golden-set scorer for pr-delivery cross-model CR.
 * Patterns are case-insensitive literals, never regular expressions.
 * A missing or ambiguous VERDICT fails closed and is never treated as PASS.
 * A standalone MUST label without a leading `#` is still a MUST section.
 * PASS with a real blocker marker and no MUST heading fails closed, not as zero findings.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{7,40}$/;
const VERDICT_LINE = /^\s*(?:[-*]\s*)?(?:\*\*|__)?VERDICT(?:\*\*|__)?\s*[:：]\s*(.+)$/i;
const SOLO_VERDICT = /^\s*(?:\*\*|__)?(CHANGES_REQUESTED|PASS)(?:\*\*|__)?\s*$/;
const EMPTY_MUST_PHRASES = new Set(['无', '无阻塞项', '无阻塞缺陷', '无必须项', 'none', 'n/a', 'na', 'nil', '0', 'no must issues', 'no must', 'no issues']);
const DIGEST_FILES = ['QA.md', 'checklist.json', 'evals/manifest.json', 'routing.json'] as const;
const REQUIRED_DIGEST_FILES = ['QA.md', 'checklist.json', 'evals/manifest.json'] as const;

export const crEvalDefectSchema = z.object({
  id: z.string().min(1).max(80),
  description: z.string().min(1).max(2000),
  anyFilePatterns: z.array(z.string().min(1).max(240)).min(1),
  anyTextPatterns: z.array(z.string().min(1).max(240)).min(1),
}).strict();
export type CrEvalDefect = z.infer<typeof crEvalDefectSchema>;

export const crEvalCaseSchema = z.object({
  id: z.string().min(1).max(80),
  pr: z.number().int().positive(),
  kind: z.enum(['negative', 'positive']),
  baseCommit: z.string().regex(SHA),
  headCommit: z.string().regex(SHA),
  expectedVerdict: z.enum(['CHANGES_REQUESTED', 'PASS']),
  summary: z.string().min(1).max(4000),
  requiredDefects: z.array(crEvalDefectSchema).optional(),
}).strict().superRefine((item, ctx) => {
  if (item.kind === 'negative') {
    if (item.expectedVerdict !== 'CHANGES_REQUESTED') {
      ctx.addIssue({ code: 'custom', message: 'negative case must expect CHANGES_REQUESTED' });
    }
    if (!item.requiredDefects?.length) {
      ctx.addIssue({ code: 'custom', message: 'negative case requires at least one defect' });
    }
  }
  if (item.kind === 'positive') {
    if (item.expectedVerdict !== 'PASS') ctx.addIssue({ code: 'custom', message: 'positive case must expect PASS' });
    if (item.requiredDefects?.length) ctx.addIssue({ code: 'custom', message: 'positive case must not list requiredDefects' });
  }
  const seen = new Set<string>();
  item.requiredDefects?.forEach((defect, index) => {
    if (seen.has(defect.id)) ctx.addIssue({ code: 'custom', path: ['requiredDefects', index, 'id'], message: `duplicate defect id ${defect.id}` });
    seen.add(defect.id);
  });
});
export type CrEvalCase = z.infer<typeof crEvalCaseSchema>;

export const crEvalManifestSchema = z.object({
  schemaVersion: z.literal(1),
  roleId: z.string().min(1),
  snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  cases: z.array(crEvalCaseSchema).min(1),
}).strict().superRefine((manifest, ctx) => {
  const seen = new Set<string>();
  manifest.cases.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: ['cases', index, 'id'], message: `duplicate case id ${item.id}` });
    seen.add(item.id);
  });
});
export type CrEvalManifest = z.infer<typeof crEvalManifestSchema>;

export const crReviewFindingSchema = z.object({
  id: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  summary: z.string().min(1),
  evidence: z.string().optional(),
}).strict();
export type CrReviewFinding = z.infer<typeof crReviewFindingSchema>;

export const crReviewResultSchema = z.object({
  caseId: z.string().min(1),
  verdict: z.enum(['CHANGES_REQUESTED', 'PASS']),
  must: z.array(crReviewFindingSchema),
  should: z.array(crReviewFindingSchema).optional(),
  rawText: z.string().optional(),
}).strict();
export type CrReviewResult = z.infer<typeof crReviewResultSchema>;

export interface CrEvalCommitVerification {
  ok: boolean;
  /** base/head endpoints whose `git cat-file -t` returned commit. Shared SHAs count once per endpoint. */
  checkedCommits: number;
  errors: string[];
}

export interface CrEvalCaseResult {
  caseId: string;
  kind: 'negative' | 'positive';
  expectedVerdict: 'CHANGES_REQUESTED' | 'PASS';
  actualVerdict: 'CHANGES_REQUESTED' | 'PASS';
  passed: boolean;
  matchedDefects: string[];
  missedDefects: string[];
  falsePositive: boolean;
}

export interface CrEvalScore {
  totalCases: number;
  negativeCases: number;
  positiveCases: number;
  negativeCaught: number;
  negativeMissed: number;
  positivePassed: number;
  falsePositives: number;
  missingCases: string[];
  unknownCases: string[];
  totalDefects: number;
  matchedDefects: number;
  negativeRecall: number;
  defectRecall: number;
  falsePositiveRate: number;
  passed: boolean;
  promotionReady: boolean;
  caseResults: CrEvalCaseResult[];
}

interface SpecialSection {
  kind: 'verdict' | 'must' | 'should';
  title: string;
  body: string;
  bodyLine: number;
}

/** Walk up to the nearest real `.git` file or directory. A symlink `.git` is not an anchor. */
export async function findRepoRoot(start: string): Promise<string> {
  let current = resolve(start);
  for (;;) {
    const gitPath = join(current, '.git');
    let info;
    try { info = await lstat(gitPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      info = undefined;
    }
    if (info?.isSymbolicLink()) throw new Error(`Refusing ${gitPath}: symlink is not a repository anchor`);
    if (info && (info.isFile() || info.isDirectory())) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`No .git repository found above ${start}`);
    current = parent;
  }
}

export interface CrEvalLintIssue {
  code:
    | 'min_cases'
    | 'class_balance'
    | 'empty_commit_range'
    | 'duplicate_commit_pair'
    | 'duplicate_defect_id'
    | 'duplicate_pattern'
    | 'weak_text_pattern'
    | 'weak_file_pattern'
    | 'indistinguishable_defects'
    | 'commit_verification'
    | 'unmatched_diff_file_pattern'
    | 'snapshot_digest_missing'
    | 'snapshot_digest_mismatch';
  caseId?: string;
  defectId?: string;
  message: string;
}

export interface CrEvalLintReport {
  ok: boolean;
  roleId: string;
  totalCases: number;
  negativeCases: number;
  positiveCases: number;
  negativeRatio: number;
  totalDefects: number;
  declaredSnapshotDigest?: string;
  expectedSnapshotDigest: string;
  snapshotFrozen: boolean;
  checkedCommits?: number;
  issues: CrEvalLintIssue[];
}

const GENERIC_TEXT_PATTERNS = new Set([
  'bug', 'fix', 'error', 'fail', 'failed', 'pass', 'must', 'should', 'todo', 'issue', 'change', 'code', 'file', 'test', 'check', 'ok', 'warn',
]);
const GENERIC_FILE_PATTERNS = new Set([
  '.', '/', '*', '**', 'src', 'packages', 'test', 'tests', 'ts', 'tsx', 'js', 'mjs', 'json', 'md', 'yml', 'yaml',
]);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Deterministic frozen SHA-256 over the manifest payload excluding `snapshotDigest` itself. */
export function computeManifestSnapshotDigest(manifest: Pick<CrEvalManifest, 'schemaVersion' | 'roleId' | 'cases'>): string {
  const payload = {
    schemaVersion: manifest.schemaVersion,
    roleId: manifest.roleId,
    cases: manifest.cases,
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export async function lintCrEvalManifest(
  manifest: CrEvalManifest,
  options?: {
    repoRoot?: string;
    minCases?: number;
    minNegativeRatio?: number;
    maxNegativeRatio?: number;
    requireSnapshotDigest?: boolean;
  },
): Promise<CrEvalLintReport> {
  const parsed = crEvalManifestSchema.parse(manifest);
  const minCases = options?.minCases ?? 20;
  const minNegativeRatio = options?.minNegativeRatio ?? 0.45;
  const maxNegativeRatio = options?.maxNegativeRatio ?? 0.75;
  const requireSnapshotDigest = options?.requireSnapshotDigest ?? true;

  const issues: CrEvalLintIssue[] = [];
  const totalCases = parsed.cases.length;
  const negativeCases = parsed.cases.filter(item => item.kind === 'negative').length;
  const positiveCases = parsed.cases.filter(item => item.kind === 'positive').length;
  const negativeRatio = totalCases === 0 ? 0 : Math.round((negativeCases / totalCases) * 1000) / 1000;
  const totalDefects = parsed.cases.reduce((sum, item) => sum + (item.requiredDefects?.length ?? 0), 0);

  if (totalCases < minCases) {
    issues.push({
      code: 'min_cases',
      message: `Manifest has ${totalCases} cases, requiring at least ${minCases}`,
    });
  }
  if (negativeCases === 0 || positiveCases === 0 || negativeRatio < minNegativeRatio || negativeRatio > maxNegativeRatio) {
    issues.push({
      code: 'class_balance',
      message: `Class balance out of range: negative=${negativeCases}, positive=${positiveCases} (negativeRatio=${negativeRatio}, expected ${minNegativeRatio}..${maxNegativeRatio})`,
    });
  }

  const seenCommitPairs = new Map<string, string>();
  const seenDefectIds = new Map<string, string>();

  for (const item of parsed.cases) {
    if (item.baseCommit === item.headCommit) {
      issues.push({
        code: 'empty_commit_range',
        caseId: item.id,
        message: `${item.id}: baseCommit equals headCommit (${item.baseCommit})`,
      });
    }
    const pairKey = `${item.baseCommit}..${item.headCommit}`;
    const priorCase = seenCommitPairs.get(pairKey);
    if (priorCase) {
      issues.push({
        code: 'duplicate_commit_pair',
        caseId: item.id,
        message: `${item.id}: commit range ${pairKey} duplicates ${priorCase}`,
      });
    } else {
      seenCommitPairs.set(pairKey, item.id);
    }

    const defectSignatures = new Set<string>();
    for (const defect of item.requiredDefects ?? []) {
      const priorOwner = seenDefectIds.get(defect.id);
      if (priorOwner) {
        issues.push({
          code: 'duplicate_defect_id',
          caseId: item.id,
          defectId: defect.id,
          message: `${item.id}/${defect.id}: defect id duplicates ${priorOwner}`,
        });
      } else {
        seenDefectIds.set(defect.id, item.id);
      }

      const normFiles = new Set<string>();
      for (const fp of defect.anyFilePatterns) {
        const trimmed = fp.trim().toLowerCase();
        if (normFiles.has(trimmed)) {
          issues.push({
            code: 'duplicate_pattern',
            caseId: item.id,
            defectId: defect.id,
            message: `${item.id}/${defect.id}: duplicate file pattern "${fp}"`,
          });
        }
        normFiles.add(trimmed);
        if (trimmed.length < 3 || GENERIC_FILE_PATTERNS.has(trimmed)) {
          issues.push({
            code: 'weak_file_pattern',
            caseId: item.id,
            defectId: defect.id,
            message: `${item.id}/${defect.id}: overly generic file pattern "${fp}"`,
          });
        }
      }

      const normTexts = new Set<string>();
      for (const tp of defect.anyTextPatterns) {
        const trimmed = tp.trim().toLowerCase();
        if (normTexts.has(trimmed)) {
          issues.push({
            code: 'duplicate_pattern',
            caseId: item.id,
            defectId: defect.id,
            message: `${item.id}/${defect.id}: duplicate text pattern "${tp}"`,
          });
        }
        normTexts.add(trimmed);
        if (trimmed.length < 2 || GENERIC_TEXT_PATTERNS.has(trimmed)) {
          issues.push({
            code: 'weak_text_pattern',
            caseId: item.id,
            defectId: defect.id,
            message: `${item.id}/${defect.id}: overly generic text pattern "${tp}"`,
          });
        }
      }

      const signature = `${[...normFiles].sort().join('|')}::${[...normTexts].sort().join('|')}`;
      if (defectSignatures.has(signature)) {
        issues.push({
          code: 'indistinguishable_defects',
          caseId: item.id,
          defectId: defect.id,
          message: `${item.id}/${defect.id}: shares identical file+text pattern signature with another defect in the same case`,
        });
      }
      defectSignatures.add(signature);
    }
  }

  let checkedCommits: number | undefined;
  if (options?.repoRoot) {
    const verification = await verifyCrEvalCommits(parsed, options.repoRoot);
    checkedCommits = verification.checkedCommits;
    for (const err of verification.errors) {
      issues.push({ code: 'commit_verification', message: err });
    }
    if (verification.ok) {
      for (const item of parsed.cases) {
        if (item.kind !== 'negative' || !item.requiredDefects?.length) continue;
        const diff = await git(options.repoRoot, ['diff', '--name-only', item.baseCommit, item.headCommit]);
        if (diff.code !== 0) {
          issues.push({
            code: 'commit_verification',
            caseId: item.id,
            message: `${item.id}: git diff ${item.baseCommit}..${item.headCommit} failed`,
          });
          continue;
        }
        const changedFiles = diff.stdout.split(/\r?\n/).map(line => line.trim().toLowerCase()).filter(Boolean);
        for (const defect of item.requiredDefects) {
          const matchesDiff = defect.anyFilePatterns.some(pattern => {
            const needle = pattern.trim().toLowerCase();
            return changedFiles.some(file => file.includes(needle));
          });
          if (!matchesDiff) {
            issues.push({
              code: 'unmatched_diff_file_pattern',
              caseId: item.id,
              defectId: defect.id,
              message: `${item.id}/${defect.id}: none of anyFilePatterns [${defect.anyFilePatterns.join(', ')}] appear in git diff ${item.baseCommit}..${item.headCommit}`,
            });
          }
        }
      }
    }
  }

  const expectedSnapshotDigest = computeManifestSnapshotDigest(parsed);
  const declaredSnapshotDigest = parsed.snapshotDigest;
  let snapshotFrozen = false;
  if (!declaredSnapshotDigest) {
    if (requireSnapshotDigest) {
      issues.push({
        code: 'snapshot_digest_missing',
        message: `Missing snapshotDigest freeze field (expected ${expectedSnapshotDigest})`,
      });
    }
  } else if (declaredSnapshotDigest !== expectedSnapshotDigest) {
    issues.push({
      code: 'snapshot_digest_mismatch',
      message: `snapshotDigest mismatch: declared ${declaredSnapshotDigest} !== computed ${expectedSnapshotDigest}`,
    });
  } else {
    snapshotFrozen = true;
  }

  return {
    ok: issues.length === 0,
    roleId: parsed.roleId,
    totalCases,
    negativeCases,
    positiveCases,
    negativeRatio,
    totalDefects,
    ...(declaredSnapshotDigest ? { declaredSnapshotDigest } : {}),
    expectedSnapshotDigest,
    snapshotFrozen,
    ...(checkedCommits !== undefined ? { checkedCommits } : {}),
    issues,
  };
}

export function formatCrEvalLintText(report: CrEvalLintReport): string {
  const lines = [
    `CR 考卷清单一键 Lint：角色 ${report.roleId}，样本 ${report.totalCases}（负 ${report.negativeCases} / 正 ${report.positiveCases}，负样本占比 ${(report.negativeRatio * 100).toFixed(1)}%），缺陷 ${report.totalDefects}`,
    `快照冻结：${report.snapshotFrozen ? '已冻结' : '未冻结/不匹配'}（expected ${report.expectedSnapshotDigest.slice(0, 12)}）`,
  ];
  if (report.checkedCommits !== undefined) lines.push(`提交核验端点数：${report.checkedCommits}`);
  if (report.issues.length) {
    lines.push(`发现 ${report.issues.length} 个问题：`);
    for (const issue of report.issues) lines.push(`  [${issue.code}] ${issue.message}`);
  } else {
    lines.push('Lint 全部通过。');
  }
  return lines.join('\n');
}

export async function loadCrEvalManifest(roleDirectory: string): Promise<CrEvalManifest> {
  const manifestFile = await readContained(roleDirectory, 'evals/manifest.json');
  const profileFile = await readContained(roleDirectory, 'profile.json');
  let manifestJson: unknown;
  let profileJson: unknown;
  try { manifestJson = JSON.parse(manifestFile.text); }
  catch { throw new Error('evals/manifest.json is not valid JSON'); }
  try { profileJson = JSON.parse(profileFile.text); }
  catch { throw new Error('profile.json is not valid JSON'); }
  const manifest = crEvalManifestSchema.parse(manifestJson);
  const profileId = profileJson && typeof profileJson === 'object' ? (profileJson as { id?: unknown }).id : undefined;
  if (typeof profileId !== 'string' || profileId !== manifest.roleId) {
    throw new Error(`evals/manifest.json roleId ${manifest.roleId} does not match profile.json id ${typeof profileId === 'string' ? profileId : '(missing)'}`);
  }
  if (manifest.snapshotDigest) {
    const expected = computeManifestSnapshotDigest(manifest);
    if (manifest.snapshotDigest !== expected) {
      throw new Error(`evals/manifest.json snapshotDigest mismatch: declared ${manifest.snapshotDigest} !== computed ${expected}`);
    }
  }
  return manifest;
}

/** SHA-256 of the eval manifest and the CR instructions it is scored against, in sorted path order. */
export async function computeCrEvalDigest(roleDirectory: string): Promise<string> {
  const present: string[] = [];
  for (const rel of DIGEST_FILES) {
    const found = await containedKind(roleDirectory, rel);
    if (found === 'missing') {
      if ((REQUIRED_DIGEST_FILES as readonly string[]).includes(rel)) throw new Error(`Missing ${rel} under ${roleDirectory}`);
      continue;
    }
    present.push(rel);
  }
  present.sort();
  const hash = createHash('sha256');
  for (const rel of present) {
    const file = await readContained(roleDirectory, rel);
    hash.update(rel);
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function verifyCrEvalCommits(manifest: CrEvalManifest, repoRoot: string): Promise<CrEvalCommitVerification> {
  const parsed = crEvalManifestSchema.parse(manifest);
  const errors: string[] = [];
  let checkedCommits = 0;
  for (const item of parsed.cases) {
    const baseOk = await isCommit(repoRoot, item.baseCommit);
    const headOk = await isCommit(repoRoot, item.headCommit);
    if (baseOk.ok) checkedCommits += 1;
    else errors.push(`${item.id} baseCommit ${item.baseCommit} is not a commit${baseOk.detail ? ` (${baseOk.detail})` : ''}`);
    if (headOk.ok) checkedCommits += 1;
    else errors.push(`${item.id} headCommit ${item.headCommit} is not a commit${headOk.detail ? ` (${headOk.detail})` : ''}`);
    if (!baseOk.ok || !headOk.ok) continue;
    const ancestor = await git(repoRoot, ['merge-base', '--is-ancestor', item.baseCommit, item.headCommit]);
    if (ancestor.code !== 0) {
      errors.push(`${item.id} baseCommit ${item.baseCommit} is not an ancestor of headCommit ${item.headCommit}`);
    }
  }
  return { ok: errors.length === 0, checkedCommits, errors };
}

/**
 * Parse a Markdown CR report. A VERDICT heading uses the heading line, otherwise only its first
 * non-empty line. Later explanation cannot add a second verdict. Fenced code is not a heading.
 * MUST/SHOULD prose cannot supply or override the verdict.
 * Bold or bare label lines (`**MUST**`, `MUST:`) open the same sections as `#` headings.
 * With no MUST section at all, a top-level blocker marker still becomes a MUST finding.
 */
export function parseMarkdownCrReport(caseId: string, markdown: string): CrReviewResult {
  if (!caseId.trim()) throw new Error('caseId is required');
  const { preamble, sections } = splitSpecial(markdown);
  const verdictSections = sections.filter(section => section.kind === 'verdict');
  const verdict = verdictSections.length
    ? oneVerdict(verdictSections.flatMap(section => verdictTokens(section)), caseId)
    : oneVerdict(declarationTokens(preamble, sections), caseId);
  const headed = sections.some(section => section.kind === 'must');
  const must = headed
    ? sections.filter(section => section.kind === 'must').flatMap(section => parseFindings(section.body, section.bodyLine))
    : extractLooseBlockers(preamble, sections);
  const should = sections.filter(section => section.kind === 'should').flatMap(section => parseFindings(section.body, section.bodyLine));
  return crReviewResultSchema.parse({
    caseId, verdict, must, ...(should.length ? { should } : {}), rawText: markdown,
  });
}

/** Accept a JSON array or `{ results }` whose items are structured results or `{ caseId, markdown }`. */
export function coerceCrEvalResults(input: unknown): CrReviewResult[] {
  const items = Array.isArray(input) ? input
    : input && typeof input === 'object' && Array.isArray((input as { results?: unknown }).results)
      ? (input as { results: unknown[] }).results
      : undefined;
  if (!items) throw new Error('results must be a JSON array or { results: [...] }');
  return items.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`result ${index} is not an object`);
    const record = item as Record<string, unknown>;
    if (typeof record.markdown === 'string') {
      if (typeof record.caseId !== 'string' || !record.caseId.trim()) throw new Error(`result ${index} markdown is missing caseId`);
      return parseMarkdownCrReport(record.caseId, record.markdown);
    }
    return crReviewResultSchema.parse(record);
  });
}

/**
 * Score one report per manifest case. Duplicate and unknown case ids throw.
 * A returned report therefore always has `unknownCases: []`; missing cases stay in the report and fail it.
 */
export function scoreCrEvalSuite(manifest: CrEvalManifest, results: CrReviewResult[]): CrEvalScore {
  const parsed = crEvalManifestSchema.parse(manifest);
  const reviews = results.map(result => crReviewResultSchema.parse(result));
  const known = new Set(parsed.cases.map(item => item.id));
  const byId = new Map<string, CrReviewResult>();
  const unknown: string[] = [];
  for (const review of reviews) {
    if (byId.has(review.caseId)) throw new Error(`duplicate CR result for ${review.caseId}`);
    if (!known.has(review.caseId)) unknown.push(review.caseId);
    byId.set(review.caseId, review);
  }
  if (unknown.length) throw new Error(`unknown CR result caseId: ${unknown.join(', ')}`);
  const caseResults: CrEvalCaseResult[] = [];
  const missingCases: string[] = [];
  for (const item of parsed.cases) {
    const review = byId.get(item.id);
    if (!review) {
      missingCases.push(item.id);
      continue;
    }
    caseResults.push(scoreCase(item, review));
  }
  const negativeCases = parsed.cases.filter(item => item.kind === 'negative').length;
  const positiveCases = parsed.cases.filter(item => item.kind === 'positive').length;
  const negativeCaught = caseResults.filter(item => item.kind === 'negative' && item.passed).length;
  const negativeMissed = caseResults.filter(item => item.kind === 'negative' && !item.passed).length;
  const positivePassed = caseResults.filter(item => item.kind === 'positive' && item.passed).length;
  const falsePositives = caseResults.filter(item => item.falsePositive).length;
  const totalDefects = parsed.cases.reduce((sum, item) => sum + (item.requiredDefects?.length ?? 0), 0);
  const matchedDefects = caseResults.reduce((sum, item) => sum + item.matchedDefects.length, 0);
  const passed = missingCases.length === 0 && negativeMissed === 0 && falsePositives === 0 && caseResults.every(item => item.passed);
  return {
    totalCases: parsed.cases.length,
    negativeCases, positiveCases, negativeCaught, negativeMissed, positivePassed, falsePositives,
    missingCases, unknownCases: [], totalDefects, matchedDefects,
    negativeRecall: ratio(negativeCaught, negativeCases),
    defectRecall: ratio(matchedDefects, totalDefects),
    falsePositiveRate: ratio(falsePositives, positiveCases),
    passed,
    promotionReady: passed && negativeCases > 0 && positiveCases > 0,
    caseResults,
  };
}

function scoreCase(item: CrEvalCase, review: CrReviewResult): CrEvalCaseResult {
  if (item.kind === 'positive') {
    const clean = review.verdict === 'PASS' && review.must.length === 0;
    return {
      caseId: item.id, kind: item.kind, expectedVerdict: item.expectedVerdict, actualVerdict: review.verdict,
      passed: clean, matchedDefects: [], missedDefects: [], falsePositive: !clean,
    };
  }
  const defects = item.requiredDefects ?? [];
  const assigned = assignDefects(defects, review.must);
  const matchedDefects = defects.filter((_, index) => assigned[index] >= 0).map(defect => defect.id);
  const missedDefects = defects.filter((_, index) => assigned[index] < 0).map(defect => defect.id);
  const passed = review.verdict === 'CHANGES_REQUESTED' && missedDefects.length === 0;
  return {
    caseId: item.id, kind: item.kind, expectedVerdict: item.expectedVerdict, actualVerdict: review.verdict,
    passed, matchedDefects, missedDefects, falsePositive: false,
  };
}

function defectHit(defect: CrEvalDefect, finding: CrReviewFinding): boolean {
  const haystack = [finding.file, finding.summary, finding.evidence].filter((part): part is string => Boolean(part)).join('\n').toLowerCase();
  const fileHit = defect.anyFilePatterns.some(pattern => haystack.includes(pattern.toLowerCase()));
  const textHit = defect.anyTextPatterns.some(pattern => haystack.includes(pattern.toLowerCase()));
  return fileHit && textHit;
}

/** One finding may pay for only one defect. Kuhn matching so an earlier overlap cannot hide a later exclusive finding. */
function assignDefects(defects: CrEvalDefect[], findings: CrReviewFinding[]): number[] {
  const assigned = defects.map(() => -1);
  const edges = findings.map(finding => defects.map(defect => defectHit(defect, finding)));
  const visit = (finding: number, seen: boolean[]): boolean => {
    for (let defect = 0; defect < defects.length; defect += 1) {
      if (!edges[finding]?.[defect] || seen[defect]) continue;
      seen[defect] = true;
      const owner = assigned[defect];
      if (owner < 0 || visit(owner, seen)) {
        assigned[defect] = finding;
        return true;
      }
    }
    return false;
  };
  for (let finding = 0; finding < findings.length; finding += 1) visit(finding, defects.map(() => false));
  return assigned;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function splitSpecial(markdown: string): { preamble: string; sections: SpecialSection[] } {
  const lines = markdown.split(/\r?\n/);
  const preamble: string[] = [];
  const sections: SpecialSection[] = [];
  let current: { kind: SpecialSection['kind']; level: number; title: string; lines: string[]; bodyLine: number } | undefined;
  let fence: { char: '`' | '~'; len: number } | undefined;
  const flush = () => {
    if (!current) return;
    sections.push({ kind: current.kind, title: current.title, body: current.lines.join('\n'), bodyLine: current.bodyLine });
    current = undefined;
  };
  const push = (line: string) => {
    if (current) current.lines.push(line);
    else preamble.push(line);
  };
  const openLabel = (label: LabelHit, index: number) => {
    flush();
    if (label.kind === 'other') {
      if (label.inline) push(label.inline);
      return;
    }
    current = {
      kind: label.kind,
      level: 2,
      title: label.title,
      lines: label.inline ? [label.inline] : [],
      bodyLine: index + (label.inline ? 1 : 2),
    };
  };
  lines.forEach((line, index) => {
    const marker = fenceMarker(line);
    if (marker && (!fence || (marker.char === fence.char && marker.len >= fence.len))) {
      fence = fence ? undefined : marker;
      push(line);
      return;
    }
    if (fence) { push(line); return; }
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      const kind = classifyHeading(title);
      const terminator = classifyLabelCore(splitLabel(title).core) === 'other';
      if (current && (level <= current.level || terminator)) flush();
      if (kind && !current) {
        current = { kind, level, title, lines: [], bodyLine: index + 2 };
        return;
      }
      if (current) current.lines.push(line);
      else preamble.push(line);
      return;
    }
    const label = matchStandaloneLabel(line);
    if (label) {
      openLabel(label, index);
      return;
    }
    push(line);
  });
  flush();
  return { preamble: preamble.join('\n'), sections };
}

type LabelKind = SpecialSection['kind'] | 'other';

interface LabelHit {
  kind: LabelKind;
  title: string;
  inline?: string;
}

function classifyHeading(title: string): SpecialSection['kind'] | undefined {
  const stripped = unwrapEmphasis(title).replace(/^\d+\.\s*/, '').trim();
  const core = unwrapEmphasis(stripped);
  if (/^VERDICT\b/i.test(core)) return 'verdict';
  if (/^MUST\b/i.test(core)) return 'must';
  if (/^SHOULD\b/i.test(core)) return 'should';
  return undefined;
}

/** A whole line that is only a section label, not a sentence that mentions one. Fences never reach here. */
function matchStandaloneLabel(line: string): LabelHit | undefined {
  const trimmed = line.trim();
  if (!trimmed || /^[-+>|]/.test(trimmed) || /^\*(?!\*)/.test(trimmed)) return undefined;
  const wrapped = matchWrappedLabel(trimmed);
  const parts = wrapped ?? matchBareLabel(trimmed);
  if (!parts) return undefined;
  const kind = classifyLabelCore(parts.core);
  if (!kind) return undefined;
  const title = parts.rest ? `${parts.core}: ${parts.rest}` : parts.core;
  return { kind, title, ...(parts.rest ? { inline: parts.rest } : {}) };
}

function matchWrappedLabel(trimmed: string): { core: string; rest?: string } | undefined {
  const mark = trimmed.startsWith('**') ? '**' : trimmed.startsWith('__') ? '__' : undefined;
  if (!mark) return undefined;
  const close = trimmed.indexOf(mark, mark.length);
  if (close <= mark.length) return undefined;
  const inner = trimmed.slice(mark.length, close).trim();
  if (!inner) return undefined;
  const after = trimmed.slice(close + mark.length).trim();
  const split = splitLabel(inner);
  if (!classifyLabelCore(split.core)) return undefined;
  if (!after) return { core: split.core, ...(split.rest ? { rest: split.rest } : {}) };
  if (after.startsWith(':') || after.startsWith('：')) {
    const rest = after.slice(1).trim();
    return { core: split.core, ...(rest ? { rest } : {}) };
  }
  if (/[:：]\s*$/.test(inner)) return { core: split.core, rest: after };
  return undefined;
}

function matchBareLabel(trimmed: string): { core: string; rest?: string } | undefined {
  if (trimmed.startsWith('#') || trimmed.startsWith('**') || trimmed.startsWith('__') || /^[-*+>|]/.test(trimmed)) return undefined;
  const body = trimmed.replace(/^\d+\.\s+/, '');
  const split = splitLabel(body);
  if (!classifyLabelCore(split.core)) return undefined;
  const colon = body.search(/[:：]/);
  const head = (colon >= 0 ? body.slice(0, colon) : body).trim();
  const withoutParen = head.replace(/\s*[（(][^）)]*[）)]\s*$/g, '').trim();
  if (withoutParen !== split.core) return undefined;
  const suffix = head.slice(split.core.length).trim();
  if (suffix && !/^[（(][^）)]*[）)]$/.test(suffix)) return undefined;
  return split;
}

function splitLabel(raw: string): { core: string; rest?: string } {
  let text = unwrapEmphasis(raw.trim()).replace(/^(?:\d+\.|[一二三四五六七八九十]+[、.．])\s*/, '').trim();
  text = unwrapEmphasis(text);
  const colon = text.search(/[:：]/);
  let core = text;
  let rest: string | undefined;
  if (colon >= 0) {
    core = text.slice(0, colon).trim();
    rest = text.slice(colon + 1).trim() || undefined;
  }
  core = core.replace(/\s*[（(][^）)]*[）)]\s*$/g, '').trim();
  return { core, ...(rest ? { rest } : {}) };
}

function classifyLabelCore(core: string): LabelKind | undefined {
  if (/^VERDICT$/i.test(core)) return 'verdict';
  if (/^MUST$/i.test(core)) return 'must';
  if (/^SHOULD$/i.test(core)) return 'should';
  if (/^VERIFIED_CHECKS$/i.test(core)) return 'other';
  if (core === '总结' || core === '结论') return 'other';
  if (/^(?:总结|结论)(?:与|和|及)[\u4e00-\u9fffA-Za-z0-9]{1,16}$/.test(core)) return 'other';
  return undefined;
}

function unwrapEmphasis(text: string): string {
  let value = text.trim();
  for (;;) {
    const wrapped = /^(\*\*|__)([\s\S]+)\1$/.exec(value);
    if (!wrapped) return value;
    const inner = wrapped[2].trim();
    if (!inner) return value;
    value = inner;
  }
}

function verdictTokens(section: SpecialSection): string[] {
  const titleTokens = verdictWords(section.title);
  if (titleTokens.length) return titleTokens;
  const visible = stripFences(section.body);
  const first = visible.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  return verdictWords(first);
}

function declarationTokens(preamble: string, sections: SpecialSection[]): string[] {
  const chunks = [preamble, ...sections.filter(section => section.kind !== 'must' && section.kind !== 'should').map(section => `${section.title}\n${stripFences(section.body)}`)];
  const lines = chunks.flatMap(chunk => chunk.split(/\r?\n/).filter(line => VERDICT_LINE.test(line) || SOLO_VERDICT.test(line)));
  return lines.flatMap(verdictWords);
}

function verdictWords(text: string): string[] {
  return [...text.matchAll(/\b(CHANGES_REQUESTED|PASS)\b/g)].map(match => match[1]);
}

function oneVerdict(tokens: string[], caseId: string): 'CHANGES_REQUESTED' | 'PASS' {
  const found = new Set(tokens);
  if (found.size !== 1) throw new Error(`CR report for ${caseId} has no unique VERDICT (found ${[...found].join(', ') || 'none'})`);
  return [...found][0] as 'CHANGES_REQUESTED' | 'PASS';
}

function parseFindings(body: string, originLine: number): CrReviewFinding[] {
  const visible = stripFences(body);
  if (isEmptyMust(visible)) return [];
  const lines = visible.split(/\r?\n/);
  const starts = numberedStarts(lines);
  const ranges = starts.length ? starts : unnumberedStarts(lines);
  return materializeFindings(lines, ranges, originLine);
}

/**
 * No MUST heading at all. Marker lines in the preamble or a non-SHOULD section are still blockers.
 * Prose such as "无 MUST" / "0 MUST" has no marker and stays empty. Fenced samples are already stripped.
 */
function extractLooseBlockers(preamble: string, sections: SpecialSection[]): CrReviewFinding[] {
  const findings: CrReviewFinding[] = [];
  const take = (text: string, originLine: number) => {
    const visible = stripFences(text);
    const lines = visible.split(/\r?\n/);
    const starts = numberedStarts(lines);
    if (!starts.length) return;
    findings.push(...materializeFindings(lines, starts, originLine));
  };
  take(preamble, 1);
  for (const section of sections) {
    if (section.kind === 'should' || section.kind === 'must') continue;
    take(section.body, section.bodyLine);
  }
  return findings;
}

function materializeFindings(lines: string[], ranges: { index: number; id?: string }[], originLine: number): CrReviewFinding[] {
  return ranges.map((start, index) => ({
    id: start.id,
    line: originLine + start.index,
    text: lines.slice(start.index, index + 1 < ranges.length ? ranges[index + 1].index : lines.length).join('\n').trim(),
  })).filter(slice => slice.text && !isEmptyMust(slice.text)).map(slice => {
    const file = extractFileClue(slice.text);
    return {
      ...(slice.id ? { id: slice.id } : {}),
      ...(file ? { file } : {}),
      line: slice.line,
      summary: slice.text,
    };
  });
}

function numberedStarts(lines: string[]): { index: number; id?: string }[] {
  const starts: { index: number; id?: string }[] = [];
  lines.forEach((line, index) => {
    const heading = /^#{1,6}\s+(?:\d+\.\s*)?(?:\[(M\d+)\]|(M\d+))\b/.exec(line);
    if (heading) { starts.push({ index, id: heading[1] || heading[2] }); return; }
    const bullet = /^[-*]\s+\*\*\[(M\d+)\]\*\*/.exec(line);
    if (bullet) { starts.push({ index, id: bullet[1] }); return; }
    const bold = /^\*\*\[(M\d+)\]\*\*/.exec(line);
    if (bold) starts.push({ index, id: bold[1] });
  });
  return starts;
}

/** Without M1/M2 markers, each top-level list item or blank-line paragraph is its own finding. */
function unnumberedStarts(lines: string[]): { index: number; id?: string }[] {
  const listAt = lines.flatMap((line, index) => /^(?:[-*]|\d+\.)\s+\S/.test(line) ? [index] : []);
  if (listAt.length) {
    const starts: { index: number; id?: string }[] = [];
    if (lines.slice(0, listAt[0]).some(line => line.trim())) starts.push({ index: 0 });
    for (const index of listAt) starts.push({ index });
    return starts;
  }
  const starts: { index: number; id?: string }[] = [];
  let open = false;
  lines.forEach((line, index) => {
    if (!line.trim()) { open = false; return; }
    if (!open) { starts.push({ index }); open = true; }
  });
  return starts;
}

function isEmptyMust(text: string): boolean {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.every(line => isEmptyPhrase(normalizeMustLine(line)));
}

function normalizeMustLine(line: string): string {
  let text = line.trim().replace(/^(?:(?:[-+>]|•)\s+|\*\s+)+/, '').trim();
  let wrapped = true;
  while (wrapped) {
    wrapped = false;
    for (const mark of ['**', '__', '`', '*', '_']) {
      if (text.startsWith(mark) && text.endsWith(mark) && text.length > mark.length * 2) {
        const inner = text.slice(mark.length, -mark.length).trim();
        if (inner) { text = inner; wrapped = true; break; }
      }
    }
  }
  return text.replace(/[\s。．.!?！？,，;；:：、]+$/g, '').trim().toLowerCase();
}

function isEmptyPhrase(value: string): boolean {
  if (!value || EMPTY_MUST_PHRASES.has(value)) return true;
  return /^无（[^）]*）$/.test(value) || /^无\([^)]*\)$/.test(value);
}

function fenceMarker(line: string): { char: '`' | '~'; len: number } | undefined {
  const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return undefined;
  return { char: match[1][0] as '`' | '~', len: match[1].length };
}

function stripFences(text: string): string {
  const kept: string[] = [];
  let fence: { char: '`' | '~'; len: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = fenceMarker(line);
    if (marker && (!fence || (marker.char === fence.char && marker.len >= fence.len))) {
      fence = fence ? undefined : marker;
      continue;
    }
    if (!fence) kept.push(line);
  }
  return kept.join('\n');
}

function extractFileClue(text: string): string | undefined {
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const candidate = cleanPathToken(match[1]);
    if (candidate && looksLikeRepoPath(candidate)) return candidate;
  }
  const bare = /(?:^|[\s(])((?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+)\b/.exec(text);
  if (bare && looksLikeRepoPath(bare[1])) return bare[1];
  if (/(?:^|[\s`'"(])\.gitignore\b/.test(text)) return '.gitignore';
  return undefined;
}

function cleanPathToken(token: string): string {
  return token.trim().replace(/[),，。:：]+$/g, '');
}

function looksLikeRepoPath(value: string): boolean {
  if (!value || value.length > 240 || /\s/.test(value) || value.includes('..')) return false;
  if (value === '.gitignore' || value.endsWith('/.gitignore')) return true;
  return /^(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+$/.test(value)
    || /^[A-Za-z0-9_.@+-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml)$/.test(value);
}

async function isCommit(repoRoot: string, sha: string): Promise<{ ok: boolean; detail?: string }> {
  const result = await git(repoRoot, ['cat-file', '-t', sha]);
  if (result.code === 0 && result.stdout.trim() === 'commit') return { ok: true };
  const detail = (result.stderr || result.stdout).trim().split('\n')[0];
  return { ok: false, ...(detail ? { detail } : {}) };
}

async function git(repoRoot: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', repoRoot, '--no-optional-locks', ...args], {
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 15_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (typeof failed.code === 'number') return { code: failed.code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    throw new Error(`git ${args.join(' ')} failed: ${failed.message}`);
  }
}

async function containedKind(roleDirectory: string, relativePath: string): Promise<'file' | 'missing'> {
  try {
    await readContained(roleDirectory, relativePath);
    return 'file';
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Missing ')) return 'missing';
    throw error;
  }
}

async function readContained(roleDirectory: string, relativePath: string): Promise<{ bytes: Buffer; text: string }> {
  const root = await realpath(roleDirectory);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error(`Role directory is not a directory: ${roleDirectory}`);
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error(`Refusing to read ${relativePath}`);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Missing ${relativePath} under ${root}`);
      throw error;
    }
    if (info.isSymbolicLink()) {
      const target = await realpath(current).catch(() => undefined);
      if (!target || !inside(root, target)) throw new Error(`Refusing to read ${relativePath}: symlink escapes the role directory`);
      current = target;
    }
  }
  const finalInfo = await lstat(current);
  if (finalInfo.isSymbolicLink()) {
    const target = await realpath(current).catch(() => undefined);
    if (!target || !inside(root, target)) throw new Error(`Refusing to read ${relativePath}: symlink escapes the role directory`);
    current = target;
  }
  if (!(await lstat(current)).isFile()) throw new Error(`${relativePath} is not a regular file`);
  const real = await realpath(current);
  if (!inside(root, real)) throw new Error(`Refusing to read ${relativePath}: path escapes the role directory`);
  const bytes = await readFile(real);
  return { bytes, text: bytes.toString('utf8') };
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
