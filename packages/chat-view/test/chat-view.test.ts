import assert from 'node:assert/strict';
import test from 'node:test';
import { h } from 'preact';
import { render } from 'preact-render-to-string';
import { ChatView, lineDiff, type ChatItem } from '../src/index.ts';

test('line diff trims the shared prefix and suffix', () => {
    const lines = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd', 1);
    assert.deepEqual(lines.map(l => `${l.type}:${l.text}`), ['ctx:a', 'del:b', 'add:B', 'ctx:c']);
});

test('renders messages, folds a separate tool result into its card, and offers earlier history', () => {
    const items: ChatItem[] = [
        { id: '1', createdAt: 1, kind: 'user', content: 'hello <b>there</b>' },
        { id: '2', createdAt: 2, kind: 'tool_use', toolName: 'Read', input: '{}', calls: [{ toolName: 'Read', input: '{"file_path":"/a/b.ts"}', toolCallId: 'c1', locations: [{ path: '/a/b.ts', line: 3 }] }] },
        { id: '3', createdAt: 3, kind: 'tool_result', toolCallId: 'c1', content: 'file body', isError: false },
        { id: '4', createdAt: 4, kind: 'error', content: 'boom' },
    ];
    const html = render(h(ChatView, { items, hasMore: true, onLoadMore: () => {}, theme: 'light' }));
    assert.match(html, /hello &lt;b>there&lt;\/b>/);
    assert.match(html, /b\.ts:3/);
    assert.match(html, /file body/);
    assert.equal((html.match(/cv-tool /g) || []).length, 1, 'result is merged, not a second card');
    assert.match(html, /Load earlier messages/);
    assert.match(html, /boom/);
});

test('shows the empty state only when nothing is loading', () => {
    assert.match(render(h(ChatView, { items: [] })), /No messages yet/);
    assert.doesNotMatch(render(h(ChatView, { items: [], loading: true })), /No messages yet/);
});
