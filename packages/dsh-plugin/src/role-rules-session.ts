/**
 * Resolve an authenticated ACP session to its workspace cwd, then read role rules from that project.
 * Callers never supply projectRoot.
 */
import { readRoleRules, resolveProjectRootFromCwd, type RoleRulesPhase } from '@1agents/acp-service/roles';

export async function readSessionRoleRules(input: {
  sessionId: string;
  roleId: string;
  phase?: RoleRulesPhase;
  resolveAgent: (sessionId: string) => Promise<unknown>;
}): Promise<string> {
  const resolved = await input.resolveAgent(input.sessionId);
  if (!resolved || typeof resolved !== 'object') throw new Error('无法取得会话工作目录：会话不存在');
  const record = resolved as { error?: unknown; agent?: { session?: { header?: { cwd?: unknown } } } };
  if ('error' in record && record.error) {
    const message = record.error instanceof Error ? record.error.message : String(record.error);
    throw new Error(`无法取得会话工作目录：${message}`);
  }
  const cwd = record.agent?.session?.header?.cwd;
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new Error('当前会话没有工作目录，无法读取角色规则');
  const projectRoot = await resolveProjectRootFromCwd(cwd);
  if (!projectRoot) throw new Error(`会话工作目录不在含 .1agents/roles 的项目内：${cwd}`);
  const rules = await readRoleRules({
    projectRoot,
    roleId: input.roleId,
    ...(input.phase ? { phase: input.phase } : {}),
  });
  return JSON.stringify(rules);
}
