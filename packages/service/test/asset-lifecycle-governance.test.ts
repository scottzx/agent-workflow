import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runRolesCli } from '../bin/roles.js';
import { settler } from '../bin/ticket.js';
import { projectApprovals } from '../src/execution/approvals-view.js';
import { workbenchCases } from '../src/execution/case-view.js';
import { JobLedger } from '../src/execution/ledger.js';
import {
  GOVERNANCE_PROPOSAL_KINDS,
  invokeTicket,
  openTicket,
  qualityReviewSchema,
  raiseGovernanceProposal,
  setProposal,
  TicketError,
} from '../src/execution/ticket.js';
import { workbenchSnapshot } from '../src/execution/workbench.js';
import {
  ASSET_KINDS,
  AssetLifecycleError,
  AssetLifecycleStore,
  assertAssetWriteAllowed,
  computeAssetDigest,
  validateFormalDependencyClosure,
} from '../src/roles/index.js';
import { readRoleRules } from '../src/roles/role-rules.js';
import { validateSkillFrontmatter } from '../src/roles/worktree-projection.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

test('tracked pr-coach thin preset loads via readRoleRules and passes skill frontmatter validation', async () => {
  const rules = await readRoleRules({ projectRoot: repoRoot, roleId: 'pr-coach', phase: 'all' });
  assert.equal(rules.roleId, 'pr-coach');
  assert.equal(rules.profile.entrySkill, 'orchestrate');
  assert.deepEqual(rules.profile.skills.map(s => s.name), ['pr-orchestrate', 'local-deploy-verify', 'rsi-distill']);
  assert.ok(rules.checklist?.items.length === 3);
  assert.match(rules.roleInstructions ?? '', /trial \/ formal/);

  for (const skill of rules.profile.skills) {
    const skillFile = join(repoRoot, '.1agents/roles/pr-coach/skills', skill.name, 'SKILL.md');
    const content = await readFile(skillFile, 'utf8');
    const validated = validateSkillFrontmatter(content, skill.name);
    assert.equal(validated.name, skill.name);
    assert.ok(validated.description.length > 0);
  }
});

test('AssetLifecycleStore enforces trial/formal/evals boundaries, unidirectional formal closure, one-click fork and rollback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'asset-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new AssetLifecycleStore(dir);

  assert.deepEqual([...ASSET_KINDS], ['preset', 'check', 'rubric', 'dag']);

  // 1. Coach cannot write evals/ exam papers or formal snapshots; person can touch evals/.
  assert.throws(
    () => assertAssetWriteAllowed({ actor: 'coach', lifecycle: 'trial', relativePath: '.1agents/roles/pr-delivery/evals/manifest.json' }),
    (err: unknown) => err instanceof AssetLifecycleError && err.code === 'EVAL_EXAM_READONLY',
  );
  assert.throws(
    () => assertAssetWriteAllowed({ actor: 'coach', lifecycle: 'formal', relativePath: 'checks/l1-gate.mjs' }),
    (err: unknown) => err instanceof AssetLifecycleError && err.code === 'FORMAL_SNAPSHOT_IMMUTABLE',
  );
  await assert.rejects(
    store.saveTrialAsset({
      kind: 'check', id: 'bad-eval', content: '{}', relativePath: 'evals/manifest.json', version: '1.0.0', actor: 'coach',
    }),
    (err: unknown) => err instanceof AssetLifecycleError && err.code === 'EVAL_EXAM_READONLY',
  );

  // 2. Coach autonomously creates trial assets across all 4 kinds (check, rubric, preset, dag).
  const checkTrial = await store.saveTrialAsset({
    kind: 'check', id: 'l1-gate', content: 'check v1', relativePath: 'checks/l1-gate.mjs', version: '1.0.0', actor: 'coach',
  });
  const rubricTrial = await store.saveTrialAsset({
    kind: 'rubric', id: 'outline-rubric', content: '{"v":1}', relativePath: 'rubric.json', version: '1.0.0', actor: 'coach',
  });
  const dagTrial = await store.saveTrialAsset({
    kind: 'dag',
    id: 'delivery-dag',
    content: '{"entry":"implement"}',
    relativePath: 'workflow.json',
    version: '1.0.0',
    dependencies: [{ kind: 'check', id: 'l1-gate', digest: checkTrial.record.digest }],
    actor: 'coach',
  });
  const presetTrial = await store.saveTrialAsset({
    kind: 'preset',
    id: 'pr-coach',
    content: '# pr-coach v1',
    relativePath: 'ROLE.md',
    version: '1.0.0',
    dependencies: [
      { kind: 'dag', id: 'delivery-dag' },
      { kind: 'rubric', id: 'outline-rubric' },
    ],
    actor: 'coach',
  });
  assert.equal(checkTrial.record.lifecycle, 'trial');
  assert.equal(checkTrial.record.digest, computeAssetDigest('check v1'));

  // 3. Coach CANNOT self-promote to formal; person promoting DAG while its check dependency is still trial MUST FAIL (unidirectional formal closure).
  await assert.rejects(
    store.promoteTrialToFormal({ kind: 'check', id: 'l1-gate', actor: 'coach', evidence: 'self approve' }),
    (err: unknown) => err instanceof AssetLifecycleError && err.code === 'APPROVAL_REQUIRED',
  );
  await assert.rejects(
    store.promoteTrialToFormal({ kind: 'dag', id: 'delivery-dag', actor: 'person', evidence: 'promote dag early' }),
    (err: unknown) => err instanceof AssetLifecycleError && err.code === 'FORMAL_DEPENDENCY_VIOLATION',
  );

  // 4. Bottom-up formal promotion succeeds: check + rubric -> dag -> preset; formal snapshots are OS read-only (0o444).
  const checkFormal1 = await store.promoteTrialToFormal({ kind: 'check', id: 'l1-gate', actor: 'person', evidence: 'L3 calibrated' });
  const rubricFormal1 = await store.promoteTrialToFormal({ kind: 'rubric', id: 'outline-rubric', actor: 'person', evidence: 'alpha >= 0.8' });
  const dagFormal1 = await store.promoteTrialToFormal({ kind: 'dag', id: 'delivery-dag', actor: 'person', evidence: 'DAG verified' });
  const presetFormal1 = await store.promoteTrialToFormal({ kind: 'preset', id: 'pr-coach', actor: 'person', evidence: 'pairwise >= 0.6' });
  assert.equal(presetFormal1.record.lifecycle, 'formal');
  assert.equal((await stat(checkFormal1.snapshotPath)).mode & 0o777, 0o444);
  assert.equal(rubricFormal1.record.lifecycle, 'formal');
  assert.equal(dagFormal1.record.lifecycle, 'formal');
  await assert.rejects(
    store.attemptDirectFormalOverwrite('check', 'l1-gate', 'person'),
    (err: unknown) => err instanceof AssetLifecycleError && err.code === 'FORMAL_SNAPSHOT_IMMUTABLE',
  );

  // 5. One-click fork formal -> trial for a production fix, coach edits trial freely, person promotes v2, then instant rollback to v1!
  const forked = await store.forkTrialFromFormal({ kind: 'check', id: 'l1-gate', newVersion: '1.1.0-trial', actor: 'coach' });
  assert.equal(forked.record.lifecycle, 'trial');
  assert.equal(forked.record.forkedFromDigest, checkFormal1.record.digest);
  const checkTrialV2 = await store.saveTrialAsset({
    kind: 'check',
    id: 'l1-gate',
    content: 'check v2 hotfix',
    relativePath: 'checks/l1-gate.mjs',
    version: '1.1.0',
    forkedFromDigest: checkFormal1.record.digest,
    actor: 'coach',
  });
  const checkFormal2 = await store.promoteTrialToFormal({ kind: 'check', id: 'l1-gate', actor: 'person', evidence: 'v2 verified' });
  assert.equal(checkFormal2.record.digest, checkTrialV2.record.digest);

  // Instant rollback back to v1 formal snapshot!
  const rolledBack = await store.rollbackFormalSnapshot({
    kind: 'check', id: 'l1-gate', actor: 'person', reason: 'regression detected in prod',
  });
  assert.equal(rolledBack.record.digest, checkFormal1.record.digest);
  assert.equal(rolledBack.rolledBackFromDigest, checkFormal2.record.digest);

  // Direct closure validator also catches transitive trial reference.
  const mixedRegistry = new Map([
    ['check:leaf', checkTrial.record],
    ['dag:mid', { ...dagFormal1.record, id: 'mid', dependencies: [{ kind: 'check' as const, id: 'leaf' }] }],
  ]);
  const transitive = validateFormalDependencyClosure(
    { kind: 'preset', id: 'top', dependencies: [{ kind: 'dag', id: 'mid' }] },
    mixedRegistry,
  );
  assert.equal(transitive.ok, false);
  assert.match(transitive.violations[0] ?? '', /formal asset cannot depend on trial asset/);
});

test('two-key ticket proposals scope to eval_change / permission_escalation / promote_formal, require evidence, and reject batch or coach self-settlement', () => {
  assert.deepEqual([...GOVERNANCE_PROPOSAL_KINDS], ['eval_change', 'permission_escalation', 'promote_formal']);

  // qualityReviewSchema rejects governance proposals without evidence.
  assert.throws(() => qualityReviewSchema.parse({
    verdict: 'pass',
    summary: 'ok',
    scores: { 吸引力: 5 },
    issues: [],
    proposals: [{ kind: 'promote_formal', text: 'promote outline v2' }],
  }), /requires non-empty evidence/);

  const validReview = qualityReviewSchema.parse({
    verdict: 'pass',
    summary: 'ok',
    scores: { 吸引力: 5 },
    issues: [],
    proposals: [{ kind: 'eval_change', text: 'add PR #23 case', evidence: 'git commit 6a10f605..a2734d75 verified' }],
  });
  assert.equal(validReview.proposals?.[0]?.evidence, 'git commit 6a10f605..a2734d75 verified');

  // Direct ticket API: raiseGovernanceProposal + two-key settlement + reject batch settlement.
  const { ticket } = openTicket('pr-coach', 'case-1');
  assert.throws(
    () => raiseGovernanceProposal(ticket, { kind: 'promote_formal', text: 'promote', evidence: '   ' }),
    TicketError,
  );
  raiseGovernanceProposal(ticket, {
    kind: 'promote_formal',
    text: 'promote pr-delivery check v2',
    evidence: 'calibration.json passed=true, pairwise winRate=0.80',
  });
  raiseGovernanceProposal(ticket, {
    kind: 'permission_escalation',
    text: 'allow extra write path',
    evidence: 'needed for release manifest',
  });
  assert.equal(ticket.proposals.length, 2);

  // Coach cannot self-settle a governance proposal.
  assert.throws(
    () => setProposal(ticket, 'G1-1', 'accepted', 'self approve', { kind: 'coach', agent: 'antigravity', sessionId: 's1' }),
    /必须显式由人（person）双钥匙裁决/,
  );

  // Batch settlement forms (comma list, wildcard, 'all') are strictly rejected!
  for (const batchId of ['G1-1,G1-2', 'G1-1;G1-2', '*', 'all', 'G1-1 G1-2']) {
    assert.throws(
      () => setProposal(ticket, batchId, 'accepted', 'batch', { kind: 'person' }),
      /禁止批量结算/,
    );
  }

  // Ledger invokeTicket also rejects extra batch fields via strict schema.
  const ledger = new JobLedger(undefined, () => {});
  const prepared = ledger.prepare({ originSessionId: 'root', targetSnapshot: { targetId: 'host' }, input: {} });
  invokeTicket(ledger, 'ticket_open', { originSessionId: 'root', jobId: prepared.job.jobId, roleId: 'pr-coach', caseId: 'c1' });
  assert.throws(
    () => invokeTicket(ledger, 'ticket_proposal', {
      originSessionId: 'root', jobId: prepared.job.jobId, proposalIds: ['G1-1', 'G1-2'], state: 'accepted',
    }),
    /Unrecognized|Invalid|expected string/i,
  );

  // One-by-one human settlement succeeds!
  setProposal(ticket, 'G1-1', 'accepted', 'approved after reviewing evidence', { kind: 'person', via: 'page' });
  setProposal(ticket, 'G1-2', 'rejected', 'not needed', { kind: 'person', via: 'page' });
  assert.equal(ticket.proposals[0]!.state, 'accepted');
  assert.equal(ticket.proposals[1]!.state, 'rejected');

  // M1: omitting `by` on governance proposal MUST fail closed (no silent default to person), and DSH/Codex/OneAgents envs resolve to coach!
  assert.deepEqual(settler({ DSH_SESSION_ID: 'dsh-42' }), { kind: 'coach', agent: 'dsh', sessionId: 'dsh-42' });
  assert.deepEqual(settler({ ONEAGENTS_SESSION_ID: 'oa-9' }), { kind: 'coach', agent: 'oneagents', sessionId: 'oa-9' });
  assert.deepEqual(settler({ CODEX_THREAD_ID: 'codex-7' }), { kind: 'coach', agent: 'codex', sessionId: 'codex-7' });

  // M2 + M3: gateway RPC `ticket_proposal_raise` creates governance proposal, surfaces in Workbench Approvals + Case Inbox with evidence,
  // and `ticket_proposal` without explicit `by: { kind: 'person' }` fails closed!
  const raisedTicket = invokeTicket(ledger, 'ticket_proposal_raise', {
    originSessionId: 'root',
    jobId: prepared.job.jobId,
    kind: 'promote_formal',
    text: 'promote pr-delivery v2 to formal',
    evidence: 'calibration passed=true, eval-cr kappa=0.92, pairwise winRate=0.80',
    actor: 'coach',
  });
  assert.equal(raisedTicket.proposals.length, 1);
  const raisedId = raisedTicket.proposals[0]!.id;
  assert.equal(raisedTicket.proposals[0]!.evidence, 'calibration passed=true, eval-cr kappa=0.92, pairwise winRate=0.80');

  assert.throws(
    () => invokeTicket(ledger, 'ticket_proposal', {
      originSessionId: 'root',
      jobId: prepared.job.jobId,
      proposalId: raisedId,
      state: 'accepted',
      note: 'bypass attempt without by',
    }),
    /必须显式由人（person）双钥匙裁决/,
  );

  // Workbench approvals & case inbox surface governance proposal with evidence!
  const snapState = ledger.snapshot();
  snapState.jobs[prepared.job.jobId]!.caseId = 'c1';
  const source = { ledger: snapState, runs: [], reviews: [], actorId: 'person-1' };
  const approvals = projectApprovals(source);
  const govApproval = approvals.items.find(item => item.proposalId === raisedId);
  assert.ok(govApproval, 'promote_formal proposal must appear in workbench approvals queue');
  assert.equal(govApproval.proposalKind, 'promote_formal');
  assert.equal(govApproval.title, '晋升 formal 提议');
  assert.equal(govApproval.evidence, 'calibration passed=true, eval-cr kappa=0.92, pairwise winRate=0.80');

  const wb = workbenchSnapshot(source);
  const cases = workbenchCases(source, wb);
  const caseDetail = Object.values(cases.details)[0]!;
  const inboxGov = caseDetail.inbox.find(item => item.proposalId === raisedId);
  assert.ok(inboxGov, 'promote_formal proposal must appear in case inbox');
  assert.equal(inboxGov.evidence, 'calibration passed=true, eval-cr kappa=0.92, pairwise winRate=0.80');

  // Explicit person settler succeeds via gateway RPC!
  const settledTicket = invokeTicket(ledger, 'ticket_proposal', {
    originSessionId: 'root',
    jobId: prepared.job.jobId,
    proposalId: raisedId,
    state: 'accepted',
    note: 'verified evidence',
    by: { kind: 'person', via: 'page' },
  });
  assert.equal(settledTicket.proposals[0]!.state, 'accepted');
  assert.equal(settledTicket.proposals[0]!.by?.kind, 'person');

  // S2: QA review path (`ticket_review`) preserves governance proposal `evidence` into ticket & approvals.
  invokeTicket(ledger, 'ticket_checks', { originSessionId: 'root', jobId: prepared.job.jobId, results: [] });
  const reviewedTicket = invokeTicket(ledger, 'ticket_review', {
    originSessionId: 'root',
    jobId: prepared.job.jobId,
    review: {
      verdict: 'pass',
      summary: 'ok',
      scores: { 吸引力: 5 },
      issues: [],
      proposals: [{ kind: 'eval_change', text: 'add regression case', evidence: 'commit a1b2c3d4 verified' }],
    },
  });
  const qaGovProposal = reviewedTicket.proposals.find(p => p.kind === 'eval_change');
  assert.ok(qaGovProposal);
  assert.equal(qaGovProposal.evidence, 'commit a1b2c3d4 verified');
});

test('AssetLifecycleStore binds digest/rollback to real disk files, enforces OS 0o444 immutability, detects corrupt snapshots, and integrates with roles lifecycle CLI', async t => {
  // Isolate ambient coach harness env vars (e.g. DSH_SESSION_ID when tests run inside DSH!) so person CLI steps are deterministic.
  const coachEnvKeys = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'DSH_SESSION_ID', 'ONEAGENTS_SESSION_ID', 'CODEX_THREAD_ID'] as const;
  const savedEnv = Object.fromEntries(coachEnvKeys.map(k => [k, process.env[k]]));
  for (const k of coachEnvKeys) delete process.env[k];
  t.after(() => {
    for (const k of coachEnvKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const dir = await mkdtemp(join(tmpdir(), 'asset-lifecycle-disk-'));
  const roleDir = join(dir, 'role');
  const storeDir = join(dir, 'store');
  t.after(async () => {
    // Restore permissions on snapshots so rm succeeds cleanly.
    const store = new AssetLifecycleStore(storeDir);
    const st = await store.inspect().catch(() => null);
    if (st) {
      for (const rec of Object.values(st.formalHistory).flat()) {
        await chmod(store.formalSnapshotPath(rec.kind, rec.id, rec.digest), 0o644).catch(() => {});
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  const checkFile = join(roleDir, 'checks', 'l1-gate.mjs');
  await writeFile(join(dir, 'dummy'), ''); // ensure dir exists
  const store = new AssetLifecycleStore(storeDir);

  // Create real check file v1 on disk, save trial bound to sourceRoot (reads actual file bytes).
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(roleDir, 'checks'), { recursive: true });
  await writeFile(checkFile, 'export const version = 1;\n', 'utf8');

  const trialV1 = await store.saveTrialAsset({
    kind: 'check',
    id: 'l1-gate',
    sourceRoot: roleDir,
    relativePath: 'checks/l1-gate.mjs',
    version: '1.0.0',
    actor: 'coach',
  });
  assert.equal(trialV1.record.digest, computeAssetDigest('export const version = 1;\n'));

  const formalV1 = await store.promoteTrialToFormal({
    kind: 'check',
    id: 'l1-gate',
    actor: 'person',
    evidence: 'v1 calibrated',
  });

  // S4: Real OS write to 0o444 formal snapshot MUST fail with EACCES/EPERM (unless running as root).
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    await assert.rejects(
      writeFile(formalV1.snapshotPath, 'tampered', 'utf8'),
      (err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code;
        return code === 'EACCES' || code === 'EPERM';
      },
    );
  }

  // Update real file to v2, save trial, promote v2 via roles CLI, then rollback to v1 via roles CLI!
  await writeFile(checkFile, 'export const version = 2;\n', 'utf8');
  await runRolesCli([
    'lifecycle', 'save-trial',
    '--store', storeDir,
    '--role-dir', roleDir,
    '--kind', 'check',
    '--id', 'l1-gate',
    '--path', 'checks/l1-gate.mjs',
    '--version', '2.0.0',
  ]);

  // Simulate DSH coach trying to promote via CLI -> rejected with APPROVAL_REQUIRED!
  process.env.DSH_SESSION_ID = 'dsh-coach-99';
  try {
    await assert.rejects(
      runRolesCli([
        'lifecycle', 'promote',
        '--store', storeDir,
        '--kind', 'check',
        '--id', 'l1-gate',
        '--evidence', 'coach self promote',
      ]),
      (err: unknown) => err instanceof AssetLifecycleError && err.code === 'APPROVAL_REQUIRED',
    );
  } finally {
    delete process.env.DSH_SESSION_ID;
  }

  // Person promotes v2 via CLI, then rolls back to v1 restoring the real disk file!
  await runRolesCli([
    'lifecycle', 'promote',
    '--store', storeDir,
    '--kind', 'check',
    '--id', 'l1-gate',
    '--evidence', 'v2 approved by person',
  ]);
  await runRolesCli([
    'lifecycle', 'rollback',
    '--store', storeDir,
    '--role-dir', roleDir,
    '--kind', 'check',
    '--id', 'l1-gate',
    '--reason', 'prod regression',
  ]);
  assert.equal(await readFile(checkFile, 'utf8'), 'export const version = 1;\n', 'rollback must restore real file bytes on disk');

  // S4: Tampering a formal snapshot on disk MUST be detected as SNAPSHOT_CORRUPT on fork!
  await chmod(formalV1.snapshotPath, 0o644);
  await writeFile(formalV1.snapshotPath, 'CORRUPTED BYTES', 'utf8');
  await chmod(formalV1.snapshotPath, 0o444);
  await assert.rejects(
    store.forkTrialFromFormal({ kind: 'check', id: 'l1-gate', newVersion: '1.0.1-trial', actor: 'coach' }),
    (err: unknown) => err instanceof AssetLifecycleError && err.code === 'SNAPSHOT_CORRUPT',
  );
});
