import { useState } from 'preact/hooks';
import { ChatView, type ChatViewProps } from './ChatView.tsx';
import type { ChatPageLoader } from './types.ts';
import { useChatPages } from './usePages.ts';

export interface LazyChatProps extends Omit<ChatViewProps, 'items' | 'loading' | 'loadingMore' | 'hasMore' | 'error' | 'onLoadMore' | 'onRetry'> {
    load: ChatPageLoader;
    title?: string;
    /** Start expanded. Collapsed panels make no request until opened. */
    defaultOpen?: boolean;
    pageSize?: number;
    /** Height of the transcript when open (default 420px). */
    height?: string;
}

/** A collapsible transcript that fetches its first page only when the user opens it. */
export function LazyChat({ load, title = 'Conversation', defaultOpen = false, pageSize, height = '420px', ...view }: LazyChatProps) {
    const [open, setOpen] = useState(defaultOpen);
    const pages = useChatPages(load, { pageSize, enabled: open });
    return (
        <section class="cv-lazy">
            <button type="button" class="cv-lazy-head" aria-expanded={open} onClick={() => setOpen(!open)}>
                <span>{title}</span>
                <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
                <div style={{ height }}>
                    <ChatView {...view} items={pages.items} loading={pages.loading} loadingMore={pages.loadingMore} hasMore={pages.hasMore}
                        error={pages.error} onLoadMore={pages.loadMore} onRetry={pages.reload} />
                </div>
            )}
        </section>
    );
}
