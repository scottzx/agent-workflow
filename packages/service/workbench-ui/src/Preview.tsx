import { useCallback, useState } from 'preact/hooks';
import { ChatView, useChatPages, type ChatPageLoader } from '@1agents/chat-view';
import { FilePreview } from '@1agents/file-preview';
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

/** One artifact. A readable URL gets an on-demand inline preview; a path on the execution host is shown as a path. */
export function ArtifactItem({ artifact }: { artifact: { path?: string; url?: string; mediaType?: string } }) {
    const [open, setOpen] = useState(false);
    const url = safeArtifactUrl(artifact.url);
    const name = artifact.path?.split('/').pop() || (url ? decodeURIComponent(new URL(url).pathname.split('/').pop() || '') : '') || text('产物', 'Artifact');
    if (!url) {
        return artifact.path ? (
            <span class="acp-muted">
                {name} · <code>{artifact.path}</code>
            </span>
        ) : null;
    }
    return (
        <div class="acp-artifact-item">
            <span class="acp-artifact-row">
                <a href={url} target="_blank" rel="noopener noreferrer">
                    {name}
                </a>
                <button type="button" class="acp-link" aria-expanded={open} onClick={() => setOpen(!open)}>
                    {open ? text('收起预览', 'Hide preview') : text('预览', 'Preview')}
                </button>
            </span>
            {open && (
                <FilePreview name={name} path={artifact.path} url={url} mediaType={artifact.mediaType} diagrams={false} hideHeader labels={labels} />
            )}
        </div>
    );
}

/** The inline Markdown report of a review version. */
export function ReportPreview({ markdown, path }: { markdown: string; path?: string }) {
    return <FilePreview name={path?.split('/').pop() || 'report.md'} path={path} content={markdown} diagrams={false} hideHeader labels={labels} />;
}

/** Conversation of one task, newest page first; nothing is requested until this component mounts. */
export function TaskChat({ jobId }: { jobId: string }) {
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
            />
        </div>
    );
}
