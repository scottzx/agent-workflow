import type {
    AcpAgentCatalog,
    AcpAgentDraftInput,
    AcpChatPage,
    AcpDecisionInput,
    AcpDshSession,
    AcpProcessAnswerInput,
    AcpTaskDetail,
    AcpTaskFilter,
    AcpTaskList,
} from './types';

/** The page talks only to its own gateway. The login cookie never leaves this origin. */
const BASE = '/workbench/ui/api';

export class AcpTaskApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code?: string
    ) {
        super(message);
    }
}

/** Every page fires this on 401 so the shell can return to the login form. */
export const loginRequired = new EventTarget();

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        credentials: 'same-origin',
        headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    if (response.ok) return (await response.json()) as T;
    let message = response.statusText;
    let code: string | undefined;
    const raw = await response.text();
    try {
        const body = JSON.parse(raw);
        message = body.message || (typeof body.error === 'string' ? body.error : body.error?.message) || message;
        code = typeof body.code === 'string' ? body.code : typeof body.error === 'string' ? body.error : undefined;
    } catch {
        message = raw || message;
    }
    if (response.status === 401 && code === 'login_required') loginRequired.dispatchEvent(new Event('required'));
    throw new AcpTaskApiError(message, response.status, code);
}

const post = <T>(path: string, input: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(input) });

export const session = {
    status: () => call<{ authenticated: boolean; loginRequired?: boolean }>('/session'),
    login: (token: string) => post<{ authenticated: boolean }>('/session', { token }),
    logout: () => call<{ authenticated: boolean }>('/session', { method: 'DELETE' }),
};

export const acpTaskService = {
    list(filter: AcpTaskFilter, offset = 0, limit = 100): Promise<AcpTaskList> {
        const params = new URLSearchParams({ filter, offset: String(offset), limit: String(limit) });
        return call(`/tasks?${params}`);
    },
    get: (jobId: string): Promise<AcpTaskDetail> => call(`/tasks/${encodeURIComponent(jobId)}`),
    /** Only DSH serves this route: the session on this host that ran an A2A task, and whether its turn is still running. */
    dshSession: (taskId: string): Promise<AcpDshSession> => call(`/dsh/tasks/${encodeURIComponent(taskId)}`),
    chat: (jobId: string, before: number | undefined, limit: number): Promise<AcpChatPage> => {
        const params = new URLSearchParams({ limit: String(limit) });
        if (before !== undefined) params.set('before', String(before));
        return call(`/tasks/${encodeURIComponent(jobId)}/chat?${params}`);
    },
    decide: (jobId: string, reviewId: string, input: AcpDecisionInput): Promise<unknown> =>
        post(`/tasks/${encodeURIComponent(jobId)}/reviews/${encodeURIComponent(reviewId)}/decisions`, input),
    /** Asks the execution host for the task's latest state now, e.g. after its caller stopped waiting on it. */
    refresh: (jobId: string): Promise<AcpTaskDetail> => post(`/tasks/${encodeURIComponent(jobId)}/refresh`, {}),
    answerProcessRequest: (jobId: string, requestId: string, input: AcpProcessAnswerInput): Promise<AcpTaskDetail> =>
        post(`/tasks/${encodeURIComponent(jobId)}/process-requests/${encodeURIComponent(requestId)}/answers`, input),
    listAgents: (): Promise<AcpAgentCatalog> => call('/agents'),
    createAgent: (input: AcpAgentDraftInput): Promise<AcpAgentCatalog & { draft: { agentId: string } }> => post('/agents', input),
    updateAgent: (agentId: string, input: AcpAgentDraftInput): Promise<AcpAgentCatalog> =>
        post(`/agents/${encodeURIComponent(agentId)}/settings`, input),
    publishAgent: (agentId: string, input: { releaseName: string; replace?: boolean }): Promise<AcpAgentCatalog> =>
        post(`/agents/${encodeURIComponent(agentId)}/publish`, input),
};
