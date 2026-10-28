/** Turns the A2A tasks behind one workbench job into the chat view's transcript items, newest page first. */
import { Role, Task } from '@a2a-js/sdk';

export interface WorkbenchChatItem {
  id: string;
  createdAt: number;
  kind: 'user' | 'assistant_text';
  content: string;
}
export interface WorkbenchChatPage { items: WorkbenchChatItem[]; hasMore: boolean; nextCursor?: string; total: number }

const fence = (value: unknown) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';

/** One item per message: text parts joined, structured data fenced, file parts as links. */
export function chatItems(tasks: { attemptId?: string; task: unknown }[]): WorkbenchChatItem[] {
  const items: WorkbenchChatItem[] = [], seen = new Set<string>();
  for (const { attemptId, task: raw } of tasks) {
    const task = Task.fromJSON(raw);
    const messages = [...task.history, ...(task.status?.message ? [task.status.message] : [])];
    for (const message of messages) {
      const key = `${task.id}:${message.messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const blocks = message.parts.flatMap(part => {
        const content = part.content;
        if (!content) return [];
        if (content.$case === 'text') return content.value.trim() ? [content.value] : [];
        if (content.$case === 'data') return [fence(content.value)];
        if (content.$case === 'url') return [`[${part.filename || content.value}](${content.value})`];
        return [];
      });
      if (!blocks.length) continue;
      // Ordinals, not clocks: A2A history carries no timestamps, and ids must stay stable as history grows.
      items.push({ id: `${attemptId ?? task.id}:${message.messageId}`, createdAt: items.length,
        kind: message.role === Role.ROLE_USER ? 'user' : 'assistant_text', content: blocks.join('\n\n') });
    }
  }
  return items;
}

/** `before` is the index the previous page started at; pages walk from the newest toward the oldest. */
export function pageChat(items: WorkbenchChatItem[], query: { limit?: number; before?: number } = {}): WorkbenchChatPage {
  const end = Math.min(query.before ?? items.length, items.length), start = Math.max(0, end - (query.limit ?? 40));
  return { items: items.slice(start, end), hasMore: start > 0, ...(start > 0 ? { nextCursor: String(start) } : {}), total: items.length };
}
