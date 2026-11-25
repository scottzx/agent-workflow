import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { bindA2AExecution, unbindA2AExecution } from '@1agents/acp-service/a2a';
import { TICKET_TOOLS } from '../dist/ticket-spec.js';
import { createTicketGateway, runTicketTool, ticketTools } from '../dist/ticket-tools.js';

const execution = { jobId: 'job-exec', attemptId: 'attempt-2' };
const ticket = { status: 'in_revision', round: 2, items: [
  { id: 'P1-P2', severity: 'must', where: 'style/font', problem: '程序检查 P2 未通过', evidence: [{ path: 'style/font', message: 'Arial' }], state: 'reopened',
    log: [{ by: 'host', action: 'raised' }, { by: 'executor', action: 'done', note: '改成了微软雅黑' }, { by: 'host', action: 'reopened' }] },
  { id: 'Q1-1', severity: 'should', where: 'project/oneLiner', problem: '太空泛', suggestion: '写场景', state: 'open', log: [{ by: 'qa', action: 'raised' }] },
  { id: 'Q1-2', severity: 'must', where: 'x', problem: 'y', state: 'verified', log: [] }] };

function fakeGateway(reply = async () => ticket) {
  const calls = [];
  return { calls, invoke: async (method, params) => { calls.push({ method, params }); return reply(method, params); } };
}

test('a session that is not running an A2A task has no ticket', async () => {
  const gateway = fakeGateway();
  await assert.rejects(runTicketTool(gateway, 'plain-session', 'ticket_show'), /不是正在执行的 A2A 任务会话/);
  assert.deepEqual(gateway.calls, [], 'nothing reaches the gateway');
});

test('the tools resolve the session to the job and attempt it runs, and show pending items for the agent', async t => {
  bindA2AExecution('exec-session', execution);
  t.after(() => unbindA2AExecution('exec-session'));
  const gateway = fakeGateway();
  const shown = await runTicketTool(gateway, 'exec-session', 'ticket_show');
  assert.deepEqual(gateway.calls[0], { method: 'ticket_show', params: { jobId: 'job-exec', attemptId: 'attempt-2', sessionId: 'exec-session', via: 'dsh' } });
  assert.match(shown, /P1-P2 \[必须改\] style\/font：程序检查 P2 未通过\n {2}证据：\[\{"path":"style\/font","message":"Arial"\}\]\n {2}上一次：executor done：改成了微软雅黑/);
  assert.match(shown, /Q1-1 \[建议改\] project\/oneLiner：太空泛\n {2}建议：写场景/);
  assert.doesNotMatch(shown, /Q1-2/, 'settled items are not pending');
  assert.match(shown, /待处理 2 条，任务单状态 in_revision，第 2 轮/);

  assert.match(await runTicketTool(gateway, 'exec-session', 'ticket_mark', { id: 'Q1-1', state: 'done', note: '改了' }), /Q1-1 已标为 done，还剩 2 条待处理/);
  assert.deepEqual(gateway.calls[1].params, { jobId: 'job-exec', attemptId: 'attempt-2', sessionId: 'exec-session', via: 'dsh', itemId: 'Q1-1', state: 'done', note: '改了' });
  assert.match(await runTicketTool(gateway, 'exec-session', 'ticket_submit'), /任务单已提交（第 2 轮）/);

  const refusing = fakeGateway(async () => { throw new Error('还有 2 条没处理：P1-P2、Q1-1'); });
  assert.equal(await runTicketTool(refusing, 'exec-session', 'ticket_submit'), '任务单操作被拒绝：还有 2 条没处理：P1-P2、Q1-1', 'the gateway’s rule reaches the agent as text');
});

test('the registered tools validate their arguments and act for the calling agent session', async t => {
  bindA2AExecution('tool-session', execution);
  t.after(() => unbindA2AExecution('tool-session'));
  const gateway = fakeGateway(), tools = ticketTools(gateway);
  assert.deepEqual(tools.map(tool => tool.name), ['ticket_show', 'ticket_mark', 'ticket_self_check', 'ticket_submit']);
  const mark = tools.find(tool => tool.name === 'ticket_mark');
  await assert.rejects(mark.execute({ id: 'Q1-1', state: 'verified', note: 'x' }, { agent: { id: 'tool-session' } }), /state/);
  assert.deepEqual(await mark.execute({ id: 'Q1-1', state: 'disputed', note: '仓库里就是这么写的' }, { agent: { id: 'tool-session' } }), { message: 'Q1-1 已标为 disputed，还剩 2 条待处理。' });
  assert.equal(gateway.calls.at(-1).params.sessionId, 'tool-session');
  const selfSpec = TICKET_TOOLS.find(tool => tool.name === 'ticket_self_check');
  assert.deepEqual(Object.keys(selfSpec.parameters).sort(), ['id', 'note', 'status']);
  assert.deepEqual(selfSpec.parameters.status.enum, ['pass', 'na']);
  const selfCheck = tools.find(tool => tool.name === 'ticket_self_check');
  await assert.rejects(selfCheck.execute({ id: 'A1', status: 'maybe', note: 'x' }, { agent: { id: 'tool-session' } }), /status/);
  assert.deepEqual(await selfCheck.execute({ id: 'A1', status: 'pass', note: '标题含受众' }, { agent: { id: 'tool-session' } }), { message: 'A1 已自检为 pass，还剩 0 条必填自检待完成。' });
  assert.deepEqual(gateway.calls.at(-1).params, { jobId: 'job-exec', attemptId: 'attempt-2', sessionId: 'tool-session', via: 'dsh', checkId: 'A1', status: 'pass', note: '标题含受众' });
  await assert.rejects(tools[0].execute({}, {}), /owning agent session/);
});

test('ticket_self_check reaches the gateway from the DSH tool and from the mcp channel', async t => {
  bindA2AExecution('exec-session', execution);
  t.after(() => unbindA2AExecution('exec-session'));
  const gateway = fakeGateway(async (method, params) => {
    if (method !== 'ticket_self_check') return ticket;
    const selfChecks = [{ id: 'A1', severity: 'must', state: params.checkId === 'A1' ? params.status : 'pending', rule: '受众' },
      { id: 'S1', severity: 'must', state: params.checkId === 'S1' ? params.status : 'pending', rule: '场景' }];
    return { ...ticket, selfChecks };
  });
  assert.match(await runTicketTool(gateway, 'exec-session', 'ticket_self_check', { id: 'A1', status: 'pass', note: '标题含受众' }), /A1 已自检为 pass，还剩 1 条必填自检待完成/);
  assert.equal(gateway.calls[0].params.via, 'dsh');
  assert.match(await runTicketTool(gateway, 'exec-session', 'ticket_self_check', { id: 'S1', status: 'na', note: '本题不适用' }, 'mcp'), /S1 已自检为 na，还剩 1 条必填自检待完成/);
  assert.deepEqual(gateway.calls[1].params, { jobId: 'job-exec', attemptId: 'attempt-2', sessionId: 'exec-session', via: 'mcp', checkId: 'S1', status: 'na', note: '本题不适用' });
});

test('review-mcp lists ticket_self_check and forwards its arguments on the ticket channel', async t => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ authorization: req.headers.authorization, session: req.headers['x-oneagents-session'], body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'A1 已自检为 pass，还剩 0 条必填自检待完成。' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/review-mcp.js', import.meta.url))], {
    env: { ...process.env, ONEAGENTS_REVIEW_URL: `http://127.0.0.1:${port}/review`, ONEAGENTS_TICKET_URL: `http://127.0.0.1:${port}/ticket`,
      ONEAGENTS_REVIEW_SESSION: 'exec-session', ONEAGENTS_REVIEW_TOKEN: 'mcp-token' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index; while ((index = buffer.indexOf('\n')) >= 0) { lines.push(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
  });
  t.after(() => { child.kill(); return new Promise(resolve => server.close(resolve)); });
  const ask = async message => {
    const before = lines.length;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const deadline = Date.now() + 5000;
    while (lines.length === before) {
      if (child.exitCode !== null) throw new Error(`review-mcp exited ${child.exitCode}: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`review-mcp timed out: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return JSON.parse(lines[before]);
  };
  const listed = await ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const spec = listed.result.tools.find(tool => tool.name === 'ticket_self_check');
  assert.deepEqual(spec.inputSchema.required.slice().sort(), ['id', 'note', 'status']);
  assert.deepEqual(spec.inputSchema.properties.status.enum, ['pass', 'na']);
  assert.equal(spec.inputSchema.additionalProperties, false);
  const called = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ticket_self_check', arguments: { id: 'A1', status: 'pass', note: '标题含受众' } } });
  assert.equal(called.result.isError, undefined);
  assert.match(called.result.content[0].text, /A1 已自检为 pass/);
  assert.equal(seen[0].authorization, 'Bearer mcp-token');
  assert.equal(seen[0].session, 'exec-session');
  assert.deepEqual(seen[0].body, { tool: 'ticket_self_check', arguments: { id: 'A1', status: 'pass', note: '标题含受众' } });
});

test('the gateway client posts to /invoke on the workbench origin with its token and surfaces the error', async t => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, authorization: req.headers.authorization, origin: req.headers.origin, body: JSON.parse(body) });
    const failing = JSON.parse(body).method === 'ticket_submit';
    res.writeHead(failing ? 400 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(failing ? { error: '现在不能提交' } : ticket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const gateway = createTicketGateway({ url: `http://127.0.0.1:${server.address().port}/workbench`, token: 'gw-token' });
  assert.deepEqual(await gateway.invoke('ticket_show', { jobId: 'j' }), ticket);
  assert.deepEqual(seen[0], { url: '/invoke', authorization: 'Bearer gw-token', origin: undefined, body: { method: 'ticket_show', params: { jobId: 'j' } } });
  await assert.rejects(gateway.invoke('ticket_submit', {}), /现在不能提交/);
});
