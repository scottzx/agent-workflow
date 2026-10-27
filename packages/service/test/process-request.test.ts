import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SendMessageRequest } from '@a2a-js/sdk';
import { bindA2AExecution, currentA2AExecution, unbindA2AExecution } from '../src/a2a/execution-binding.js';
import { parseA2AInput } from '../src/a2a/executor.js';
import { answerProcessRequest, createProcessRequest, expireProcessRequest, PROCESS_REQUEST_TTL_MS, ProcessRequestError, projectProcessRequest, sameProcessRequest } from '../src/execution/process-request.js';

const at = new Date('2026-10-27T02:00:00.000Z');
const question = { requestId: 'prc-1', jobId: 'job-1', attemptId: 'attempt-1', sessionId: 'dsh-1', kind: 'question' as const,
  questions: [{ id: '0', question: 'Choose targets', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] };

test('process request answers are idempotent and a mismatched replay conflicts', () => {
  const request = createProcessRequest(question, at);
  assert.equal(Date.parse(request.deadlineAt) - at.getTime(), PROCESS_REQUEST_TTL_MS);
  const answer = { clientRequestId: 'wb-1', outcome: 'accepted' as const, answers: { 'Choose targets': ['A', 'B'] } };
  const first = answerProcessRequest(request, answer, new Date(at.getTime() + 1000));
  assert.equal(first.idempotent, false); assert.equal(first.request.status, 'answered');
  const replay = answerProcessRequest(first.request, answer, new Date(at.getTime() + 2000));
  assert.equal(replay.idempotent, true); assert.equal(replay.request.answer?.at, first.request.answer?.at);
  assert.throws(() => answerProcessRequest(first.request, { ...answer, answers: { 'Choose targets': 'A' } }), (error: ProcessRequestError) => error.code === 'idempotency_conflict');
  assert.throws(() => answerProcessRequest(first.request, { ...answer, clientRequestId: 'wb-2' }), (error: ProcessRequestError) => error.code === 'already_decided');
  assert.throws(() => answerProcessRequest(request, { clientRequestId: 'wb-3', outcome: 'approved' }), (error: ProcessRequestError) => error.code === 'invalid');
});

test('a late answer expires the request and reading does not rewrite a pending record', () => {
  const request = createProcessRequest(question, at);
  const late = new Date(at.getTime() + PROCESS_REQUEST_TTL_MS + 1);
  assert.throws(() => answerProcessRequest(request, { clientRequestId: 'wb-late', outcome: 'accepted', answers: { 'Choose targets': ['A'] } }, late), (error: ProcessRequestError) => error.code === 'expired');
  assert.equal(request.status, 'pending');
  const expired = expireProcessRequest(request, late);
  assert.equal(expired.status, 'expired'); assert.equal(request.status, 'pending');
  assert.throws(() => answerProcessRequest(expired, { clientRequestId: 'wb-late', outcome: 'cancelled' }, late), (error: ProcessRequestError) => error.code === 'expired');
  const viewed = projectProcessRequest(request, late.getTime());
  assert.equal(viewed.status, 'expired'); assert.equal(request.status, 'pending');
  assert.equal(sameProcessRequest(request, { ...question, questions: [{ id: '0', question: 'Other' }] }), false);
});

test('plan approval has no question answers and cancellation closes the request', () => {
  const request = createProcessRequest({ ...question, requestId: 'prc-plan', kind: 'plan', questions: undefined, planContent: 'Read the project' }, at);
  assert.equal(request.questions, undefined);
  const approved = answerProcessRequest(request, { clientRequestId: 'wb-plan', outcome: 'approved' }, at);
  assert.equal(approved.request.status, 'answered');
  const cancelled = answerProcessRequest(createProcessRequest({ ...question, requestId: 'prc-cancel' }, at), { clientRequestId: 'dsh-cancel:prc-cancel', outcome: 'cancelled' }, at);
  assert.equal(cancelled.request.status, 'cancelled');
  assert.throws(() => answerProcessRequest(request, { clientRequestId: 'wb-bad', outcome: 'approved', answers: { note: 'extra' } }), (error: ProcessRequestError) => error.code === 'invalid');
});

test('execution metadata reaches the run options and cannot carry extra fields', () => {
  const request = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'work' }] },
    metadata: { '1agents': { cwd: '/tmp/project', execution: { jobId: ' job-1 ', attemptId: 'attempt-1', token: 'secret' } } } });
  assert.throws(() => parseA2AInput(request, {}), /Unknown metadata\.1agents\.execution field/);
  request.metadata = { '1agents': { cwd: '/tmp/project', execution: { jobId: ' job-1 ', attemptId: 'attempt-1' } } };
  const parsed = parseA2AInput(request, {});
  assert.deepEqual(parsed.execution, { jobId: 'job-1', attemptId: 'attempt-1' });
  assert.equal(parsed.input.cwd, '/tmp/project');
  assert.equal('execution' in parsed.input, false);
  request.metadata = { '1agents': { sessionId: 'injected-session' } };
  assert.throws(() => parseA2AInput(request, {}), /Unknown metadata/);
});

test('an execution binding is replaced only by its own attempt', () => {
  const sessionId = `binding-${randomUUID()}`;
  bindA2AExecution(sessionId, { jobId: 'job-1', attemptId: 'attempt-1' });
  assert.deepEqual(currentA2AExecution(sessionId), { jobId: 'job-1', attemptId: 'attempt-1' });
  unbindA2AExecution(sessionId, { jobId: 'job-2', attemptId: 'attempt-2' });
  assert.deepEqual(currentA2AExecution(sessionId), { jobId: 'job-1', attemptId: 'attempt-1' });
  unbindA2AExecution(sessionId, { jobId: 'job-1', attemptId: 'attempt-1' });
  assert.equal(currentA2AExecution(sessionId), undefined);
});
