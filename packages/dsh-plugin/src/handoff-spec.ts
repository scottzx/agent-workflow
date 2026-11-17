/**
 * The executor's handoff tool.
 *
 * A running agent may propose that the version it just produced goes to another target. It never dispatches the
 * next task: the proposal waits on the workbench page, and only a person decides it.
 */
export const HANDOFF_TOOLS = [
  { name: 'handoff_propose', description: '提议把这一轮已记录的产物交给另一个执行目标。只写账本，不派下一单；是否接受由人在工作台页面决定。', parameters: {
    toTargetId: { type: 'string', description: '接手的执行目标编号，例如 legacy:dsh-host。' },
    purpose: { type: 'string', description: '接手的用途，例如 make。' },
    reason: { type: 'string', description: '为什么这一版可以交出去。' } } },
] as const;
export type HandoffTool = typeof HANDOFF_TOOLS[number]['name'];
export const HANDOFF_PATH = '/1agents-acp/handoff';
