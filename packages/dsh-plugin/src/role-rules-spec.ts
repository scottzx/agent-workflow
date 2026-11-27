/** Read-only role-rules tool shared by the ACP review MCP server. The host resolves the project root; callers cannot pass one. */
export const ROLE_RULES_PATH = '/1agents-acp/role-rules';
export const ROLE_RULES_PHASES = ['all', 'implement', 'review', 'gate', 'coach'] as const;
export type RoleRulesPhaseName = typeof ROLE_RULES_PHASES[number];
export const ROLE_RULES_TOOL = {
  name: 'role_rules_get',
  description: '只读热加载当前会话项目 `.1agents/roles/<roleId>/` 的角色规则。phase 省略时为 all。不接受 projectRoot：项目根只由宿主按已鉴权会话的工作目录解析。每次调用直接读盘。',
  parameters: {
    roleId: { type: 'string', description: '角色目录名，例如 pr-delivery。' },
    phase: {
      type: 'string',
      enum: ['all', 'implement', 'review', 'gate', 'coach'],
      description: 'all、implement、review、gate 或 coach。省略等同 all。implement 不含审查提示词，review 不含实施提示词。',
    },
  },
  required: ['roleId'],
} as const;

export function roleRulesArguments(args: unknown): { ok: true; value: { roleId: string; phase?: RoleRulesPhaseName } } | { ok: false; error: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'roleId is required' };
  const record = args as Record<string, unknown>;
  const extra = Object.keys(record).filter(key => key !== 'roleId' && key !== 'phase');
  if (extra.length) return { ok: false, error: `unexpected argument: ${extra.join(', ')}` };
  if (typeof record.roleId !== 'string' || !record.roleId.trim()) return { ok: false, error: 'roleId is required' };
  if (record.phase !== undefined && (typeof record.phase !== 'string' || !(ROLE_RULES_PHASES as readonly string[]).includes(record.phase))) {
    return { ok: false, error: 'invalid phase' };
  }
  return {
    ok: true,
    value: { roleId: record.roleId, ...(typeof record.phase === 'string' ? { phase: record.phase as RoleRulesPhaseName } : {}) },
  };
}
