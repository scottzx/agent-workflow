import type { AcpTaskDetail, AcpWorkflowNode } from './types';
import type { ArtifactRef } from './Preview';
import { LazyView, preload, preloadProps } from './LazyView';

const loadPreview = () => import('./Preview');
const loadTicket = () => import('./TicketPanel');

export const preloadPreview = () => preload('preview', loadPreview);
export const preloadTicket = () => preload('ticket-panel', loadTicket);
export const previewHover = preloadProps('preview', loadPreview);
export const ticketHover = preloadProps('ticket-panel', loadTicket);

export function LazyMd(props: { source: string; class?: string; onOpenFile?: (path: string) => void }) {
    return (
        <LazyView cacheKey="preview" load={loadPreview} lines={3}>
            {mod => <mod.Md source={props.source} class={props.class} onOpenFile={props.onOpenFile} />}
        </LazyView>
    );
}

export function LazyArtifactItem(props: {
    jobId: string;
    artifact: ArtifactRef;
    active?: boolean;
    onPreview: (artifact: ArtifactRef) => void;
}) {
    return (
        <LazyView cacheKey="preview" load={loadPreview} lines={1}>
            {mod => <mod.ArtifactItem {...props} />}
        </LazyView>
    );
}

export function LazyArtifactDrawer(props: { jobId: string; artifact: ArtifactRef; onClose: () => void }) {
    return (
        <LazyView cacheKey="preview" load={loadPreview} lines={6}>
            {mod => <mod.ArtifactDrawer {...props} />}
        </LazyView>
    );
}

export function LazyReportPreview(props: { markdown: string; path?: string }) {
    return (
        <LazyView cacheKey="preview" load={loadPreview} lines={6}>
            {mod => <mod.ReportPreview {...props} />}
        </LazyView>
    );
}

export function LazyTaskChat(props: { jobId: string; onOpenFile?: (path: string) => void }) {
    return (
        <LazyView cacheKey="preview" load={loadPreview} lines={8}>
            {mod => <mod.TaskChat {...props} />}
        </LazyView>
    );
}

export function LazyTicketPanel(props: { detail: AcpTaskDetail; onChanged: () => void }) {
    return (
        <LazyView cacheKey="ticket-panel" load={loadTicket} lines={6}>
            {mod => <mod.TicketPanel {...props} />}
        </LazyView>
    );
}

export function LazyMicroDag(props: { nodes: AcpWorkflowNode[] }) {
    return (
        <LazyView cacheKey="ticket-panel" load={loadTicket} lines={4}>
            {mod => <mod.MicroDag {...props} />}
        </LazyView>
    );
}
