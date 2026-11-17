/**
 * The executor's handoff tool, as DSH's native tool. The operation itself lives in handoff-executor.ts, which
 * carries no host dependency and is shared with the ACP agents' MCP server.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HANDOFF_TOOLS, type HandoffTool } from './handoff-spec.js';
import { runHandoffTool, type HandoffGateway, type HandoffToolArgs } from './handoff-executor.js';

export type { HandoffToolArgs };
export { runHandoffTool };

const output = { schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true } } },
  render: (_args: unknown, value: { message: string }) => [{ type: 'text' as const, text: value.message }] } as const;

export function handoffTools(gateway: HandoffGateway) {
  return HANDOFF_TOOLS.map(spec => defineTool({ name: spec.name, description: spec.description, output,
    // Every parameter is required in DSH's own schema form.
    parameters: Object.fromEntries(Object.entries(spec.parameters).map(([key, value]) => [key, { ...value, required: true }])),
    execute: (args: HandoffToolArgs, exec: { agent?: { id: string } }) => {
      if (!exec.agent) throw new Error(`${spec.name} requires an owning agent session`);
      return runHandoffTool(gateway, exec.agent.id, spec.name, args).then(message => ({ message }));
    } }));
}
