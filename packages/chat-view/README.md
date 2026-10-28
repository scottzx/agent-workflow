# @1agents/chat-view

Read-only Preact transcript view for agent sessions. It renders user and assistant messages (Markdown, via
`@1agents/file-preview`), thinking, tool calls with input/output and inline diffs, plans, questions, permission
results and subagent turns, and loads history on demand.

```tsx
import { ChatView, useChatPages } from '@1agents/chat-view';
import '@1agents/file-preview/style.css';
import '@1agents/chat-view/style.css';

function Conversation({ id }: { id: string }) {
  const load = useCallback<ChatPageLoader>(async (cursor, limit, signal) => {
    const page = await fetch(`/api/chat/${id}?limit=${limit}${cursor ? `&before=${cursor}` : ''}`, { signal }).then(r => r.json());
    return { items: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor };
  }, [id]);
  const pages = useChatPages(load, { pageSize: 40 });
  return <ChatView {...pages} onLoadMore={pages.loadMore} onRetry={pages.reload} onOpenFile={(path, line) => open(path, line)} />;
}
```

## On-demand loading

* `useChatPages(loader, { pageSize, enabled })` fetches the **newest** page first; `loadMore` prepends older ones
  using the `nextCursor` your loader returned. Nothing is requested while `enabled` is `false`.
* `ChatView` calls `onLoadMore` when the top scrolls near the viewport (and shows a button as a fallback), and keeps
  the viewport still while older messages are prepended. It sticks to the bottom while new messages arrive.
* `LazyChat` is a collapsible panel that makes its first request only when opened.

## Data shape

`ChatItem` is structurally the 1agents `ChatItem` (`user`, `assistant_text`, `thinking`, `tool_use`, `tool_result`,
`permission_request`, `ask_user_question`, `exit_plan_mode`, `error`, `turn_receipt`, `subagent_turn`). A separate
`tool_result` is folded into the `tool_use` card with the same `toolCallId`.

`onOpenFile(path, line?)` fires for tool file chips, diff paths and non-http Markdown links. `diagrams={false}`
disables Mermaid under a strict CSP. Requires `preact@^10` as a peer dependency.
