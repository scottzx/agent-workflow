import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ChatView, useChatPages, type ChatPageLoader } from '@1agents/chat-view';
import { FilePreview, renderMarkdown } from '@1agents/file-preview';
import { acpTaskService } from './api';
import { safeArtifactUrl } from './model';
import { language, text } from './ui';

// The gateway page runs under a strict CSP: no inline <style> from diagram renderers, same-origin loads only.
const labels =
    language === 'zh-CN'
        ? { loading: '正在读取…', failed: '无法读取该文件', open: '新窗口打开', unsupported: '此类型文件暂不支持预览', truncated: '文件较大，仅显示开头部分', noSource: '该产物没有可读取的地址', empty: '空文件' }
        : undefined;
const chatLabels =
    language === 'zh-CN'
        ? { empty: '暂无对话内容', loading: '正在读取对话…', loadEarlier: '加载更早的对话', loadingEarlier: '加载中…', retry: '重试', thinking: '思考', input: '输入', output: '输出', showMore: '显示全部', allowed: '已允许', denied: '已拒绝', waiting: '等待回答', plan: '计划', you: '你', agent: '智能体' }
        : undefined;

export interface ArtifactRef {
    path?: string;
    url?: string;
    mediaType?: string;
    sha256?: string;
}

/** A published URL as is; a verified file on the execution host through the gateway, which re-checks its digest. */
export function artifactUrl(jobId: string, artifact: ArtifactRef): string | undefined {
    const published = safeArtifactUrl(artifact.url);
    if (published) return published;
    if (!artifact.sha256 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return undefined;
    return new URL(`/workbench/ui/api/tasks/${encodeURIComponent(jobId)}/artifacts/${artifact.sha256}`, location.origin).href;
}

function artifactName(artifact: ArtifactRef, url?: string): string {
    return (
        artifact.path?.split('/').pop() ||
        (url ? decodeURIComponent(new URL(url).pathname.split('/').pop() || '') : '') ||
        text('产物', 'Artifact')
    );
}

/** One artifact; its preview opens in the detail's bottom drawer. Without URL or receipt digest it is only a path. */
export function ArtifactItem({
    jobId,
    artifact,
    active,
    onPreview,
}: {
    jobId: string;
    artifact: ArtifactRef;
    active?: boolean;
    onPreview: (artifact: ArtifactRef) => void;
}) {
    const url = artifactUrl(jobId, artifact);
    const name = artifactName(artifact, url);
    if (!url) {
        return artifact.path ? (
            <span class="acp-muted">
                {name} · <code>{artifact.path}</code>
            </span>
        ) : null;
    }
    return (
        <span class="acp-artifact-row">
            <a href={url} target="_blank" rel="noopener noreferrer">
                {name}
            </a>
            <button type="button" class="acp-link" aria-pressed={active} onClick={() => onPreview(artifact)}>
                {active ? text('预览中', 'Previewing') : text('预览', 'Preview')}
            </button>
        </span>
    );
}

/** Bottom drawer inside the task detail: the preview stays beside whatever tab opened it. */
export function ArtifactDrawer({ jobId, artifact, onClose }: { jobId: string; artifact: ArtifactRef; onClose: () => void }) {
    const url = artifactUrl(jobId, artifact);
    const name = artifactName(artifact, url);
    const close = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        close.current?.focus({ preventScroll: true });
        // Captured before the page's own Escape (which closes the whole detail): the first press closes only the drawer.
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            onClose();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [onClose]);
    return (
        <section class="acp-artifact-drawer" role="dialog" aria-label={name}>
            <header class="acp-artifact-drawer-header">
                <div>
                    <strong>{name}</strong>
                    {artifact.path && <small title={artifact.path}>{artifact.path}</small>}
                </div>
                {url && (
                    <a class="acp-button" href={url} target="_blank" rel="noopener noreferrer">
                        {text('新窗口打开', 'Open in new tab')}
                    </a>
                )}
                <button type="button" class="acp-button" ref={close} onClick={onClose}>
                    {text('关闭', 'Close')}
                </button>
            </header>
            <div class="acp-artifact-drawer-body">
                {url ? (
                    <FilePreview key={url} name={name} path={artifact.path} url={url} mediaType={artifact.mediaType} diagrams={false} hideHeader labels={labels} />
                ) : (
                    <p class="acp-muted">{text('该产物没有可读取的地址', 'This artifact has no readable address')}</p>
                )}
            </div>
        </section>
    );
}

/** The inline Markdown report of a review version. */
export function ReportPreview({ markdown, path }: { markdown: string; path?: string }) {
    return <FilePreview name={path?.split('/').pop() || 'report.md'} path={path} content={markdown} diagrams={false} hideHeader labels={labels} />;
}

/** Conversation of one task, newest page first; nothing is requested until this component mounts. */
export function TaskChat({ jobId, onOpenFile }: { jobId: string; onOpenFile?: (path: string) => void }) {
    const load = useCallback<ChatPageLoader>(
        async (cursor, limit) => {
            const page = await acpTaskService.chat(jobId, cursor === undefined ? undefined : Number(cursor), limit);
            return {
                items: page.items,
                hasMore: page.hasMore,
                nextCursor: page.nextCursor,
            };
        },
        [jobId]
    );
    const pages = useChatPages(load, { pageSize: 40 });
    return (
        <div class="acp-chat">
            <ChatView
                items={pages.items}
                loading={pages.loading}
                loadingMore={pages.loadingMore}
                hasMore={pages.hasMore}
                error={pages.error}
                onLoadMore={pages.loadMore}
                onRetry={pages.reload}
                diagrams={false}
                labels={chatLabels}
                onOpenFile={onOpenFile}
            />
        </div>
    );
}

/** Task text written by agents (progress, results, plans) is Markdown; it is sanitized before it reaches the page. */
export function Md({ source, class: className, onOpenFile }: { source: string; class?: string; onOpenFile?: (path: string) => void }) {
    const [html, setHtml] = useState('');
    useEffect(() => {
        let live = true;
        renderMarkdown(source).then(next => live && setHtml(next)).catch(() => live && setHtml(''));
        return () => {
            live = false;
        };
    }, [source]);
    // Until the renderer chunk arrives (or if it fails) the raw text stays readable.
    return html ? (
        <div
            class={`fp-md acp-md${className ? ` ${className}` : ''}`}
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={event => {
                // A local path names a file on the execution host, never a page of this site.
                const href = (event.target as HTMLElement).closest('a')?.getAttribute('href');
                if (!href || /^(https?:|mailto:|#)/i.test(href) || !onOpenFile) return;
                event.preventDefault();
                onOpenFile(decodeURIComponent(href.split('#')[0]!).replace(/:\d+$/, ''));
            }}
        />
    ) : (
        <p class={className}>{source}</p>
    );
}
