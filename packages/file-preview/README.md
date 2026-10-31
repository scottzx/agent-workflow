# @1agents/file-preview

Preact component that previews one file: Markdown, code, JSON, CSV/TSV, images, audio, video, PDF and HTML.
Text renderers (marked, DOMPurify, highlight.js, mermaid) are loaded with dynamic `import()`, so a page that
never previews a file pays nothing for them.

```tsx
import { FilePreview } from '@1agents/file-preview';
import '@1agents/file-preview/style.css';

<FilePreview name="report.md" url="/files/report.md" />
<FilePreview name="data.csv" content={csvText} />
```

If your bundler cannot import CSS, copy `dist/style.css` into your own stylesheet.

## Props

| prop | meaning |
| --- | --- |
| `name` | File name; its extension chooses the renderer (`detectPreviewKind`). |
| `url` / `content` | Where to read the bytes, or text you already hold. Text kinds fetch `url` with same-origin credentials unless you pass `fetcher`. |
| `mediaType`, `size`, `path` | Optional hints shown in the header / used when the extension is unknown. |
| `theme` | `'light' \| 'dark'`; defaults to `prefers-color-scheme`. |
| `diagrams` | Draw ` ```mermaid ` blocks (default `true`). Mermaid needs inline styles; turn it off under a strict CSP. |
| `maxTextBytes` | Text beyond this (default 2 MiB) is cut with a notice. |
| `targetLine` | Scroll to and highlight a 1-based line in the code view. |
| `hideHeader`, `labels`, `markdown`, `onOpenLink` | Embedding and localisation. |

## Safety

* Markdown is sanitized with DOMPurify; external links get `rel="noopener noreferrer"`.
* HTML files render in a fully sandboxed iframe (no scripts, no same-origin).
* Only `http:`, `https:` and `blob:` URLs are loaded.

## Other exports

`renderMarkdown`, `highlightToLines`, `highlightToHtml`, `detectCodeLang`, `renderMermaidBlocks`, `parseDelimited`,
`detectPreviewKind`, `isTextKind`, `formatBytes`.

Office files (docx/xlsx/pptx) and archives show an "open" link instead of a preview.

Requires `preact@^10` as a peer dependency.
