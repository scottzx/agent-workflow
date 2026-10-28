import { extensionOf } from './kinds.ts';

type Hljs = typeof import('highlight.js/lib/core').default;

const LANGS: Record<string, () => Promise<{ default: unknown }>> = {
    json: () => import('highlight.js/lib/languages/json'),
    bash: () => import('highlight.js/lib/languages/bash'),
    python: () => import('highlight.js/lib/languages/python'),
    javascript: () => import('highlight.js/lib/languages/javascript'),
    typescript: () => import('highlight.js/lib/languages/typescript'),
    xml: () => import('highlight.js/lib/languages/xml'),
    css: () => import('highlight.js/lib/languages/css'),
    scss: () => import('highlight.js/lib/languages/scss'),
    yaml: () => import('highlight.js/lib/languages/yaml'),
    go: () => import('highlight.js/lib/languages/go'),
    rust: () => import('highlight.js/lib/languages/rust'),
    cpp: () => import('highlight.js/lib/languages/cpp'),
    c: () => import('highlight.js/lib/languages/c'),
    ini: () => import('highlight.js/lib/languages/ini'),
    sql: () => import('highlight.js/lib/languages/sql'),
    dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
    markdown: () => import('highlight.js/lib/languages/markdown'),
    diff: () => import('highlight.js/lib/languages/diff'),
    java: () => import('highlight.js/lib/languages/java'),
    ruby: () => import('highlight.js/lib/languages/ruby'),
    php: () => import('highlight.js/lib/languages/php'),
};

const ALIASES: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', sh: 'bash', zsh: 'bash', shell: 'bash', yml: 'yaml', toml: 'ini', conf: 'ini', html: 'xml', htm: 'xml',
    rs: 'rust', rb: 'ruby', h: 'c', hpp: 'cpp', jsonc: 'json', patch: 'diff', md: 'markdown', jsonl: 'json', ndjson: 'json',
};

/** Language id for a file name or a fenced-code info string; undefined when we cannot highlight it. */
export function detectCodeLang(nameOrLang: string): string | undefined {
    const raw = nameOrLang.includes('.') || nameOrLang.includes('/') ? extensionOf(nameOrLang) : nameOrLang.toLowerCase();
    const lang = ALIASES[raw] || raw;
    return Object.hasOwn(LANGS, lang) ? lang : undefined;
}

let core: Promise<Hljs> | undefined;
const loaded = new Map<string, Promise<void>>();

async function engine(lang: string): Promise<Hljs> {
    core ??= import('highlight.js/lib/core').then(mod => mod.default);
    const hljs = await core;
    if (!loaded.has(lang)) loaded.set(lang, LANGS[lang]!().then(mod => hljs.registerLanguage(lang, mod.default as never)));
    await loaded.get(lang);
    return hljs;
}

/**
 * Highlight source into one HTML string per line, so a gutter can sit beside it. Spans that cross a
 * newline are closed and reopened so every line is self-contained markup.
 */
export async function highlightToLines(source: string, lang: string | undefined): Promise<string[]> {
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (!lang || !Object.hasOwn(LANGS, lang)) return source.split('\n').map(escape);
    const hljs = await engine(lang);
    const html = hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
    const lines: string[] = [];
    let open: string[] = [];
    for (const raw of html.split('\n')) {
        let line = open.join('') + raw;
        const re = /<span[^>]*>|<\/span>/g;
        let match: RegExpExecArray | null;
        const stack = [...open];
        while ((match = re.exec(raw))) {
            if (match[0] === '</span>') stack.pop(); else stack.push(match[0]);
        }
        line += '</span>'.repeat(stack.length);
        open = stack;
        lines.push(line);
    }
    return lines;
}

/** Highlight a fenced block to HTML (used by markdown). Falls back to escaped text. */
export async function highlightToHtml(source: string, lang: string | undefined): Promise<string> {
    return (await highlightToLines(source, lang)).join('\n');
}
