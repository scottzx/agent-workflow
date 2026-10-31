import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { formatToolOutput } from './formatToolOutput.ts';
import { lineDiff } from './diff.ts';
import { Markdown } from './Markdown.tsx';
import type { ChatItem, ToolCallInfo } from './types.ts';

export interface ChatLabels {
    empty: string; loading: string; loadEarlier: string; loadingEarlier: string; retry: string; thinking: string;
    input: string; output: string; showMore: string; allowed: string; denied: string; waiting: string; plan: string; you: string; agent: string;
}
const defaultLabels: ChatLabels = {
    empty: 'No messages yet', loading: 'Loading messages…', loadEarlier: 'Load earlier messages', loadingEarlier: 'Loading…', retry: 'Retry',
    thinking: 'Thinking', input: 'Input', output: 'Output', showMore: 'Show all', allowed: 'Allowed', denied: 'Denied', waiting: 'Waiting for an answer',
    plan: 'Plan', you: 'You', agent: 'Agent',
};

export interface ChatViewProps {
    items: ChatItem[];
    theme?: 'light' | 'dark';
    loading?: boolean;
    loadingMore?: boolean;
    hasMore?: boolean;
    error?: string;
    /** Called when the top of the list nears the viewport, or the load-earlier button is pressed. */
    onLoadMore?: () => void;
    onRetry?: () => void;
    /** A file path in a message, tool card or link was activated. */
    onOpenFile?: (path: string, line?: number) => void;
    /** Keep the newest message in view as items grow (default true while the user is near the bottom). */
    /** Draw ```mermaid blocks (default true); turn off under a strict CSP. */
    diagrams?: boolean;
    stickToBottom?: boolean;
    labels?: Partial<ChatLabels>;
    class?: string;
}

const OUTPUT_LIMIT = 4000;

function Collapsible({ label, children, open }: { label: string; children: ComponentChildren; open?: boolean }) {
    return (
        <details class="cv-fold" open={open}>
            <summary>{label}</summary>
            {children}
        </details>
    );
}

function Text({ text, limit, labels }: { text: string; limit: number; labels: ChatLabels }) {
    const [all, setAll] = useState(false);
    const cut = !all && text.length > limit;
    return (
        <>
            <pre class="cv-pre">{cut ? text.slice(0, limit) : text}</pre>
            {cut && <button type="button" class="cv-link" onClick={() => setAll(true)}>{labels.showMore}</button>}
        </>
    );
}

function Diff({ path, oldText, newText, onOpenFile }: { path: string; oldText?: string; newText: string; onOpenFile?: (p: string) => void }) {
    const lines = lineDiff(oldText, newText);
    return (
        <div class="cv-diff">
            <button type="button" class="cv-link cv-diff-path" onClick={() => onOpenFile?.(path)}>{path}</button>
            <pre class="cv-pre">
                {lines.map((line, i) => (
                    <div key={i} class={`cv-diff-${line.type}`}>{line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}{line.text}</div>
                ))}
            </pre>
        </div>
    );
}

function statusOf(call: ToolCallInfo): 'running' | 'failed' | 'done' {
    if (call.isError || call.status === 'failed') return 'failed';
    if (call.status === 'pending' || call.status === 'in_progress' || (call.status === undefined && call.output === undefined)) return 'running';
    return 'done';
}

function ToolCall({ call, labels, onOpenFile }: { call: ToolCallInfo; labels: ChatLabels; onOpenFile?: (path: string, line?: number) => void }) {
    const status = statusOf(call);
    const output = call.output === undefined ? undefined : formatToolOutput(call.output);
    return (
        <div class={`cv-tool cv-tool-${status}`}>
            <div class="cv-tool-head">
                <span class="cv-dot" aria-hidden="true" />
                <strong>{call.toolName}</strong>
                {call.kind && <span class="cv-tag">{call.kind}</span>}
                {call.locations?.map(loc => (
                    <button type="button" class="cv-chip" key={`${loc.path}:${loc.line ?? ''}`} onClick={() => onOpenFile?.(loc.path, loc.line)}>
                        {loc.path.split('/').pop()}{loc.line ? `:${loc.line}` : ''}
                    </button>
                ))}
            </div>
            {call.diffs?.map((diff, i) => <Diff key={i} {...diff} onOpenFile={onOpenFile} />)}
            {call.input && call.input !== '{}' && (
                <Collapsible label={labels.input}><Text text={call.input} limit={OUTPUT_LIMIT} labels={labels} /></Collapsible>
            )}
            {output !== undefined && output !== '' && (
                <Collapsible label={labels.output}><Text text={output} limit={OUTPUT_LIMIT} labels={labels} /></Collapsible>
            )}
            {call.permission && (
                <p class="cv-note">{call.permission.resolved === 'allow' ? labels.allowed : call.permission.resolved === 'deny' ? labels.denied : labels.waiting}</p>
            )}
        </div>
    );
}

function Row({ item, results, theme, labels, onOpenFile, diagrams }: {
    diagrams: boolean;
    item: ChatItem; results: Map<string, ChatItem & { kind: 'tool_result' }>; theme: 'light' | 'dark'; labels: ChatLabels; onOpenFile?: (path: string, line?: number) => void;
}) {
    switch (item.kind) {
        case 'user':
            return <div class="cv-row cv-user"><div class="cv-bubble"><Text text={item.content} limit={20000} labels={labels} /></div></div>;
        case 'assistant_text':
            return <div class="cv-row cv-agent"><Markdown diagrams={diagrams} text={item.content} theme={theme} streaming={item.streaming} onOpenFile={onOpenFile} /></div>;
        case 'thinking':
            return <div class="cv-row"><Collapsible label={labels.thinking}><Text text={item.content} limit={OUTPUT_LIMIT} labels={labels} /></Collapsible></div>;
        case 'tool_use': {
            const calls = item.calls.length ? item.calls : [{ toolName: item.toolName, input: item.input, toolCallId: item.toolCallId }];
            return (
                <div class="cv-row">
                    {calls.map((call, i) => {
                        const result = call.output === undefined && call.toolCallId ? results.get(call.toolCallId) : undefined;
                        const merged = result ? { ...call, output: result.content, isError: result.isError } : call;
                        return <ToolCall key={call.id || call.toolCallId || i} call={merged} labels={labels} onOpenFile={onOpenFile} />;
                    })}
                </div>
            );
        }
        case 'tool_result':
            return (
                <div class="cv-row">
                    <ToolCall call={{ toolName: item.toolName || 'tool', input: '', output: item.content, isError: item.isError }} labels={labels} onOpenFile={onOpenFile} />
                </div>
            );
        case 'permission_request':
            return (
                <div class="cv-row"><div class="cv-tool">
                    <div class="cv-tool-head"><strong>{item.toolName}</strong></div>
                    <p class="cv-note">{item.resolved === 'allow' ? labels.allowed : item.resolved === 'deny' ? labels.denied : labels.waiting}</p>
                </div></div>
            );
        case 'ask_user_question':
            return (
                <div class="cv-row"><div class="cv-tool">
                    {item.questions.map((q, i) => (
                        <div key={i}>
                            <strong>{q.header ? `${q.header} · ` : ''}{q.question}</strong>
                            {q.options && <ul class="cv-options">{q.options.map(o => <li key={o.label}>{o.label}{o.description ? ` — ${o.description}` : ''}</li>)}</ul>}
                        </div>
                    ))}
                    {item.resolved === undefined && <p class="cv-note">{labels.waiting}</p>}
                </div></div>
            );
        case 'exit_plan_mode':
            return <div class="cv-row"><Collapsible label={labels.plan} open><Markdown diagrams={diagrams} text={item.planContent} theme={theme} onOpenFile={onOpenFile} /></Collapsible></div>;
        case 'error':
            return <div class="cv-row"><p class="cv-error" role="alert">{item.content}</p></div>;
        case 'turn_receipt':
            return <div class="cv-row"><p class={`cv-receipt cv-receipt-${item.status}`}>{item.content}</p></div>;
        case 'subagent_turn':
            return (
                <div class="cv-row"><Collapsible label={item.label}>
                    {item.thinking && <Text text={item.thinking} limit={OUTPUT_LIMIT} labels={labels} />}
                    {item.calls.map((call, i) => <ToolCall key={i} call={call} labels={labels} onOpenFile={onOpenFile} />)}
                    {item.output && <Markdown diagrams={diagrams} text={item.output} theme={theme} streaming={item.streaming} onOpenFile={onOpenFile} />}
                </Collapsible></div>
            );
        default:
            return null;
    }
}

/**
 * Read-only transcript. It renders whatever items it is given and asks for older ones through
 * onLoadMore when the top comes into view, keeping the viewport still while they are prepended.
 */
export function ChatView(props: ChatViewProps) {
    const labels = { ...defaultLabels, ...props.labels };
    const theme = props.theme ?? (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const scroller = useRef<HTMLDivElement>(null);
    const top = useRef<HTMLDivElement>(null);
    const nearBottom = useRef(true);
    const previous = useRef({ height: 0, firstId: '', count: 0 });

    // Results that arrived as separate items are folded into their tool card.
    const results = new Map<string, ChatItem & { kind: 'tool_result' }>();
    for (const item of props.items) if (item.kind === 'tool_result' && item.toolCallId) results.set(item.toolCallId, item);
    const merged = new Set(props.items.flatMap(item => item.kind === 'tool_use' ? item.calls.filter(c => c.output === undefined && c.toolCallId && results.has(c.toolCallId)).map(c => c.toolCallId!) : []));
    const visible = props.items.filter(item => !(item.kind === 'tool_result' && item.toolCallId && merged.has(item.toolCallId)));

    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const before = previous.current;
        const prepended = before.firstId !== '' && props.items.length > before.count && props.items[0]?.id !== before.firstId;
        if (prepended) el.scrollTop += el.scrollHeight - before.height;
        else if ((props.stickToBottom ?? true) && nearBottom.current) el.scrollTop = el.scrollHeight;
        previous.current = { height: el.scrollHeight, firstId: props.items[0]?.id ?? '', count: props.items.length };
    }, [props.items]);

    useEffect(() => {
        const target = top.current, root = scroller.current;
        if (!target || !root || !props.hasMore || props.loadingMore || !props.onLoadMore || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) props.onLoadMore?.(); }, { root, rootMargin: '200px 0px 0px 0px' });
        observer.observe(target);
        return () => observer.disconnect();
    }, [props.hasMore, props.loadingMore, props.onLoadMore, props.items.length]);

    return (
        <div
            ref={scroller}
            class={`cv-root${props.class ? ` ${props.class}` : ''}`}
            data-fp-theme={theme}
            onScroll={event => {
                const el = event.currentTarget as HTMLElement;
                nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
        >
            <div ref={top} />
            {props.hasMore && (
                <button type="button" class="cv-more" disabled={props.loadingMore} onClick={props.onLoadMore}>
                    {props.loadingMore ? labels.loadingEarlier : labels.loadEarlier}
                </button>
            )}
            {props.loading && <p class="cv-note" role="status">{labels.loading}</p>}
            {props.error && (
                <p class="cv-error" role="alert">
                    {props.error} {props.onRetry && <button type="button" class="cv-link" onClick={props.onRetry}>{labels.retry}</button>}
                </p>
            )}
            {!props.loading && !props.error && visible.length === 0 && <p class="cv-note">{labels.empty}</p>}
            {visible.map(item => <Row key={item.id} item={item} results={results} theme={theme} labels={labels} onOpenFile={props.onOpenFile} diagrams={props.diagrams ?? true} />)}
        </div>
    );
}
