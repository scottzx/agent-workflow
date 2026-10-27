import { useEffect, useState } from 'preact/hooks';
import type { AcpExecution, AcpTaskSummary } from './types';
import { acpTaskHash, executionLabels, executionServiceLabels, parseAcpTaskHash, type AcpTaskRoute } from './model';

export const language = navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
export const text = (zh: string, en: string) => (language === 'zh-CN' ? zh : en);
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const title = (task: AcpTaskSummary) => task.title || task.jobId;
export const channelLabel = (channel?: string) =>
    channel === 'trial' ? text('试跑', 'Trial') : channel === 'formal' ? text('正式', 'Formal') : text('临时', 'Temporary');

/** The hash keeps task and review ids out of the request path the gateway logs. */
export function useRoute(): AcpTaskRoute {
    const read = () => parseAcpTaskHash(location.hash) ?? { full: false };
    const [route, setRoute] = useState(read);
    useEffect(() => {
        const update = () => setRoute(read());
        window.addEventListener('hashchange', update);
        return () => window.removeEventListener('hashchange', update);
    }, []);
    return route;
}
export function navigateAcpTask(route: AcpTaskRoute) {
    location.hash = acpTaskHash(route);
}

export function statusLabel(status: string): string {
    const labels: Record<string, [string, string]> = {
        not_started: ['未开始', 'Not started'],
        submitted: ['已提交', 'Submitted'],
        working: ['进行中', 'Working'],
        completed: ['已完成', 'Completed'],
        failed: ['失败', 'Failed'],
        canceled: ['已取消', 'Canceled'],
        rejected: ['已拒绝', 'Rejected'],
        unknown: ['待核实', 'Unknown'],
        input_required: ['需要处理', 'Needs input'],
        auth_required: ['需要认证', 'Needs authentication'],
        waiting_human: ['待人工确认', 'Awaiting review'],
        awaiting_human: ['待人工确认', 'Awaiting review'],
        pending: ['待确认', 'Pending'],
        approved: ['已通过', 'Approved'],
        changes_requested: ['要求修改', 'Changes requested'],
        superseded: ['已被替代', 'Superseded'],
        awaiting_validation: ['等待校验', 'Awaiting validation'],
        processing: ['正在续跑', 'Resuming'],
        resuming: ['等待续跑', 'Waiting to resume'],
        applied: ['已处理', 'Applied'],
    };
    const label = labels[status];
    return label ? text(...label) : status;
}

export function phaseLabel(value: string): string {
    const names: Record<string, [string, string]> = {
        research: ['临时智能体分析', 'Project analysis'],
        file_check: ['报告文件检查', 'Report file check'],
        summary: ['文稿生成', 'Writing'],
        project_script: ['文稿生成', 'Writing'],
        human_review: ['人工审核', 'Human review'],
        human_resume: ['续跑处理', 'Resuming workflow'],
        awaiting_human: ['人工审核', 'Human review'],
        make: ['设计制作', 'Production'],
        ppt_production: ['设计制作', 'Production'],
        validate: ['机器校验', 'Validation'],
        review: ['独立验收', 'Independent review'],
        independent_review: ['独立验收', 'Independent review'],
        finished: ['交付完成', 'Delivered'],
        waiting_children: ['等待执行结果', 'Waiting for execution'],
    };
    return names[value] ? text(...names[value]) : value;
}

export function displayStatus(task: AcpTaskSummary) {
    return task.displayStatus || (task.pendingReviewId ? 'waiting_human' : task.executionStatus);
}

export function Status({ value }: { value: string }) {
    return <span class={`acp-status acp-status-${value.replace(/[^a-z_]/gi, '')}`}>{statusLabel(value)}</span>;
}

export function date(value?: string | null) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime())
        ? value
        : d.toLocaleString(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function duration(ms?: number) {
    if (ms === undefined) return '—';
    const minutes = Math.floor(ms / 60000);
    return minutes < 60
        ? text(`${minutes} 分钟`, `${minutes} min`)
        : text(`${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`, `${Math.floor(minutes / 60)} h ${minutes % 60} min`);
}

export function progressExcerpt(value?: string): string {
    const characters = Array.from((value || '').replace(/\s+/g, ' ').trim());
    return characters.length > 50 ? `${characters.slice(0, 49).join('')}…` : characters.join('') || '—';
}

export function ExecutionRole({ execution }: { execution?: AcpExecution }) {
    const labels = executionLabels(execution, language);
    return (
        <span class="acp-execution-role" title={[labels.role, labels.roleNote].filter(Boolean).join(' · ')}>
            <span>{labels.role}</span>
            {labels.roleNote && <small>{labels.roleNote}</small>}
        </span>
    );
}

export function ExecutionService({ execution }: { execution?: AcpExecution }) {
    const labels = executionServiceLabels(execution, language);
    return (
        <span class="acp-execution-service" title={[labels.service, labels.serviceNote].filter(Boolean).join(' · ')}>
            <span>{labels.service}</span>
            {labels.serviceNote && <small>{labels.serviceNote}</small>}
        </span>
    );
}

export function ServiceProvenance({ execution }: { execution?: AcpExecution }) {
    const labels = executionServiceLabels(execution, language);
    return (
        <>
            <dt>{text('服务来源依据', 'Service evidence')}</dt>
            <dd>{labels.serviceSource}</dd>
            {labels.connectionAlias && (
                <>
                    <dt>{text('配置连接别名', 'Configured connection alias')}</dt>
                    <dd>{labels.connectionAlias}</dd>
                </>
            )}
        </>
    );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
    return (
        <div class="acp-empty">
            <strong>{title}</strong>
            {description && <p>{description}</p>}
        </div>
    );
}

export function ErrorState({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
    return (
        <div class="acp-error" role="alert">
            <strong>{title}</strong>
            <p>{message}</p>
            {onRetry && (
                <button type="button" class="acp-button" onClick={onRetry}>
                    {text('重试', 'Retry')}
                </button>
            )}
        </div>
    );
}
