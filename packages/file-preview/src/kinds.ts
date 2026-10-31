export type PreviewKind =
    | 'markdown'
    | 'code'
    | 'json'
    | 'csv'
    | 'image'
    | 'video'
    | 'audio'
    | 'pdf'
    | 'html'
    | 'text'
    | 'unsupported';

const EXT: Record<string, PreviewKind> = {
    md: 'markdown', markdown: 'markdown', mdx: 'markdown',
    json: 'json', jsonc: 'json', jsonl: 'code', ndjson: 'code',
    csv: 'csv', tsv: 'csv',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', ico: 'image', bmp: 'image', avif: 'image',
    mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
    mp3: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio', oga: 'audio', ogg: 'audio',
    pdf: 'pdf',
    html: 'html', htm: 'html',
    txt: 'text', log: 'text',
    js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', css: 'code', scss: 'code', py: 'code', go: 'code',
    rs: 'code', c: 'code', h: 'code', cpp: 'code', hpp: 'code', java: 'code', rb: 'code', php: 'code', sh: 'code', bash: 'code',
    zsh: 'code', yaml: 'code', yml: 'code', toml: 'code', ini: 'code', xml: 'code', sql: 'code', diff: 'code', patch: 'code',
    dockerfile: 'code', env: 'text', conf: 'text',
    doc: 'unsupported', docx: 'unsupported', xls: 'unsupported', xlsx: 'unsupported', ppt: 'unsupported', pptx: 'unsupported',
    zip: 'unsupported', gz: 'unsupported', tar: 'unsupported', bin: 'unsupported',
};

const MEDIA_PREFIX: [string, PreviewKind][] = [
    ['image/', 'image'], ['video/', 'video'], ['audio/', 'audio'],
    ['application/pdf', 'pdf'], ['text/html', 'html'], ['text/markdown', 'markdown'], ['text/csv', 'csv'],
    ['application/json', 'json'], ['text/', 'text'],
];

export const extensionOf = (name: string): string => {
    const base = name.split(/[\\/]/).pop() || name;
    const dot = base.lastIndexOf('.');
    return dot > 0 || (dot === 0 && base.length > 1) ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
};

/** Pick a renderer from the file name first, then the media type; unknown → unsupported. */
export function detectPreviewKind(name: string, mediaType?: string): PreviewKind {
    const byExt = EXT[extensionOf(name)];
    if (byExt) return byExt;
    const type = (mediaType || '').toLowerCase().split(';')[0]!.trim();
    for (const [prefix, kind] of MEDIA_PREFIX) if (type.startsWith(prefix)) return kind;
    return 'unsupported';
}

/** Kinds whose bytes are read as text; the rest are handed to the browser by URL. */
export const isTextKind = (kind: PreviewKind): boolean =>
    kind === 'markdown' || kind === 'code' || kind === 'json' || kind === 'csv' || kind === 'text';

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
