/** Host services are requested only when DSH activates this package as a plugin. */
export const name = 'oneagents-acp';
export const inject = ['llm', 'agents', 'approval', 'userQuestions', 'commands', 'sessionProjections', 'webServer', 'sessionController', 'agentPresets', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'tools', 'connection'];

/** Keep the service API usable without loading plugin code or DSH declarations.
 * The fully typed plugin entry is available from /dsh. */
export async function apply(ctx: unknown, input: Record<string, unknown> = {}): Promise<void> {
  const plugin = await import(new URL('../../vendor/dsh/index.js', import.meta.url).href);
  await plugin.apply(ctx, input);
}
