/** Official A2A executor with durable DSH context bindings and independent turns. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Role, Task, TaskState, Message, type SendMessageRequest } from '@a2a-js/sdk';
import { ContentTypeNotSupportedError, RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext, resolveUserScope } from '@a2a-js/sdk/server';
import { a2aRequestId } from './request-id.js';
import { toSafeError, type SafeError } from '@1agents/acp-service/runtime';
import type { FileA2AStore } from './store.js';
import { a2aRoleSkillsSchema, type A2ABackend, type A2APrepareInput, type A2ARoleSkills, type A2ARunResult, type A2ATarget } from './types.js';
import { resolveRoleSkills, type RoleSkillLock } from '../roles/index.js';
import { A2APreflightError, a2aPreflightRequirementsSchema } from './preflight.js';
import { a2aResultContractSchema, A2AResultValidationError, createA2AResultMetadata, saveA2AResultMetadata,
  type A2AResultContract, type A2AResultMetadata } from './result-metadata.js';
import { CapacityGovernor, CapacityError, type CapacityOptions, type CapacityLease } from '../capacity.js';
import { CapacityQueue } from '../capacity-queue.js';

const FAILURE_MESSAGES: Record<NonNullable<A2ARunResult['failureReason']>, string> = {
  'missing-final-answer': 'DSH completed the task without a final answer; ACP final-answer metadata contained no final output',
  'max-tokens': 'DSH reached the model output token limit',
  forked: 'DSH task turn was closed by a session fork',
  'unsupported-ending': 'DSH returned an unsupported turn ending',
  discarded: 'DSH discarded the queued task before execution',
  disposed: 'DSH session was disposed before the task finished',
  aborted: 'DSH task execution was canceled',
  interrupted: 'DSH task execution was interrupted',
};

export interface A2AExecutionOptions {
  /** Trusted host policy. All A2A executions are automatic; request metadata cannot override it. */
  capacity?: CapacityOptions;
  defaultCwd?: string;
  defaultAgentPreset?: string;
  workspaces?: Record<string, string>;
  /** Profiles and the writable cache root are controlled by the execution host. */
  roleSkills?: { cacheRoot: string; profiles: Record<string, string>;
    /** Optional compatibility binding for fresh fixed-preset contexts only. */
    presetRoles?: Record<string, string> };
}

/** Validate trusted host configuration before acquiring a state-directory lease. */
export function validateA2AExecutionOptions(options: A2AExecutionOptions): void {
  new CapacityGovernor(options.capacity);
  const roles = options.roleSkills;
  if (roles === undefined) return;
  if (!roles || typeof roles !== 'object' || typeof roles.cacheRoot !== 'string' || !isAbsolute(roles.cacheRoot) || roles.cacheRoot.includes('\0')
      || !roles.profiles || typeof roles.profiles !== 'object' || Array.isArray(roles.profiles)
      || Object.entries(roles.profiles).some(([id, path]) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)
        || typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) throw new Error('Role skills require host-owned absolute cache and profile paths');
  if (roles.presetRoles !== undefined && (!roles.presetRoles || typeof roles.presetRoles !== 'object' || Array.isArray(roles.presetRoles)
      || Object.entries(roles.presetRoles).some(([preset, roleId]) => !preset.trim() || preset.length > 256 || preset.includes('\0')
        || typeof roleId !== 'string' || !Object.hasOwn(roles.profiles, roleId)))) throw new Error('Role preset bindings must reference registered host profiles');
}

class RoleSkillLoadingError extends Error {
  constructor(cause: unknown) { super('Role skills could not be loaded or verified; the model was not started', { cause }); }
}

const sessionFailureCodes = new Set(['SESSION_NOT_FOUND', 'SESSION_DELETED', 'SESSION_CLOSED', 'SESSION_CONFLICT', 'SESSION_ATTACH_IN_PROGRESS']);

function sessionFailureCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const queue = [error];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && sessionFailureCodes.has(record.code)) return record.code;
    if (record.code === -32003 || record.message === 'Session was deleted') return 'SESSION_DELETED';
    if (typeof record.message === 'string' && /cwd conflicts|preset conflicts|identity conflicts/.test(record.message)) return 'SESSION_CONFLICT';
    if (record.cause !== undefined) queue.push(record.cause);
  }
  return undefined;
}

async function waitForPreparation(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  const canceled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { await Promise.race([previous, canceled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Validate application metadata before the SDK starts an execution. */
export function parseA2AInput(request: SendMessageRequest, options: A2AExecutionOptions): {
  prompt: string; input: A2APrepareInput; resultContract?: A2AResultContract;
} {
  const message = request.message;
  if (!message?.messageId.trim() || message.role !== Role.ROLE_USER) throw new RequestMalformedError('A user message with messageId is required');
  if (!message.parts.length || message.parts.some(part => part.content?.$case !== 'text' || (part.mediaType && part.mediaType !== 'text/plain'))) {
    throw new ContentTypeNotSupportedError('DSH A2A accepts text/plain parts');
  }
  const prompt = message.parts.map(part => part.content?.value as string).join('\n');
  if (!prompt.trim()) throw new RequestMalformedError('Prompt must contain text');
  const metadata: unknown = request.metadata?.['1agents'];
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) throw new RequestMalformedError('metadata.1agents must be an object');
  const value = (metadata ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!['cwd', 'agentPreset', 'workspace', 'preflight', 'resultContract', 'roleId', 'roleLockPath'].includes(key)) throw new RequestMalformedError(`Unknown metadata.1agents field: ${key}`);
  for (const key of ['cwd', 'agentPreset', 'workspace', 'roleId', 'roleLockPath']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !(value[key] as string).trim())) throw new RequestMalformedError(`${key} must be a nonempty string`);
  }
  if (value.roleId !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.roleId as string)
      || !options.roleSkills || !Object.hasOwn(options.roleSkills.profiles, value.roleId as string))) throw new RequestMalformedError('Unknown host role');
  if (value.roleLockPath !== undefined && (!options.roleSkills || !isAbsolute(value.roleLockPath as string)
      || (value.roleLockPath as string).includes('\0'))) throw new RequestMalformedError('Invalid role lock path');
  if (value.cwd && value.workspace) throw new RequestMalformedError('Use cwd or workspace, not both');
  let cwd = value.cwd as string | undefined;
  if (value.workspace) {
    cwd = options.workspaces?.[value.workspace as string];
    if (!cwd) throw new RequestMalformedError(`Unknown workspace: ${value.workspace}`);
  }
  const preflight = value.preflight === undefined ? undefined : a2aPreflightRequirementsSchema.safeParse(value.preflight);
  if (preflight && !preflight.success) throw new RequestMalformedError('Invalid preflight requirements');
  const resultContract = value.resultContract === undefined ? undefined : a2aResultContractSchema.safeParse(value.resultContract);
  if (resultContract && !resultContract.success) throw new RequestMalformedError('Invalid result contract');
  return { prompt, input: { cwd, agentPreset: value.agentPreset as string | undefined,
    ...(preflight?.success ? { preflight: preflight.data } : {}),
    ...(value.roleId ? { roleId: value.roleId as string } : {}),
    ...(value.roleLockPath ? { roleLockPath: value.roleLockPath as string } : {}) },
    ...(resultContract?.success ? { resultContract: resultContract.data } : {}) };
}

/** SDK owns the execution lifetime; an HTTP disconnect never aborts this signal. */
export class A2ASessionExecutor implements AgentExecutor {
  private readonly capacity: CapacityQueue;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly awaitingInput = new Map<string, { contextId: string; target: A2ATarget; result: A2AResultMetadata }>();
  private readonly preparing = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(private readonly backend: A2ABackend, private readonly store: FileA2AStore, private readonly options: A2AExecutionOptions) {
    validateA2AExecutionOptions(options);
    this.capacity = new CapacityQueue(options.capacity);
  }

  private roleIdFor(input: A2APrepareInput, saved: A2ATarget | undefined): string | undefined {
    if (input.roleId) return input.roleId;
    // Existing contexts keep their original typed or untyped identity even if
    // the host later adds or changes preset-to-role compatibility bindings.
    if (saved) return saved.roleId;
    const preset = input.agentPreset ?? this.options.defaultAgentPreset, bindings = this.options.roleSkills?.presetRoles;
    return preset && bindings && Object.hasOwn(bindings, preset) ? bindings[preset] : undefined;
  }

  private async roleFor(input: A2APrepareInput, saved: A2ATarget | undefined, contextKey: string, signal: AbortSignal): Promise<{ roleId: string; summary: A2ARoleSkills; promptPrefix: string } | undefined> {
    const roleId = this.roleIdFor(input, saved);
    if (!roleId) {
      if (input.roleLockPath) throw new Error('A role lock requires a role identity');
      return undefined;
    }
    if (saved && (!saved.roleSkills || saved.roleId !== roleId)) throw new Error('An existing context cannot change its role');
    const configuration = this.options.roleSkills;
    if (!configuration || !Object.hasOwn(configuration.profiles, roleId)) throw new Error('The saved role is no longer configured on this host');
    await mkdir(join(configuration.cacheRoot, 'locks'), { recursive: true, mode: 0o700 });
    const lockRootInfo = await lstat(join(configuration.cacheRoot, 'locks'));
    if (!lockRootInfo.isDirectory() || lockRootInfo.isSymbolicLink()) throw new Error('The host role locks directory must be a real directory');
    const lockRoot = await realpath(join(configuration.cacheRoot, 'locks'));
    const existingPath = saved?.roleSkills?.lockPath ?? input.roleLockPath;
    let lockPath: string;
    if (existingPath) {
      const info = await lstat(existingPath);
      const actual = await realpath(existingPath), tail = relative(lockRoot, actual);
      if (!info.isFile() || info.isSymbolicLink() || tail === '' || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error('Role lock must be an existing regular file inside the host locks directory');
      // Preserve a saved summary byte-for-byte when a migrated cache retains
      // the old root as a compatible alias. Fresh contexts use canonical paths.
      lockPath = saved?.roleSkills?.lockPath ?? actual;
      if (saved?.roleSkills && input.roleLockPath && await realpath(input.roleLockPath) !== actual) throw new Error('An existing context cannot change its role lock');
    } else {
      lockPath = join(lockRoot, `a2a-${createHash('sha256').update(contextKey).digest('hex')}.json`);
    }
    const lock: RoleSkillLock = await resolveRoleSkills({ profilePath: configuration.profiles[roleId], cacheRoot: configuration.cacheRoot, lockPath, signal });
    const summary = a2aRoleSkillsSchema.parse({ roleId: lock.roleId, roleVersion: lock.roleVersion, lockPath,
      roleDirectory: lock.roleDirectory, ...(lock.entryGuidePath ? { entryGuidePath: lock.entryGuidePath } : {}),
      skills: lock.skills.map(({ key, skillId, sourceId, name, revision, directory, guidePath }) => ({ key, skillId, sourceId, name, revision, directory, guidePath })) });
    if (saved?.roleSkills && JSON.stringify(saved.roleSkills) !== JSON.stringify(summary)) throw new Error('Saved role skill identity differs from its verified lock');
    const instructions = lock.instructionsPath ? await readFile(lock.instructionsPath, 'utf8') : '';
    if (Buffer.byteLength(instructions) > 65536) throw new Error('Role instructions exceed the host prompt budget');
    const guides = summary.skills.map(skill => `- ${skill.key}: ${skill.guidePath} (revision=${skill.revision})`).join('\n');
    return { roleId, summary, promptPrefix: `宿主已加载角色 ${roleId}，本任务技能锁：${lockPath}。仅使用此锁及下列缓存技能，不重新检索或切换版本；续派和恢复沿用同一锁。先读取适用指南及其配套资源。\n${guides}\n${instructions}\n\n上游任务：\n` };
  }

  isRunning(taskId: string): boolean { return this.active.has(taskId); }

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    if (this.stopped) throw new UnsupportedOperationError('A2A host is stopping');
    if (this.active.has(context.taskId)) throw new UnsupportedOperationError('This task already has an active execution');
    const controller = new AbortController();
    this.awaitingInput.delete(context.taskId);
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.active.set(context.taskId, { controller, done });
    let published = false;
    let target: A2ATarget | undefined;
    let returnedError: SafeError | undefined;
    let returnedFailureMessage: string | undefined;
    const startedAt = new Date().toISOString();
    let resultContract: A2AResultContract | undefined;
    let resultMetadata: A2AResultMetadata | undefined;
    let capacityLease: CapacityLease | undefined;
    let capacityFailure: CapacityError | undefined;
    // DSH deduplicates prompts by rpcId across the whole session. A Task can
    // have several input-required turns, each with its own message identity.
    const requestId = a2aRequestId(context.taskId, context.userMessage.messageId);
    const status = (state: TaskState, text?: string, error?: SafeError, capacity?: { code: 'CAPACITY_PENDING'; position: number; waitedMs: number }, slots?: { taskSlot: { limit: number; used: number }; processSlot: { limit: number; used: number; headWaitMs: number } }): void => {
      bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId,
        status: { state, timestamp: new Date().toISOString(), message: text ? Message.fromJSON({
          messageId: randomUUID(), role: 'ROLE_AGENT', contextId: context.contextId, taskId: context.taskId, parts: [{ text }],
        }) : undefined }, metadata: target || error || resultMetadata || capacity || slots ? { '1agents': {
          ...target, ...(resultMetadata ? { result: resultMetadata } : {}), ...(error ? { error } : {}),
          ...(capacity ? { capacity } : {}),
          ...(slots ? { taskSlot: slots.taskSlot, processSlot: slots.processSlot } : {}),
        } } : undefined }));
    };
    const submitted = (text?: string): void => {
      if (published) return;
      const task = Task.fromJSON({ ...Task.toJSON(context.task ?? Task.fromJSON({ id: context.taskId, contextId: context.contextId })) as object,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString(),
          ...(text ? { message: { messageId: randomUUID(), role: 'ROLE_AGENT', contextId: context.contextId,
            taskId: context.taskId, parts: [{ text }] } } : {}) },
        metadata: { ...context.task?.metadata, '1agents': target ?? {} } });
      bus.publish(AgentEvent.task(task));
      published = true;
    };
    const pendingCapacity = (): void => {
      const message = 'Pending: waiting in FIFO order for device memory and ACP capacity.';
      submitted(message);
      status(TaskState.TASK_STATE_SUBMITTED, message);
    };
    const acquireCapacity = (signal = controller.signal) => this.capacity.acquire({ kind: 'task', source: 'automatic', id: requestId }, {
      signal, onPending: pendingCapacity,
    });
    const beforeStart = async (hostSignal?: AbortSignal): Promise<void> => {
      const signal = hostSignal ? AbortSignal.any([controller.signal, hostSignal]) : controller.signal;
      for (;;) {
        signal.throwIfAborted();
        try { await capacityLease!.recheck(); break; }
        catch (error) {
          if (!(error instanceof CapacityError)) throw error;
          await capacityLease!.release();
          capacityLease = undefined;
          pendingCapacity();
          capacityLease = await acquireCapacity(signal);
        }
      }
      signal.throwIfAborted();
      // ACP process admission is still ahead of this call. Stay submitted until the slot is held.
      if (!target?.agentPreset?.startsWith('oneagents-acp-')) status(TaskState.TASK_STATE_WORKING);
    };
    try {
      const parsed = parseA2AInput(context.request, this.options);
      const { prompt, input } = parsed;
      resultContract = parsed.resultContract;
      // Only role loading needs early admission for potentially cold packages.
      // Ordinary clients retain the first Task's prepared session metadata.
      if (this.roleIdFor(input, this.store.loadTarget(context.contextId, context.context))) submitted();
      const key = JSON.stringify([context.context.tenant ?? '', resolveUserScope(context.context), context.contextId]);
      if (this.preparing.has(key)) {
        const message = 'Pending: waiting for an earlier task to prepare this session.';
        submitted(message);
        status(TaskState.TASK_STATE_SUBMITTED, message);
      }
      const previous = this.preparing.get(key) ?? Promise.resolve();
      let promptPrefix = '';
      let unlock!: () => void;
      const lock = new Promise<void>(resolve => { unlock = resolve; });
      // A canceled waiter must not let later requests bypass its still-pending predecessor.
      const tail = previous.then(() => lock);
      this.preparing.set(key, tail);
      void tail.then(() => { if (this.preparing.get(key) === tail) this.preparing.delete(key); });
      try {
        await waitForPreparation(previous, controller.signal);
        controller.signal.throwIfAborted();
        const saved = this.store.loadTarget(context.contextId, context.context);
        if (saved?.roleSkills) submitted();
        let role;
        try { role = await this.roleFor(input, saved, key, controller.signal); }
        catch (error) { throw new RoleSkillLoadingError(error); }
        controller.signal.throwIfAborted();
        // ACP session preparation can itself wait in the process FIFO.
        if ((input.agentPreset ?? saved?.agentPreset ?? this.options.defaultAgentPreset)?.startsWith('oneagents-acp-')) pendingCapacity();
        // Acquire only after context/role waits, immediately before session creation.
        capacityLease = await acquireCapacity();
        controller.signal.throwIfAborted();
        target = await this.backend.prepare({ sessionId: saved?.sessionId,
          cwd: input.cwd ?? saved?.cwd ?? this.options.defaultCwd,
          agentPreset: input.agentPreset ?? saved?.agentPreset ?? this.options.defaultAgentPreset,
          ...(input.preflight ? { preflight: input.preflight } : {}) }, { signal: controller.signal });
        if (role) { target.roleId = role.roleId; target.roleSkills = role.summary; promptPrefix = role.promptPrefix; }
        this.store.saveTarget(context.contextId, target, context.context);
      } finally {
        unlock();
      }
      submitted();
      controller.signal.throwIfAborted();
      // Preparation can include I/O or a cold ACP handshake. Never start the
      // model using a memory observation taken before that work.
      await beforeStart();
      const onCapacity = (pending: { code: 'CAPACITY_PENDING'; position: number; waitedMs: number } | undefined): void => {
        if (!target?.agentPreset?.startsWith('oneagents-acp-')) return;
        void this.capacity.slotView().then(slots => {
          if (pending) {
            submitted();
            status(TaskState.TASK_STATE_SUBMITTED, 'CAPACITY_PENDING', undefined, pending, slots);
          } else status(TaskState.TASK_STATE_WORKING, undefined, undefined, undefined, slots);
        }).catch(() => {
          if (pending) {
            submitted();
            status(TaskState.TASK_STATE_SUBMITTED, 'CAPACITY_PENDING', undefined, pending);
          } else status(TaskState.TASK_STATE_WORKING);
        });
      };
      const result = await this.backend.run(target, promptPrefix + prompt, { requestId, signal: controller.signal, beforeStart, onCapacity });
      returnedError = result.outcome === 'failed' && result.error !== undefined
        ? toSafeError(result.error, { origin: 'a2a', operationId: requestId }) : undefined;
      returnedFailureMessage = result.outcome === 'failed' && typeof result.failureReason === 'string' && Object.hasOwn(FAILURE_MESSAGES, result.failureReason)
        ? FAILURE_MESSAGES[result.failureReason] : undefined;
      controller.signal.throwIfAborted();
      // Publish the final answer first so failed artifact validation remains diagnosable.
      if (result.text) bus.publish(AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId,
        artifact: { artifactId: `${context.taskId}-${randomUUID()}`, name: 'DSH response', description: '',
          parts: [{ content: { $case: 'text', value: result.text }, mediaType: 'text/plain', filename: '', metadata: undefined }], metadata: undefined, extensions: [] },
        append: false, lastChunk: true, metadata: undefined }));
      resultMetadata = await createA2AResultMetadata({ taskId: context.taskId, contextId: context.contextId,
        requestId, startedAt, outcome: result.outcome, target, contract: resultContract });
      await saveA2AResultMetadata(resultMetadata, target);
      if (resultMetadata.artifacts.some(artifact => artifact.url)) {
        bus.publish(AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId,
          artifact: { artifactId: `${context.taskId}-verified-artifacts`, name: 'Verified artifacts', description: '',
            parts: resultMetadata.artifacts.filter(artifact => artifact.url).map(artifact => ({
              content: { $case: 'url' as const, value: artifact.url! }, mediaType: artifact.mediaType ?? 'application/octet-stream',
              filename: '', metadata: { sha256: artifact.sha256, size: artifact.size },
            })), metadata: { verifiedBy: '1agents/a2a-host' }, extensions: [] },
          append: false, lastChunk: true, metadata: undefined }));
      }
      if (result.outcome === 'input-required') this.awaitingInput.set(context.taskId, {
        contextId: context.contextId, target, result: resultMetadata,
      });
      const error = result.outcome === 'failed'
        ? toSafeError(returnedError, { origin: 'a2a', operationId: requestId }) : undefined;
      status(result.outcome === 'completed' ? TaskState.TASK_STATE_COMPLETED : result.outcome === 'input-required' ? TaskState.TASK_STATE_INPUT_REQUIRED : TaskState.TASK_STATE_FAILED, returnedFailureMessage ?? error?.message ?? result.detail, error);
    } catch (error) {
      if (error instanceof CapacityError) capacityFailure = error;
      if (!published) bus.publish(AgentEvent.task(Task.fromJSON({ id: context.taskId, contextId: context.contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() } })));
      const projected = controller.signal.aborted && returnedError ? returnedError : toSafeError(error, { origin: 'a2a', operationId: requestId });
      const cancellationOnly = controller.signal.aborted && !returnedError && error === controller.signal.reason;
      const safe = toSafeError(cancellationOnly ? new DOMException('A2A task canceled', 'AbortError') : projected, {
        origin: 'a2a', operationId: requestId, outcomeUnknown: projected.outcomeUnknown,
      });
      resultMetadata = await createA2AResultMetadata({ taskId: context.taskId, contextId: context.contextId,
        requestId, startedAt, outcome: controller.signal.aborted ? 'canceled' : 'failed', target, contract: resultContract,
        validationCode: capacityFailure?.code ?? sessionFailureCode(error) ?? (error instanceof A2AResultValidationError ? error.code : error instanceof RoleSkillLoadingError ? 'role-skills-unavailable' : undefined),
        ...(error instanceof A2APreflightError ? { preflight: error.report } : {}) });
      try { await saveA2AResultMetadata(resultMetadata, target); }
      catch { resultMetadata.validation = { status: 'failed', code: 'result-record-write-failed' }; delete resultMetadata.recordPath; }
      status(controller.signal.aborted ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED, capacityFailure?.message ?? returnedFailureMessage ?? safe.message, safe);
    } finally {
      // Release failures retain the durable reservation and cannot strand close().
      try { await capacityLease?.release(); }
      catch { console.warn('ACP task capacity reservation could not be released'); }
      this.active.delete(context.taskId);
      finish();
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const execution = this.active.get(taskId);
    if (!execution) {
      const pending = this.awaitingInput.get(taskId);
      if (!pending) throw new UnsupportedOperationError('No active execution for this task');
      this.awaitingInput.delete(taskId);
      const result: A2AResultMetadata = { ...pending.result, finishedAt: new Date().toISOString(), outcome: 'canceled' };
      try { await saveA2AResultMetadata(result, pending.target); }
      catch { result.validation = { status: 'failed', code: 'result-record-write-failed' }; delete result.recordPath; }
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId: pending.contextId,
        status: { state: TaskState.TASK_STATE_CANCELED, timestamp: result.finishedAt, message: undefined },
        metadata: { '1agents': { ...pending.target, result } } }));
      return;
    }
    execution.controller.abort(new Error('A2A task canceled'));
    await execution.done;
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const execution of this.active.values()) execution.controller.abort(new Error('A2A host stopped'));
    await Promise.all([...this.active.values()].map(execution => execution.done));
  }
}
