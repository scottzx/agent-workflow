/**
 * Stage 1: L0 `@1agents/dreammate-network@0.6.0` vocabulary alignment, `MessageCorrelation` pass-through,
 * and BL-002 (`routing.json` `readOnly: true` -> OS-level read-only sandbox).
 *
 * Every case drives the real modules: the installed L0 package, the real gateway, a real
 * `createA2AServer` host, and a real HTTP session host. Reverting the production change must make the
 * matching case fail.
 */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SendMessageRequest } from '@a2a-js/sdk';
import { PROTOCOL_VERSION, type SessionDeliveryMode as L0SessionDeliveryMode } from '@1agents/dreammate-network';
import { parseA2AInput } from '../src/a2a/executor.js';
import { RemoteAgentGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import { createA2AServer } from '../src/a2a/server.js';
import { SessionDelivery, sessionSendSchema } from '../src/a2a/session-delivery.js';
import {
  messageCorrelationSchema, SESSION_DELIVERY_MODES, sessionHostSchema,
  type SessionDeliveryMode as ServiceSessionDeliveryMode,
} from '../src/a2a/session-hosts.js';
import { countPendingGovernanceProposals, projectDelegationMirror, toL0ExecutionStatus } from '../src/execution/delegation-mirror.js';
import type { Ticket } from '../src/execution/ticket.js';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';
import { PROTOCOL_VERSION as SERVICE_PROTOCOL_VERSION } from '../src/manifest.js';
import { testCapacity } from './capacity-fixture.js';

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, '../../..');
const prDeliveryRoleDir = join(repoRoot, '.1agents/roles/pr-delivery');

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function stop(server: Server): Promise<void> {
  const done = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await done;
}
async function until<T>(operation: () => Promise<T>, predicate: (result: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const result = await operation();
    if (predicate(result)) return result;
    if (Date.now() >= deadline) throw new Error(`deadline waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

interface HostAdmission { url: string; requestId: string; mode?: string; text: string; form?: string; correlation?: unknown }

/** A DSH session host stand-in that records the exact delivery envelope it admitted. */
async function recordingSessionHost(t: TestContext): Promise<{ calls: HostAdmission[]; url: string }> {
  const calls: HostAdmission[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}') as { rpcId?: string; payload?: { args?: { request?: Record<string, unknown> } } };
      const request = body.payload?.args?.request ?? {};
      const content = request.content as Array<{ text?: string }> | undefined;
      calls.push({
        url: req.url ?? '',
        requestId: String(request.requestId ?? ''),
        mode: typeof request.mode === 'string' ? request.mode : undefined,
        text: String(request.text ?? content?.[0]?.text ?? ''),
        form: typeof request.form === 'string' ? request.form : undefined,
        correlation: request.correlation,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }));
    })().catch(() => { if (!res.headersSent) { res.writeHead(400); res.end(); } });
  });
  await listen(server);
  t.after(() => stop(server));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { calls, url: `http://127.0.0.1:${address.port}` };
}

test('the installed L0 package is 0.6.0 and its delegation schema is the contract this projection targets', async () => {
  const installed = JSON.parse(await readFile(require.resolve('@1agents/dreammate-network/package.json'), 'utf8')) as { version: string };
  assert.equal(installed.version, '0.6.0', 'the workspace must resolve the published 0.6.0, never a file: link');
  assert.equal(PROTOCOL_VERSION, '0.6.0');
  assert.equal(SERVICE_PROTOCOL_VERSION, '0.6.0', 'the service manifest reports the same L0 version it is built against');
  const schema = JSON.parse(await readFile(
    require.resolve('@1agents/dreammate-network/schemas/delegation.schema.json'), 'utf8')) as {
      required: string[]; properties: Record<string, { type?: string | string[] }>;
    };
  assert.deepEqual(schema.required, ['job_id', 'updated_at']);
  assert.equal(Object.hasOwn(schema.properties, 'a2a_task_id'), true);
  assert.equal(Object.hasOwn(schema.properties, 'task_id'), false, 'L0 deliberately has no task_id inside a delegation');
});

test('every internal execution state maps onto the six L0 states and an unknown member degrades to failed', () => {
  const expected: Record<string, string> = {
    not_started: 'queued', submitted: 'queued', working: 'running', input_required: 'waiting_for_user',
    auth_required: 'waiting_for_user', completed: 'completed', failed: 'failed', rejected: 'failed',
    canceled: 'canceled', unknown: 'failed',
  };
  assert.equal(Object.keys(expected).length, 10, '1acp has ten internal states');
  for (const [internal, l0] of Object.entries(expected)) {
    assert.equal(toL0ExecutionStatus(internal as Parameters<typeof toL0ExecutionStatus>[0]), l0, `${internal} -> ${l0}`);
  }
  // L0 0.x may add enum members; a consumer must not crash on one it has never seen.
  assert.equal((toL0ExecutionStatus as (status: string) => string)('brand_new_1acp_state'), 'failed');
  assert.equal((toL0ExecutionStatus as (status: string) => string)(''), 'failed');
});

/** Minimal structural check against the L0 schema document just read from the installed package. */
async function assertValidDelegationMirror(mirror: Record<string, unknown>): Promise<void> {
  const schema = JSON.parse(await readFile(
    require.resolve('@1agents/dreammate-network/schemas/delegation.schema.json'), 'utf8')) as {
      required: string[]; properties: Record<string, { type?: string | string[]; minimum?: number }>;
    };
  const declared = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(mirror)) {
    assert.ok(/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(key), `${key} is not snake_case`);
    assert.ok(declared.has(key), `delegation.schema.json has no property ${key}`);
    const rule = schema.properties[key]!;
    const value = mirror[key];
    const types: string[] = rule.type === undefined ? ['string', 'null'] : (Array.isArray(rule.type) ? rule.type : [rule.type]);
    if (value === null) { assert.ok(types.includes('null'), `${key} must accept null`); continue; }
    if (types.includes('integer')) assert.ok(Number.isInteger(value), `${key} must be an integer`);
    else assert.equal(typeof value, 'string', `${key} must be a string or null`);
    if (typeof rule.minimum === 'number' && typeof value === 'number') assert.ok(value >= rule.minimum, `${key} >= ${rule.minimum}`);
  }
  for (const required of schema.required) assert.ok(Object.hasOwn(mirror, required), `missing required ${required}`);
  assert.equal(Object.hasOwn(mirror, 'task_id'), false, 'a delegation mirror must never carry task_id');
  assert.doesNotMatch(JSON.stringify(mirror), /"task_id":/, 'task_id must not appear as its own key');
  assert.ok(!Number.isNaN(Date.parse(String(mirror.updated_at))), 'updated_at must be a date-time');
  const vocabularies: Record<string, string[]> = {
    lifecycle_mode: ['trial', 'formal'],
    status: ['queued', 'running', 'waiting_for_user', 'completed', 'failed', 'canceled'],
    review_status: ['pending', 'accepted', 'changes_requested'],
  };
  for (const [key, allowed] of Object.entries(vocabularies)) {
    const value = mirror[key];
    if (value === null) continue;
    assert.ok(allowed.includes(String(value)), `${key}=${String(value)} is outside the L0 vocabulary`);
  }
}

const ticketWithProposals = {
  schemaVersion: 1, roleId: 'pr-delivery', caseId: 'case-1', status: 'in_review', round: 2,
  items: [], history: [],
  proposals: [
    { id: 'G2-1', kind: 'promote_formal', text: '升为正式', evidence: '验收记录', raisedInRound: 2, state: 'open' },
    { id: 'G2-2', kind: 'eval_change', text: '改考题', evidence: '差异说明', raisedInRound: 2, state: 'accepted' },
    { id: 'R2-1', kind: 'role', text: '调整角色说明', raisedInRound: 2, state: 'open' },
    { id: 'G2-3', kind: 'permission_escalation', text: '放宽权限', evidence: '风险评估', raisedInRound: 2, state: 'open' },
  ],
} as unknown as Ticket;

test('projectDelegationMirror emits a snake_case L0 mirror with a2a_task_id, review status and open governance count', async () => {
  const job = { jobId: 'job-0ba07988', targetId: 'legacy:dsh-superagent', roleId: 'pr-delivery', resultRevision: 'rev-6', updatedAt: '2026-11-28T10:01:00.230Z' };
  const attempt = {
    attemptId: 'attempt-1', executionStatus: 'working' as const, updatedAt: '2026-11-28T10:00:59.000Z',
    backendRunRef: { taskId: 'a2a-task-8f21c0', sessionId: 'session://scott-mac/codex/01a0907c' },
    result: { resultRevision: 'rev-7', resultDigest: `sha256:${'9f2c1e'.repeat(10)}` },
  };
  assert.equal(countPendingGovernanceProposals(ticketWithProposals), 2,
    'only open proposals of the three governance kinds count: the accepted one and the legacy role proposal do not');
  const mirror = projectDelegationMirror({
    job, attempt, ticket: ticketWithProposals,
    acceptance: { reviewStatus: 'changes_requested' },
    pendingApprovalId: 'approval-31', lifecycleMode: 'formal',
  }) as unknown as Record<string, unknown>;

  assert.equal(mirror.job_id, 'job-0ba07988');
  assert.equal(mirror.attempt_id, 'attempt-1');
  assert.equal(mirror.a2a_task_id, 'a2a-task-8f21c0', 'the remote id travels as a2a_task_id');
  assert.equal(mirror.session_id, 'session://scott-mac/codex/01a0907c');
  assert.equal(mirror.target_id, 'legacy:dsh-superagent');
  assert.equal(mirror.role_id, 'pr-delivery');
  assert.equal(mirror.lifecycle_mode, 'formal');
  assert.equal(mirror.status, 'running', 'working maps to the L0 running state');
  assert.equal(mirror.result_revision, 'rev-7');
  assert.equal(mirror.result_digest, `sha256:${'9f2c1e'.repeat(10)}`);
  assert.equal(mirror.review_status, 'changes_requested');
  assert.equal(mirror.pending_approval_id, 'approval-31');
  assert.equal(mirror.pending_proposal_count, 2);
  assert.equal(mirror.updated_at, '2026-11-28T10:01:00.230Z');
  await assertValidDelegationMirror(mirror);

  // A bare job keeps every L0 key present and null rather than dropping it.
  const bare = projectDelegationMirror({ job: { jobId: 'job-7771c0de', targetId: 'legacy:drill', updatedAt: '2026-11-28T09:00:00.000Z' } }) as unknown as Record<string, unknown>;
  assert.equal(bare.status, null);
  assert.equal(bare.a2a_task_id, null);
  assert.equal(bare.review_status, null);
  assert.equal(bare.pending_proposal_count, 0);
  await assertValidDelegationMirror(bare);

  // A failed round still mirrors the L0 failed state, never a 1acp-only word.
  const rejected = projectDelegationMirror({
    job: { jobId: 'job-1', targetId: 'legacy:drill', updatedAt: '2026-11-28T09:00:00.000Z' },
    attempt: { attemptId: 'attempt-2', executionStatus: 'rejected', updatedAt: '2026-11-28T09:00:00.000Z' },
  }) as unknown as Record<string, unknown>;
  assert.equal(rejected.status, 'failed');
  await assertValidDelegationMirror(rejected);
});

test('messageCorrelationSchema rejects unknown keys, blanks, non-strings, control characters and over-long values', () => {
  assert.deepEqual(messageCorrelationSchema.parse({ job_id: ' job-1 ' }), { job_id: 'job-1' });
  assert.deepEqual(messageCorrelationSchema.parse({}), {});
  const cases: unknown[] = [
    { bogus: 'x' },
    { job_id: '   ' },
    { job_id: 7 },
    { job_id: 'a\0b' },
    { a2a_task_id: 'a'.repeat(513) },
    { job_id: null },
  ];
  for (const [index, input] of cases.entries()) {
    assert.throws(() => messageCorrelationSchema.parse(input), `case ${index} must be rejected`);
  }
  // Old saved deliveries never carried the field; it stays optional in the wire schema.
  const parsed = sessionSendSchema.parse({ originSessionId: 'o', messageId: 'm', text: 'x' });
  assert.equal('correlation' in parsed, false);
});

test('the delivery mode tuple is the L0 vocabulary and the runtime schema is pinned to it', () => {
  // Compile-time proof: the service tuple and its alias both stay inside the published L0 type.
  const fitsL0: readonly L0SessionDeliveryMode[] = SESSION_DELIVERY_MODES;
  const sameAlias: (mode: ServiceSessionDeliveryMode) => L0SessionDeliveryMode = mode => mode;
  assert.equal(fitsL0.length, 2);
  assert.equal(sameAlias('steer'), 'steer');
  assert.deepEqual([...SESSION_DELIVERY_MODES], ['queue', 'steer']);

  // Runtime proof: the zod enum is built from that tuple, so a mode the L0 vocabulary does not have
  // is rejected before anything reaches a host queue.
  for (const mode of SESSION_DELIVERY_MODES) {
    assert.equal(sessionSendSchema.parse({ originSessionId: 'o', messageId: 'm', text: 'x', mode }).mode, mode);
  }
  for (const widening of ['steer-then-queue', 'interrupt', 'QUEUE', '', 'steer ']) {
    assert.throws(
      () => sessionSendSchema.parse({ originSessionId: 'o', messageId: 'm', text: 'x', mode: widening }),
      `mode ${JSON.stringify(widening)} is outside the L0 vocabulary`,
    );
  }
});

test('an empty correlation object is normalised to absent instead of being persisted or forwarded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage1-empty-correlation-'));
  const host = await recordingSessionHost(t);
  const gateway = new RemoteAgentGateway({
    stateDirectory: root, port: 0, remotes: {}, pollIntervalMs: 60_000,
    sessionHosts: { dsh: sessionHostSchema.parse({ kind: 'dsh', url: host.url, timeoutMs: 2_000 }) },
  });
  t.after(() => gateway.close());
  await gateway.invoke('session_bind', { originSessionId: 'owner-origin', host: 'dsh', sessionId: 'owner-session' });

  const sent = await gateway.invoke('session_message_send', {
    fromSessionId: 'sender-a', toSessionId: 'owner-session', messageId: 'session-msg:empty-corr', text: '没有上下文的留言',
    correlation: {},
  }) as { correlation?: unknown; receipt: Record<string, unknown> };
  assert.equal('correlation' in sent, false, 'the top-level session_message_send reply must not echo an empty correlation');
  assert.equal('correlation' in sent.receipt, false, 'the delivery receipt must not carry an empty correlation');

  const receipt = gateway.sessions.get({ originSessionId: 'owner-origin', messageId: 'session-msg:empty-corr' });
  assert.equal(Object.hasOwn(receipt, 'correlation'), false);
  const persisted = JSON.parse(await readFile(join(root, 'session-delivery.json'), 'utf8')) as {
    deliveries: Array<Record<string, unknown>>;
  };
  const stored = persisted.deliveries.find(item => item.messageId === 'session-msg:empty-corr')!;
  assert.equal(Object.hasOwn(stored, 'correlation'), false, 'session-delivery.json must not store an empty correlation');

  await gateway.sessions.reconcile();
  const admission = await until(async () => host.calls.length, count => count >= 1, 'the uncorrelated host admission');
  assert.ok(admission >= 1);
  assert.equal(host.calls[0]!.correlation, undefined, 'the host envelope carries no correlation key at all');

  // An empty context is the same context: replaying the message stays idempotent.
  const before = gateway.sessions.summary().deliveries.total;
  await gateway.invoke('session_message_send', {
    fromSessionId: 'sender-a', toSessionId: 'owner-session', messageId: 'session-msg:empty-corr', text: '没有上下文的留言',
    correlation: {},
  });
  assert.equal(gateway.sessions.summary().deliveries.total, before);
  // ... and it is not the same message as one that names a context.
  await assert.rejects(
    gateway.invoke('session_message_send', {
      fromSessionId: 'sender-a', toSessionId: 'owner-session', messageId: 'session-msg:empty-corr', text: '没有上下文的留言',
      correlation: { job_id: 'job-1' },
    }),
    /different content/,
  );
  // A state file written by an older version may already contain `correlation: {}`; loading it drops
  // the empty object from memory, from the receipt and from the bytes on disk.
  const legacyRoot = join(root, 'legacy-empty-correlation');
  const legacyHost = sessionHostSchema.parse({ kind: 'dsh', url: host.url, timeoutMs: 2_000 });
  const legacy = new SessionDelivery(legacyRoot, { dsh: legacyHost });
  legacy.bind({ originSessionId: 'legacy-origin', host: 'dsh', sessionId: 'legacy-session' });
  legacy.enqueue({ originSessionId: 'legacy-origin', messageId: 'legacy-empty-corr', text: '旧的空上下文' });
  await legacy.close();
  const legacyFile = join(legacyRoot, 'session-delivery.json');
  const legacyState = JSON.parse(await readFile(legacyFile, 'utf8')) as { deliveries: Array<Record<string, unknown>> };
  legacyState.deliveries[0]!.correlation = {};
  await writeFile(legacyFile, JSON.stringify(legacyState));
  const reopened = new SessionDelivery(legacyRoot, { dsh: legacyHost });
  t.after(() => reopened.close());
  assert.equal(Object.hasOwn(reopened.get({ originSessionId: 'legacy-origin', messageId: 'legacy-empty-corr' }), 'correlation'), false);
  const rewritten = JSON.parse(await readFile(legacyFile, 'utf8')) as { deliveries: Array<Record<string, unknown>> };
  assert.equal(Object.hasOwn(rewritten.deliveries[0]!, 'correlation'), false, 'loading rewrites the empty object away');
  // ... and the same content stays idempotent instead of looking like a different context.
  assert.equal(reopened.enqueue({ originSessionId: 'legacy-origin', messageId: 'legacy-empty-corr', text: '旧的空上下文' }).messageId, 'legacy-empty-corr');

  // Cleanup runs after the gateway and host close hooks registered above.
  t.after(() => rm(root, { recursive: true, force: true }));
});

test('session_message_send carries correlation to the DSH envelope, keeps it on the receipt, and fails closed on a malformed one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage1-correlation-'));
  const host = await recordingSessionHost(t);
  const config: A2AGatewayConfig = {
    stateDirectory: root, port: 0, remotes: {}, pollIntervalMs: 60_000,
    sessionHosts: { dsh: sessionHostSchema.parse({ kind: 'dsh', url: host.url, timeoutMs: 2_000 }) },
  };
  const gateway = new RemoteAgentGateway(config);
  t.after(() => gateway.close());
  await gateway.invoke('session_bind', { originSessionId: 'owner-origin', host: 'dsh', sessionId: 'owner-session' });

  const total = (): number => {
    const summary = gateway.sessions.summary();
    return summary.deliveries.total + summary.subscriberDeliveries.total;
  };

  const sent = await gateway.invoke('session_message_send', {
    fromSessionId: 'sender-a', toSessionId: 'owner-session', messageId: 'session-msg:corr-1', text: '带着上下文的留言',
    correlation: { job_id: 'job-1', a2a_task_id: 'a2a-task-1', pending_approval_id: 'approval-1' },
  }) as { messageId: string; correlation?: Record<string, string> };
  assert.deepEqual(sent.correlation, { job_id: 'job-1', a2a_task_id: 'a2a-task-1', pending_approval_id: 'approval-1' });
  const receipt = gateway.sessions.get({ originSessionId: 'owner-origin', messageId: 'session-msg:corr-1' });
  assert.deepEqual(receipt.correlation, { job_id: 'job-1', a2a_task_id: 'a2a-task-1', pending_approval_id: 'approval-1' });
  const persisted = JSON.parse(await readFile(join(root, 'session-delivery.json'), 'utf8')) as {
    deliveries: Array<{ messageId: string; correlation?: unknown }>;
  };
  assert.deepEqual(persisted.deliveries.find(item => item.messageId === 'session-msg:corr-1')?.correlation,
    { job_id: 'job-1', a2a_task_id: 'a2a-task-1', pending_approval_id: 'approval-1' });

  await gateway.sessions.reconcile();
  const admission = await until(async () => host.calls.length, count => count >= 1, 'the correlated host admission');
  assert.ok(admission >= 1);
  assert.deepEqual(host.calls[0]!.correlation, { job_id: 'job-1', a2a_task_id: 'a2a-task-1', pending_approval_id: 'approval-1' });

  // Reusing the same message id for a different context is a content conflict, not a silent overwrite.
  await assert.rejects(
    gateway.invoke('session_message_send', {
      fromSessionId: 'sender-a', toSessionId: 'owner-session', messageId: 'session-msg:corr-1', text: '带着上下文的留言',
      correlation: { job_id: 'job-2' },
    }),
    /different content/,
  );
  // Replaying the identical request is idempotent and re-delivers nothing.
  const before = total();
  const replay = await gateway.invoke('session_message_send', {
    fromSessionId: 'sender-a', toSessionId: 'owner-session', messageId: 'session-msg:corr-1', text: '带着上下文的留言',
    correlation: { job_id: 'job-1', a2a_task_id: 'a2a-task-1', pending_approval_id: 'approval-1' },
  }) as { messageId: string };
  assert.equal(replay.messageId, 'session-msg:corr-1');
  assert.equal(total(), before);

  const rejects: Array<[string, unknown, RegExp]> = [
    ['unknown key', { bogus: 'x' }, /Unrecognized key/],
    ['blank value', { job_id: '   ' }, /Too small/],
    ['non-string value', { job_id: 7 }, /expected string/],
    ['control character', { job_id: 'a\u0000b' }, /printable/],
    ['over-long value', { a2a_task_id: 'a'.repeat(513) }, /Too big/],
    ['null value', { pending_approval_id: null }, /expected string/],
    ['not an object', 'job-1', /Invalid input|expected object/],
  ];
  for (const [label, correlation, expected] of rejects) {
    await assert.rejects(
      gateway.invoke('session_message_send', { fromSessionId: 'sender-a', toSessionId: 'owner-session', text: 'x', correlation }),
      expected, label,
    );
  }
  assert.equal(total(), before, 'every malformed correlation is rejected before anything is persisted');

  // An old session-delivery.json without the field still loads and reads back.
  const legacyRoot = join(root, 'legacy-state');
  const first = new SessionDelivery(legacyRoot, { dsh: sessionHostSchema.parse({ kind: 'dsh', url: host.url, timeoutMs: 2_000 }) });
  first.bind({ originSessionId: 'legacy-origin', host: 'dsh', sessionId: 'legacy-session' });
  first.enqueue({ originSessionId: 'legacy-origin', messageId: 'legacy-1', text: '旧记录' });
  await first.close();
  const legacyFile = join(legacyRoot, 'session-delivery.json');
  const legacyState = JSON.parse(await readFile(legacyFile, 'utf8')) as { deliveries: Array<Record<string, unknown>> };
  assert.equal(Object.hasOwn(legacyState.deliveries[0]!, 'correlation'), false, 'the pre-0.6.0 file has no such key');
  const reopened = new SessionDelivery(legacyRoot, { dsh: sessionHostSchema.parse({ kind: 'dsh', url: host.url, timeoutMs: 2_000 }) });
  t.after(() => reopened.close());
  assert.equal(reopened.get({ originSessionId: 'legacy-origin', messageId: 'legacy-1' }).correlation, undefined);
  // Cleanup is registered last: node:test runs after hooks in registration order, so the hosts and the
  // gateway must be closed before the state directory disappears.
  t.after(() => rm(root, { recursive: true, force: true }));
});

/** An A2A backend whose runs stay pending, so a process request can be opened while the job is working. */
class PendingBackend implements A2ABackend {
  readonly prepared: A2APrepareInput[] = [];
  private nextSession = 0;
  private readonly pending: Array<() => void> = [];
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    this.prepared.push(structuredClone(input));
    return { sessionId: input.sessionId ?? `remote-session-${++this.nextSession}`, cwd: input.cwd!, agentPreset: input.agentPreset };
  }
  async run(): Promise<A2ARunResult> {
    return new Promise<A2ARunResult>(resolve => this.pending.push(() => resolve({ outcome: 'completed', text: 'done' })));
  }
  release(): void { while (this.pending.length) this.pending.pop()!(); }
}

async function startRemoteA2A(t: TestContext, backend: A2ABackend & { release?: () => void }, directory: string): Promise<string> {
  const capacity = testCapacity(directory);
  let a2a: Awaited<ReturnType<typeof createA2AServer>>;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/.well-known/agent-card.json') { a2a.cardHandler(req, res); return; }
    void a2a.handler(req, res);
  });
  const url = await listen(server);
  a2a = await createA2AServer({
    backend, capacity, publicUrl: url, stateDirectory: join(directory, 'remote-a2a'),
    token: 'remote-secret-token', defaultAgentPreset: 'standard',
  });
  // Release the backend's pending runs before closing, so teardown can never wait on a synthetic turn.
  t.after(async () => { backend.release?.(); await a2a.close(); await stop(server); });
  return url;
}

test('a process-request steer wakeup names its job, remote A2A task and pending approval', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stage1-process-correlation-'));
  const host = await recordingSessionHost(t);
  const backend = new PendingBackend();
  const remoteUrl = await startRemoteA2A(t, backend, dir);
  const gateway = new RemoteAgentGateway({
    stateDirectory: join(dir, 'gateway'), port: 0, pollIntervalMs: 60_000,
    remotes: { drill: { url: remoteUrl, token: 'remote-secret-token' } },
    sessionHosts: { dsh: sessionHostSchema.parse({ kind: 'dsh', url: host.url, timeoutMs: 2_000 }) },
    workbench: { token: 'test-wb-token', reviewerId: 'owner-1', reviewerName: 'Owner' },
  });
  t.after(() => gateway.close());
  await gateway.invoke('session_bind', { originSessionId: 'origin-drill', host: 'dsh', sessionId: 'origin-drill' });

  const submitted = await gateway.invoke('execution_submit', {
    originSessionId: 'origin-drill', targetId: 'legacy:drill', title: '带审批的任务',
    input: { cwd: dir, prompt: 'Wait for an approval', agentPreset: 'standard' },
  }) as { jobId: string; attemptId: string; error?: string };
  assert.equal(submitted.error, undefined, submitted.error);
  await until(async () => backend.prepared.length, count => count >= 1, 'the remote admission');
  const remoteTaskId = (await gateway.invoke('execution_get', { originSessionId: 'origin-drill', jobId: submitted.jobId }) as { taskId?: string }).taskId;
  assert.ok(remoteTaskId, 'the gateway recorded the remote A2A task id');

  const created = await gateway.openProcessRequest(submitted.jobId, {
    requestId: 'prc-stage1-1', jobId: submitted.jobId, attemptId: submitted.attemptId,
    sessionId: 'remote-session-1', kind: 'permission', toolTitle: 'bash',
  });
  assert.equal(created.requestId, 'prc-stage1-1');
  await gateway.sessions.reconcile();
  // The host admission is addressed by its own deterministic message id, so the approval is identified by its text.
  const wake = await until(async () => host.calls.find(call => call.text.includes('prc-stage1-1')),
    call => Boolean(call), 'the steer wakeup admission');
  assert.equal(wake!.mode, 'steer', 'a process request interrupts rather than queues');
  assert.equal(wake!.url, '/api/1agents-acp/session/deliver');
  assert.deepEqual(wake!.correlation, {
    job_id: submitted.jobId,
    a2a_task_id: remoteTaskId,
    pending_approval_id: 'prc-stage1-1',
  });
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 50)); await rm(dir, { recursive: true, force: true }); });
});

test('parseA2AInput accepts only sandboxMode "read-only" and rejects every widening value before a session exists', () => {
  const build = (sandboxMode: unknown) => SendMessageRequest.fromJSON({
    message: { messageId: 'msg-1', role: 'ROLE_USER', parts: [{ text: 'review this change' }] },
    metadata: { '1agents': { cwd: '/tmp/project', sandboxMode } },
  });
  const parsed = parseA2AInput(build('read-only'), {});
  assert.equal(parsed.input.sandboxMode, 'read-only');
  assert.equal('sandboxMode' in parseA2AInput(build(undefined), {}).input, false, 'an omitted sandbox adds no field');

  for (const widening of ['danger-full-access', 'workspace-write', 'read_only', '', ' read-only', 'READ-ONLY', 7, null, true, ['read-only']]) {
    assert.throws(() => parseA2AInput(build(widening), {}), /sandboxMode may only be "read-only"/,
      `${JSON.stringify(widening)} must never widen a remote caller's permissions`);
  }
});

test('a readOnly: true reviewer route dispatches sandboxMode read-only, while the worker route sends none', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stage1-readonly-route-'));
  const workDir = join(dir, 'work');
  await mkdir(join(workDir, '.1agents', 'roles', 'pr-delivery'), { recursive: true });
  await cp(join(prDeliveryRoleDir, 'routing.json'), join(workDir, '.1agents', 'roles', 'pr-delivery', 'routing.json'));

  const backend = new PendingBackend();
  const remoteUrl = await startRemoteA2A(t, backend, dir);
  const gateway = new RemoteAgentGateway({
    stateDirectory: join(dir, 'gateway'), port: 0, pollIntervalMs: 60_000,
    remotes: { drill: { url: remoteUrl, token: 'remote-secret-token' } },
    capacityDirectory: testCapacity(dir).directory,
  });
  t.after(() => gateway.close());

  const worker = await gateway.invoke('execution_submit', {
    originSessionId: 'origin-drill', targetId: 'legacy:drill',
    input: { cwd: workDir, routingRoleId: 'pr-delivery', routingSlot: 'worker', prompt: 'Run the implementation', agentPreset: 'standard' },
  }) as { jobId: string; attemptId: string; routing?: { selected: { readOnly?: boolean } }; error?: string };
  assert.equal(worker.error, undefined, worker.error);
  await until(async () => backend.prepared.length, count => count >= 1, 'the worker admission');
  const workerInput = backend.prepared[0]!;
  assert.equal(workerInput.sandboxMode, undefined, 'a writable worker route must not be narrowed or widened');
  assert.equal(worker.routing?.selected.readOnly, undefined);

  const reviewer = await gateway.invoke('execution_submit', {
    originSessionId: 'origin-drill', targetId: 'legacy:drill',
    input: {
      cwd: workDir, routingRoleId: 'pr-delivery', routingSlot: 'reviewer', peerJobId: worker.jobId,
      prompt: 'Run the independent read-only CR', agentPreset: 'standard',
    },
  }) as { jobId: string; attemptId: string; routing?: { selected: { readOnly?: boolean } }; error?: string };
  assert.equal(reviewer.error, undefined, reviewer.error);
  await until(async () => backend.prepared.length, count => count >= 2, 'the reviewer admission');
  const reviewerInput = backend.prepared[1]!;
  assert.equal(reviewer.routing?.selected.readOnly, true, 'routing.json marks this slot readOnly');
  assert.equal(reviewerInput.sandboxMode, 'read-only',
    'the readOnly routing candidate reaches the DSH backend as an OS-level read-only sandbox');

  // The mirror is opt-in: the default execution_get view keeps its old shape.
  const plain = await gateway.invoke('execution_get', { originSessionId: 'origin-drill', jobId: reviewer.jobId }) as Record<string, unknown>;
  assert.equal('delegationMirror' in plain, false);
  const withMirror = await gateway.invoke('execution_get', {
    originSessionId: 'origin-drill', jobId: reviewer.jobId, includeDelegationMirror: true,
  }) as { delegationMirror?: Record<string, unknown> };
  assert.ok(withMirror.delegationMirror, 'includeDelegationMirror adds the L0 projection');
  await assertValidDelegationMirror(withMirror.delegationMirror!);
  assert.equal(withMirror.delegationMirror!.job_id, reviewer.jobId);
  assert.equal(withMirror.delegationMirror!.a2a_task_id, (plain as { taskId?: string }).taskId);
  assert.ok(['queued', 'running', 'waiting_for_user', 'completed', 'failed', 'canceled']
    .includes(String(withMirror.delegationMirror!.status)));
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 50)); await rm(dir, { recursive: true, force: true }); });
});
