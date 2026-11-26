import { type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { text } from './ui';

const pending = new Map<string, Promise<unknown>>();

/** Loads a split chunk once. A failed load is forgotten so Retry can ask for it again. */
export function preload<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = pending.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const next = load().catch(error => {
        pending.delete(key);
        throw error;
    });
    pending.set(key, next);
    return next;
}

export function dropPreload(key: string) {
    pending.delete(key);
}

/** Hover or keyboard focus starts the chunk download before the click. */
export function preloadProps(key: string, load: () => Promise<unknown>) {
    const start = () => {
        void preload(key, load).catch(() => undefined);
    };
    return { onMouseEnter: start, onFocus: start };
}

export function Skeleton({ lines = 5 }: { lines?: number }) {
    return (
        <div class="acp-skeleton" role="status" aria-live="polite" aria-busy="true">
            <span class="acp-sr">{text('正在加载…', 'Loading…')}</span>
            {Array.from({ length: lines }, (_, index) => (
                <span key={index} class="acp-skeleton-bar" style={{ width: `${92 - (index % 3) * 14}%` }} />
            ))}
        </div>
    );
}

/**
 * Shows a skeleton while a dynamic import is in flight, and a retryable error if it fails.
 * `cacheKey` is the contract: the loader itself is not a hook dependency.
 */
export function LazyView<T>({
    cacheKey,
    load,
    children,
    lines,
}: {
    cacheKey: string;
    load: () => Promise<T>;
    children: (loaded: T) => ComponentChildren;
    lines?: number;
}) {
    const [attempt, setAttempt] = useState(0);
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
    const [value, setValue] = useState<T | undefined>(undefined);
    const [error, setError] = useState('');

    useEffect(() => {
        let live = true;
        setPhase('loading');
        setError('');
        preload(cacheKey, load)
            .then(next => {
                if (!live) return;
                setValue(next);
                setPhase('ready');
            })
            .catch(err => {
                if (!live) return;
                setError(err instanceof Error ? err.message : String(err));
                setPhase('error');
            });
        return () => {
            live = false;
        };
        // The loader closes over module scope; retry bumps `attempt`.
    }, [cacheKey, attempt]);

    if (phase === 'error') {
        return (
            <div class="acp-error" role="alert">
                <strong>{text('这一块没有载入', 'This part did not load')}</strong>
                <p>{error || text('网络或脚本加载失败。', 'The script failed to load.')}</p>
                <button
                    type="button"
                    class="acp-button"
                    onClick={() => {
                        dropPreload(cacheKey);
                        setAttempt(count => count + 1);
                    }}
                >
                    {text('重试', 'Retry')}
                </button>
            </div>
        );
    }
    if (phase !== 'ready' || value === undefined) return <Skeleton lines={lines} />;
    return <>{children(value)}</>;
}
