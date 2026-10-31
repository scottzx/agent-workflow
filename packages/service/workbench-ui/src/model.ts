import type { AcpExecution, AcpReview, AcpTaskSummary } from './types';

/** Connection aliases describe routing configuration, not the service that executed an attempt. */
export function executionServiceLabels(execution: AcpExecution | undefined, language = 'zh-CN') {
    const text = (zh: string, en: string) => (language === 'zh-CN' ? zh : en);
    const info = execution?.serviceInfo;
    const connectionAlias = info?.connectionAlias || execution?.service;
    let service = text('未记录', 'Not recorded');
    if (info?.kind === 'gateway_workflow') service = text('ACP 内置协调器', 'ACP built-in coordinator');
    else if (info?.kind === 'a2a' || info?.kind === 'activepieces') {
        const protocol = info.kind === 'a2a' ? 'A2A' : 'Activepieces';
        const host =
            info.locality === 'loopback'
                ? text('本机', 'Loopback')
                : info.host?.includes(':') && !info.host.startsWith('[')
                  ? `[${info.host}]`
                  : info.host;
        service =
            info.host && host
                ? `${protocol} · ${host}${info.port ? `:${info.port}` : ''}`
                : `${protocol} · ${text('端点未记录', 'Endpoint not recorded')}`;
    }
    const sources = {
        backend_run: text('执行回执', 'Execution receipt'),
        target_snapshot: text('派单快照', 'Dispatch snapshot'),
        workflow_run: text('流程记录', 'Workflow record'),
        unrecorded: text('未记录', 'Not recorded'),
    };
    return {
        service,
        serviceNote:
            connectionAlias && info?.kind !== 'gateway_workflow'
                ? text(`连接别名 ${connectionAlias}`, `Connection alias ${connectionAlias}`)
                : undefined,
        serviceSource: info ? sources[info.source] || sources.unrecorded : sources.unrecorded,
        connectionAlias,
    };
}

/** Present recorded identity fields independently; a target ID is never an Agent name. */
export function executionLabels(execution: AcpExecution | undefined, language = 'zh-CN') {
    const text = (zh: string, en: string) => (language === 'zh-CN' ? zh : en);
    const missing = text('未记录', 'Not recorded');
    const modes = {
        temporary: text('临时任务', 'Temporary task'),
        resident: text('常驻角色', 'Resident role'),
        workflow: text('工作流', 'Workflow'),
        unknown: missing,
    };
    const mode = execution ? modes[execution.kind] || missing : missing;
    let role = missing;
    let roleNote: string | undefined;
    if (execution?.kind === 'resident' || execution?.kind === 'workflow') {
        role = execution.targetName || execution.roleId || missing;
        if (execution.kind === 'resident' && execution.agentPreset)
            roleNote = text(`预设 ${execution.agentPreset}`, `Preset ${execution.agentPreset}`);
    } else if (execution?.agentPreset) {
        role = execution.agentPreset;
    } else if (execution?.kind === 'temporary' && execution.presetStatus === 'host_default') {
        role = text('宿主默认', 'Host default');
        roleNote = text('实际预设未记录', 'Effective preset not recorded');
    }
    return { mode, role, roleNote, service: executionServiceLabels(execution, language).service };
}

export interface AcpTaskRoute {
    jobId?: string;
    reviewId?: string;
    full: boolean;
}

/** Hash routes never enter ttyd's terminal command/query parameters. */
export function parseAcpTaskHash(hash: string): AcpTaskRoute | null {
    const match = /^#acp\/tasks(?:\/([^?]+))?(?:\?(.*))?$/.exec(hash);
    if (!match) return null;
    try {
        const jobId = match[1] ? decodeURIComponent(match[1]) : undefined;
        if (jobId && (jobId.length > 512 || /[\u0000-\u001f/]/.test(jobId))) return null;
        const params = new URLSearchParams(match[2] || '');
        const reviewId = params.get('review') || undefined;
        if (reviewId && (reviewId.length > 512 || /[\u0000-\u001f]/.test(reviewId))) return null;
        return { jobId, reviewId, full: !!jobId && params.get('mode') !== 'drawer' };
    } catch {
        return null;
    }
}

export function acpTaskHash(route: AcpTaskRoute): string {
    if (!route.jobId) return '#acp/tasks';
    const params = new URLSearchParams();
    if (route.reviewId) params.set('review', route.reviewId);
    if (!route.full) params.set('mode', 'drawer');
    return `#acp/tasks/${encodeURIComponent(route.jobId)}${params.size ? `?${params}` : ''}`;
}

export function latestReview(reviews: AcpReview[]): AcpReview | undefined {
    return [...reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function safeArtifactUrl(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    try {
        const url = new URL(raw);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
    } catch {
        return undefined;
    }
}

export function taskDepth(task: AcpTaskSummary, rows: AcpTaskSummary[]): number {
    const byId = new Map(rows.map(row => [row.jobId, row]));
    const visited = new Set([task.jobId]);
    let cursor = task,
        depth = 0;
    while (cursor.parentJobRef && !visited.has(cursor.parentJobRef.jobId)) {
        const parent = byId.get(cursor.parentJobRef.jobId);
        if (!parent) break;
        visited.add(parent.jobId);
        depth++;
        cursor = parent;
    }
    return depth;
}
