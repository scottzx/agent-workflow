import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ChatItem, ChatPageLoader } from './types.ts';

export interface ChatPagesOptions {
    /** Items per request (default 40). */
    pageSize?: number;
    /** Nothing is requested while false, so a collapsed panel costs no round trip. */
    enabled?: boolean;
}

export interface ChatPages {
    items: ChatItem[];
    /** True during the first (newest) page. */
    loading: boolean;
    /** True while an older page is loading. */
    loadingMore: boolean;
    hasMore: boolean;
    error?: string;
    loadMore: () => void;
    reload: () => void;
}

/**
 * Pages a transcript newest-first: the first request returns the latest messages, loadMore prepends
 * older ones. The loader decides what a cursor means; pass `key` changes via a new loader identity.
 */
export function useChatPages(loader: ChatPageLoader, { pageSize = 40, enabled = true }: ChatPagesOptions = {}): ChatPages {
    const [items, setItems] = useState<ChatItem[]>([]);
    const [state, setState] = useState({ loading: false, loadingMore: false, hasMore: false, error: undefined as string | undefined });
    const cursor = useRef<string | undefined>(undefined);
    const abort = useRef<AbortController>();
    const generation = useRef(0);
    const busy = useRef(false);

    const run = useCallback((first: boolean) => {
        if (busy.current) return;
        busy.current = true;
        const mine = generation.current;
        abort.current = new AbortController();
        setState(s => ({ ...s, error: undefined, loading: first, loadingMore: !first }));
        loader(first ? undefined : cursor.current, pageSize, abort.current.signal)
            .then(page => {
                if (mine !== generation.current) return;
                cursor.current = page.nextCursor;
                setItems(prev => {
                    if (first) return page.items;
                    const known = new Set(prev.map(item => item.id));
                    return [...page.items.filter(item => !known.has(item.id)), ...prev];
                });
                setState({ loading: false, loadingMore: false, hasMore: page.hasMore, error: undefined });
            })
            .catch(error => {
                if (mine !== generation.current) return;
                setState(s => ({ ...s, loading: false, loadingMore: false, error: error instanceof Error ? error.message : String(error) }));
            })
            .finally(() => { if (mine === generation.current) busy.current = false; });
    }, [loader, pageSize]);

    const reload = useCallback(() => {
        generation.current++;
        abort.current?.abort();
        busy.current = false;
        cursor.current = undefined;
        setItems([]);
        run(true);
    }, [run]);

    useEffect(() => {
        if (!enabled) return;
        reload();
        return () => { generation.current++; abort.current?.abort(); busy.current = false; };
    }, [enabled, reload]);

    const loadMore = useCallback(() => { if (state.hasMore && !busy.current) run(false); }, [state.hasMore, run]);
    return { items, ...state, loadMore, reload };
}
