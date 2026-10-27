/** Polls the gateway workbench for a question or plan answer. The token stays in plugin config. */
import { setTimeout as delay } from 'node:timers/promises';

export interface ProcessQuestionInput {
  id: string;
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export interface ProcessRequestOpenInput {
  requestId: string;
  jobId: string;
  attemptId: string;
  sessionId: string;
  kind: 'question' | 'plan';
  questions?: ProcessQuestionInput[];
  planContent?: string;
}
export interface ProcessRequestView {
  requestId: string;
  jobId: string;
  kind: 'question' | 'plan';
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  deadlineAt: string;
  answer?: { clientRequestId: string; outcome: string; answers?: Record<string, string | string[]> };
}
export interface ProcessRequestClient {
  open(input: ProcessRequestOpenInput): Promise<{ requestId: string; deadlineAt: string; status: string }>;
  wait(input: { jobId: string; requestId: string; signal: AbortSignal }): Promise<ProcessRequestView>;
  report(input: { jobId: string; requestId: string; clientRequestId: string; outcome: string; answers?: Record<string, string | string[]> }): Promise<void>;
}

export function createWorkbenchProcessClient(options: { url: string; token: string; pollMs?: number }): ProcessRequestClient {
  const url = new URL(options.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('a2a.workbench.url must be an HTTP(S) URL without credentials');
  if (!options.token.trim()) throw new Error('a2a.workbench.token is required');
  const origin = url.origin;
  const token = options.token;
  const pollMs = options.pollMs ?? 200;
  const endpoint = (path: string) => new URL(path, origin);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function send(path: string, method: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    const response = await fetch(endpoint(path), { method, headers, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Process request ${method} failed (${response.status})`);
    return response;
  }
  return {
    async open(input) {
      const response = await send(`/workbench/tasks/${encodeURIComponent(input.jobId)}/process-requests`, 'POST', AbortSignal.timeout(5_000), input);
      const body = await response.json() as { requestId?: unknown; deadlineAt?: unknown; status?: unknown };
      if (typeof body.requestId !== 'string' || typeof body.deadlineAt !== 'string') throw new Error('Process request record is incomplete');
      return { requestId: body.requestId, deadlineAt: body.deadlineAt, status: typeof body.status === 'string' ? body.status : 'pending' };
    },
    async wait(input) {
      for (;;) {
        input.signal.throwIfAborted();
        const response = await send(`/workbench/tasks/${encodeURIComponent(input.jobId)}/process-requests/${encodeURIComponent(input.requestId)}`, 'GET', input.signal);
        const view = await response.json() as ProcessRequestView;
        if (view.status !== 'pending') return view;
        if (Date.parse(view.deadlineAt) <= Date.now()) return { ...view, status: 'expired' };
        await delay(pollMs, undefined, { signal: input.signal });
      }
    },
    async report(input) {
      const response = await fetch(endpoint(`/workbench/tasks/${encodeURIComponent(input.jobId)}/process-requests/${encodeURIComponent(input.requestId)}/answers`), {
        method: 'POST', headers, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ clientRequestId: input.clientRequestId, outcome: input.outcome, ...(input.answers ? { answers: input.answers } : {}) }),
      });
      if (response.status === 409) return;
      if (!response.ok) throw new Error(`Process request answer was not recorded (${response.status})`);
    },
  };
}
