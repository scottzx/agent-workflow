// Deterministic external ACP Agent used by the runtime integration test.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let turn;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const p = m.params;
  const reply = result => send({ id: m.id, result });
  // Lets a test see which MCP servers each session request carried.
  if (process.env.ACP_FIXTURE_MCP_LOG && ['session/new', 'session/load', 'session/resume'].includes(m.method)) appendFileSync(process.env.ACP_FIXTURE_MCP_LOG, `${m.method} ${(p.mcpServers ?? []).map(s => s.name).join(',')}\n`);
  switch (m.method) {
    case 'initialize': reply({ protocolVersion: 1, agentInfo: { name: 'fixture', version: '1' }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, authMethods: [] }); break;
    case 'session/new': reply({ sessionId: 'native-fixture' }); break;
    case 'session/load': case 'session/resume': reply({}); break;
    case 'session/prompt':
      turn = m;
      send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'progress', _meta: { codex: { phase: 'commentary' } }, content: { type: 'text', text: 'I will perform the operation.' } } } });
      send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'write-1', title: 'Write', kind: 'edit', status: 'pending', rawInput: { path: '/tmp/example' } } } });
      send({ id: 'approval', method: 'session/request_permission', params: { sessionId: p.sessionId, toolCall: { toolCallId: 'write-1', title: 'Write', kind: 'edit', rawInput: { path: '/tmp/example' } }, options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }] } });
      break;
    default:
      if (m.id === 'approval') {
        send({ method: 'session/update', params: { sessionId: turn.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'write-1', content: [{ type: 'content', content: { type: 'text', text: 'saved' } }] } } });
        send({ method: 'session/update', params: { sessionId: turn.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'write-1', status: 'completed', rawOutput: { result: 'saved' } } } });
        if (!['commentary only', 'terminal only'].includes(turn.params.prompt[0]?.text)) for (const text of ['fixture ', 'complete']) send({ method: 'session/update', params: { sessionId: turn.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'answer', _meta: { codex: { phase: 'final_answer' } }, content: { type: 'text', text } } } });
        send({ id: turn.id, result: { stopReason: 'end_turn' } });
      } else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
