import assert from 'node:assert/strict';
import test from 'node:test';
import { Task } from '@a2a-js/sdk';
import { artifactLinks, formatNotice, formatNoticeSummary, formatProcessRequestNotice, formatProcessRequestSummary, type RemoteAgentNotice } from '../src/a2a/notices.js';

const notice: RemoteAgentNotice = {
  noticeId: 'synthetic-notice', originSessionId: 'synthetic-origin', remote: 'synthetic-remote',
  taskId: 'synthetic-task', contextId: 'synthetic-context', cwd: '/synthetic',
  state: 'TASK_STATE_COMPLETED', result: '已完成排版。\n\n[下载演示文稿](https://example.test/deck.pptx)', createdAt: new Date(0).toISOString(),
};

test('completion notifications lead with the final answer and attachment links, with acknowledgement locators at the end', () => {
  const text = formatNotice({ ...notice, artifactLinks: [{ name: '预览 [PDF]', url: 'https://example.test/preview.pdf' }] });
  assert.ok(text.startsWith('[A2A任务通知] 任务已完成\n'));
  assert.ok(text.includes(notice.result));
  assert.ok(text.includes('[预览 \\[PDF\\]](<https://example.test/preview.pdf>)'));
  assert.ok(text.indexOf(notice.result) < text.indexOf('任务定位信息：'));
  assert.ok(text.indexOf('https://example.test/preview.pdf') < text.indexOf('任务定位信息：'));
  assert.match(text, /remote_agent_get.*remote_agent_inbox/);
  assert.match(text, /保存处理结论后调用 remote_agent_ack/);
  assert.deepEqual(JSON.parse(text.split('\n').at(-1)!), {
    noticeId: notice.noticeId, originSessionId: notice.originSessionId, remote: notice.remote,
    taskId: notice.taskId, contextId: notice.contextId, state: notice.state,
  });
});

test('explicit A2A URL parts preserve attachment identity and media type, without inventing links for binary or data parts', () => {
  const task = Task.fromJSON({ id: 'synthetic-task', artifacts: [{ name: '交付文件', parts: [
    { url: 'https://example.test/deck.pptx', filename: 'deck.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    { url: 'https://example.test/deck.pptx' },
    { url: 'https://example.test/preview.pdf' },
    { url: 'javascript:alert(1)' }, { url: 'https://synthetic:credential@example.test/private' },
    { raw: 'c3ludGhldGlj' }, { data: { path: '/remote/private.pptx' } },
  ] }] });
  assert.deepEqual(artifactLinks(task), [
    { name: 'deck.pptx', url: 'https://example.test/deck.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    { name: '交付文件', url: 'https://example.test/preview.pdf' },
  ]);
});

test('failure and missing final answers remain accurately labelled and queryable', () => {
  assert.match(formatNotice({ ...notice, state: 'TASK_STATE_FAILED', result: '远端执行失败：合成测试错误。' }), /^\[A2A任务通知\] 任务失败\n\n远端执行失败/);
  const empty = formatNotice({ ...notice, state: 'TASK_STATE_INPUT_REQUIRED', result: '' });
  assert.match(empty, /任务需要补充输入/);
  assert.match(empty, /尚未提供答复正文/);
  assert.match(empty, /remote_agent_get/);
  assert.match(empty, /remote_agent_ack/);
  assert.ok(!empty.includes('任务已完成'));
});

test('large multibyte answers and many attachments are bounded with explicit full-result query guidance', () => {
  const text = formatNotice({ ...notice, result: '中文🙂'.repeat(40000), artifactLinks: Array.from({ length: 20 }, (_, i) => ({
    name: `产物 ${i}`, url: `https://example.test/${'a'.repeat(1800)}/${i}.pptx`,
  })) });
  assert.ok(Buffer.byteLength(text) < 64 * 1024);
  assert.ok(!text.includes('\uFFFD'));
  assert.match(text, /正文较长.*节选/);
  assert.match(text, /更多产物链接/);
  assert.equal(JSON.parse(text.split('\n').at(-1)!).taskId, notice.taskId);
});

test('process request wakeup wraps tool permission, plan and question in a bounded system-reminder with locator JSON', () => {
  const deadlineAt = '2026-11-25T02:40:00.000Z';
  const perm = formatProcessRequestNotice({
    originSessionId: 'origin-1', jobId: 'job-1', attemptId: 'att-1', requestId: 'prc-1',
    title: '实现 MCP 服务', kind: 'permission', toolTitle: 'run_command', toolDetail: '{"cmd":"pnpm test"}', deadlineAt,
  });
  assert.ok(perm.startsWith('<system-reminder>\n[A2A过程审批] 子任务等待工具权限批准\n'));
  assert.ok(perm.endsWith('\n</system-reminder>'));
  assert.match(perm, /工具：run_command/);
  assert.match(perm, /mcp-a2a-approval\.a2a_process_answer/);
  assert.match(perm, /跳过 dreammate_search_tools \/ dreammate_inspect/);
  assert.match(perm, /execution_process_answer/);
  const lines = perm.split('\n');
  assert.deepEqual(JSON.parse(lines.at(-2)!), {
    kind: 'permission', originSessionId: 'origin-1', jobId: 'job-1', attemptId: 'att-1', requestId: 'prc-1', deadlineAt,
  });

  const oversized = formatProcessRequestNotice({
    originSessionId: 'origin-1', jobId: 'job-1', attemptId: 'att-1', requestId: 'prc-2',
    kind: 'plan', planContent: '计划内容🙂'.repeat(4000), deadlineAt,
  });
  assert.ok(Buffer.byteLength(oversized) < 16 * 1024);
  assert.ok(!oversized.includes('\uFFFD'));
  assert.match(oversized, /内容较长.*节选/);

  const question = formatProcessRequestNotice({
    originSessionId: 'origin-1', jobId: 'job-1', attemptId: 'att-1', requestId: 'prc-3',
    kind: 'question', questions: [{ id: '0', question: '目标环境？', options: [{ label: 'local' }, { label: 'network' }] }], deadlineAt,
  });
  assert.match(question, /子任务等待问题答复/);
  assert.match(question, /1\. 目标环境？（选项：local \/ network）/);
  assert.match(question, /outcome="accepted"/);

  assert.equal(
    formatProcessRequestSummary({ originSessionId: 'o', jobId: 'j', attemptId: 'a', requestId: 'r', title: '实现 MCP', kind: 'permission', toolTitle: 'bash', deadlineAt }),
    'A2A过程审批 · 工具「bash」等待批准（实现 MCP）',
  );
  const capped = formatProcessRequestSummary({
    originSessionId: 'o', jobId: 'j', attemptId: 'a', requestId: 'r', title: '很长的标题'.repeat(40), kind: 'plan', deadlineAt,
  });
  assert.equal(capped.length, 120);
  assert.ok(capped.endsWith('…'));
  assert.equal(formatNoticeSummary({ ...notice, title: '方案B实测' }), 'A2A任务通知 · 任务已完成（方案B实测）');
  assert.equal(formatNoticeSummary({ ...notice, state: 'TASK_STATE_CANCELED', title: '方案B实测' }), 'A2A任务通知 · 任务已取消（方案B实测）');
});
