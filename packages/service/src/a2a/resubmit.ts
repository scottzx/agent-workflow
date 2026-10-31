/**
 * Manual takeover: a person finished a task in its DSH session and the agent hands the result back.
 * The host re-verifies the job directory's manifest exactly as at completion; the gateway sees a newer
 * completed snapshot and records it as a new result revision awaiting business acceptance.
 */
import { randomUUID } from 'node:crypto';
import { Message, Task, TaskState, type StreamResponse } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { a2aResultContractSchema, A2AResultValidationError, createA2AResultMetadata, saveA2AResultMetadata, type A2AResultMetadata } from './result-metadata.js';
import type { FileA2AStore } from './store.js';

export type A2AResubmitCode = 'NOT_A2A_SESSION' | 'TASK_RUNNING' | 'TASK_NOT_RESUBMITTABLE' | 'ARTIFACTS_INVALID' | 'INVALID_SUMMARY';
export class A2AResubmitError extends Error {
  constructor(readonly code: A2AResubmitCode, message: string) { super(message); }
}

export interface A2ASessionTask {
  taskId: string;
  contextId: string;
  jobId?: string;
  state: string;
  running: boolean;
  /** Completed or awaiting input, and not running: the session may be handed back. */
  resubmittable: boolean;
}

export interface A2AResubmission {
  taskId: string;
  contextId: string;
  jobId?: string;
  artifacts: { path: string; size: number; sha256: string }[];
  validation: A2AResultMetadata['validation']['status'];
  submittedAt: string;
}

interface Deps {
  store: FileA2AStore;
  executor: { isRunning(taskId: string): boolean; releaseInput(taskId: string): void };
  push(event: StreamResponse, context: ServerCallContext, task: Task): Promise<void>;
}

const SUMMARY_LIMIT = 64 * 1024;
const resubmittable = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_INPUT_REQUIRED]);
const hostContext = () => new ServerCallContext({ requestedVersion: '1.0', user: { isAuthenticated: true, userName: 'dsh-a2a' } });
const meta = (task: Task) => (task.metadata?.['1agents'] ?? {}) as Record<string, unknown> & { result?: A2AResultMetadata; manualSubmissions?: number };

export function a2aSessionTask(deps: Pick<Deps, 'store' | 'executor'>, sessionId: string): A2ASessionTask | undefined {
  const task = deps.store.latestTaskForSession(sessionId, hostContext());
  if (!task) return undefined;
  const running = deps.executor.isRunning(task.id), state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
  const jobId = meta(task).result?.lineage?.jobId;
  return { taskId: task.id, contextId: task.contextId, ...(jobId ? { jobId } : {}), state: TaskState[state] ?? String(state),
    running, resubmittable: !running && resubmittable.has(state) };
}

/** The DSH session that ran an A2A task; the gateway ledger records only the task ID. */
export function a2aTaskSession(deps: Pick<Deps, 'store'>, taskId: string): string | undefined {
  return deps.store.sessionOfTask(taskId, hostContext());
}

export async function resubmitA2ASession(deps: Deps, input: { sessionId: string; summary: string }): Promise<A2AResubmission> {
  const summary = input.summary.trim();
  if (!summary || Buffer.byteLength(summary) > SUMMARY_LIMIT) throw new A2AResubmitError('INVALID_SUMMARY', 'summary must be non-empty text of at most 64 KiB');
  const context = hostContext();
  const task = deps.store.latestTaskForSession(input.sessionId, context);
  if (!task) throw new A2AResubmitError('NOT_A2A_SESSION', 'This session did not run an A2A workbench task');
  if (deps.executor.isRunning(task.id)) throw new A2AResubmitError('TASK_RUNNING', 'The A2A turn is still running; submit after it ends');
  if (!resubmittable.has(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)) {
    throw new A2AResubmitError('TASK_NOT_RESUBMITTABLE', 'Only a completed task or one awaiting input can be handed back; dispatch a failed or canceled task again from the workbench');
  }
  const previous = meta(task), target = deps.store.loadTarget(task.contextId, context);
  const { source: _source, ...declared } = previous.result?.lineage ?? {};
  const contract = previous.result?.lineage ? a2aResultContractSchema.parse(declared) : undefined;
  // Same verification as a completed turn: only the job directory's manifest names artifacts.
  const result = await createA2AResultMetadata({ taskId: task.id, contextId: task.contextId, requestId: `manual-${randomUUID()}`,
    startedAt: previous.result?.startedAt ?? new Date().toISOString(), outcome: 'completed', ...(target ? { target } : {}), ...(contract ? { contract } : {}) })
    .catch(error => {
      if (error instanceof A2AResultValidationError) throw new A2AResubmitError('ARTIFACTS_INVALID', `Artifact manifest check failed: ${error.code}`);
      throw error;
    });
  if (result.validation.status === 'failed') throw new A2AResubmitError('ARTIFACTS_INVALID', `Artifact manifest check failed: ${result.validation.code}`);
  await saveA2AResultMetadata(result, target);
  deps.executor.releaseInput(task.id);
  const submittedAt = result.finishedAt;
  const verified = result.artifacts.filter(artifact => artifact.url);
  const next = Task.fromJSON(Task.toJSON(task));
  next.status = { state: TaskState.TASK_STATE_COMPLETED, timestamp: submittedAt, message: Message.fromJSON({
    messageId: randomUUID(), role: 'ROLE_AGENT', contextId: task.contextId, taskId: task.id, parts: [{ text: summary }] }) };
  // The gateway reads the result text from text artifacts; the earlier answer stays in its result history.
  next.artifacts = [
    { artifactId: `${task.id}-manual-${randomUUID()}`, name: 'Manual submission', description: '',
      parts: [{ content: { $case: 'text', value: summary }, mediaType: 'text/plain', filename: '', metadata: undefined }], metadata: undefined, extensions: [] },
    ...(verified.length ? [{ artifactId: `${task.id}-verified-artifacts`, name: 'Verified artifacts', description: '',
      parts: verified.map(artifact => ({ content: { $case: 'url' as const, value: artifact.url! }, mediaType: artifact.mediaType ?? 'application/octet-stream',
        filename: '', metadata: { sha256: artifact.sha256, size: artifact.size } })), metadata: { verifiedBy: '1agents/a2a-host' }, extensions: [] }] : []),
  ];
  next.metadata = { ...task.metadata, '1agents': { ...previous, result, manualSubmissions: (previous.manualSubmissions ?? 0) + 1 } };
  await deps.store.taskStore.save(next, context);
  // A webhook failure leaves the stored snapshot authoritative; the gateway also reads it on refresh.
  void deps.push({ payload: { $case: 'task', value: next } }, context, next).catch(() => {});
  return { taskId: task.id, contextId: task.contextId, ...(result.lineage?.jobId ? { jobId: result.lineage.jobId } : {}),
    artifacts: result.artifacts.map(({ path, size, sha256 }) => ({ path, size, sha256 })), validation: result.validation.status, submittedAt };
}
