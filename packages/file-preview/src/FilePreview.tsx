import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { parseDelimited } from './csv.ts';
import { detectCodeLang, highlightToLines } from './highlight.ts';
import { detectPreviewKind, formatBytes, isTextKind, type PreviewKind } from './kinds.ts';
import { renderMarkdown, type RenderMarkdownOptions } from './markdown.ts';
import { renderMermaidBlocks } from './mermaid.ts';

export interface FilePreviewProps {
    /** File name; the extension chooses the renderer. */
    name: string;
    /** Shown in the header when it differs from the name. */
    path?: string;
    /** Where the browser can read the bytes. Required unless `content` is given. */
    url?: string;
    /** Text content you already hold; skips fetching for text kinds. */
    content?: string;
    mediaType?: string;
    size?: number;
    theme?: 'light' | 'dark';
    /** Text bigger than this is cut off with a notice (default 2 MiB). */
    maxTextBytes?: number;
    /** Custom fetch, e.g. to add auth headers. Defaults to same-origin credentials. */
    fetcher?: (url: string) => Promise<Response>;
    /** Hide the name/size header, for embedding in a panel that already has one. */
    hideHeader?: boolean;
    /** Scroll to and highlight this 1-based line in the code view. */
    targetLine?: number;
    onOpenLink?: (href: string) => void;
    /** Draw ```mermaid blocks (default true). Diagrams need inline styles, so turn this off under a strict CSP. */
    diagrams?: boolean;
    markdown?: RenderMarkdownOptions;
    labels?: Partial<PreviewLabels>;
    class?: string;
}

export interface PreviewLabels {
    loading: string;
    failed: string;
    open: string;
    unsupported: string;
    truncated: string;
    noSource: string;
    empty: string;
}

const defaultLabels: PreviewLabels = {
    loading: 'Loading…',
    failed: 'Could not load this file',
    open: 'Open in new tab',
    unsupported: 'No preview for this file type',
    truncated: 'Showing the first part of a large file',
    noSource: 'This file has no readable location',
    empty: 'Empty file',
};

const DEFAULT_MAX = 2 * 1024 * 1024;

/** True for URLs the browser may load as a document/media source. */
export function isSafeUrl(url: string): boolean {
    try {
        const parsed = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'blob:') && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

type TextState = { status: 'idle' | 'loading' } | { status: 'ready'; text: string; truncated: boolean } | { status: 'error'; message: string };

function useText(kind: PreviewKind, url: string | undefined, content: string | undefined, max: number, fetcher?: (url: string) => Promise<Response>): TextState {
    const [state, setState] = useState<TextState>({ status: 'idle' });
    useEffect(() => {
        if (!isTextKind(kind)) return setState({ status: 'idle' });
        if (content !== undefined) {
            const cut = content.length > max;
            return setState({ status: 'ready', text: cut ? content.slice(0, max) : content, truncated: cut });
        }
        if (!url || !isSafeUrl(url)) return setState({ status: 'error', message: '' });
        const controller = new AbortController();
        setState({ status: 'loading' });
        (async () => {
            const response = await (fetcher ? fetcher(url) : fetch(url, { credentials: 'same-origin', signal: controller.signal }));
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
            const buffer = await response.arrayBuffer();
            const cut = buffer.byteLength > max;
            setState({ status: 'ready', text: new TextDecoder().decode(cut ? buffer.slice(0, max) : buffer), truncated: cut });
        })().catch(error => {
            if (!controller.signal.aborted) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
        });
        return () => controller.abort();
    }, [kind, url, content, max, fetcher]);
    return state;
}

function resolveTheme(theme?: 'light' | 'dark'): 'light' | 'dark' {
    if (theme) return theme;
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function MarkdownBody({ text, theme, options, onOpenLink, diagrams }: { text: string; theme: 'light' | 'dark'; options?: RenderMarkdownOptions; onOpenLink?: (href: string) => void; diagrams: boolean }) {
    const [html, setHtml] = useState('');
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let live = true;
        renderMarkdown(text, options).then(next => live && setHtml(next)).catch(() => live && setHtml(''));
        return () => { live = false; };
    }, [text, options]);
    useEffect(() => {
        if (diagrams && html && ref.current) void renderMermaidBlocks(ref.current, theme);
    }, [html, theme, diagrams]);
    return (
        <div
            ref={ref}
            class="fp-md"
            // Sanitized by DOMPurify in renderMarkdown.
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={event => {
                const link = (event.target as HTMLElement).closest('a');
                const href = link?.getAttribute('href');
                if (!link || !href) return;
                if (href.startsWith('#')) {
                    event.preventDefault();
                    const id = decodeURIComponent(href.slice(1));
                    ref.current?.querySelector(`[id="${id.replace(/"/g, '\\"')}"]`)?.scrollIntoView({ behavior: 'smooth' });
                } else if (onOpenLink) {
                    event.preventDefault();
                    onOpenLink(href);
                }
            }}
        />
    );
}

function CodeBody({ text, lang, targetLine }: { text: string; lang?: string; targetLine?: number }) {
    const [lines, setLines] = useState<string[] | null>(null);
    const target = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let live = true;
        setLines(null);
        highlightToLines(text, lang).then(next => live && setLines(next)).catch(() => live && setLines(text.split('\n')));
        return () => { live = false; };
    }, [text, lang]);
    useEffect(() => { if (lines && targetLine) target.current?.scrollIntoView({ block: 'center' }); }, [lines, targetLine]);
    const plain = useMemo(() => text.split('\n'), [text]);
    const rows = lines ?? plain;
    return (
        <div class="fp-code" role="region" aria-label="code">
            {rows.map((html, index) => (
                <div key={index} ref={targetLine === index + 1 ? target : undefined} class={`fp-code-row${targetLine === index + 1 ? ' fp-code-target' : ''}`}>
                    <span class="fp-code-no">{index + 1}</span>
                    {lines ? (
                        <span class="fp-code-text hljs" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                    ) : (
                        <span class="fp-code-text">{html || ' '}</span>
                    )}
                </div>
            ))}
        </div>
    );
}

function CsvBody({ text, delimiter }: { text: string; delimiter: string }) {
    const { rows, truncated } = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
    if (!rows.length) return null;
    const [head, ...body] = rows;
    return (
        <div class="fp-table-wrap">
            <table class="fp-table">
                <thead>
                    <tr>{head!.map((cell, i) => <th key={i}>{cell}</th>)}</tr>
                </thead>
                <tbody>
                    {body.map((row, r) => (
                        <tr key={r}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>
                    ))}
                </tbody>
            </table>
            {truncated && <p class="fp-note">{`Showing the first ${rows.length} rows`}</p>}
        </div>
    );
}

function prettyJson(text: string): string {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/**
 * Previews one file. Text kinds (markdown, code, JSON, CSV) are fetched and rendered here with lazily
 * loaded engines; images, audio, video, PDF and HTML are handed to the browser by URL (HTML in a
 * script-less sandbox). Anything else shows a notice and an open link.
 */
export function FilePreview(props: FilePreviewProps) {
    const [mediaFailed, setMediaFailed] = useState(false);
    useEffect(() => setMediaFailed(false), [props.url]);
    const labels = { ...defaultLabels, ...props.labels };
    const kind = detectPreviewKind(props.name, props.mediaType);
    const theme = resolveTheme(props.theme);
    const url = props.url && isSafeUrl(props.url) ? props.url : undefined;
    const state = useText(kind, url, props.content, props.maxTextBytes ?? DEFAULT_MAX, props.fetcher);
    let body: VNode | null;
    if (isTextKind(kind)) {
        if (state.status === 'error') body = <p class="fp-note fp-error" role="alert">{state.message || labels.noSource}{state.message ? ` · ${labels.failed}` : ''}</p>;
        else if (state.status !== 'ready') body = <p class="fp-note" role="status">{labels.loading}</p>;
        else if (!state.text.trim()) body = <p class="fp-note">{labels.empty}</p>;
        else {
            const text = kind === 'json' ? prettyJson(state.text) : state.text;
            body = (
                <>
                    {kind === 'markdown' ? (
                        <MarkdownBody text={text} theme={theme} options={props.markdown} onOpenLink={props.onOpenLink} diagrams={props.diagrams ?? true} />
                    ) : kind === 'csv' ? (
                        <CsvBody text={text} delimiter={props.name.toLowerCase().endsWith('.tsv') ? '\t' : ','} />
                    ) : (
                        <CodeBody text={text} lang={kind === 'json' ? 'json' : kind === 'text' ? undefined : detectCodeLang(props.name)} targetLine={props.targetLine} />
                    )}
                    {state.truncated && <p class="fp-note">{labels.truncated}</p>}
                </>
            );
        }
    } else if (!url) {
        body = <p class="fp-note">{kind === 'unsupported' ? labels.unsupported : labels.noSource}</p>;
    } else if (mediaFailed && (kind === 'image' || kind === 'video' || kind === 'audio')) {
        body = <p class="fp-note fp-error" role="alert">{labels.failed}</p>;
    } else if (kind === 'image') {
        body = <div class="fp-media"><img src={url} alt={props.name} loading="lazy" onError={() => setMediaFailed(true)} /></div>;
    } else if (kind === 'video') {
        body = <div class="fp-media"><video src={url} controls preload="metadata" onError={() => setMediaFailed(true)} /></div>;
    } else if (kind === 'audio') {
        body = <div class="fp-media"><audio src={url} controls preload="metadata" onError={() => setMediaFailed(true)} /></div>;
    } else if (kind === 'pdf') {
        body = <iframe class="fp-frame" src={url} title={props.name} />;
    } else if (kind === 'html') {
        // No allow-scripts and no allow-same-origin: agent-made pages render but cannot run code.
        body = <iframe class="fp-frame" src={url} title={props.name} sandbox="" referrerpolicy="no-referrer" />;
    } else {
        body = <p class="fp-note">{labels.unsupported}</p>;
    }
    return (
        <section class={`fp-root${props.class ? ` ${props.class}` : ''}`} data-fp-theme={theme} data-fp-kind={kind}>
            {!props.hideHeader && (
                <header class="fp-header">
                    <strong class="fp-name" title={props.path || props.name}>{props.name}</strong>
                    {props.size !== undefined && <span class="fp-size">{formatBytes(props.size)}</span>}
                    {url && <a class="fp-open" href={url} target="_blank" rel="noopener noreferrer">{labels.open}</a>}
                </header>
            )}
            <div class="fp-body">{body}</div>
        </section>
    );
}
