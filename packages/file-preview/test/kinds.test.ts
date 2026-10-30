import assert from 'node:assert/strict';
import test from 'node:test';
import { detectCodeLang, detectPreviewKind, formatBytes, highlightToLines, parseDelimited } from '../src/index.ts';

test('detects the renderer from the extension first, then the media type', () => {
    assert.equal(detectPreviewKind('report.md'), 'markdown');
    assert.equal(detectPreviewKind('/a/b/App.TSX'), 'code');
    assert.equal(detectPreviewKind('data.csv'), 'csv');
    assert.equal(detectPreviewKind('slides.pptx'), 'unsupported');
    assert.equal(detectPreviewKind('Dockerfile'), 'code');
    assert.equal(detectPreviewKind('blob', 'image/png'), 'image');
    assert.equal(detectPreviewKind('blob', 'application/pdf; charset=binary'), 'pdf');
    assert.equal(detectPreviewKind('blob'), 'unsupported');
});

test('code language aliases cover file names and fence info strings', () => {
    assert.equal(detectCodeLang('main.py'), 'python');
    assert.equal(detectCodeLang('ts'), 'typescript');
    assert.equal(detectCodeLang('x.unknown'), undefined);
});

test('csv parser handles quotes, doubled quotes, CRLF and a cap', () => {
    assert.deepEqual(parseDelimited('a,b\r\n"x,1","he said ""hi"""\n').rows, [['a', 'b'], ['x,1', 'he said "hi"']]);
    const capped = parseDelimited('1\n2\n3\n4\n', ',', 2);
    assert.equal(capped.rows.length, 2);
    assert.equal(capped.truncated, true);
});

test('highlighted lines stay balanced when a span crosses a newline', async () => {
    const lines = await highlightToLines('/* a\nb */\nconst x = 1;', 'javascript');
    assert.equal(lines.length, 3);
    for (const line of lines) assert.equal((line.match(/<span/g) || []).length, (line.match(/<\/span>/g) || []).length);
});

test('formats byte sizes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
});
