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
  export interface UserMessage { id?: MessageId; role: string; source?: any; content?: any; [key: string]: any }
  export type LlmAdapter = any;
  export interface GenerateOptions { messages: UserMessage[]; [key: string]: any }
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
declare module '@deepseek-ai/dsh-agent' { export type Agent = any; }
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
declare module '@deepseek-ai/dsh-user-approval' {}
declare module '@deepseek-ai/dsh-user-questions' {}
declare module '@deepseek-ai/dsh-workspace' {}
