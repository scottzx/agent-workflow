/**
 * The transcript shape this view renders. It is structurally the same as the 1agents ChatItem, so
 * history replayed from a bridge can be passed straight in.
 */
export interface ToolCallDiff { path: string; oldText?: string; newText: string }
export interface ToolCallLocation { path: string; line?: number }
export interface ToolCallInfo {
    id?: string;
    toolName: string;
    input: string;
    toolCallId?: string;
    output?: string;
    isError?: boolean;
    kind?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'failed';
    locations?: ToolCallLocation[];
    diffs?: ToolCallDiff[];
    permission?: { requestId: string; toolName: string; input: string; resolved?: 'allow' | 'deny' };
}
export interface AskUserQuestionItem { question: string; header?: string; options?: { label: string; description?: string }[] }

export type ChatItem = { id: string; createdAt: number } & (
    | { kind: 'user'; content: string; queueStatus?: 'queued' }
    | { kind: 'assistant_text'; content: string; streaming?: boolean }
    | { kind: 'thinking'; content: string }
    | { kind: 'tool_use'; toolName: string; input: string; calls: ToolCallInfo[]; toolCallId?: string }
    | { kind: 'tool_result'; toolCallId?: string; toolName?: string; content: string; isError: boolean }
    | { kind: 'permission_request'; requestId: string; toolName: string; input: string; resolved?: 'allow' | 'deny' }
    | { kind: 'ask_user_question'; requestId: string; questions: AskUserQuestionItem[]; resolved?: string; answers?: Record<string, unknown> }
    | { kind: 'exit_plan_mode'; requestId: string; planContent: string; resolved?: string; comments?: string }
    | { kind: 'error'; content: string }
    | { kind: 'turn_receipt'; content: string; count: number; status: 'succeeded' | 'rejected' | 'failed' | 'cancelled' }
    | { kind: 'subagent_turn'; label: string; thinking: string; output: string; calls: ToolCallInfo[]; streaming: boolean }
);

/** One page of a transcript. `nextCursor` addresses the next-older page. */
export interface ChatPage {
    /** Items in chronological order. */
    items: ChatItem[];
    hasMore: boolean;
    nextCursor?: string;
}
export type ChatPageLoader = (cursor: string | undefined, limit: number, signal: AbortSignal) => Promise<ChatPage>;
