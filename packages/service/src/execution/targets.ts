/** Manually maintained execution targets. This directory never starts an agent or a workflow. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const id = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/);
const text = z.string().trim().min(1).max(4096);
const version = z.number().int().positive();
const absolutePath = text.refine(value => path.posix.isAbsolute(value), 'Expected an absolute remote path');
const jsonObject = z.record(z.string(), z.unknown());
const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Expected an HTTP(S) endpoint without embedded credentials');

// Credentials remain in gateway remotes. Only the alias and derived non-secret URL are retained.
export const executionConnectionConfigSchema = z.object({
  connectionId: id, provider: z.enum(['a2a', 'activepieces']).default('a2a'), remote: id,
  enabled: z.boolean().default(true), description: text.optional(),
  probePolicy: z.object({ ttlMs: z.number().int().min(100).max(3_600_000).default(60_000),
    timeoutMs: z.number().int().min(100).max(60_000).default(5000) }).strict().optional(),
}).strict();
export const executionConnectionSchema = executionConnectionConfigSchema.extend({
  connectionVersion: version, createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  endpoint: endpoint.optional(), endpointFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const executionTargetBindingSchema = z.object({
  remote: id.optional(), cwd: absolutePath.optional(), agentPreset: id.optional(),
  roleId: id.optional(), skillRefs: z.array(text).max(100).optional(),
  // Forward roleId to the host so it loads that role and the skills in cwd/.agents/skills. Without it roleId is only a label.
  loadRole: z.literal(true).optional(),
  allowedDirectories: z.array(absolutePath).min(1).max(100).optional(),
  allowedPresets: z.array(id).min(1).max(100).optional(),
  flowId: id.optional(), flowVersion: text.optional(), driver: z.literal('ppt_delivery').optional(),
  // A path agent: an agent_host fixed to cwd and preset whose role is this agents/*.md file inside cwd.
  agentFile: absolutePath.optional(),
  // A path agent on a DSH-native preset may fix its model; both are passed together and checked against the host catalog.
  provider: id.optional(), model: text.optional(),
}).strict();
export const executionTargetConfigSchema = z.object({
  targetId: id, kind: z.enum(['agent_host', 'resident_agent', 'workflow']), name: text,
  description: text.optional(), connectionId: id, enabled: z.boolean().default(true),
  inputSchema: jsonObject.optional(), outputSchema: jsonObject.optional(),
  capabilities: z.object({ query: z.boolean().default(true), cancel: z.boolean().default(true),
    continue: z.boolean().default(true), reconcile: z.boolean().default(false) }).strict().optional(),
  binding: executionTargetBindingSchema.default({}),
}).strict();
export const executionTargetSchema = executionTargetConfigSchema.extend({
  configVersion: version, createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type ExecutionConnection = z.output<typeof executionConnectionSchema>;
export type ExecutionTarget = z.output<typeof executionTargetSchema>;

export const targetHealthSchema = z.object({
  targetId: id, configVersion: version, connectionId: id, connectionVersion: version,
  connectionStatus: z.enum(['unknown', 'reachable', 'unreachable', 'auth_required']),
  targetStatus: z.enum(['unknown', 'ready', 'misconfigured', 'unavailable']),
  checkedAt: z.string().datetime(), validUntil: z.string().datetime(), checkedScope: z.array(text).max(100),
  lastSuccessAt: z.string().datetime().optional(), reasonCode: text.optional(),
  failureCount: z.number().int().nonnegative(), nextCheckAt: z.string().datetime().optional(),
  capacity: z.enum(['busy', 'available', 'unknown']).optional(),
}).strict().superRefine((health, ctx) => {
  if (Date.parse(health.validUntil) <= Date.parse(health.checkedAt))
    ctx.addIssue({ code: 'custom', message: 'Probe expiry must follow checkedAt' });
  if (health.targetStatus === 'ready' && (health.connectionStatus !== 'reachable' || !health.checkedScope.length))
    ctx.addIssue({ code: 'custom', message: 'ready requires a reachable connection and explicit checked scope' });
});
export type TargetHealth = z.output<typeof targetHealthSchema>;

const targetRef = z.object({ targetId: id }).strict();
const connectionRef = z.object({ connectionId: id }).strict();
const empty = z.object({}).strict();
const targetUpdate = z.object({ targetId: id, expectedConfigVersion: version.optional(),
  patch: executionTargetConfigSchema.omit({ targetId: true }).partial().extend({
    enabled: z.boolean().optional(), binding: executionTargetBindingSchema.optional(),
  }).strict() }).strict();
const connectionUpdate = z.object({ connectionId: id, expectedConnectionVersion: version.optional(),
  patch: executionConnectionConfigSchema.omit({ connectionId: true }).partial().extend({
    provider: z.enum(['a2a', 'activepieces']).optional(), enabled: z.boolean().optional(),
  }).strict() }).strict();
const targetDelete = targetRef.extend({ expectedConfigVersion: version.optional() });
/** Copy a target under a new ID. `patch.binding` is merged into the copied binding, so only the fields being changed are given. */
const targetFork = z.object({ targetId: id, newTargetId: id,
  patch: targetUpdate.shape.patch.extend({ binding: executionTargetBindingSchema.partial().optional() }).strict().optional() }).strict();
/** The preset a fixed role runs on when its binding names none. */
export const DEFAULT_RESIDENT_PRESET = 'standard';
function withDefaults<T extends { kind: string; binding: z.infer<typeof executionTargetBindingSchema> }>(target: T): T {
  return target.kind === 'resident_agent' && !target.binding.agentPreset
    ? { ...target, binding: { ...target.binding, agentPreset: DEFAULT_RESIDENT_PRESET } } : target;
}
const connectionDelete = connectionRef.extend({ expectedConnectionVersion: version.optional() });
export const TARGET_METHODS = {
  execution_connection_list: { description: '列出人工登记的执行连接及派生端点，不返回凭据。', parameters: z.toJSONSchema(empty) },
  execution_connection_get: { description: '读取执行连接配置与版本。', parameters: z.toJSONSchema(connectionRef) },
  execution_connection_create: { description: '登记连接，仅引用已有 remote 别名，不启动后端。仅可信本机管理入口可调用。', parameters: z.toJSONSchema(executionConnectionConfigSchema) },
  execution_connection_update: { description: '修改或启停连接并递增配置版本。仅可信本机管理入口可调用。', parameters: z.toJSONSchema(connectionUpdate) },
  execution_connection_delete: { description: '删除未被目标引用的连接，编号永久保留。仅可信本机管理入口可调用。', parameters: z.toJSONSchema(connectionDelete) },
  execution_target_list: { description: '列出已登记执行目标及独立健康视图，不创建任务。', parameters: z.toJSONSchema(empty) },
  execution_target_get: { description: '读取执行目标、配置版本及探测范围。', parameters: z.toJSONSchema(targetRef) },
  execution_target_create: { description: '登记通用宿主、固定角色或工作流，不部署或运行能力。仅可信本机管理入口可调用。', parameters: z.toJSONSchema(executionTargetConfigSchema) },
  execution_target_update: { description: '修改或启停执行目标并递增配置版本。仅可信本机管理入口可调用。', parameters: z.toJSONSchema(targetUpdate) },
  execution_target_delete: { description: '删除目标且不取消历史任务，编号永久保留。仅可信本机管理入口可调用。', parameters: z.toJSONSchema(targetDelete) },
  execution_target_fork: { description: '把已有目标复制成新编号的副本，可同时修改名称、默认预设或默认模型等；patch.binding 只写要改的字段。原目标不变。仅可信本机管理入口可调用。', parameters: z.toJSONSchema(targetFork) },
  execution_target_probe: { description: '读取只读探测要求和当前健康视图；调用方适配器可执行 agent-card/preflight 检查，目录自身不调用模型。', parameters: z.toJSONSchema(targetRef) },
};

const stateSchema = z.object({ version: z.literal(1), connections: z.array(executionConnectionSchema),
  targets: z.array(executionTargetSchema), usedConnectionIds: z.array(id), usedTargetIds: z.array(id) }).strict();
type State = z.output<typeof stateSchema>;
type Remotes = Record<string, { url: string; token?: string }>;
const clone = <T>(value: T): T => structuredClone(value);

export interface ExecutionTargetSnapshot {
  target: ExecutionTarget;
  connection: ExecutionConnection;
  configVersion: number;
  connectionVersion: number;
  remote: string;
  endpoint: string;
  cwd?: string;
  agentPreset?: string;
  input: Record<string, unknown>;
  directoryPolicy?: { allowedDirectories: string[]; executorVerificationRequired: true };
}

/** Use inside the gateway's single-owner lease; targets.json is not a transaction with gateway.json. */
export class TargetDirectory {
  private readonly file: string;
  private state: State;
  private readonly health = new Map<string, TargetHealth>();
  constructor(stateDirectory: string, private readonly remotes: Remotes) {
    if (!path.isAbsolute(stateDirectory)) throw new Error('stateDirectory must be absolute');
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    this.file = path.join(stateDirectory, 'targets.json');
    try { this.state = stateSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, connections: [], targets: [], usedConnectionIds: [], usedTargetIds: [] };
    }
    for (const key of ['connections', 'targets'] as const) {
      const values = this.state[key].map(item => key === 'connections' ? (item as ExecutionConnection).connectionId : (item as ExecutionTarget).targetId);
      if (new Set(values).size !== values.length) throw new Error('Duplicate persistent execution directory ID');
    }
    for (const connection of this.state.connections) {
      if (!this.state.usedConnectionIds.includes(connection.connectionId)) throw new Error('Missing connection ID reservation');
    }
    for (const target of this.state.targets) {
      if (!this.state.usedTargetIds.includes(target.targetId)) throw new Error('Missing target ID reservation');
      // Offline/removed remotes are diagnostics, not a reason to discard the registered target.
      this.validateTarget(target, this.getConnection(target.connectionId));
    }
    this.reloadRemoteEndpoints();
  }

  private commit(next: State): void {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.file);
      const dir = openSync(path.dirname(this.file), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
      this.state = next;
    } catch (error) { try { unlinkSync(temp); } catch {} throw error; }
  }

  getConnection(connectionId: string): ExecutionConnection {
    const item = this.state.connections.find(value => value.connectionId === connectionId);
    if (!item) throw new Error(`Execution connection not found: ${connectionId}`);
    return clone(item);
  }
  getTarget(targetId: string): ExecutionTarget {
    const item = this.state.targets.find(value => value.targetId === targetId);
    if (!item) throw new Error(`Execution target not found: ${targetId}`);
    return clone(item);
  }
  listConnections(): ExecutionConnection[] { return clone(this.state.connections); }
  listTargets(): ExecutionTarget[] { return clone(this.state.targets); }

  private withEndpoint(connection: ExecutionConnection): ExecutionConnection {
    const { endpoint: _oldEndpoint, endpointFingerprint: _oldFingerprint, ...base } = connection;
    if (connection.provider !== 'a2a' || !Object.hasOwn(this.remotes, connection.remote)) return base;
    // Deliberately never access remotes[alias].token, including for fingerprinting.
    const value = new URL(endpoint.parse(this.remotes[connection.remote]!.url)).href;
    return { ...base, endpoint: value, endpointFingerprint: createHash('sha256').update(value).digest('hex') };
  }

  /** Controlled remote-config reload. A URL change creates a new connection version, never a new target. */
  reloadRemoteEndpoints(): string[] {
    const next = clone(this.state), changed: string[] = [];
    let dirty = false;
    for (let index = 0; index < next.connections.length; index++) {
      const previous = next.connections[index]!;
      if (previous.provider !== 'a2a' || !Object.hasOwn(this.remotes, previous.remote)) continue;
      const current = this.withEndpoint(previous);
      if (previous.endpoint === current.endpoint && previous.endpointFingerprint === current.endpointFingerprint) continue;
      // Older targets.json has no URL baseline; recording its first fingerprint is not evidence of a URL change.
      if (previous.endpoint !== undefined || previous.endpointFingerprint !== undefined) {
        current.connectionVersion = previous.connectionVersion + 1;
        current.updatedAt = new Date().toISOString();
        changed.push(current.connectionId);
      }
      next.connections[index] = current; dirty = true;
    }
    if (dirty) this.commit(next);
    return changed;
  }

  /** Explicit compatibility import of configured aliases only; never discovers presets or remote roles. */
  ensureLegacyRemotes(): { importedConnections: string[]; importedTargets: string[] } {
    const next = clone(this.state), importedConnections: string[] = [], importedTargets: string[] = [];
    const now = new Date().toISOString();
    for (const remote of Object.keys(this.remotes)) {
      const connectionId = id.parse(`remote:${remote}`), targetId = id.parse(`legacy:${remote}`);
      const connection = next.connections.find(item => item.connectionId === connectionId);
      if (connection && (connection.provider !== 'a2a' || connection.remote !== remote)) throw new Error('Legacy connection ID conflicts with configured remote');
      if (!connection && !next.usedConnectionIds.includes(connectionId)) {
        next.connections.push(this.withEndpoint({ connectionId, provider: 'a2a', remote, enabled: true, connectionVersion: 1, createdAt: now, updatedAt: now }));
        next.usedConnectionIds.push(connectionId); importedConnections.push(connectionId);
      }
      const target = next.targets.find(item => item.targetId === targetId);
      if (target && (target.kind !== 'agent_host' || target.connectionId !== connectionId)) throw new Error('Legacy target ID conflicts with configured remote');
      if (!target && !next.usedTargetIds.includes(targetId) && next.connections.some(item => item.connectionId === connectionId)) {
        next.targets.push({ targetId, kind: 'agent_host', name: `Legacy A2A ${remote}`, connectionId, enabled: true,
          binding: {}, configVersion: 1, createdAt: now, updatedAt: now });
        next.usedTargetIds.push(targetId); importedTargets.push(targetId);
      }
    }
    if (importedConnections.length || importedTargets.length) this.commit(next);
    return { importedConnections, importedTargets };
  }

  private validateConnection(connection: ExecutionConnection): void {
    if (connection.provider === 'a2a' && !Object.hasOwn(this.remotes, connection.remote))
      throw new Error(`Unknown configured remote: ${connection.remote}`);
  }
  private validateTarget(target: ExecutionTarget, connection: ExecutionConnection): void {
    const binding = target.binding;
    if (binding.remote && binding.remote !== connection.remote) throw new Error('Target remote must match its connection');
    if (target.kind === 'workflow') {
      if (connection.provider !== 'activepieces' || !binding.flowId) throw new Error('workflow requires an activepieces connection and flowId');
      if (binding.cwd || binding.agentPreset || binding.roleId || binding.driver || binding.allowedDirectories || binding.allowedPresets)
        throw new Error('workflow cannot bind Agent execution fields');
    } else {
      if (connection.provider !== 'a2a') throw new Error('Agent targets require an a2a connection');
      if (binding.flowId || binding.flowVersion) throw new Error('Agent targets cannot bind a workflow');
      if (target.kind === 'resident_agent' && (!binding.cwd || !binding.agentPreset || !binding.roleId))
        throw new Error('resident_agent requires fixed cwd and roleId');
      if (binding.agentFile) {
        if (target.kind !== 'agent_host' || !binding.cwd || !binding.agentPreset || binding.roleId || binding.driver)
          throw new Error('A path agent is an agent_host with fixed cwd and agentPreset and no roleId or driver');
        const relative = path.posix.relative(path.posix.normalize(binding.cwd), path.posix.normalize(binding.agentFile));
        if (!relative || relative.startsWith('../') || relative === '..' || path.posix.isAbsolute(relative) || !relative.endsWith('.md'))
          throw new Error('agentFile must be a .md file inside cwd');
        if ((binding.provider === undefined) !== (binding.model === undefined)) throw new Error('provider and model must be fixed together');
        if (binding.provider && binding.agentPreset.startsWith('oneagents-acp-')) throw new Error('provider and model apply only to DSH-native presets');
      } else if (binding.provider || binding.model) {
        // A fixed role may name a default model; each task can still pass its own provider and model.
        if (target.kind !== 'resident_agent') throw new Error('Only a path agent or a fixed role can set provider and model');
        if ((binding.provider === undefined) !== (binding.model === undefined)) throw new Error('provider and model must be set together');
        if (binding.agentPreset!.startsWith('oneagents-acp-')) throw new Error('provider and model apply only to DSH-native presets');
      }
      else if (target.kind === 'agent_host' && (binding.cwd || binding.agentPreset || binding.roleId || binding.driver))
        throw new Error('agent_host takes cwd and preset per task, not a fixed role binding');
      if (binding.cwd && binding.allowedDirectories) this.checkDirectory(binding.cwd, binding.allowedDirectories);
      if (binding.agentPreset && binding.allowedPresets && !binding.allowedPresets.includes(binding.agentPreset))
        throw new Error('Fixed preset is outside the allowed preset scope');
    }
  }

  private checkDirectory(cwd: string, allowed: string[]): void {
    const normalized = path.posix.normalize(cwd);
    if (!allowed.some(root => {
      const relative = path.posix.relative(path.posix.normalize(root), normalized);
      return relative === '' || (!relative.startsWith('../') && relative !== '..' && !path.posix.isAbsolute(relative));
    })) throw new Error('cwd is outside allowedDirectories; remote realpath verification is also required');
  }

  /** Resolve configuration only. The actual executor must still validate realpath, permissions and dependencies. */
  resolve(targetId: string, input: unknown): ExecutionTargetSnapshot {
    const target = this.getTarget(targetId), connection = this.getConnection(target.connectionId);
    if (!target.enabled || !connection.enabled) throw new Error('Execution target or connection is disabled');
    if (target.kind === 'workflow') throw new Error('unsupported_provider: workflow execution is not available in P1');
    this.validateConnection(connection);
    const health = this.getHealth(targetId);
    if (health && ['unavailable', 'misconfigured'].includes(health.targetStatus)) throw new Error(`Execution target unavailable: ${health.reasonCode ?? health.targetStatus}`);
    if (health && ['unreachable', 'auth_required'].includes(health.connectionStatus)) throw new Error(`Execution connection unavailable: ${health.connectionStatus}`);
    const resolvedInput = jsonObject.parse(input);
    if (resolvedInput.remote !== undefined || resolvedInput.connectionId !== undefined || resolvedInput.targetId !== undefined)
      throw new Error('Input cannot override target or connection binding');
    let cwd: string | undefined, agentPreset: string | undefined;
    if (target.kind === 'resident_agent' || target.binding.agentFile) {
      // Even an identical value is not an allowed caller override; the binding is authoritative.
      if (resolvedInput.cwd !== undefined || resolvedInput.agentPreset !== undefined || resolvedInput.roleId !== undefined || resolvedInput.driver !== undefined)
        throw new Error(`${target.binding.agentFile ? 'A path agent' : 'resident_agent'} input cannot override its fixed cwd, preset, role or driver`);
      // A path agent's model is part of the agent; a fixed role's model is only a default that a task may replace.
      if (target.binding.agentFile && target.binding.provider && (resolvedInput.provider !== undefined || resolvedInput.model !== undefined))
        throw new Error('A path agent input cannot override its fixed provider and model');
      cwd = target.binding.cwd!; agentPreset = target.binding.agentPreset!;
    } else {
      cwd = absolutePath.parse(resolvedInput.cwd);
      agentPreset = resolvedInput.agentPreset === undefined ? undefined : id.parse(resolvedInput.agentPreset);
    }
    if (!text.safeParse(resolvedInput.prompt).success && target.binding.driver !== 'ppt_delivery') {
      // Prompts are intentionally larger than a display/configuration string.
      const prompt = z.string().min(1).max(256 * 1024).refine(value => Boolean(value.trim()));
      prompt.parse(resolvedInput.prompt);
    }
    if (target.binding.allowedDirectories) this.checkDirectory(cwd!, target.binding.allowedDirectories);
    if (target.binding.allowedPresets && !agentPreset) throw new Error('An explicit preset is required for this restricted host');
    if (agentPreset && target.binding.allowedPresets && !target.binding.allowedPresets.includes(agentPreset))
      throw new Error('Requested preset is outside allowedPresets');
    return clone({ target, connection, configVersion: target.configVersion, connectionVersion: connection.connectionVersion,
      remote: connection.remote, endpoint: connection.endpoint!, cwd, agentPreset, input: resolvedInput,
      ...(target.binding.allowedDirectories ? { directoryPolicy: { allowedDirectories: target.binding.allowedDirectories, executorVerificationRequired: true as const } } : {}) });
  }

  getHealth(targetId: string): TargetHealth | undefined {
    const target = this.getTarget(targetId), connection = this.getConnection(target.connectionId);
    const current = this.health.get(targetId);
    if (!current || current.configVersion !== target.configVersion || current.connectionVersion !== connection.connectionVersion ||
      current.connectionId !== connection.connectionId || !target.enabled || !connection.enabled || Date.parse(current.validUntil) <= Date.now()) return undefined;
    return clone(current);
  }

  /** Only a trusted read-only probe adapter calls this; never exposed as an agent tool. */
  recordProbe(input: unknown): boolean {
    const health = targetHealthSchema.parse(input);
    const target = this.state.targets.find(item => item.targetId === health.targetId);
    if (!target || !target.enabled || target.configVersion !== health.configVersion || target.connectionId !== health.connectionId) return false;
    const connection = this.getConnection(target.connectionId);
    if (!connection.enabled || connection.connectionVersion !== health.connectionVersion) return false;
    const old = this.health.get(target.targetId);
    if (old && Date.parse(old.checkedAt) > Date.parse(health.checkedAt)) return false;
    if (Date.parse(health.checkedAt) > Date.now() + 5000 || Date.parse(health.validUntil) <= Date.now()) return false;
    this.health.set(target.targetId, clone(health)); return true;
  }

  invoke(method: string, params: unknown): unknown {
    if (method === 'execution_connection_list') { empty.parse(params); return { connections: this.listConnections() }; }
    if (method === 'execution_connection_get') return this.getConnection(connectionRef.parse(params).connectionId);
    if (method === 'execution_target_list') { empty.parse(params); return { targets: this.listTargets().map(target => this.describe(target.targetId)) }; }
    if (method === 'execution_target_get') return this.describe(targetRef.parse(params).targetId);
    if (method === 'execution_target_probe') {
      const { targetId } = targetRef.parse(params), target = this.getTarget(targetId), connection = this.getConnection(target.connectionId);
      return { ...this.describe(targetId), performed: false, probeRequired: !this.getHealth(targetId),
        checks: target.kind === 'workflow' ? ['provider_unsupported_in_p1'] : ['agent_card', ...(target.binding.cwd ? ['executor_fixed_cwd', 'executor_preset'] : [])],
        connectionVersion: connection.connectionVersion, remote: connection.remote };
    }
    const now = new Date().toISOString(), next = clone(this.state);
    if (method === 'execution_connection_create') {
      const config = executionConnectionConfigSchema.parse(params);
      if (next.usedConnectionIds.includes(config.connectionId)) throw new Error('Connection ID already used; deleted IDs cannot be reused');
      const connection = this.withEndpoint({ ...config, connectionVersion: 1, createdAt: now, updatedAt: now });
      this.validateConnection(connection); next.connections.push(connection); next.usedConnectionIds.push(connection.connectionId);
      this.commit(next); return clone(connection);
    }
    if (method === 'execution_connection_update') {
      const { connectionId, patch, expectedConnectionVersion } = connectionUpdate.parse(params), previous = this.getConnection(connectionId);
      if (expectedConnectionVersion !== undefined && previous.connectionVersion !== expectedConnectionVersion) throw new Error('Connection version conflict');
      const candidate = this.withEndpoint(executionConnectionSchema.parse({ ...previous, ...patch, connectionVersion: previous.connectionVersion + 1, updatedAt: now }));
      this.validateConnection(candidate);
      for (const target of next.targets.filter(item => item.connectionId === connectionId)) this.validateTarget(target, candidate);
      if (Object.entries(patch).every(([key, value]) => JSON.stringify(previous[key as keyof ExecutionConnection]) === JSON.stringify(value))) return previous;
      next.connections[next.connections.findIndex(item => item.connectionId === connectionId)] = candidate;
      this.commit(next); return clone(candidate);
    }
    if (method === 'execution_connection_delete') {
      const { connectionId, expectedConnectionVersion } = connectionDelete.parse(params), previous = this.getConnection(connectionId);
      if (expectedConnectionVersion !== undefined && previous.connectionVersion !== expectedConnectionVersion) throw new Error('Connection version conflict');
      if (next.targets.some(target => target.connectionId === connectionId)) throw new Error('Connection is referenced by an execution target');
      next.connections = next.connections.filter(item => item.connectionId !== connectionId);
      this.commit(next); return { deleted: true, connectionId };
    }
    if (method === 'execution_target_create') {
      const config = withDefaults(executionTargetConfigSchema.parse(params));
      if (next.usedTargetIds.includes(config.targetId)) throw new Error('Target ID already used; deleted IDs cannot be reused');
      const target = { ...config, configVersion: 1, createdAt: now, updatedAt: now };
      this.validateTarget(target, this.getConnection(target.connectionId)); next.targets.push(target); next.usedTargetIds.push(target.targetId);
      this.commit(next); return clone(target);
    }
    if (method === 'execution_target_update') {
      const { targetId, patch, expectedConfigVersion } = targetUpdate.parse(params), previous = this.getTarget(targetId);
      if (expectedConfigVersion !== undefined && previous.configVersion !== expectedConfigVersion) throw new Error('Target version conflict');
      const candidate = withDefaults(executionTargetSchema.parse({ ...previous, ...patch, configVersion: previous.configVersion + 1, updatedAt: now }));
      this.validateTarget(candidate, this.getConnection(candidate.connectionId));
      if (Object.entries(patch).every(([key, value]) => JSON.stringify(previous[key as keyof ExecutionTarget]) === JSON.stringify(value))) return previous;
      next.targets[next.targets.findIndex(item => item.targetId === targetId)] = candidate;
      this.commit(next); return clone(candidate);
    }
    if (method === 'execution_target_fork') {
      const { targetId, newTargetId, patch = {} } = targetFork.parse(params), previous = this.getTarget(targetId);
      if (next.usedTargetIds.includes(newTargetId)) throw new Error('Target ID already used; deleted IDs cannot be reused');
      const { configVersion: _version, createdAt: _created, updatedAt: _updated, ...config } = previous;
      const target = withDefaults(executionTargetSchema.parse({ ...config, ...patch, targetId: newTargetId,
        binding: { ...previous.binding, ...patch.binding }, configVersion: 1, createdAt: now, updatedAt: now }));
      this.validateTarget(target, this.getConnection(target.connectionId)); next.targets.push(target); next.usedTargetIds.push(target.targetId);
      this.commit(next); return clone(target);
    }
    if (method === 'execution_target_delete') {
      const { targetId, expectedConfigVersion } = targetDelete.parse(params), previous = this.getTarget(targetId);
      if (expectedConfigVersion !== undefined && previous.configVersion !== expectedConfigVersion) throw new Error('Target version conflict');
      next.targets = next.targets.filter(item => item.targetId !== targetId); this.commit(next); this.health.delete(targetId);
      return { deleted: true, targetId };
    }
    throw new Error(`Unknown execution target method: ${method}`);
  }

  private describe(targetId: string) {
    const target = this.getTarget(targetId), connection = this.getConnection(target.connectionId), health = this.getHealth(targetId);
    return { ...target, connectionVersion: connection.connectionVersion, providerSupported: target.kind !== 'workflow',
      health: health ?? { targetId, configVersion: target.configVersion, connectionId: target.connectionId,
        connectionVersion: connection.connectionVersion, connectionStatus: 'unknown', targetStatus: 'unknown', checkedScope: [] },
      enabled: target.enabled, connectionEnabled: connection.enabled };
  }
}
