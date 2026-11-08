import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { client, type PromptRequest, type SessionUpdate } from '@agentclientprotocol/sdk';
import { createAgentRegistry, createRuntimeStore } from '@1agents/acp-service/runtime';
import { WebSocket } from 'ws';
import { testCapacityLifecycle } from './capacity-fixture.js';

test('ACP WebSocket traverses the real 1acp runtime and external stdio Agent', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'acp-runtime-'));
  process.env.ACP_STATE_DIR = directory;
  process.env.ACP_FIXTURE_MCP_LOG = join(directory, 'mcp.log');
  const { runtime } = await import('../src/bridge.js');
  const { serveAcpService } = await import('../src/server.js');
  const { webSocketStream } = await import('../src/acp-connection.js');
  // Configure the lazy runtime before its first Agent starts. Only the Agent
  // process is a fixture; session persistence, permissions and transport are real.
  const options = Reflect.get(runtime, 'options');
  options.sessionStore = createRuntimeStore({ stateDir: directory });
  options.processLifecycle = testCapacityLifecycle(directory);
  options.agentRegistry = createAgentRegistry({ overrides: { codex: [process.execPath, fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))] } });
  const startTurn = runtime.startTurn.bind(runtime);
  const terminalAnswers = new Map([['terminal only', 'Authoritative terminal answer'], ['terminal empty', ''], ['terminal replacement', 'Corrected terminal answer']]);
  // The current runtime omits finalAnswer. Exercise the public result contract's
  // optional authoritative answer without replacing its real event stream/store.
  runtime.startTurn = input => {
    const turn = startTurn(input);
    return terminalAnswers.has(input.text) ? { ...turn, result: turn.result.then(result => ({ ...result, finalAnswer: terminalAnswers.get(input.text)! })) } : turn;
  };
  const service = await serveAcpService({ host: '127.0.0.1', port: 0, report: false });
  t.after(async () => { await service.close(); delete process.env.ACP_STATE_DIR; delete process.env.ACP_FIXTURE_MCP_LOG; rmSync(directory, { recursive: true, force: true }); });
  const ws = new WebSocket(`ws://127.0.0.1:${service.port}/agents/codex`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const updates: string[] = [];
  const textUpdates: SessionUpdate[] = [];
  const toolUpdates: Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>[] = [];
  let permissions = 0;
  const connection = client().onNotification('session/update', ({ params }) => {
    updates.push(params.update.sessionUpdate);
    if (params.update.sessionUpdate === 'agent_message_chunk') textUpdates.push(params.update);
    if (params.update.sessionUpdate === 'tool_call' || params.update.sessionUpdate === 'tool_call_update') toolUpdates.push(params.update);
  })
    .onRequest('session/request_permission', ({ params }) => { permissions++; assert.equal(params.options[0].optionId, 'yes'); return { outcome: { outcome: 'selected' as const, optionId: 'yes' } }; })
    .connect(webSocketStream(ws));
  await connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { '1agents': { version: 1 } } } });
  const { sessionId } = await connection.agent.request('session/new', { cwd: directory, mcpServers: [{ name: 'per-session', command: process.execPath, args: [], env: [] }] });
  assert.match(readFileSync(process.env.ACP_FIXTURE_MCP_LOG, 'utf8'), /^session\/new per-session$/m, 'the Agent receives the per-session MCP servers');
  const prompt: PromptRequest = { sessionId, prompt: [{ type: 'text', text: 'perform fixture operation' }], _meta: { '1agents': { turnManaged: true, turnId: 'managed-fixture', requestId: 'managed-fixture' } } };
  const result = await connection.agent.request('session/prompt', prompt);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal((result._meta?.['1agents'] as { finalAnswer: string }).finalAnswer, 'fixture complete');
  assert.deepEqual(textUpdates.map(update => update._meta?.['1agents']).map(meta => {
    const value = meta as { messageId: string; messagePhase: string };
    return [value.messageId, value.messagePhase];
  }), [['progress', 'commentary'], ['answer', 'final_answer'], ['answer', 'final_answer']]);
  assert.equal(textUpdates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content.type === 'text' ? update.content.text : '').join(''), 'I will perform the operation.fixture complete');
  const replayed = await connection.agent.request('session/prompt', prompt);
  assert.equal((replayed._meta?.['1agents'] as { finalAnswer: string }).finalAnswer, 'fixture complete');
  assert.equal(permissions, 1);
  assert.ok(updates.includes('tool_call'));
  assert.ok(updates.includes('tool_call_update'));
  assert.ok(updates.includes('agent_message_chunk'));
  assert.equal(toolUpdates[0].title, 'Write');
  assert.ok(toolUpdates.slice(1).every(u => u.title === undefined && u.status !== 'pending'));
  const completed = toolUpdates.filter(u => u.status === 'completed');
  assert.ok(completed.length > 0);
  assert.ok(completed.every(u => JSON.stringify(u.rawOutput) === '{"result":"saved"}'));
  await connection.agent.request('session/close', { sessionId });
  const list = await connection.agent.request('session/list', {});
  assert.ok(list.sessions.some(session => session.sessionId === sessionId), 'closed sessions remain resumable');
  await connection.agent.request('session/resume', { sessionId, cwd: directory, mcpServers: [] });
  const resumed = await connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'continue fixture operation' }] });
  assert.equal(resumed.stopReason, 'end_turn');
  assert.equal(permissions, 2);
  const commentaryPrompt: PromptRequest = { sessionId, prompt: [{ type: 'text', text: 'commentary only' }], _meta: { '1agents': { turnManaged: true, turnId: 'commentary-fixture', requestId: 'commentary-fixture' } } };
  const commentary = await connection.agent.request('session/prompt', commentaryPrompt);
  assert.equal((commentary._meta?.['1agents'] as { finalAnswer: string }).finalAnswer, '');
  const commentaryReplay = await connection.agent.request('session/prompt', commentaryPrompt);
  assert.equal((commentaryReplay._meta?.['1agents'] as { finalAnswer: string }).finalAnswer, '');
  for (const [text, finalAnswer] of terminalAnswers) {
    const terminalPrompt: PromptRequest = { sessionId, prompt: [{ type: 'text', text }], _meta: { '1agents': { turnManaged: true, turnId: text, requestId: text } } };
    const terminal = await connection.agent.request('session/prompt', terminalPrompt);
    assert.equal((terminal._meta?.['1agents'] as { finalAnswer: string }).finalAnswer, finalAnswer);
    const terminalReplay = await connection.agent.request('session/prompt', terminalPrompt);
    assert.equal((terminalReplay._meta?.['1agents'] as { finalAnswer: string }).finalAnswer, finalAnswer);
  }
  await connection.agent.request('session/delete', { sessionId });
  await assert.rejects(connection.agent.request('session/resume', { sessionId, cwd: directory, mcpServers: [] }), { code: -32003 });
  assert.equal((await connection.agent.request('session/list', {})).sessions.length, 0);
  ws.close();
});
