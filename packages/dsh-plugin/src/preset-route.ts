/**
 * The route a session records to run its ACP Agent.
 *
 * A session that starts with an ACP preset gets this route when its agent is
 * created (see preset.ts). A session that only later switches to an ACP preset
 * is recomposed instead: its agent already exists, so the creation event never
 * fires and the route stays unrecorded. The next step then prepares the
 * default model and rejects the ACP route the preset proposes.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';

/** The provider a session runs its ACP Agent under. */
export const ACP_PROVIDER = '1agents-acp';

/** One recorded model choice. */
export interface ModelSelection { provider: string; model: string }

/** The part of an agent that records a model selection. */
export interface ModelSelectionApi { select(selection: ModelSelection): void }

/**
 * The model selection API of a live agent, when the host provides one.
 *
 * Current DSH records the route on the agent; older DSH agents have no such
 * API and take the route from the request waterfall instead. The host's own
 * types do not declare the API, so it is read structurally.
 */
export function modelSelectionOf(agent: unknown): ModelSelectionApi | undefined {
  const model = (agent as { model?: { select?: (selection: ModelSelection) => void } } | undefined)?.model;
  if (!model || typeof model.select !== 'function') return undefined;
  return { select: (selection: ModelSelection) => model.select!(selection) };
}

/**
 * The ACP Agent a preset id names, when this plugin registered that preset.
 * @param agentPreset - Selected preset id.
 * @param known - ACP Agent names this plugin registered presets for.
 * @returns The ACP Agent name, or undefined for another plugin's preset.
 */
export function acpAgentOf(agentPreset: string, known: readonly string[]): string | undefined {
  return known.find(name => agentPreset === `oneagents-acp-${name}`);
}

/** The live agent of a session, without resuming or creating one. */
function liveAgent(ctx: Context, sessionId: SessionId): unknown {
  const agents = (ctx as unknown as { agents?: { get?: (id: SessionId) => unknown } }).agents;
  return agents?.get?.(sessionId);
}

/**
 * Record the ACP route of a session whose preset was just selected.
 *
 * The route is written after the preset event settles, so the session is not
 * written while its own event is still being dispatched.
 * @param ctx - Host context.
 * @param sessionId - Session whose preset changed.
 * @param agentPreset - Selected preset id.
 * @param known - ACP Agent names this plugin registered presets for.
 * @returns Whether the route was recorded.
 */
export async function selectAcpRoute(ctx: Context, sessionId: SessionId, agentPreset: string, known: readonly string[]): Promise<boolean> {
  const acpAgent = acpAgentOf(agentPreset, known);
  if (acpAgent === undefined) return false;
  const model = modelSelectionOf(liveAgent(ctx, sessionId));
  if (model === undefined) return false;
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  model.select({ provider: ACP_PROVIDER, model: acpAgent });
  return true;
}
