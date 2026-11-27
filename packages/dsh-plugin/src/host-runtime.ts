/**
 * Lazy access to DeepSeek Harness host packages.
 *
 * These modules live in the DSH install and are never hot-reloaded. A top-level
 * static import would make `import('@1agents/acp-service')` fail for ordinary
 * Node consumers and would also freeze the plugin's static ESM graph on packages
 * HMR must not chase. Every load is cached so `instanceof` sees one constructor.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface DshToolsModule { defineTool: (...args: any[]) => any }
export interface DshLlmModule { LlmError: new (...args: any[]) => Error }
export interface DshStorageModule {
  Context: new (...args: any[]) => any;
  Storage: any;
  JsonStorage: any;
  StorageDomain: any;
  defineDomain: (...args: any[]) => any;
  domainTable: (...args: any[]) => any;
}

let toolsModule: DshToolsModule | undefined;
let toolsPromise: Promise<DshToolsModule> | undefined;
let llmModule: DshLlmModule | undefined;
let llmPromise: Promise<DshLlmModule> | undefined;
let storagePromise: Promise<DshStorageModule> | undefined;

/** Async load used by plugin startup. Shares the instance a sync caller already cached. */
export function loadDshTools(): Promise<DshToolsModule> {
  if (toolsModule) return Promise.resolve(toolsModule);
  return toolsPromise ??= import('@deepseek-ai/dsh-tools').then(mod => toolsModule = mod as DshToolsModule);
}

/**
 * Synchronous load for existing unit tests that call `ticketTools(gateway)` without
 * awaiting startup. Node 22 can require the ESM host package; the async path then
 * reuses this same namespace.
 */
export function loadDshToolsSync(): DshToolsModule {
  if (!toolsModule) toolsModule = require('@deepseek-ai/dsh-tools') as DshToolsModule;
  return toolsModule;
}

export function loadDshLlm(): Promise<DshLlmModule> {
  if (llmModule) return Promise.resolve(llmModule);
  return llmPromise ??= import('@deepseek-ai/dsh-llm').then(mod => llmModule = mod as DshLlmModule);
}

/** Storage packages used only while opening the diagnostics domain. */
export function loadDshStorage(): Promise<DshStorageModule> {
  return storagePromise ??= (async () => {
    const [cordis, storageMod, jsonMod, domainMod] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-storage'),
      import('@deepseek-ai/dsh-storage-json'),
      import('@deepseek-ai/dsh-storage-domain'),
    ]);
    const storageNs = storageMod as { default?: unknown };
    const domainNs = domainMod as { defineDomain: (...args: any[]) => any; domainTable: (...args: any[]) => any };
    return {
      Context: (cordis as { Context: new (...args: any[]) => any }).Context,
      Storage: storageNs.default ?? storageMod,
      JsonStorage: jsonMod,
      StorageDomain: domainMod,
      defineDomain: domainNs.defineDomain,
      domainTable: domainNs.domainTable,
    };
  })();
}
