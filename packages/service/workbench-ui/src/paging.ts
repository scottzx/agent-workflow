import { useEffect, useRef, useState } from 'preact/hooks';

export interface ChunkPage<T> {
    items: T[];
    total: number;
}

const PAGE_CAP = 200;

/**
 * Small pages for the first screen, then "load more". Polling refreshes only the rows already on screen,
 * and only while this view is the active one and the document is visible.
 */
export function useChunkedList<T>(options: {
    active: boolean;
    refreshKey: number;
    resetKey: string;
    pageSize: number;
    fetchPage: (offset: number, limit: number) => Promise<ChunkPage<T>>;
    idOf: (item: T) => string;
}) {
    const [items, setItems] = useState<T[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState('');
    const [settled, setSettled] = useState(false);
    const itemsRef = useRef<T[]>([]);
    const totalRef = useRef(0);
    const fetchRef = useRef(options.fetchPage);
    const idRef = useRef(options.idOf);
    const pageSizeRef = useRef(options.pageSize);
    const epoch = useRef(0);
    const busy = useRef(false);
    const moreLock = useRef(false);
    const resetKeyRef = useRef(options.resetKey);
    fetchRef.current = options.fetchPage;
    idRef.current = options.idOf;
    pageSizeRef.current = options.pageSize;

    // A filter change must not keep showing the previous slice for a frame.
    if (resetKeyRef.current !== options.resetKey) {
        resetKeyRef.current = options.resetKey;
        itemsRef.current = [];
        totalRef.current = 0;
        setItems([]);
        setTotal(0);
        setLoading(true);
        setSettled(false);
        setError('');
    }

    const commit = (mode: 'replace' | 'append', page: ChunkPage<T>) => {
        const idOf = idRef.current;
        let next = page.items;
        let nextTotal = page.total;
        if (mode === 'append') {
            const seen = new Set(itemsRef.current.map(idOf));
            const added = page.items.filter(item => !seen.has(idOf(item)));
            next = added.length ? [...itemsRef.current, ...added] : itemsRef.current;
            if (!added.length) nextTotal = next.length;
        }
        itemsRef.current = next;
        totalRef.current = nextTotal;
        setItems(next);
        setTotal(nextTotal);
    };

    const run = async (mode: 'replace' | 'append' | 'poll', generation: number) => {
        if (generation !== epoch.current) return;
        if (mode === 'poll' && (document.hidden || moreLock.current || busy.current)) return;
        if (mode !== 'poll' && busy.current) {
            if (mode === 'append') {
                moreLock.current = false;
                setLoadingMore(false);
            }
            return;
        }
        busy.current = true;
        const offset = mode === 'append' ? itemsRef.current.length : 0;
        const limit = mode === 'poll'
            ? Math.min(PAGE_CAP, Math.max(pageSizeRef.current, itemsRef.current.length || pageSizeRef.current))
            : pageSizeRef.current;
        try {
            const page = await fetchRef.current(offset, limit);
            if (generation !== epoch.current) return;
            commit(mode === 'append' ? 'append' : 'replace', page);
            setError('');
        } catch (err) {
            if (generation === epoch.current) setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (generation === epoch.current) {
                busy.current = false;
                setLoading(false);
                setLoadingMore(false);
                setSettled(true);
                if (mode === 'append') moreLock.current = false;
            }
        }
    };

    useEffect(() => {
        if (!options.active) return;
        const generation = ++epoch.current;
        setLoading(itemsRef.current.length === 0);
        void run('replace', generation);
        const timer = window.setInterval(() => void run('poll', epoch.current), 5000);
        const onVisible = () => {
            if (!document.hidden) void run('poll', epoch.current);
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            epoch.current += 1;
            busy.current = false;
            moreLock.current = false;
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
        // fetchPage is read from a ref so a new closure does not restart the poll.
    }, [options.active, options.resetKey, options.refreshKey]);

    const loadMore = () => {
        if (moreLock.current || busy.current || itemsRef.current.length >= totalRef.current) return;
        moreLock.current = true;
        setLoadingMore(true);
        void run('append', epoch.current);
    };

    const reload = () => {
        setLoading(itemsRef.current.length === 0);
        void run('replace', epoch.current);
    };

    return { items, total, loading, loadingMore, error, settled, loadMore, reload };
}

/** Starts another page when the sentinel scrolls into view. The button stays as a fallback. */
export function useLoadMoreSentinel(enabled: boolean, watch: number, onMore: () => void) {
    const ref = useRef<HTMLDivElement>(null);
    const onMoreRef = useRef(onMore);
    onMoreRef.current = onMore;
    useEffect(() => {
        const node = ref.current;
        if (!enabled || !node || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) onMoreRef.current();
        }, { rootMargin: '160px' });
        observer.observe(node);
        return () => observer.disconnect();
    }, [enabled, watch]);
    return ref;
}
