/** A standing preset binds its sessions to one external Agent or thin coordinator role. */
import type { Context } from '@deepseek-ai/cordis';
import { ACP_PROVIDER, modelSelectionOf } from './preset-route.js';

export const name = 'oneagents-acp-preset';
export const inject = ['agents', 'llm'];

export const PR_COACH_PRESET_ID = 'oneagents-pr-coach';
export const PR_COACH_ROLE_ID = 'pr-coach';
export const PR_COACH_SKILLS = ['pr-orchestrate', 'local-deploy-verify', 'rsi-distill'] as const;

export interface ThinRolePresetDefinition {
  id: string;
  name: string;
  description: string;
  order: number;
  roleId: string;
  skills: readonly string[];
  plugins: { id: string; name: string; config: Record<string, unknown> }[];
}

/**
 * Thin coordinator preset definition for `.1agents/roles/pr-coach/`.
 * Keeps persona/runtime lean and delegates procedure & skills to the Git-tracked role directory.
 */
export function prCoachPresetDefinition(options: { order?: number; roleId?: string; skills?: readonly string[] } = {}): ThinRolePresetDefinition {
  const roleId = options.roleId ?? PR_COACH_ROLE_ID;
  const skills = options.skills ?? PR_COACH_SKILLS;
  return {
    id: PR_COACH_PRESET_ID,
    name: 'PR 总管 · pr-coach',
    description: '薄总管协调者预设：自动绑定 .1agents/roles/pr-coach/（pr-orchestrate / local-deploy-verify / rsi-distill），遵守 trial/formal 与双钥匙边界。',
    order: options.order ?? 15,
    roleId,
    skills: [...skills],
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: {
          prefix: `角色入口：.1agents/roles/${roleId}/ROLE.md（技能：${skills.join('、')}）。`,
          complete: false,
          includeRuntimeContext: true,
        },
      },
    ],
  };
}

/** Register the thin `oneagents-pr-coach` preset on a DSH Context and return its disposer. */
export async function registerPrCoachPreset(
  ctx: Context,
  options: { order?: number; roleId?: string; skills?: readonly string[] } = {},
): Promise<() => void | Promise<void>> {
  const def = prCoachPresetDefinition(options);
  return ctx.agentPresets.register({
    id: def.id,
    name: def.name,
    description: def.description,
    order: def.order,
    plugins: def.plugins,
  });
}

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
