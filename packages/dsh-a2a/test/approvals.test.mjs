import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadlessDshBackend } from '../src/executor.js';

for (const decision of ['approved', 'rejected', 'expired']) test(`SDK runtime waits for workbench approval: ${decision}`, { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-approval-'));
  let opened, polls = 0;
  const gateway = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url.endsWith('/process-requests')) {
      opened = JSON.parse(body); res.end(JSON.stringify({ requestId: opened.requestId }));
    } else if (req.method === 'GET') {
      polls++;
      res.end(JSON.stringify({ requestId: opened.requestId, jobId: 'job', status: polls === 1 ? 'pending' : decision === 'expired' ? 'expired' : 'answered', deadlineAt: new Date(Date.now() + 5000).toISOString(), answer: { outcome: decision } }));
    } else res.end('{}');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => gateway.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const script = join(dir, 'sdk.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline';let session,wait;const send=x=>console.log(JSON.stringify(x));createInterface({input:process.stdin}).on('line',l=>{const q=JSON.parse(l),reply=result=>send({jsonrpc:'2.0',id:q.id,result});if(q.method==='initialize'){if(!q.params.approvalRequests)process.exit(2);reply({serverInfo:{name:'deepseek-harness-sdk-runtime'}})}else if(q.method==='session/query'){if(q.params.contentBlocks[0].text!=='/permission workspace-write')process.exit(3);reply({kind:'command'})}else if(q.method==='session/prompt'){session=q.params.sessionId;reply({messageId:'m'});send({jsonrpc:'2.0',id:'approval',method:'approval/request',params:{sessionId:session,toolName:'bash',callId:'call',reason:'needs write'}})}else if(q.method==='session/wait')wait=q.id;else if(q.id==='approval'){send({method:'session.event',params:{sessionId:session,event:{type:'assistant/message',data:{message:{content:[{type:'text',text:q.result.outcome}]}}}}});send({method:'session.event',params:{sessionId:session,event:{type:'turn/end',data:{reason:{kind:'completed'}}}}});send({id:wait,result:{}})}else if(q.method==='shutdown'){reply({});process.exit(0)}});`);
  const backend = new HeadlessDshBackend({ directory: join(dir, 'sessions'), mode: 'sdk', permissionMode: 'workspace-write', command: process.execPath, args: [script], provider: 'test', model: 'model', workbench: { url: `http://127.0.0.1:${gateway.address().port}`, pollMs: 5 } });
  const target = await backend.prepare({ cwd: dir });
  const result = await backend.run(target, 'run', { signal: new AbortController().signal, execution: { jobId: 'job', attemptId: 'attempt' } });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, decision === 'approved' ? 'allowed-once' : decision === 'rejected' ? 'rejected' : 'cancelled');
  assert.equal(opened.kind, 'permission'); assert.equal(opened.sessionId, target.sessionId); assert.ok(polls >= 2);
});
