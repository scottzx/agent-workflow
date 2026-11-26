/**
 * Offline golden-set scorer for pr-delivery cross-model CR.
 * Patterns are case-insensitive literals, never regular expressions.
 * A missing or ambiguous VERDICT fails closed and is never treated as PASS.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{7,40}$/i;
const VERDICT_LINE = /^\s*(?:[-*]\s*)?(?:\*\*|__)?VERDICT(?:\*\*|__)?\s*[:：]\s*(.+)$/i;
const SOLO_VERDICT = /^\s*(?:\*\*|__)?(CHANGES_REQUESTED|PASS)(?:\*\*|__)?\s*$/;
const EMPTY_MUST_LINE = /^(?:[-*+]\s+)?(?:无|无。|无\.|none\.?|n\/a)$/i;
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

/** Walk up to the nearest directory that contains a `.git` file or directory. */
export async function findRepoRoot(start: string): Promise<string> {
  let current = resolve(start);
  for (;;) {
    try {
      const info = await lstat(join(current, '.git'));
      if (info.isFile() || info.isDirectory() || info.isSymbolicLink()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`No .git repository found above ${start}`);
    current = parent;
  }
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
 * Parse a Markdown CR report. Verdict tokens are read only from a VERDICT section,
 * a `VERDICT:` line, or a preamble line that is only PASS / CHANGES_REQUESTED.
 * MUST/SHOULD prose cannot supply or override the verdict.
 */
export function parseMarkdownCrReport(caseId: string, markdown: string): CrReviewResult {
  if (!caseId.trim()) throw new Error('caseId is required');
  const { preamble, sections } = splitSpecial(markdown);
  const verdicts = new Set<string>();
  const verdictSections = sections.filter(section => section.kind === 'verdict');
  const regions = [
    ...verdictSections.map(section => `${section.title}\n${section.body}`),
    ...declarationBlobs(preamble, sections.filter(section => section.kind !== 'verdict')),
  ];
  for (const region of regions) {
    for (const match of region.matchAll(/\b(CHANGES_REQUESTED|PASS)\b/g)) verdicts.add(match[1]);
  }
  if (verdicts.size !== 1) {
    throw new Error(`CR report for ${caseId} has no unique VERDICT (found ${[...verdicts].join(', ') || 'none'})`);
  }
  const verdict = [...verdicts][0] as 'CHANGES_REQUESTED' | 'PASS';
  const must = sections.filter(section => section.kind === 'must').flatMap(section => parseFindings(section.body, section.bodyLine));
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
  const matchedDefects: string[] = [];
  const missedDefects: string[] = [];
  for (const defect of item.requiredDefects ?? []) {
    if (review.must.some(finding => defectHit(defect, finding))) matchedDefects.push(defect.id);
    else missedDefects.push(defect.id);
  }
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

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function splitSpecial(markdown: string): { preamble: string; sections: SpecialSection[] } {
  const lines = markdown.split(/\r?\n/);
  const preamble: string[] = [];
  const sections: SpecialSection[] = [];
  let current: { kind: SpecialSection['kind']; level: number; title: string; lines: string[]; bodyLine: number } | undefined;
  const flush = () => {
    if (!current) return;
    sections.push({ kind: current.kind, title: current.title, body: current.lines.join('\n'), bodyLine: current.bodyLine });
    current = undefined;
  };
  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!heading) {
      if (current) current.lines.push(line);
      else preamble.push(line);
      return;
    }
    const level = heading[1].length;
    const title = heading[2].trim();
    const kind = classifyHeading(title);
    if (current && level <= current.level) flush();
    if (kind && !current) {
      current = { kind, level, title, lines: [], bodyLine: index + 2 };
      return;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  });
  flush();
  return { preamble: preamble.join('\n'), sections };
}

function classifyHeading(title: string): SpecialSection['kind'] | undefined {
  const stripped = title.replace(/^\d+\.\s*/, '').trim();
  if (/^VERDICT\b/i.test(stripped)) return 'verdict';
  if (/^MUST\b/i.test(stripped)) return 'must';
  if (/^SHOULD\b/i.test(stripped)) return 'should';
  return undefined;
}

function declarationBlobs(preamble: string, sections: SpecialSection[]): string[] {
  const chunks = [preamble, ...sections.filter(section => section.kind !== 'must' && section.kind !== 'should').map(section => `${section.title}\n${section.body}`)];
  const blobs: string[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/).filter(line => VERDICT_LINE.test(line) || SOLO_VERDICT.test(line));
    if (lines.length) blobs.push(lines.join('\n'));
  }
  return blobs;
}

function parseFindings(body: string, originLine: number): CrReviewFinding[] {
  if (isEmptyMust(body)) return [];
  const lines = body.split(/\r?\n/);
  const starts: { index: number; id?: string }[] = [];
  lines.forEach((line, index) => {
    const mark = itemStart(line);
    if (mark) starts.push({ index, ...mark });
  });
  const slices = starts.length
    ? starts.map((start, index) => ({
      id: start.id,
      line: originLine + start.index,
      text: lines.slice(start.index, index + 1 < starts.length ? starts[index + 1].index : lines.length).join('\n').trim(),
    }))
    : [{ id: undefined, line: originLine, text: body.trim() }];
  return slices.filter(slice => slice.text && !isEmptyMust(slice.text)).map(slice => {
    const file = extractFileClue(slice.text);
    return {
      ...(slice.id ? { id: slice.id } : {}),
      ...(file ? { file } : {}),
      line: slice.line,
      summary: slice.text,
    };
  });
}

function itemStart(line: string): { id?: string } | undefined {
  const heading = /^#{2,6}\s+(?:\d+\.\s*)?(?:\[(M\d+)\]|(M\d+))\b/.exec(line);
  if (heading) return { id: heading[1] || heading[2] };
  const bullet = /^[-*]\s+\*\*\[(M\d+)\]\*\*/.exec(line);
  if (bullet) return { id: bullet[1] };
  if (/^#{3,6}\s+\S/.test(line)) return {};
  return undefined;
}

function isEmptyMust(text: string): boolean {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.length === 0 || lines.every(line => EMPTY_MUST_LINE.test(line));
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
