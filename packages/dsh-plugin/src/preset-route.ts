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

/** The part of a live agent this module needs. */
type RoutableAgent = { model?: { select?: (selection: { provider: string; model: string }) => void } };

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
function liveAgent(ctx: Context, sessionId: SessionId): RoutableAgent | undefined {
  const agents = (ctx as unknown as { agents?: { get?: (id: SessionId) => RoutableAgent | undefined } }).agents;
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
  const agent = liveAgent(ctx, sessionId);
  if (agent?.model?.select === undefined) return false;
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  agent.model.select({ provider: ACP_PROVIDER, model: acpAgent });
  return true;
}
