/**
 * Compiler and append-only store for the repository knowledge layer under `docs/solutions/`.
 *
 * Design invariants:
 * - Solution markdown docs carry structured frontmatter (`module`, `tags`, `problem_type`, `status`, `source`).
 * - `docs/solutions/rejected-edits.jsonl` is strictly append-only; its body is never rewritten or rolled back.
 * - Marking any entry `stale` updates index metadata (`docs/solutions/index-meta.json`) only.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export type KnowledgeStatus = 'active' | 'stale';

export interface KnowledgeEntry {
  id: string;
  kind: 'solution' | 'rejected_edit';
  title: string;
  summary: string;
  module: string;
  paths: string[];
  tags: string[];
  problem_type: string;
  status: KnowledgeStatus;
  source: string;
  filePath: string;
  createdAt?: string;
  staleReason?: string;
  staleUpdatedAt?: string;
}

export interface KnowledgeIndexMetaEntry {
  status: KnowledgeStatus;
  reason?: string;
  updatedAt: string;
}

export interface KnowledgeIndexMeta {
  schemaVersion: 1;
  overrides: Record<string, KnowledgeIndexMetaEntry>;
}

export interface KnowledgeIndex {
  schemaVersion: 1;
  repoRoot: string;
  solutionsDir: string;
  digest: string;
  entries: KnowledgeEntry[];
}

export interface RejectedEditInput {
  id: string;
  module: string;
  paths?: string[];
  tags: string[];
  problem_type: string;
  rule: string;
  source: string;
  createdAt?: string;
  status?: KnowledgeStatus;
}

const rejectedEditSchema = z.object({
  id: z.string().min(1),
  module: z.string().min(1),
  paths: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).default([]),
  problem_type: z.string().min(1),
  rule: z.string().min(1),
  source: z.string().min(1),
  createdAt: z.string().min(1).optional(),
  status: z.enum(['active', 'stale']).optional(),
});

const indexMetaSchema = z.object({
  schemaVersion: z.literal(1),
  overrides: z.record(z.string(), z.object({
    status: z.enum(['active', 'stale']),
    reason: z.string().optional(),
    updatedAt: z.string().min(1),
  })).default({}),
});

export function solutionsDirectory(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), 'docs', 'solutions');
}

export function rejectedEditsPath(repoRoot: string): string {
  return path.join(solutionsDirectory(repoRoot), 'rejected-edits.jsonl');
}

export function knowledgeIndexMetaPath(repoRoot: string): string {
  return path.join(solutionsDirectory(repoRoot), 'index-meta.json');
}

function normalizePosix(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(unquote).filter(Boolean);
  }
  if (!trimmed) return [];
  return trimmed.split(',').map(unquote).filter(Boolean);
}

interface ParsedFrontmatter {
  fields: Record<string, string | string[]>;
  body: string;
}

function parseSolutionFrontmatter(content: string, relativePath: string): ParsedFrontmatter {
  const clean = content.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(clean);
  if (!match) throw new Error(`Solution doc missing YAML frontmatter: ${relativePath}`);
  const fields: Record<string, string | string[]> = {};
  const lines = match[1]!.split(/\r?\n/);
  let activeListKey: string | null = null;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (activeListKey && /^\s*-\s+/.test(rawLine)) {
      const item = unquote(rawLine.replace(/^\s*-\s+/, ''));
      const current = fields[activeListKey];
      if (Array.isArray(current) && item) current.push(item);
      continue;
    }
    activeListKey = null;
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!kv) throw new Error(`Unreadable frontmatter line in ${relativePath}: ${trimmed.slice(0, 80)}`);
    const key = kv[1]!;
    const rawValue = kv[2] ?? '';
    if (rawValue === '') {
      fields[key] = [];
      activeListKey = key;
    } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      fields[key] = parseInlineList(rawValue);
    } else {
      fields[key] = unquote(rawValue);
    }
  }
  return { fields, body: clean.slice(match[0].length).trim() };
}

function asString(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value.trim();
  return '';
}

function asStringList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(item => item.trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return parseInlineList(value);
  return [];
}

function extractTitleAndSummary(body: string, fallbackTitle: string): { title: string; summary: string } {
  const lines = body.split(/\r?\n/).map(line => line.trim());
  let title = fallbackTitle;
  const paragraph: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (line.startsWith('#')) {
      if (title === fallbackTitle) title = line.replace(/^#+\s*/, '').trim() || fallbackTitle;
      continue;
    }
    if (line.startsWith('```')) break;
    paragraph.push(line.replace(/^[-*]\s+/, ''));
    if (paragraph.join(' ').length >= 220) break;
  }
  const summary = (paragraph.join(' ').trim() || title).slice(0, 280);
  return { title, summary };
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

export async function loadKnowledgeIndexMeta(repoRoot: string): Promise<KnowledgeIndexMeta> {
  const metaFile = knowledgeIndexMetaPath(repoRoot);
  let raw: string;
  try {
    raw = await readFile(metaFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, overrides: {} };
    }
    throw error;
  }
  return indexMetaSchema.parse(JSON.parse(raw));
}

/**
 * Mark an entry `stale` (or restore `active`) strictly via index metadata (`docs/solutions/index-meta.json`).
 * Never edits or rolls back `docs/solutions/rejected-edits.jsonl`.
 */
export async function markKnowledgeStale(
  repoRoot: string,
  entryId: string,
  options: { reason?: string; status?: KnowledgeStatus; now?: () => Date } = {},
): Promise<KnowledgeIndexMeta> {
  const id = entryId.trim();
  if (!id) throw new Error('entryId must be non-empty');
  const meta = await loadKnowledgeIndexMeta(repoRoot);
  const updatedAt = (options.now ?? (() => new Date()))().toISOString();
  meta.overrides[id] = {
    status: options.status ?? 'stale',
    ...(options.reason ? { reason: options.reason } : {}),
    updatedAt,
  };
  await mkdir(solutionsDirectory(repoRoot), { recursive: true });
  await writeFile(knowledgeIndexMetaPath(repoRoot), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return meta;
}

/**
 * Append a new rejected edit lesson to `docs/solutions/rejected-edits.jsonl`.
 * Strictly append-only: existing bytes in the file are never modified or truncated.
 */
export async function appendRejectedEdit(
  repoRoot: string,
  input: RejectedEditInput,
  now: () => Date = () => new Date(),
): Promise<void> {
  const parsed = rejectedEditSchema.parse({
    ...input,
    createdAt: input.createdAt ?? now().toISOString(),
  });
  await mkdir(solutionsDirectory(repoRoot), { recursive: true });
  await appendFile(rejectedEditsPath(repoRoot), `${JSON.stringify(parsed)}\n`, 'utf8');
}

export async function compileKnowledgeIndex(repoRoot: string): Promise<KnowledgeIndex> {
  const root = path.resolve(repoRoot);
  const dir = solutionsDirectory(root);
  const meta = await loadKnowledgeIndexMeta(root);
  const entries: KnowledgeEntry[] = [];

  const mdFiles = await listMarkdownFiles(dir);
  for (const file of mdFiles) {
    const relToSolutions = normalizePosix(path.relative(dir, file));
    if (relToSolutions.toLowerCase() === 'readme.md') continue;
    const relToRepo = normalizePosix(path.relative(root, file));
    const text = await readFile(file, 'utf8');
    const { fields, body } = parseSolutionFrontmatter(text, relToRepo);
    const mod = asString(fields.module);
    const tags = asStringList(fields.tags);
    const problemType = asString(fields.problem_type);
    const rawStatus = asString(fields.status);
    const source = asString(fields.source);
    if (!mod) throw new Error(`Solution doc missing frontmatter "module": ${relToRepo}`);
    if (!problemType) throw new Error(`Solution doc missing frontmatter "problem_type": ${relToRepo}`);
    if (rawStatus !== 'active' && rawStatus !== 'stale') {
      throw new Error(`Solution doc frontmatter "status" must be active or stale: ${relToRepo}`);
    }
    if (!source) throw new Error(`Solution doc missing frontmatter "source": ${relToRepo}`);

    const id = asString(fields.id) || `solution:${relToSolutions.replace(/\.md$/i, '')}`;
    const paths = asStringList(fields.paths).map(normalizePosix);
    const fallbackTitle = path.basename(file, '.md');
    const { title, summary } = extractTitleAndSummary(body, asString(fields.title) || fallbackTitle);
    const override = meta.overrides[id];
    const effectiveStatus: KnowledgeStatus = override?.status ?? rawStatus;
    entries.push({
      id,
      kind: 'solution',
      title: asString(fields.title) || title,
      summary: asString(fields.summary) || summary,
      module: normalizePosix(mod),
      paths: paths.length ? paths : [normalizePosix(mod)],
      tags,
      problem_type: problemType,
      status: effectiveStatus,
      source,
      filePath: relToRepo,
      ...(override?.reason ? { staleReason: override.reason } : {}),
      ...(override?.updatedAt ? { staleUpdatedAt: override.updatedAt } : {}),
    });
  }

  const jsonlFile = rejectedEditsPath(root);
  let jsonlRaw: string | null = null;
  try {
    jsonlRaw = await readFile(jsonlFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (jsonlRaw !== null) {
    const relToRepo = normalizePosix(path.relative(root, jsonlFile));
    const lines = jsonlRaw.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const trimmed = lines[idx]!.trim();
      if (!trimmed) continue;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch {
        throw new Error(`Invalid JSON at ${relToRepo}:${idx + 1}`);
      }
      const record = rejectedEditSchema.parse(parsedJson);
      const override = meta.overrides[record.id];
      const effectiveStatus: KnowledgeStatus = override?.status ?? record.status ?? 'active';
      const paths = (record.paths?.length ? record.paths : [record.module]).map(normalizePosix);
      entries.push({
        id: record.id,
        kind: 'rejected_edit',
        title: `${record.problem_type}: ${record.module}`,
        summary: record.rule,
        module: normalizePosix(record.module),
        paths,
        tags: record.tags,
        problem_type: record.problem_type,
        status: effectiveStatus,
        source: record.source,
        filePath: `${relToRepo}:${idx + 1}`,
        ...(record.createdAt ? { createdAt: record.createdAt } : {}),
        ...(override?.reason ? { staleReason: override.reason } : {}),
        ...(override?.updatedAt ? { staleUpdatedAt: override.updatedAt } : {}),
      });
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return {
    schemaVersion: 1,
    repoRoot: root,
    solutionsDir: dir,
    digest,
    entries,
  };
}
