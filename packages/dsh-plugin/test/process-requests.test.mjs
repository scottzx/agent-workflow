import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createWorkbenchProcessClient } from '../dist/process-requests.js';

async function recorder(t) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ requestId: 'prc-1', deadlineAt: '2026-10-28T03:00:00.000Z', status: 'pending' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}
const request = { jobId: 'job-1', attemptId: 'attempt-1', sessionId: 'dsh-1', kind: 'permission', toolTitle: 'python3 --version' };

test('a workbench without a token gets no bearer header; a configured token is sent', async t => {
  const open = await recorder(t);
  await createWorkbenchProcessClient({ url: open.url }).open(request);
  await createWorkbenchProcessClient({ url: open.url, token: 'workbench-secret' }).open(request);
  assert.deepEqual(open.seen, [undefined, 'Bearer workbench-secret']);
});
