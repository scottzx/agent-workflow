/** Named agent drafts and releases for the workbench. A passed review does not publish a draft. */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const agentIdPattern = /^agt-[a-z0-9-]{8,80}$/;
const callName = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Invalid agent name');
const acpAgentName = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const targetId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/);
const optionId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const optionValue = z.string().trim().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Invalid option value');

export const agentOptionSchema = z.object({
  id: optionId,
  value: optionValue,
  model: z.literal(true).optional(),
}).strict();
export type AgentOption = z.output<typeof agentOptionSchema>;
const absolute = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes('\0'), 'Expected an absolute local path');
/** Where a path-registered agent came from: the registered directory and its agents/*.md file. */
export const agentSourceSchema = z.object({ path: absolute, file: absolute }).strict();
export type AgentSource = z.output<typeof agentSourceSchema>;
const description = z.string().trim().min(1).max(1024);
export const agentDraftSchema = z.object({
  agentId: z.string().regex(agentIdPattern),
  name: callName,
  // ACP drafts name their ACP agent; a path agent on a DSH-native preset names the preset (and an optional fixed model) instead.
  acpAgent: acpAgentName.optional(),
  agentPreset: targetId.optional(),
  provider: targetId.optional(),
  model: optionValue.optional(),
  roleId: targetId.optional(),
  targetId: targetId.optional(),
  modeId: optionId.optional(),
  options: z.array(agentOptionSchema).max(20),
  source: agentSourceSchema.optional(),
  description: description.optional(),
  updatedAt: z.string().datetime(),
}).strict();
export const agentReleaseSchema = z.object({
  releaseName: callName,
  sourceAgentId: z.string().regex(agentIdPattern).optional(),
  acpAgent: acpAgentName.optional(),
  agentPreset: targetId.optional(),
  provider: targetId.optional(),
  model: optionValue.optional(),
  roleId: targetId.optional(),
  targetId: targetId.optional(),
  modeId: optionId.optional(),
  options: z.array(agentOptionSchema).max(20),
  source: agentSourceSchema.optional(),
  description: description.optional(),
  publishedAt: z.string().datetime(),
}).strict();
export type AgentDraft = z.output<typeof agentDraftSchema>;
export type AgentRelease = z.output<typeof agentReleaseSchema>;
export interface DevelopmentAdmission {
  agentId: string;
  name: string;
  phase: 'developing' | 'published';
  channel: 'trial' | 'formal';
}
export interface ResidentAgentRef { targetId: string; name: string; roleId?: string; agentPreset?: string }
export interface AgentTaskRef { agentId?: string; pendingReviewId?: string; pendingProcessRequestId?: string }
export interface WorkbenchAgentRow {
  agentId: string;
  name: string;
  phase: 'developing' | 'published';
  origin: 'draft' | 'release' | 'resident';
  acpAgent?: string;
  roleId?: string;
  targetId?: string;
  agentPreset?: string;
  provider?: string;
  model?: string;
  modeId?: string;
  options: AgentOption[];
  source?: AgentSource;
  description?: string;
  releaseName?: string;
  sourceAgentId?: string;
  counterpartId?: string;
  taskCount: number;
  pendingCount: number;
}

const fileSchema = z.object({
  version: z.literal(1),
  drafts: z.array(agentDraftSchema),
  releases: z.array(agentReleaseSchema),
}).strict();
const draftInputSchema = z.object({
  name: callName,
  acpAgent: acpAgentName,
  roleId: targetId.optional(),
  targetId: targetId.optional(),
  modeId: optionId.optional(),
  options: z.array(agentOptionSchema).max(20).default([]),
}).strict();
const draftPatchSchema = draftInputSchema.partial().strict();
const publishInputSchema = z.object({ releaseName: callName, replace: z.boolean().optional() }).strict();

export class AgentRegistryError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'not_found' | 'conflict') {
    super(message);
    this.name = 'AgentRegistryError';
  }
}

/** Model options stay ahead of the other accepted values. */
export function orderAgentOptions(options: readonly AgentOption[]): AgentOption[] {
  const normalized = options.map(option => ({ id: option.id, value: option.value, ...(option.model || option.id === 'model' ? { model: true as const } : {}) }));
  if (new Set(normalized.map(option => option.id)).size !== normalized.length) throw new AgentRegistryError('Each ACP option id can be saved once', 'invalid');
  return [...normalized.filter(option => option.model), ...normalized.filter(option => !option.model)];
}

export function readDevelopment(value: unknown): DevelopmentAdmission | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if ((record.channel !== 'trial' && record.channel !== 'formal') || (record.phase !== 'developing' && record.phase !== 'published')) return undefined;
  if (typeof record.agentId !== 'string' || !record.agentId || record.agentId.length > 200 || typeof record.name !== 'string' || !record.name || record.name.length > 80) return undefined;
  return { agentId: record.agentId, name: record.name, phase: record.phase, channel: record.channel };
}

export interface TaskDevelopment {
  channel: 'trial' | 'formal' | 'standalone';
  agentId?: string;
  name?: string;
  phase?: 'developing' | 'published';
}

/** A frozen admission wins. An unstamped resident target is already published. */
export function describeTaskDevelopment(raw: unknown, target: { targetId: string; resident: boolean; residentName?: string }): TaskDevelopment {
  const stamped = readDevelopment(raw);
  if (stamped) return stamped;
  if (target.resident) return { channel: 'formal', phase: 'published', agentId: `resident:${target.targetId}`, name: target.residentName || target.targetId };
  return { channel: 'standalone' };
}

export function projectWorkbenchAgents(catalog: { drafts: readonly AgentDraft[]; releases: readonly AgentRelease[]; residents: readonly ResidentAgentRef[] }, tasks: readonly AgentTaskRef[]): { developing: WorkbenchAgentRow[]; published: WorkbenchAgentRow[] } {
  const count = (agentId: string) => {
    const owned = tasks.filter(task => task.agentId === agentId);
    return { taskCount: owned.length, pendingCount: owned.filter(task => task.pendingReviewId || task.pendingProcessRequestId).length };
  };
  const developing = catalog.drafts.map(draft => {
    const release = catalog.releases.find(item => item.sourceAgentId === draft.agentId);
    return { agentId: draft.agentId, name: draft.name, phase: 'developing' as const, origin: 'draft' as const, ...(draft.acpAgent ? { acpAgent: draft.acpAgent } : {}),
      ...(draft.agentPreset ? { agentPreset: draft.agentPreset } : {}), ...(draft.provider ? { provider: draft.provider, model: draft.model } : {}),
      ...(draft.roleId ? { roleId: draft.roleId } : {}), ...(draft.targetId ? { targetId: draft.targetId } : {}),
      ...(draft.modeId ? { modeId: draft.modeId } : {}), options: draft.options.map(option => ({ ...option })),
      ...(draft.source ? { source: { ...draft.source } } : {}), ...(draft.description ? { description: draft.description } : {}),
      ...(release ? { counterpartId: `release:${release.releaseName}`, releaseName: release.releaseName } : {}), ...count(draft.agentId) };
  });
  const publishedReleases = catalog.releases.map(release => ({
    agentId: `release:${release.releaseName}`, name: release.releaseName, phase: 'published' as const, origin: 'release' as const,
    ...(release.acpAgent ? { acpAgent: release.acpAgent } : {}), ...(release.agentPreset ? { agentPreset: release.agentPreset } : {}), ...(release.provider ? { provider: release.provider, model: release.model } : {}),
    ...(release.roleId ? { roleId: release.roleId } : {}), ...(release.targetId ? { targetId: release.targetId } : {}),
    ...(release.modeId ? { modeId: release.modeId } : {}), options: release.options.map(option => ({ ...option })), releaseName: release.releaseName,
    ...(release.source ? { source: { ...release.source } } : {}), ...(release.description ? { description: release.description } : {}),
    ...(release.sourceAgentId ? { sourceAgentId: release.sourceAgentId, counterpartId: release.sourceAgentId } : {}), ...count(`release:${release.releaseName}`),
  }));
  const releasedTargets = new Set(catalog.releases.map(release => release.targetId).filter((id): id is string => Boolean(id)));
  const publishedResidents = catalog.residents.filter(resident => !releasedTargets.has(resident.targetId)).map(resident => ({
    agentId: `resident:${resident.targetId}`, name: resident.name, phase: 'published' as const, origin: 'resident' as const,
    ...(resident.roleId ? { roleId: resident.roleId } : {}), targetId: resident.targetId,
    ...(resident.agentPreset ? { agentPreset: resident.agentPreset, acpAgent: resident.agentPreset.replace(/^oneagents-acp-/, '') } : {}),
    options: [], ...count(`resident:${resident.targetId}`),
  }));
  return { developing, published: [...publishedReleases, ...publishedResidents] };
}

export class AgentRegistry {
  private readonly file: string;
  private state: z.output<typeof fileSchema>;
  constructor(directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('stateDirectory must be absolute');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'agent-registry.json');
    try { this.state = fileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, drafts: [], releases: [] };
    }
    this.assertUnique();
  }
  snapshot(): { drafts: AgentDraft[]; releases: AgentRelease[] } {
    return { drafts: this.state.drafts.map(item => structuredClone(item)), releases: this.state.releases.map(item => structuredClone(item)) };
  }
  /** New calls use a release when one owns the target, then a draft, then an already resident role. */
  admit(target: { targetId: string; kind: string; name: string }): DevelopmentAdmission | undefined {
    const release = this.state.releases.find(item => item.targetId === target.targetId);
    if (release) return { agentId: `release:${release.releaseName}`, name: release.releaseName, phase: 'published', channel: 'formal' };
    const draft = this.state.drafts.find(item => item.targetId === target.targetId);
    if (draft) return { agentId: draft.agentId, name: draft.name, phase: 'developing', channel: 'trial' };
    if (target.kind === 'resident_agent') return { agentId: `resident:${target.targetId}`, name: target.name, phase: 'published', channel: 'formal' };
  }
  create(input: unknown): AgentDraft {
    const parsed = this.parse(draftInputSchema, input);
    if (this.state.drafts.some(item => item.name === parsed.name)) throw new AgentRegistryError('An agent draft with this name already exists', 'conflict');
    const draft: AgentDraft = { agentId: `agt-${randomUUID()}`, name: parsed.name, acpAgent: parsed.acpAgent, options: orderAgentOptions(parsed.options), updatedAt: new Date().toISOString(),
      ...(parsed.roleId ? { roleId: parsed.roleId } : {}), ...(parsed.targetId ? { targetId: parsed.targetId } : {}), ...(parsed.modeId ? { modeId: parsed.modeId } : {}) };
    this.commit({ ...this.state, drafts: [...this.state.drafts, draft] });
    return structuredClone(draft);
  }
  update(agentId: string, input: unknown): AgentDraft {
    const parsed = this.parse(draftPatchSchema, input);
    const current = this.draft(agentId);
    const next: AgentDraft = { ...current, ...(parsed.name ? { name: parsed.name } : {}), ...(parsed.acpAgent ? { acpAgent: parsed.acpAgent } : {}),
      ...(parsed.roleId ? { roleId: parsed.roleId } : {}), ...(parsed.targetId ? { targetId: parsed.targetId } : {}),
      ...(parsed.modeId ? { modeId: parsed.modeId } : {}), ...(parsed.options ? { options: orderAgentOptions(parsed.options) } : {}), updatedAt: new Date().toISOString() };
    if (this.state.drafts.some(item => item.agentId !== agentId && item.name === next.name)) throw new AgentRegistryError('An agent draft with this name already exists', 'conflict');
    this.commit({ ...this.state, drafts: this.state.drafts.map(item => item.agentId === agentId ? next : item) });
    return structuredClone(next);
  }
  /** Copy the draft into a callable name. The draft remains, and its target moves to the release. */
  publish(agentId: string, input: unknown): AgentRelease {
    const parsed = this.parse(publishInputSchema, input);
    const draft = this.draft(agentId);
    const existing = this.state.releases.find(item => item.releaseName === parsed.releaseName);
    if (existing && !parsed.replace) throw new AgentRegistryError(`Published name "${parsed.releaseName}" already exists`, 'conflict');
    const release: AgentRelease = { releaseName: parsed.releaseName, sourceAgentId: draft.agentId, ...(draft.acpAgent ? { acpAgent: draft.acpAgent } : {}),
      ...(draft.agentPreset ? { agentPreset: draft.agentPreset } : {}), ...(draft.provider ? { provider: draft.provider, model: draft.model } : {}), options: orderAgentOptions(draft.options), publishedAt: new Date().toISOString(),
      ...(draft.roleId ? { roleId: draft.roleId } : {}), ...(draft.targetId ? { targetId: draft.targetId } : {}), ...(draft.modeId ? { modeId: draft.modeId } : {}),
      ...(draft.source ? { source: { ...draft.source } } : {}), ...(draft.description ? { description: draft.description } : {}) };
    const opened: AgentDraft = { ...draft, updatedAt: release.publishedAt };
    delete opened.targetId;
    this.commit({ ...this.state, drafts: this.state.drafts.map(item => item.agentId === agentId ? opened : item),
      releases: [...this.state.releases.filter(item => item.releaseName !== parsed.releaseName), release] });
    return structuredClone(release);
  }
  /** The draft registered from this agents/*.md file for this runtime: an ACP agent name or a DSH-native preset. */
  pathDraft(file: string, runtime: string): AgentDraft | undefined {
    const found = this.state.drafts.find(item => item.source?.file === file && (item.acpAgent ?? item.agentPreset) === runtime);
    return found && structuredClone(found);
  }
  /**
   * Create or refresh the draft for one agents/*.md file on one runtime. The file and runtime identify the draft, so
   * registering the same path again updates it in place and keeps its tasks, while another runtime gets its own draft.
   * A different draft already using the name is a conflict.
   */
  registerPathDraft(input: { name: string; targetId: string; source: AgentSource; description?: string; acpAgent?: string; agentPreset?: string; provider?: string; model?: string }): AgentDraft {
    const parsed = this.parse(z.object({ name: callName, targetId, source: agentSourceSchema, description: description.optional(),
      acpAgent: acpAgentName.optional(), agentPreset: targetId.optional(), provider: targetId.optional(), model: optionValue.optional() }).strict()
      .refine(value => (value.acpAgent === undefined) !== (value.agentPreset === undefined) && (value.provider === undefined) === (value.model === undefined)
        && !(value.acpAgent && value.provider), 'Name either an ACP agent or a DSH-native preset'), input);
    const runtime = parsed.acpAgent ?? parsed.agentPreset;
    const current = this.state.drafts.find(item => item.source?.file === parsed.source.file && (item.acpAgent ?? item.agentPreset) === runtime);
    if (this.state.drafts.some(item => item !== current && item.name === parsed.name)) throw new AgentRegistryError(`An agent draft named "${parsed.name}" already exists`, 'conflict');
    const { acpAgent: _acp, agentPreset: _preset, provider: _provider, model: _model, description: _description, ...kept } = current ?? { agentId: `agt-${randomUUID()}`, options: [] };
    const next: AgentDraft = { ...kept, name: parsed.name, targetId: parsed.targetId, source: parsed.source, updatedAt: new Date().toISOString(),
      ...(parsed.acpAgent ? { acpAgent: parsed.acpAgent } : { agentPreset: parsed.agentPreset! }),
      ...(parsed.provider ? { provider: parsed.provider, model: parsed.model! } : {}), ...(parsed.description ? { description: parsed.description } : {}) };
    this.commit({ ...this.state, drafts: current ? this.state.drafts.map(item => item === current ? next : item) : [...this.state.drafts, next] });
    return structuredClone(next);
  }
  private draft(agentId: string): AgentDraft {
    const found = this.state.drafts.find(item => item.agentId === agentId);
    if (!found) throw new AgentRegistryError('Agent draft not found', 'not_found');
    return found;
  }
  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    if (!result.success) throw new AgentRegistryError('Invalid agent settings', 'invalid');
    return result.data;
  }
  private assertUnique(): void {
    for (const [label, values] of [['draft', this.state.drafts.map(item => item.agentId)], ['draft name', this.state.drafts.map(item => item.name)], ['release', this.state.releases.map(item => item.releaseName)]] as const) {
      if (new Set(values).size !== values.length) throw new Error(`Duplicate agent registry ${label}`);
    }
  }
  private commit(next: z.output<typeof fileSchema>): void {
    fileSchema.parse(next);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.file);
      const dir = openSync(path.dirname(this.file), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
      this.state = next;
    } catch (error) { try { unlinkSync(temp); } catch { /* The failed temp file is already gone. */ } throw error; }
  }
}
