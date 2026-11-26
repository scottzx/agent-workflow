/**
 * What the agent panel says when a role has no RSI projection. A published agent names a role id; that id is
 * only readable when the project has `.1agents/roles/<roleId>`. A 404 is therefore a normal state, not a
 * backend error to paste on screen in English.
 */
export type RoleRsiFailureKind = 'missing-role' | 'invalid-role' | 'unavailable';

export interface RoleRsiNotice {
    kind: RoleRsiFailureKind;
    title: string;
    description: string;
}

export function roleRsiNotice(status: number | undefined, code: string | undefined, roleId: string, language = 'zh-CN'): RoleRsiNotice {
    const chinese = language === 'zh-CN';
    if (status === 400 || code === 'invalid_role') {
        return {
            kind: 'invalid-role',
            title: chinese ? '角色 ID 不能作为目录名' : 'This role id is not a directory name',
            description: chinese
                ? `“${roleId}”不能用作 RSI 角色目录：角色 ID 只能由字母、数字、点、下划线和连字符组成。请改这条智能体记录的角色 ID。`
                : `“${roleId}” is not usable as an RSI role directory: a role id may only contain letters, digits, dots, underscores and hyphens. Edit the role id on this agent record.`,
        };
    }
    if (status === 404 || code === 'not_found') {
        return {
            kind: 'missing-role',
            title: chinese ? '这个角色还没有 RSI 标准' : 'This role has no RSI standard yet',
            description: chinese
                ? `项目 .1agents/roles/ 下没有名为 “${roleId}” 的角色目录，所以没有清单、工作流和门禁可显示。可以在项目里登记同名角色，或把这条智能体记录的角色 ID 改成已有角色。`
                : `The project has no .1agents/roles/${roleId} directory, so there is no checklist, workflow or gate to show. Register that role in the project, or point this agent record at an existing role id.`,
        };
    }
    return {
        kind: 'unavailable',
        title: chinese ? '暂时读不到角色标准' : 'The role standard is unavailable',
        description: chinese
            ? `网关这次没有返回 “${roleId}” 的 RSI 数据，稍后重试即可；这不影响任务的派发与审批。`
            : `The gateway did not return RSI data for “${roleId}” this time. Retry later; dispatch and approvals are unaffected.`,
    };
}
