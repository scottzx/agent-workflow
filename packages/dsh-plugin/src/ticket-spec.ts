/** Names, descriptions and parameters of the executor's ticket tools, the same for DSH's native tools and the ACP agents' MCP server. */
export const TICKET_TOOLS = [
  { name: 'ticket_show', description: '查看本会话 A2A 任务的任务单上待处理的意见：编号、轻重、位置、问题、建议、证据，以及重开意见上一次的说明。', parameters: {} },
  { name: 'ticket_mark', description: '把任务单上一条 open 或 reopened 的意见标为 done（已改）或 disputed（不同意），并写说明。只在被打回修改时可用。',
    parameters: { id: { type: 'string', description: '意见编号，如 P1-P2、Q1-3。' },
      state: { type: 'string', enum: ['done', 'disputed'], description: 'done：已改；disputed：不同意。' },
      note: { type: 'string', description: '怎么改的（改了哪一页、改成了什么），或者不同意的理由和依据的文件。' } } },
  { name: 'ticket_submit', description: '任务单上的意见全部处理完后提交，交给宿主检查。还有待处理的意见时会被拒绝。', parameters: {} },
] as const;
export type TicketTool = typeof TICKET_TOOLS[number]['name'];
export const TICKET_PATH = '/1agents-acp/ticket';
