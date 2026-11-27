/** Names, descriptions and parameters of the executor's ticket tools, the same for DSH's native tools and the ACP agents' MCP server. */
export const TICKET_TOOLS = [
  { name: 'ticket_show', description: '查看本会话 A2A 任务的预置自检清单和待处理意见：自检项的 pending/pass/na，以及意见的编号、轻重、位置、问题、建议、证据和重开说明。', parameters: {} },
  { name: 'ticket_mark', description: '把任务单上一条 open 或 reopened 的意见标为 done（已改）或 disputed（不同意），并写说明。只在被打回修改时可用。',
    parameters: { id: { type: 'string', description: '意见编号，如 P1-P2、Q1-3。' },
      state: { type: 'string', enum: ['done', 'disputed'], description: 'done：已改；disputed：不同意。' },
      note: { type: 'string', description: '怎么改的（改了哪一页、改成了什么），或者不同意的理由和依据的文件。' } } },
  { name: 'ticket_self_check', description: '把教练预置自检清单上的一项标为 pass（已核验通过）或 na（本任务不适用），并写核验依据。全部必填自检项完成后才允许调用 ticket_submit 交稿。',
    parameters: { id: { type: 'string', description: '自检项编号，如 A1、S1、P5。' },
      status: { type: 'string', enum: ['pass', 'na'], description: 'pass：已核验通过；na：本任务不适用。' },
      note: { type: 'string', description: '自检依据（核验了哪些文件、运行了什么检查、或不适用的原因）。' } } },
  { name: 'ticket_submit', description: '必填自检已打卡、任务单上的意见全部处理完后提交，交给宿主检查。还有未打卡的必填自检或待处理意见时会被拒绝。', parameters: {} },
] as const;
export type TicketTool = typeof TICKET_TOOLS[number]['name'];
export const TICKET_PATH = '/1agents-acp/ticket';
