/**
 * Pre-implementation knowledge lookup (`learnings_lookup`).
 *
 * Queries `docs/solutions/` markdown cards and append-only `rejected-edits.jsonl`
 * for target file paths, skips `stale` entries, deduplicates, and caps recall at <= 3 constraints.
 */
import path from 'node:path';
import { compileKnowledgeIndex, type KnowledgeEntry } from './compile.js';
import type { NodeHandler } from './engine.js';

export const MAX_LEARNINGS_RECALL = 3;

export interface LearningMatch {
  id: string;
  kind: KnowledgeEntry['kind'];
  title: string;
  summary: string;
  module: string;
  tags: string[];
  problem_type: string;
  source: string;
  filePath: string;
  score: number;
  matchedBy: string[];
}

export interface LearningsLookupReport {
  ok: boolean;
  repoRoot: string;
  targetPaths: string[];
  indexDigest: string;
  totalIndexed: number;
  activeCount: number;
  limit: number;
  matches: LearningMatch[];
}

function normalizeTargetPath(repoRoot: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  const rel = path.isAbsolute(trimmed) ? path.relative(repoRoot, trimmed) : trimmed;
  return rel.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(token => token.length >= 2),
  );
}

function pathPrefixMatch(target: string, candidate: string): boolean {
  if (!target || !candidate) return false;
  if (target === candidate) return true;
  if (target.startsWith(`${candidate}/`)) return true;
  if (candidate.startsWith(`${target}/`)) return true;
  return false;
}

function scoreEntry(entry: KnowledgeEntry, targetPaths: readonly string[]): { score: number; matchedBy: string[] } {
  let score = 0;
  const matchedBy = new Set<string>();
  const targetTokens = new Set<string>();
  for (const target of targetPaths) {
    for (const token of tokenize(target)) targetTokens.add(token);
  }

  for (const target of targetPaths) {
    const targetLower = target.toLowerCase();
    for (const p of entry.paths) {
      const pLower = p.toLowerCase();
      if (targetLower === pLower) {
        score += 100;
        matchedBy.add(`path:${p}`);
      } else if (pathPrefixMatch(targetLower, pLower)) {
        score += 60;
        matchedBy.add(`prefix:${p}`);
      }
    }
    const modLower = entry.module.toLowerCase();
    if (modLower && (targetLower === modLower || pathPrefixMatch(targetLower, modLower) || targetLower.includes(modLower))) {
      score += 35;
      matchedBy.add(`module:${entry.module}`);
    }
  }

  for (const tag of entry.tags) {
    const tagLower = tag.toLowerCase();
    if (targetTokens.has(tagLower)) {
      score += 15;
      matchedBy.add(`tag:${tag}`);
    } else {
      const tagTokens = tokenize(tagLower);
      if (tagTokens.size > 0 && [...tagTokens].every(t => targetTokens.has(t))) {
        score += 10;
        matchedBy.add(`tag:${tag}`);
      }
    }
  }

  return { score, matchedBy: [...matchedBy].sort() };
}

export async function lookupLearnings(options: {
  repoRoot: string;
  paths: readonly string[];
  limit?: number;
}): Promise<LearningsLookupReport> {
  const repoRoot = path.resolve(options.repoRoot);
  const targetPaths = [...new Set(options.paths.map(p => normalizeTargetPath(repoRoot, p)).filter(Boolean))];
  const requestedLimit = options.limit ?? MAX_LEARNINGS_RECALL;
  const limit = Math.max(0, Math.min(MAX_LEARNINGS_RECALL, Math.floor(requestedLimit)));
  const index = await compileKnowledgeIndex(repoRoot);
  const active = index.entries.filter(entry => entry.status === 'active');

  const scored: LearningMatch[] = [];
  for (const entry of active) {
    const { score, matchedBy } = scoreEntry(entry, targetPaths);
    if (score <= 0) continue;
    scored.push({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary,
      module: entry.module,
      tags: entry.tags,
      problem_type: entry.problem_type,
      source: entry.source,
      filePath: entry.filePath,
      score,
      matchedBy,
    });
  }

  scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  const seenSummaries = new Set<string>();
  const matches: LearningMatch[] = [];
  for (const item of scored) {
    const key = item.summary.trim().toLowerCase();
    if (seenSummaries.has(key)) continue;
    seenSummaries.add(key);
    matches.push(item);
    if (matches.length >= limit) break;
  }

  return {
    ok: true,
    repoRoot,
    targetPaths,
    indexDigest: index.digest,
    totalIndexed: index.entries.length,
    activeCount: active.length,
    limit,
    matches,
  };
}

export function formatLearningsLookupText(report: LearningsLookupReport): string {
  const lines = [
    `知识库检索（摘要 ${report.indexDigest.slice(0, 12)}，活跃 ${report.activeCount}/${report.totalIndexed} 条，召回 ${report.matches.length}/${report.limit} 条）`,
  ];
  if (!report.matches.length) {
    lines.push('  无命中的历史约束。');
    return lines.join('\n');
  }
  for (const match of report.matches) {
    lines.push(`  - [${match.id}] (${match.problem_type}, ${match.source}) ${match.summary}`);
  }
  return lines.join('\n');
}

/**
 * Builds a DAG handler for a `learnings_lookup` workflow node.
 * Reports errors through `results` (never raw `status: 'failed'`) so `engine.ts` applies
 * checklist `modePolicy` (`trial: observe` non-blocking, `formal: block` blocking).
 */
export function createLearningsLookupHandler(options: {
  repoRoot: string;
  paths: readonly string[];
  itemId?: string;
  limit?: number;
}): NodeHandler {
  const itemId = options.itemId ?? 'learnings_lookup';
  return async () => {
    try {
      const report = await lookupLearnings({
        repoRoot: options.repoRoot,
        paths: options.paths,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      return {
        output: report,
        results: [{
          itemId,
          pass: true,
          evidence: report.matches.length
            ? report.matches.map(m => `${m.id} (${m.source}): ${m.summary}`)
            : [`0 matches across ${report.activeCount} active entries`],
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        output: { ok: false, error: message },
        results: [{
          itemId,
          pass: false,
          evidence: [message],
        }],
      };
    }
  };
}
