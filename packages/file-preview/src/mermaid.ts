type MermaidApi = {
    initialize(config: Record<string, unknown>): void;
    render(id: string, src: string): Promise<{ svg: string }>;
};

let api: Promise<MermaidApi> | undefined;
let initializedTheme: string | undefined;
let sequence = 0;

/**
 * Draw every `.fp-mermaid[data-mermaid]` placeholder under root. The mermaid library is only fetched
 * when a diagram exists. Blocks remember the theme they were drawn with so a toggle redraws them.
 */
export async function renderMermaidBlocks(root: ParentNode, theme: 'light' | 'dark' = 'light'): Promise<void> {
    const blocks = [...root.querySelectorAll<HTMLElement>('.fp-mermaid[data-mermaid]')].filter(el => el.dataset.drawnTheme !== theme);
    if (!blocks.length) return;
    api ??= import('mermaid').then(mod => mod.default as unknown as MermaidApi);
    const mermaid = await api;
    if (initializedTheme !== theme) {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default' });
        initializedTheme = theme;
    }
    for (const block of blocks) {
        let source = '';
        try { source = decodeURIComponent(block.dataset.mermaid || ''); } catch { continue; }
        try {
            const { svg } = await mermaid.render(`fp-mermaid-${++sequence}`, source);
            block.innerHTML = svg;
            block.dataset.drawnTheme = theme;
        } catch {
            block.classList.add('fp-mermaid-error');
            block.textContent = source;
            block.dataset.drawnTheme = theme;
        }
    }
}
