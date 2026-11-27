import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { markSelfCheck, openTicket, submitTicket } from '../src/execution/ticket.js';
import {
  effectiveEnforcement, loadChecklist, parseChecklist, renderExecutorChecklistPrompt, renderQaChecklistPrompt, toTicketSelfChecks,
} from '../src/rsi/checklist.js';
import { expandCheckRefs, firstRoundSubmitGate, loadWorkflow, runRoundDag, workflowSchema, type WorkflowNode } from '../src/rsi/engine.js';
import { worktreeConfigSchema } from '../src/rsi/worktree.js';

const ROLE = resolve(import.meta.dirname, '../../../.1agents/roles/product-intro-outline');

const v1 = {
  schemaVersion: 1, roleId: 'legacy',
  outlineTemplate: { locked: true, sections: ['positioning'] },
  program: { run: 'checks/check_outline.py', schema: 'checks/outline.schema.json' },
  items: [
    { id: 'P1', type: 'program', source: 'norm', severity: 'block', locked: true, rule: '符合 schema' },
    { id: 'P5', type: 'program', severity: 'block', locked: true, rule: '出处存在', selfCheck: true },
    { id: 'A1', type: 'agent', source: 'task', severity: 'block', locked: true, rule: '出处支持说法', evidence: '写页标题和行号' },
    { id: 'S1', type: 'agent', severity: 'should', locked: false, rule: '可跳过', modePolicy: { trial: 'skip', formal: 'observe' } },
  ],
};

function workflow(nodes: WorkflowNode[], enforce = { trial: false, formal: true }) {
  return workflowSchema.parse({
    schemaVersion: 1, entry: nodes[0]!.id, nodes,
    cycles: {
      programBounce: { from: 'l1_crosscheck', to: 'produce', when: 'block_failed' },
      qaRevise: { from: 'l2_crosscheck', to: 'produce', when: 'verdict_revise' },
    },
    policies: {
      trial: { maxProgramBounces: 1, maxQaRevisions: 3, enforceObserveAsBlock: enforce.trial, requireQa: true, collectProposals: true, allowExternalHandoff: false },
      formal: { maxProgramBounces: 2, maxQaRevisions: 2, enforceObserveAsBlock: enforce.formal, requireQa: true, collectProposals: false, allowExternalHandoff: true },
    },
  });
}

test('v1 checklists normalize into the v2 model and v2 files parse as themselves', async () => {
  const legacy = parseChecklist(v1);
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.program?.schema, 'checks/outline.schema.json');
  assert.deepEqual(legacy.items.map(item => [item.id, item.kind, item.severity, item.legacyType, item.evidenceHint, item.selfCheck]), [
    ['P1', 'program', 'must', 'program', undefined, undefined],
    ['P5', 'program', 'must', 'program', undefined, true],
    ['A1', 'self_and_qa', 'must', 'agent', '写页标题和行号', undefined],
    ['S1', 'self_and_qa', 'should', 'agent', undefined, undefined],
  ]);
  assert.throws(() => parseChecklist({ schemaVersion: 3, roleId: 'x', items: [] }), /schemaVersion 1 or 2/);

  const current = await loadChecklist(ROLE);
  assert.equal(current.schemaVersion, 2);
  assert.deepEqual(current.artifacts, ['outline.json']);
  assert.equal(current.program?.run, 'checks/check_outline.py');
  assert.deepEqual(current.outlineTemplate?.sections, ['positioning', 'features', 'architecture', 'getting_started', 'screenshots']);
  assert.equal(current.items.find(item => item.id === 'A1')?.kind, 'self_and_qa');
  assert.equal(current.items.find(item => item.id === 'P1')?.kind, 'program');
  assert.ok(current.items.find(item => item.id === 'P9')?.nonGoals?.length);
  const loaded = await loadWorkflow(ROLE);
  assert.equal(loaded.nodes.find(node => node.id === 'produce')?.requireTicketSubmit, false);
  assert.deepEqual(loaded.nodes.map(node => node.id), ['produce', 'check_schema', 'check_rules', 'check_digest', 'l1_crosscheck', 'qa_review', 'l2_crosscheck']);
  assert.deepEqual(expandCheckRefs(['P1', 'P2..P15'], current.items.map(item => item.id)), ['P1', ...Array.from({ length: 14 }, (_, index) => `P${index + 2}`)]);
});

test('mode policy, ticket self-checks and prompt projection follow trial versus formal', () => {
  const checklist = parseChecklist({
    schemaVersion: 2, roleId: 'demo', artifacts: ['outline.json'],
    items: [
      { id: 'P1', kind: 'program', severity: 'must', locked: true, rule: 'schema', selfCheck: true, modePolicy: { trial: 'observe', formal: 'observe' } },
      { id: 'P9', kind: 'program', severity: 'must', locked: true, rule: '无占位', nonGoals: ['待确认不是占位'], modePolicy: { trial: 'skip' } },
      { id: 'S1', kind: 'self', severity: 'must', locked: true, rule: '核对标题', evidenceHint: '写出标题' },
      { id: 'A1', kind: 'self_and_qa', severity: 'should', locked: true, rule: '出处支持说法', modePolicy: { trial: 'skip', formal: 'block' } },
    ],
  });
  assert.equal(effectiveEnforcement(checklist.items[0]!, 'trial'), 'observe');
  assert.equal(effectiveEnforcement(checklist.items[0]!, 'trial', true), 'block');
  assert.equal(effectiveEnforcement(checklist.items[0]!, 'formal', true), 'block');
  assert.deepEqual(toTicketSelfChecks(checklist, 'trial').map(item => item.id), ['P1', 'S1']);
  assert.deepEqual(toTicketSelfChecks(checklist, 'formal').map(item => [item.id, item.kind]), [['P1', 'program'], ['S1', 'self'], ['A1', 'self_and_qa']]);
  assert.deepEqual(toTicketSelfChecks(checklist, 'formal', true).filter(item => item.id === 'P1').map(item => item.severity), ['must']);

  const executor = renderExecutorChecklistPrompt(checklist, 'trial');
  assert.match(executor, /S1/); assert.match(executor, /核对标题/); assert.match(executor, /写出标题/);
  assert.match(executor, /P1/); assert.doesNotMatch(executor, /P9/);
  const qa = renderQaChecklistPrompt(checklist, 'formal');
  assert.match(qa, /程序已查项/); assert.match(qa, /不拦：待确认不是占位/);
  assert.match(qa, /selfCheckAudit/); assert.match(qa, /A1/); assert.match(qa, /P9/);
  const qaTrial = renderQaChecklistPrompt(checklist, 'trial');
  assert.doesNotMatch(qaTrial, /P9/); assert.match(qaTrial, /（无）/);
});

test('nodes in one topological layer run concurrently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-dag-'));
  let started = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const slow = (id: string) => async () => {
    started += 1;
    if (started === 2) release();
    await both;
    return { output: { id } };
  };
  const graph = workflow([
    { id: 'check_schema', type: 'program_check', checks: ['P1'] },
    { id: 'check_rules', type: 'program_check', checks: ['P2'], dependsOn: ['check_schema'] },
    { id: 'check_digest', type: 'artifact_digest_check', dependsOn: ['check_schema'] },
  ]);
  const result = await Promise.race([
    runRoundDag({
      workflow: graph, round: 1, workDirectory: root, mode: 'trial',
      handlersById: {
        check_schema: async () => ({ results: [{ itemId: 'P1', pass: true, evidence: [] }] }),
        check_rules: slow('rules'),
        check_digest: slow('digest'),
      },
    }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('checks did not overlap')), 1000)),
  ]);
  assert.equal(started, 2);
  assert.deepEqual(result.records.map(record => record.status), ['completed', 'completed', 'completed']);
});

test('a failed upstream skips every dependent and names the failed node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-dag-skip-'));
  const calls: string[] = [];
  const graph = workflow([
    { id: 'check_schema', type: 'program_check', checks: ['P1'] },
    { id: 'check_rules', type: 'program_check', checks: ['P2..P4'], dependsOn: ['check_schema'] },
    { id: 'check_digest', type: 'artifact_digest_check', dependsOn: ['check_schema'] },
    { id: 'l1_crosscheck', type: 'ticket_apply_checks', dependsOn: ['check_rules', 'check_digest'] },
  ]);
  const result = await runRoundDag({
    workflow: graph, round: 1, workDirectory: root, mode: 'formal',
    handlersByType: {
      program_check: async ctx => {
        calls.push(ctx.node.id);
        return ctx.node.id === 'check_schema'
          ? { results: [{ itemId: 'P1', pass: false, evidence: [{ message: 'schema' }] }] }
          : { results: [{ itemId: 'P2', pass: true, evidence: [] }] };
      },
      artifact_digest_check: async () => { calls.push('check_digest'); return { results: [] }; },
      ticket_apply_checks: async () => { calls.push('l1_crosscheck'); return { status: 'completed' }; },
    },
  });
  assert.deepEqual(calls, ['check_schema']);
  assert.equal(result.blocked, true);
  assert.equal(result.checksPassed, false);
  assert.equal(result.records.find(record => record.nodeId === 'check_rules')?.skipReason, 'upstream failed: check_schema');
  assert.equal(result.records.find(record => record.nodeId === 'check_digest')?.skipReason, 'upstream failed: check_schema');
  assert.match(result.records.find(record => record.nodeId === 'l1_crosscheck')?.skipReason ?? '', /^upstream skipped: /);
});

test('trial observe does not block the round; formal promote-to-block does', async () => {
  const checklist = parseChecklist({
    schemaVersion: 2, roleId: 'demo', artifacts: ['out.json'],
    items: [{ id: 'P9', kind: 'program', severity: 'must', locked: true, rule: '无占位', modePolicy: { trial: 'observe', formal: 'observe' } }],
  });
  const graph = workflow([
    { id: 'check_rules', type: 'program_check', checks: ['P9'] },
    { id: 'l1_crosscheck', type: 'ticket_apply_checks', dependsOn: ['check_rules'] },
  ]);
  const run = (mode: 'trial' | 'formal') => runRoundDag({
    workflow: graph, round: 1, workDirectory: join(tmpdir(), `rsi-dag-${mode}-${Date.now()}`), mode, checklist,
    handlersByType: {
      program_check: async () => ({ results: [{ itemId: 'P9', pass: false, evidence: [{ message: 'TODO' }] }] }),
      ticket_apply_checks: async () => ({ status: 'completed' as const }),
    },
  });
  const trial = await run('trial');
  assert.equal(trial.blocked, false);
  assert.equal(trial.records.find(record => record.nodeId === 'check_rules')?.status, 'completed');
  assert.equal(trial.records.find(record => record.nodeId === 'l1_crosscheck')?.status, 'completed');
  const formal = await run('formal');
  assert.equal(formal.blocked, true);
  assert.equal(formal.records.find(record => record.nodeId === 'check_rules')?.status, 'failed');
  assert.equal(formal.records.find(record => record.nodeId === 'l1_crosscheck')?.status, 'skipped');
  assert.equal(formal.records.find(record => record.nodeId === 'l1_crosscheck')?.skipReason, 'upstream failed: check_rules');
});

test('a completed (round, nodeId, inputDigest) is reused and not executed again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-dag-cache-'));
  let calls = 0;
  const graph = workflow([
    { id: 'check_schema', type: 'program_check', checks: ['P1'] },
    { id: 'check_rules', type: 'program_check', checks: ['P2'], dependsOn: ['check_schema'] },
  ]);
  const options = {
    workflow: graph, workDirectory: root, mode: 'trial' as const,
    handlersByType: { program_check: async (ctx: { node: { id: string } }) => { calls += 1; return { output: { node: ctx.node.id, token: 'once' } }; } },
  };
  const first = await runRoundDag({ ...options, round: 1 });
  const second = await runRoundDag({ ...options, round: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(second.records.map(record => record.cached), [true, true]);
  assert.deepEqual(second.records.map(record => (record.output as { token: string }).token), ['once', 'once']);
  assert.equal(first.records[0]!.inputDigest, second.records[0]!.inputDigest);
  const third = await runRoundDag({ ...options, round: 2 });
  assert.equal(calls, 4);
  assert.equal(third.records[0]!.cached, undefined);
  const state = JSON.parse(await readFile(join(root, 'run-state.json'), 'utf8')) as { nodes: { round: number; nodeId: string; cached?: boolean }[] };
  assert.ok(state.nodes.some(node => node.round === 1 && node.nodeId === 'check_schema' && node.cached === true));
});

test('checks_passed skips when an upstream completed with a blocking failure, and requireTicketSubmit bounces only a pending first round', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-dag-when-'));
  const graph = workflow([
    { id: 'l1_crosscheck', type: 'ticket_apply_checks' },
    { id: 'qa_review', type: 'qa_session_review', dependsOn: ['l1_crosscheck'], when: 'checks_passed' },
  ]);
  const skipped = await runRoundDag({
    workflow: graph, round: 1, workDirectory: root, mode: 'trial',
    precompleted: [{ round: 1, nodeId: 'l1_crosscheck', inputDigest: 'l1', status: 'completed', blockingFailure: true, startedAt: 't', finishedAt: 't' }],
    handlersByType: { qa_session_review: async () => { throw new Error('qa should not run'); } },
  });
  assert.equal(skipped.records.find(record => record.nodeId === 'qa_review')?.skipReason, 'checks_passed not satisfied');

  const opened = openTicket('role', 'demo', undefined, { selfChecks: [{ id: 'S1', kind: 'self', severity: 'must', rule: '核对标题' }] });
  assert.deepEqual(firstRoundSubmitGate({ requireTicketSubmit: true, round: 1, ticket: opened.ticket }), { bounce: true, problems: ['还没有提交任务单（必填自检未打卡 S1）'] });
  markSelfCheck(opened.ticket, 'S1', 'pass', '标题与 README 一致');
  submitTicket(opened.ticket);
  assert.equal(firstRoundSubmitGate({ requireTicketSubmit: true, round: 1, ticket: opened.ticket }).bounce, false);
  assert.equal(firstRoundSubmitGate({ requireTicketSubmit: false, round: 1, ticket: openTicket('role', 'demo', undefined, { selfChecks: [{ id: 'S1', kind: 'self', severity: 'must', rule: '核对标题' }] }).ticket }).bounce, false);
  assert.equal(firstRoundSubmitGate({ requireTicketSubmit: true, round: 1, ticket: openTicket('role', 'demo').ticket }).bounce, false);
  assert.equal(firstRoundSubmitGate({ requireTicketSubmit: true, round: 2, ticket: opened.ticket }).bounce, false);

  const withWorkspace = workflowSchema.parse({
    ...graph, workspace: worktreeConfigSchema.parse({
      strategy: 'git_worktree', root: '.1agents/runtime/worktrees', baseBranch: 'main', branchTemplate: 'rsi/${caseId}/${stage}',
      dependencySetup: 'pnpm_offline', mergePolicy: { trial: 'keep_isolated', formal: 'ff_or_merge_on_accepted' }, cleanupOnMerge: true,
    }),
  });
  assert.equal(withWorkspace.workspace?.mergePolicy.formal, 'ff_or_merge_on_accepted');
});
