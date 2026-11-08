/** A standing preset binds its sessions to one external Agent. */
import type { Context } from '@deepseek-ai/cordis';
import { ACP_PROVIDER, modelSelectionOf } from './preset-route.js';
export const name = 'oneagents-acp-preset';
export const inject = ['agents', 'llm'];
export function apply(ctx: Context, config: { agent: string }): void {
  if (!/^[a-z0-9_-]+$/i.test(config.agent)) throw new Error('Invalid ACP Agent name');
  const route = { provider: ACP_PROVIDER, model: config.agent };
  // Current DSH fixes each step's model before agent/request and rejects a later swap,
  // so the route is recorded through agent.model.select() when the agent is created or resumed.
  ctx.on('agent/created', ({ agent }) => {
    modelSelectionOf(agent)?.select(route);
    return undefined;
  });
  // Older DSH has no agent.model and still takes the route from agent/request; on current DSH
  // the proposal already carries the selected route, so this keeps it and its other controls unchanged.
  ctx.on('agent/request', async (_event, next) => ({ ...await next(), ...route }));
}
