import { useEffect, useRef, useState } from 'preact/hooks';
import { renderMarkdown, renderMermaidBlocks } from '@1agents/file-preview';

/** Sanitized markdown. Local (non-http) links are routed to onOpenFile instead of navigating. */
export function Markdown({ text, theme, onOpenFile, streaming, diagrams = true }: { text: string; theme: 'light' | 'dark'; onOpenFile?: (path: string, line?: number) => void; streaming?: boolean; diagrams?: boolean }) {
    const [html, setHtml] = useState('');
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let live = true;
        renderMarkdown(text).then(next => live && setHtml(next)).catch(() => live && setHtml(''));
        return () => { live = false; };
    }, [text]);
    // A half-streamed diagram is a parse error, so draw diagrams only once the text is final.
    useEffect(() => { if (diagrams && html && !streaming && ref.current) void renderMermaidBlocks(ref.current, theme); }, [html, streaming, theme, diagrams]);
    return (
        <div
            ref={ref}
            class="fp-md cv-md"
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={event => {
                const href = (event.target as HTMLElement).closest('a')?.getAttribute('href');
                if (!href || /^(https?:|mailto:|#)/i.test(href) || !onOpenFile) return;
                event.preventDefault();
                const match = /^(.*?)(?::(\d+))?$/.exec(decodeURIComponent(href.split('#')[0]!));
                onOpenFile(match?.[1] || href, match?.[2] ? Number(match[2]) : undefined);
            }}
        />
    );
}
