/**
 * Chooses what a single DSH step forwards to the stateful remote ACP Agent.
 *
 * `GenerateOptions.messages` can end with a user-role message that DSH itself injected, such as the
 * `user-approval` notice emitted when the user changes the approval policy mid-turn. Such a step has nothing to
 * say to the remote Agent, so it must end normally instead of failing. This module carries no `@deepseek-ai/*`
 * runtime import so its selection rules can be tested without a linked DSH install; it accepts structural
 * parameters so both the real `RequestMessage[]` and the local host shims type-check without casts.
 */

/** The parts of a DSH request message this selection reads; `content` and `source` stay opaque here. */
export interface PromptMessage {
  readonly id?: string;
  readonly role: string;
  readonly source?: unknown;
  readonly content?: readonly unknown[];
}

/**
 * `noop`: the step carries only DSH-owned injected messages, so there is nothing to forward.
 * `prompt`: the forwarded messages and the text sent as `session/prompt`.
 */
export type PromptSelection<M extends PromptMessage> =
  | { readonly kind: 'noop' }
  | { readonly kind: 'prompt'; readonly input: readonly M[]; readonly text: string };

/** Message sources this plugin forwards to the remote Agent. Every other source is DSH-owned context. */
export function isForwardableSource(kind: unknown): boolean {
  return kind === 'user' || kind === '1agents-acp';
}

/** The opaque `source` DSH attaches to a durable or client-forwarded user message. */
export function sourceOf(message: { readonly source?: unknown }): { kind?: unknown; rpcId?: unknown } | undefined {
  return message.source as { kind?: unknown; rpcId?: unknown } | undefined;
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string');
}

/** A user-role message whose source marks it as DSH-hosted context rather than something the user typed. */
function isHostInjectedUser(message: PromptMessage): boolean {
  const kind = sourceOf(message)?.kind;
  return message.role === 'user' && typeof kind === 'string' && !isForwardableSource(kind);
}

/**
 * Selects this step's new user input from the messages that follow the last assistant reply.
 *
 * A remote ACP Agent owns its own conversation, so only messages after the last `assistant` message are new,
 * and only user messages this plugin forwards (and has not already imported) are sent. A step whose only new
 * user message is DSH-owned context (for example `user-approval`) resolves to `noop` so the caller can finish
 * the step without a remote connection, keeping the DSH turn alive for the next queued message.
 */
export function selectPromptInput<M extends PromptMessage>(messages: readonly M[], importedIds: ReadonlySet<string>): PromptSelection<M> {
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== 'assistant') start--;
  const tail = messages.slice(start + 1);
  const input = tail.filter(message => {
    if (message.role !== 'user' || !isForwardableSource(sourceOf(message)?.kind)) return false;
    const id = message.id;
    return id === undefined || !importedIds.has(id);
  });
  if (!input.length) {
    // DSH-owned context is not a prompt: finish this step instead of reporting a request the user never made.
    if (tail.some(isHostInjectedUser)) return { kind: 'noop' };
    throw new Error('No forwardable text prompt was supplied to the ACP plugin');
  }
  const blocks: readonly unknown[] = input.flatMap(message => message.content ?? []);
  if (!blocks.length || !blocks.every(isTextBlock)) throw new Error('This ACP plugin currently accepts text prompts only');
  return { kind: 'prompt', input, text: blocks.map(block => block.text).join('\n\n') };
}
