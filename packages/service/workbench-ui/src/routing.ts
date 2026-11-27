/**
 * The four top-level modules and the hash that names each one. Kept free of `location` so the page shell and
 * the tests can agree on the mapping without a DOM: the hash is the browser's only routing state.
 */
export type AcpModule = 'approvals' | 'cases' | 'tasks' | 'agents';

export const modules: readonly AcpModule[] = ['approvals', 'cases', 'tasks', 'agents'];

/** A detail hash (`#acp/tasks/<jobId>?mode=drawer`) still names its module, so opening a detail keeps the tab. */
const MODULE_HASH = /^#acp\/(approvals|cases|tasks|agents)(?:[/?]|$)/;

export function moduleFromHash(hash: string): AcpModule | undefined {
    const match = MODULE_HASH.exec(hash);
    return match ? (match[1] as AcpModule) : undefined;
}

/** What a module switch writes. A hash that already names this module (including a detail) is left alone. */
export function hashForModule(module: AcpModule): string {
    return `#acp/${module}`;
}
