import type { Marked } from 'marked';
import { detectCodeLang, highlightToHtml } from './highlight.ts';

let parser: Promise<{ marked: Marked; purify: { sanitize(html: string, config?: object): string } }> | undefined;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function load() {
    const [{ Marked }, purifyModule] = await Promise.all([import('marked'), import('dompurify')]);
    const marked = new Marked({ gfm: true, breaks: false });
    // Code blocks leave a marker; highlighting happens on the sanitized DOM in renderMarkdown.
    marked.use({
        async: false,
        renderer: {
            code({ text, lang }) {
                const info = (lang || '').trim().split(/\s+/)[0] || '';
                if (info === 'mermaid') return `<div class="fp-mermaid" data-mermaid="${encodeURIComponent(text)}"><pre>${escapeHtml(text)}</pre></div>`;
                return `<pre class="fp-md-code"><code class="hljs" data-lang="${escapeHtml(info)}">${escapeHtml(text)}</code></pre>`;
            },
        },
    });
    const purify = (purifyModule.default as unknown as { sanitize(html: string, config?: object): string });
    return { marked, purify };
}

export interface RenderMarkdownOptions {
    /** Rewrite relative links/images (e.g. onto an artifact base URL). Return undefined to drop the URL. */
    resolveUrl?: (url: string, kind: 'link' | 'image') => string | undefined;
}

/**
 * Markdown → sanitized HTML. Output is DOMPurify-cleaned (no scripts, handlers or javascript: URLs),
 * and external links get rel="noopener noreferrer" target="_blank".
 */
export async function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): Promise<string> {
    parser ??= load();
    const { marked, purify } = await parser;
    const raw = marked.parse(source) as string;
    const doc = new DOMParser().parseFromString(purify.sanitize(raw, { ADD_ATTR: ['data-mermaid', 'data-lang'] }), 'text/html');
    for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const next = options.resolveUrl ? options.resolveUrl(href, 'link') : href;
        if (next === undefined) { a.removeAttribute('href'); continue; }
        a.setAttribute('href', next);
        if (/^(https?:)?\/\//i.test(next)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }
    }
    for (const img of doc.querySelectorAll('img[src]')) {
        const next = options.resolveUrl ? options.resolveUrl(img.getAttribute('src') || '', 'image') : img.getAttribute('src');
        if (next === undefined) img.remove(); else { img.setAttribute('src', next!); img.setAttribute('loading', 'lazy'); }
    }
    for (const code of doc.querySelectorAll<HTMLElement>('code.hljs[data-lang]')) {
        const lang = detectCodeLang(code.dataset.lang || '');
        if (lang) code.innerHTML = await highlightToHtml(code.textContent || '', lang);
    }
    return doc.body.innerHTML;
}
