/**
 * Minimal ambient declarations for DeepSeek Harness (DSH) host packages.
 *
 * These packages are provided by the DeepSeek Harness runtime and are not
 * published to npm. The declarations below exist only so this plugin can be
 * type-checked and built outside a DSH install. At runtime DSH injects the real
 * modules. For full typings, link a DSH checkout with `pnpm link:dsh <path>`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare module '@deepseek-ai/cordis' {
  export class Context { [key: string]: any; constructor(...args: any[]); }
  export interface Context { [key: string]: any }
}
declare module '@deepseek-ai/dsh-llm' {
  export type ContentBlock = any;
  export type MessageId = string;
  /**
   * Host-owned messages are immutable: DSH declares `content`/`source` readonly and deep-freezes
   * them at runtime. Queued notices must be swapped through `AgentInbox.replace`, never mutated.
   * Mirrors the real `@deepseek-ai/dsh-llm` `MessageBase`-derived type: durable identity is required.
   */
  export interface UserMessage {
    readonly id: MessageId; readonly role: 'user'; readonly content: readonly ContentBlock[]; readonly source?: unknown;
    [key: string]: unknown;
  }
  /** Client-forwarded user input without durable identity; `id`/`source` do not exist. */
  export interface RequestUserInput {
    readonly role: 'user'; readonly content: readonly ContentBlock[]; readonly id?: never; readonly source?: never;
    [key: string]: unknown;
  }
  /** Non-user messages that share the same request list. */
  export interface Message {
    readonly id: MessageId; readonly role: 'assistant' | 'tool' | 'system' | (string & {});
    readonly content?: readonly ContentBlock[]; readonly source?: unknown;
    [key: string]: unknown;
  }
  /** What `GenerateOptions.messages` really carries: durable messages plus forwarded input. */
  export type RequestMessage = UserMessage | RequestUserInput | Message;
  export type LlmAdapter = any;
  export interface GenerateOptions { messages: RequestMessage[]; [key: string]: any }
  export type StreamChunk = any;
  export type LlmModelInfo = any;
  export class LlmError extends Error { [key: string]: any; constructor(...args: any[]); }
}
declare module '@deepseek-ai/dsh-session' {
  export type SessionId = string;
  export type SessionEvent = any;
  export type TurnEndReason = any;
}
declare module '@deepseek-ai/dsh-api-session-controller' { export type SessionRequestId = string; }
declare module '@deepseek-ai/dsh-agent' {
  import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
  /**
   * Pending-input queues. `replace` atomically swaps one not-yet-consumed message by ID.
   * Single source of truth: DSH host `packages/core/agent/src/runtime-types.ts`
   * (`Inbox.replace(messageId, newMessage): boolean`).
   */
  export interface AgentInbox {
    readonly nextTurn?: readonly UserMessage[];
    readonly nextStep?: readonly UserMessage[];
    replace?(messageId: MessageId, next: UserMessage): boolean;
  }
  /** The host-owned part of an agent that queued notices touch. */
  export interface AgentHost {
    readonly id?: string;
    readonly inbox?: AgentInbox;
  }
  export type Agent = any;
}
declare module '@deepseek-ai/dsh-tools' { export const defineTool: (...args: any[]) => any; }
declare module '@deepseek-ai/dsh-storage' { const Storage: any; export default Storage; }
declare module '@deepseek-ai/dsh-storage-json' { const value: any; export = value; }
declare module '@deepseek-ai/dsh-storage-domain' {
  export type Domain<T = any> = any;
  export type DomainFacility<T = any> = any;
  export const defineDomain: (...args: any[]) => any;
  export function domainTable<K = any, V = any>(...args: any[]): any;
}
declare module '@deepseek-ai/dsh-agent-preset-registry' {}
declare module '@deepseek-ai/dsh-client-connection' {}
declare module '@deepseek-ai/dsh-commands' {}
declare module '@deepseek-ai/dsh-host-webserver' {}
declare module '@deepseek-ai/dsh-session-persistence' {}
declare module '@deepseek-ai/dsh-session-projection' {}
declare module '@deepseek-ai/dsh-session-projection/types' { export interface SessionProjectionStateMap {} }
declare module '@deepseek-ai/dsh-user-approval' {}
declare module '@deepseek-ai/dsh-user-questions' {}
declare module '@deepseek-ai/dsh-workspace' {}
