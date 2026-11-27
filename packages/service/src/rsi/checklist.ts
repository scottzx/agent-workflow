/**
 * Loads a role checklist and projects it into the executor prompt, the QA prompt and the ticket's self-checks.
 * v2 is the canonical shape; a v1 file (type program|agent, severity block) is normalized into the same model.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { TicketSelfCheckInput } from '../execution/ticket.js';

export type CheckKind = 'program' | 'self' | 'self_and_qa';
export type CheckEnforcement = 'block' | 'observe' | 'skip';
export type RsiMode = 'trial' | 'formal';

const enforcementSchema = z.enum(['block', 'observe', 'skip']);
const modePolicySchema = z.object({
  trial: enforcementSchema.optional(),
  formal: enforcementSchema.optional(),
}).strict();
const runnerSchema = z.object({
  id: z.string().min(1),
  cmd: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
const programSchema = z.object({ run: z.string().min(1), schema: z.string().min(1) }).strict();
const outlineTemplateSchema = z.object({
  locked: z.boolean().optional(),
  sections: z.array(z.string().min(1)).min(1),
}).strict();

const v2ItemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['program', 'self', 'self_and_qa']),
  dependsOn: z.array(z.string().min(1)).optional(),
  severity: z.enum(['must', 'should']),
  locked: z.boolean(),
  rule: z.string().min(1),
  nonGoals: z.array(z.string()).optional(),
  selfCheck: z.boolean().optional(),
  recheckOnRevision: z.boolean().optional(),
  evidenceHint: z.string().optional(),
  runner: runnerSchema.optional(),
  modePolicy: modePolicySchema.optional(),
}).strict();

export const checklistV2Schema = z.object({
  schemaVersion: z.literal(2),
  roleId: z.string().min(1),
  artifacts: z.array(z.string().min(1)),
  items: z.array(v2ItemSchema).min(1),
  program: programSchema.optional(),
  outlineTemplate: outlineTemplateSchema.optional(),
}).strict();

const v1ItemSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['program', 'agent']),
  source: z.string().optional(),
  severity: z.enum(['block', 'must', 'should']),
  locked: z.boolean(),
  rule: z.string().min(1),
  evidence: z.string().optional(),
  nonGoals: z.array(z.string()).optional(),
  selfCheck: z.boolean().optional(),
  recheckOnRevision: z.boolean().optional(),
  evidenceHint: z.string().optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  runner: runnerSchema.optional(),
  modePolicy: modePolicySchema.optional(),
}).passthrough();

const checklistV1Schema = z.object({
  schemaVersion: z.literal(1),
  roleId: z.string().min(1),
  items: z.array(v1ItemSchema).min(1),
  artifacts: z.array(z.string().min(1)).optional(),
  program: programSchema.optional(),
  outlineTemplate: outlineTemplateSchema.optional(),
}).passthrough();

export interface NormalizedCheckItem {
  id: string;
  kind: CheckKind;
  dependsOn?: string[];
  severity: 'must' | 'should';
  locked: boolean;
  rule: string;
  nonGoals?: string[];
  selfCheck?: boolean;
  recheckOnRevision?: boolean;
  evidenceHint?: string;
  runner?: { id: string; cmd: string[]; timeoutMs?: number };
  modePolicy?: { trial?: CheckEnforcement; formal?: CheckEnforcement };
  /** Set when the item was normalized from a v1 `type`. Agent items become `self_and_qa`. */
  legacyType?: 'program' | 'agent';
}

export interface NormalizedChecklist {
  schemaVersion: 1 | 2;
  roleId: string;
  artifacts: string[];
  items: NormalizedCheckItem[];
  program?: { run: string; schema: string };
  outlineTemplate?: { locked?: boolean; sections: string[] };
}

type Policy = z.infer<typeof modePolicySchema> | undefined;

function copyItem(item: {
  id: string; kind: CheckKind; dependsOn?: string[]; severity: 'must' | 'should'; locked: boolean; rule: string;
  nonGoals?: string[]; selfCheck?: boolean; recheckOnRevision?: boolean; evidenceHint?: string;
  runner?: NormalizedCheckItem['runner']; modePolicy?: Policy; legacyType?: 'program' | 'agent';
}): NormalizedCheckItem {
  return {
    id: item.id, kind: item.kind, severity: item.severity, locked: item.locked, rule: item.rule,
    ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
    ...(item.nonGoals ? { nonGoals: item.nonGoals } : {}),
    ...(item.selfCheck !== undefined ? { selfCheck: item.selfCheck } : {}),
    ...(item.recheckOnRevision !== undefined ? { recheckOnRevision: item.recheckOnRevision } : {}),
    ...(item.evidenceHint ? { evidenceHint: item.evidenceHint } : {}),
    ...(item.runner ? { runner: item.runner } : {}),
    ...(item.modePolicy ? { modePolicy: item.modePolicy } : {}),
    ...(item.legacyType ? { legacyType: item.legacyType } : {}),
  };
}

function normalizeV2(raw: z.infer<typeof checklistV2Schema>): NormalizedChecklist {
  return {
    schemaVersion: 2, roleId: raw.roleId, artifacts: raw.artifacts, items: raw.items.map(item => copyItem(item)),
    ...(raw.program ? { program: raw.program } : {}),
    ...(raw.outlineTemplate ? { outlineTemplate: raw.outlineTemplate } : {}),
  };
}

function normalizeV1(raw: z.infer<typeof checklistV1Schema>): NormalizedChecklist {
  return {
    schemaVersion: 1, roleId: raw.roleId, artifacts: raw.artifacts ?? [],
    items: raw.items.map(item => copyItem({
      id: item.id,
      kind: item.type === 'agent' ? 'self_and_qa' : 'program',
      legacyType: item.type,
      severity: item.severity === 'should' ? 'should' : 'must',
      locked: item.locked,
      rule: item.rule,
      ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
      ...(item.nonGoals ? { nonGoals: item.nonGoals } : {}),
      ...(item.selfCheck !== undefined ? { selfCheck: item.selfCheck } : {}),
      ...(item.recheckOnRevision !== undefined ? { recheckOnRevision: item.recheckOnRevision } : {}),
      evidenceHint: item.evidenceHint ?? item.evidence,
      ...(item.runner ? { runner: item.runner } : {}),
      ...(item.modePolicy ? { modePolicy: item.modePolicy } : {}),
    })),
    ...(raw.program ? { program: raw.program } : {}),
    ...(raw.outlineTemplate ? { outlineTemplate: raw.outlineTemplate } : {}),
  };
}

/** Accepts either checklist version and returns one internal shape. */
export function parseChecklist(raw: unknown): NormalizedChecklist {
  const version = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]) }).passthrough().safeParse(raw);
  if (!version.success) throw new Error('checklist.json needs schemaVersion 1 or 2');
  return version.data.schemaVersion === 2 ? normalizeV2(checklistV2Schema.parse(raw)) : normalizeV1(checklistV1Schema.parse(raw));
}

export async function loadChecklist(roleDirectory: string): Promise<NormalizedChecklist> {
  const text = await readFile(path.join(roleDirectory, 'checklist.json'), 'utf8');
  return parseChecklist(JSON.parse(text));
}

/**
 * How a check is enforced in this mode. Unspecified policy defaults to block.
 * `enforceObserveAsBlock` upgrades observe to block (formal policy, or an explicit override).
 */
export function effectiveEnforcement(item: NormalizedCheckItem, mode: RsiMode, enforceObserveAsBlock = false): CheckEnforcement {
  const chosen = item.modePolicy?.[mode] ?? 'block';
  return chosen === 'observe' && enforceObserveAsBlock ? 'block' : chosen;
}

/** Self-checks to mount on `ticket_open`. Skipped items for this mode are left off. */
export function toTicketSelfChecks(checklist: NormalizedChecklist, mode: RsiMode, enforceObserveAsBlock = false): TicketSelfCheckInput[] {
  return checklist.items.filter(item => {
    const mounted = item.kind === 'self' || item.kind === 'self_and_qa' || (item.kind === 'program' && item.selfCheck === true);
    return mounted && effectiveEnforcement(item, mode, enforceObserveAsBlock) !== 'skip';
  }).map(item => ({
    id: item.id,
    kind: item.kind,
    severity: item.severity,
    rule: item.rule,
    ...(item.evidenceHint ? { evidenceHint: item.evidenceHint } : {}),
    ...(item.recheckOnRevision !== undefined ? { recheckOnRevision: item.recheckOnRevision } : {}),
  }));
}

function visible(item: NormalizedCheckItem, mode: RsiMode, enforceObserveAsBlock: boolean): boolean {
  return effectiveEnforcement(item, mode, enforceObserveAsBlock) !== 'skip';
}

/** Executor-facing checklist section. Appended to the role text so ROLE.md does not hand-copy the items. */
export function renderExecutorChecklistPrompt(checklist: NormalizedChecklist, mode: RsiMode, enforceObserveAsBlock = false): string {
  const lines = ['## 清单投影（由 checklist.json 自动生成，勿手抄）', ''];
  const self = toTicketSelfChecks(checklist, mode, enforceObserveAsBlock);
  lines.push('### 交付前自检', '');
  if (!self.length) lines.push('- （本模式没有必挂的自检项）');
  for (const item of self) {
    lines.push(`- \`${item.id}\`（${item.severity === 'must' ? '必填' : '建议'}，${item.kind}）${item.rule}${item.evidenceHint ? `。依据：${item.evidenceHint}` : ''}`);
  }
  lines.push('', '### 程序会检查的规则', '');
  const programs = checklist.items.filter(item => item.kind === 'program' && visible(item, mode, enforceObserveAsBlock));
  if (!programs.length) lines.push('- （无）');
  for (const item of programs) {
    lines.push(`- \`${item.id}\`（${effectiveEnforcement(item, mode, enforceObserveAsBlock)}）${item.rule}`);
  }
  return lines.join('\n');
}

/** QA-facing section: program items already checked (with non-goals) and the L2 self-check audit list. */
export function renderQaChecklistPrompt(checklist: NormalizedChecklist, mode: RsiMode, enforceObserveAsBlock = false): string {
  const lines = ['## 清单投影（由 checklist.json 自动生成，勿手抄）', '', '### 程序已查项', ''];
  const programs = checklist.items.filter(item => item.kind === 'program' && visible(item, mode, enforceObserveAsBlock));
  if (!programs.length) lines.push('- （无）');
  for (const item of programs) {
    lines.push(`- \`${item.id}\` ${item.rule}`);
    for (const goal of item.nonGoals ?? []) lines.push(`  - 不拦：${goal}`);
  }
  lines.push('', '### 需做 L2 selfCheckAudit 对校的自检项', '');
  const audits = checklist.items.filter(item => item.kind === 'self_and_qa' && visible(item, mode, enforceObserveAsBlock));
  if (!audits.length) lines.push('- （无）');
  for (const item of audits) {
    lines.push(`- \`${item.id}\` ${item.rule}${item.evidenceHint ? `。依据格式：${item.evidenceHint}` : ''}`);
  }
  return lines.join('\n');
}
