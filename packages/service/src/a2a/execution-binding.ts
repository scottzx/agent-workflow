/** Session-scoped link from the DSH prompt to the gateway job that is waiting on it. */
export interface A2AExecutionRef { jobId: string; attemptId: string }

const bindings = new Map<string, A2AExecutionRef>();

export function bindA2AExecution(sessionId: string, execution: A2AExecutionRef): void {
  if (!sessionId.trim() || !execution.jobId.trim() || !execution.attemptId.trim()) throw new Error('A2A execution binding requires a session, job, and attempt');
  bindings.set(sessionId, { jobId: execution.jobId, attemptId: execution.attemptId });
}

export function currentA2AExecution(sessionId: string): A2AExecutionRef | undefined {
  const value = bindings.get(sessionId);
  return value ? { ...value } : undefined;
}

/** Clears the binding only when it still belongs to this attempt. */
export function unbindA2AExecution(sessionId: string, execution?: A2AExecutionRef): void {
  const current = bindings.get(sessionId);
  if (!current) return;
  if (execution && (current.jobId !== execution.jobId || current.attemptId !== execution.attemptId)) return;
  bindings.delete(sessionId);
}
