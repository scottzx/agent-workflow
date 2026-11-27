/**
 * One round of a role's check/review micro-DAG. Nodes in the same ready layer run together.
 * A failed upstream skips its dependents. A completed (round, nodeId, inputDigest) is reused on resume.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CheckResult, Ticket } from '../execution/ticket.js';
import { pendingSelfChecks } from '../execution/ticket.js';
import { effectiveEnforcement, type CheckEnforcement, type NormalizedChecklist, type RsiMode } from './checklist.js';
import { worktreeConfigSchema } from './worktree.js';

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['executor_turn', 'program_check', 'artifact_digest_check', 'ticket_apply_checks', 'qa_session_review', 'ticket_apply_review', 'learnings_lookup']),
  dependsOn: z.array(z.string().min(1)).optional(),
  checks: z.array(z.string().min(1)).optional(),
  when: z.enum(['checks_passed', 'always']).optional(),
  requireTicketSubmit: z.boolean().optional(),
}).strict();

const policySchema = z.object({
  maxProgramBounces: z.number().int().nonnegative(),
  maxQaRevisions: z.number().int().nonnegative(),
  enforceObserveAsBlock: z.boolean(),
  requireQa: z.boolean(),
  collectProposals: z.boolean(),
  allowExternalHandoff: z.boolean(),
}).strict();

export const workflowSchema = z.object({
  schemaVersion: z.literal(1),
  entry: z.string().min(1),
  nodes: z.array(nodeSchema).min(1),
  cycles: z.object({
    programBounce: z.object({ from: z.string().min(1), to: z.string().min(1), when: z.literal('block_failed') }).strict(),
    qaRevise: z.object({ from: z.string().min(1), to: z.string().min(1), when: z.literal('verdict_revise') }).strict(),
  }).strict(),
  policies: z.object({ trial: policySchema, formal: policySchema }).strict(),
  workspace: worktreeConfigSchema.optional(),
}).strict();

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowNode = Workflow['nodes'][number];
export type WorkflowPolicy = Workflow['policies']['trial'];
export type NodeStatus = 'completed' | 'failed' | 'skipped';

export interface NodeRecord {
  round: number;
  nodeId: string;
  inputDigest: string;
  status: NodeStatus;
  startedAt: string;
  finishedAt: string;
  output?: unknown;
  error?: string;
  skipReason?: string;
  cached?: boolean;
  blockingFailure?: boolean;
}

export interface RunStateFile {
  schemaVersion: 1;
  nodes: NodeRecord[];
}

export interface NodeHandlerResult {
  status?: 'completed' | 'failed';
  output?: unknown;
  error?: string;
  results?: CheckResult[];
}

export interface NodeRunContext {
  round: number;
  node: WorkflowNode;
  mode: RsiMode;
  policy: WorkflowPolicy;
  upstream: ReadonlyMap<string, NodeRecord>;
  inputDigest: string;
  checklist?: NormalizedChecklist;
  checkIds: string[];
}

export type NodeHandler = (ctx: NodeRunContext) => Promise<NodeHandlerResult>;

export interface RoundDagResult {
  records: NodeRecord[];
  /** True when a blocking check failed or a node failed hard enough to trip programBounce. */
  blocked: boolean;
  checksPassed: boolean;
  state: RunStateFile;
}

export interface RunRoundDagOptions {
  workflow: Workflow;
  round: number;
  workDirectory: string;
  mode: RsiMode;
  checklist?: NormalizedChecklist;
  /** Defaults to the workflow's nodes. Outline runs pass the check subgraph and drive QA outside. */
  nodes?: WorkflowNode[];
  handlersById?: Partial<Record<string, NodeHandler>>;
  handlersByType?: Partial<Record<WorkflowNode['type'], NodeHandler>>;
  inputDigest?: (node: WorkflowNode, upstream: ReadonlyMap<string, NodeRecord>, round: number) => string;
  /** Nodes already finished before this call (the executor turn, when the caller waited on it). */
  precompleted?: NodeRecord[];
  now?: () => Date;
}

const CHECK_NODE = new Set<WorkflowNode['type']>(['program_check', 'artifact_digest_check', 'learnings_lookup']);

export function defaultOutlineWorkflow(): Workflow {
  return workflowSchema.parse({
    schemaVersion: 1,
    entry: 'produce',
    nodes: [
      { id: 'produce', type: 'executor_turn', requireTicketSubmit: false },
      { id: 'check_schema', type: 'program_check', checks: ['P1'], dependsOn: ['produce'] },
      { id: 'check_rules', type: 'program_check', checks: ['P2..P15'], dependsOn: ['check_schema'] },
      { id: 'check_digest', type: 'artifact_digest_check', dependsOn: ['check_schema'] },
      { id: 'l1_crosscheck', type: 'ticket_apply_checks', dependsOn: ['check_rules', 'check_digest'] },
      { id: 'qa_review', type: 'qa_session_review', dependsOn: ['l1_crosscheck'], when: 'checks_passed' },
      { id: 'l2_crosscheck', type: 'ticket_apply_review', dependsOn: ['qa_review'] },
    ],
    cycles: {
      programBounce: { from: 'l1_crosscheck', to: 'produce', when: 'block_failed' },
      qaRevise: { from: 'l2_crosscheck', to: 'produce', when: 'verdict_revise' },
    },
    policies: {
      trial: { maxProgramBounces: 1, maxQaRevisions: 3, enforceObserveAsBlock: false, requireQa: true, collectProposals: true, allowExternalHandoff: false },
      formal: { maxProgramBounces: 2, maxQaRevisions: 2, enforceObserveAsBlock: true, requireQa: true, collectProposals: false, allowExternalHandoff: true },
    },
  });
}

export async function loadWorkflow(roleDirectory: string): Promise<Workflow> {
  const file = path.join(roleDirectory, 'workflow.json');
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultOutlineWorkflow();
    throw error;
  }
  return workflowSchema.parse(JSON.parse(text));
}

/** `P2..P15` expands to known checklist ids with that prefix; an explicit id is kept. */
export function expandCheckRefs(refs: readonly string[] | undefined, knownIds?: readonly string[]): string[] {
  if (!refs?.length) return [];
  const out: string[] = [];
  for (const ref of refs) {
    const match = /^([A-Za-z]+)(\d+)\.\.([A-Za-z]+)(\d+)$/.exec(ref);
    if (!match || match[1] !== match[3]) { out.push(ref); continue; }
    const prefix = match[1]!, lo = Math.min(Number(match[2]), Number(match[4])), hi = Math.max(Number(match[2]), Number(match[4]));
    if (knownIds) {
      for (const id of knownIds) {
        const item = new RegExp(`^${prefix}(\\d+)$`).exec(id);
        if (item && Number(item[1]) >= lo && Number(item[1]) <= hi) out.push(id);
      }
    } else {
      for (let n = lo; n <= hi; n++) out.push(`${prefix}${n}`);
    }
  }
  return out;
}

/**
 * Round 1 may not end without `ticket_submit` only when the produce node requires it AND the ticket
 * still has required self-checks. Otherwise the historical "first draft is not a ticket round" behavior stands.
 */
export function firstRoundSubmitGate(input: { requireTicketSubmit?: boolean; round: number; ticket?: Ticket | null }): { bounce: boolean; problems: string[] } {
  if (input.round !== 1 || input.requireTicketSubmit !== true || !input.ticket) return { bounce: false, problems: [] };
  const pending = pendingSelfChecks(input.ticket);
  if (!pending.length) return { bounce: false, problems: [] };
  return { bounce: true, problems: [`还没有提交任务单（必填自检未打卡 ${pending.map(check => check.id).join('、')}）`] };
}

function enforcementFor(checklist: NormalizedChecklist | undefined, itemId: string, mode: RsiMode, enforceObserveAsBlock: boolean): CheckEnforcement {
  const item = checklist?.items.find(entry => entry.id === itemId);
  if (!item) return 'block';
  return effectiveEnforcement(item, mode, enforceObserveAsBlock);
}

function defaultInputDigest(node: WorkflowNode, upstream: ReadonlyMap<string, NodeRecord>, round: number): string {
  const deps = [...(node.dependsOn ?? [])].sort().map(id => {
    const record = upstream.get(id);
    return { id, status: record?.status, inputDigest: record?.inputDigest, output: record?.output };
  });
  return createHash('sha256').update(JSON.stringify({
    round, nodeId: node.id, type: node.type, checks: node.checks ?? [], when: node.when ?? 'always', upstream: deps,
  })).digest('hex');
}

function upsert(state: RunStateFile, record: NodeRecord): void {
  const index = state.nodes.findIndex(entry => entry.round === record.round && entry.nodeId === record.nodeId);
  if (index >= 0) state.nodes[index] = record;
  else state.nodes.push(record);
}

type Decision = 'wait' | 'run' | { skip: string };

function classify(node: WorkflowNode, done: ReadonlyMap<string, NodeRecord>, nodeIds: ReadonlySet<string>): Decision {
  for (const dep of node.dependsOn ?? []) {
    const record = done.get(dep);
    if (!record) return nodeIds.has(dep) ? 'wait' : { skip: `upstream missing: ${dep}` };
    if (record.status === 'failed') return { skip: `upstream failed: ${dep}` };
    if (record.status === 'skipped') return { skip: `upstream skipped: ${dep}` };
  }
  if ((node.when ?? 'always') === 'checks_passed') {
    const blocked = (node.dependsOn ?? []).some(id => {
      const record = done.get(id);
      return !record || record.status !== 'completed' || record.blockingFailure === true;
    });
    if (blocked) return { skip: 'checks_passed not satisfied' };
  }
  return 'run';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function runRoundDag(options: RunRoundDagOptions): Promise<RoundDagResult> {
  const now = options.now ?? (() => new Date());
  const nodes = options.nodes ?? options.workflow.nodes;
  const nodeIds = new Set(nodes.map(node => node.id));
  const policy = options.workflow.policies[options.mode];
  const digestOf = options.inputDigest ?? defaultInputDigest;
  const knownIds = options.checklist?.items.map(item => item.id);
  const statePath = path.join(options.workDirectory, 'run-state.json');
  let state: RunStateFile = { schemaVersion: 1, nodes: [] };
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as RunStateFile;
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.nodes)) state = { schemaVersion: 1, nodes: parsed.nodes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { /* a broken state file starts fresh rather than failing the run */ }
  }
  await mkdir(options.workDirectory, { recursive: true });
  let writing = Promise.resolve();
  const save = () => {
    const body = JSON.stringify(state, null, 2) + '\n';
    writing = writing.then(() => writeFile(statePath, body));
    return writing;
  };
  const done = new Map<string, NodeRecord>();
  for (const record of options.precompleted ?? []) {
    done.set(record.nodeId, record);
    upsert(state, record);
  }

  const settle = (record: NodeRecord) => {
    done.set(record.nodeId, record);
    upsert(state, record);
  };

  while ([...nodeIds].some(id => !done.has(id))) {
    const waiting = nodes.filter(node => !done.has(node.id));
    const runnable: WorkflowNode[] = [];
    const skipped: { node: WorkflowNode; reason: string }[] = [];
    let progress = false;
    for (const node of waiting) {
      const decision = classify(node, done, nodeIds);
      if (decision === 'wait') continue;
      progress = true;
      if (decision === 'run') runnable.push(node);
      else skipped.push({ node, reason: decision.skip });
    }
    if (!progress) throw new Error(`Workflow has a cycle or a missing dependency: ${waiting.map(node => node.id).join(', ')}`);

    const stamp = now().toISOString();
    for (const item of skipped) {
      const record: NodeRecord = {
        round: options.round, nodeId: item.node.id, inputDigest: digestOf(item.node, done, options.round),
        status: 'skipped', startedAt: stamp, finishedAt: stamp, skipReason: item.reason,
      };
      settle(record);
    }

    await Promise.all(runnable.map(async node => {
      const inputDigest = digestOf(node, done, options.round);
      const cached = state.nodes.find(entry => entry.round === options.round && entry.nodeId === node.id && entry.inputDigest === inputDigest && entry.status === 'completed');
      if (cached) {
        settle({ ...cached, cached: true });
        return;
      }
      const startedAt = now().toISOString();
      const handler = options.handlersById?.[node.id] ?? options.handlersByType?.[node.type];
      const ctx: NodeRunContext = {
        round: options.round, node, mode: options.mode, policy, upstream: done, inputDigest,
        ...(options.checklist ? { checklist: options.checklist } : {}),
        checkIds: expandCheckRefs(node.checks, knownIds),
      };
      try {
        if (!handler) {
          settle({ round: options.round, nodeId: node.id, inputDigest, status: 'failed', startedAt, finishedAt: now().toISOString(), error: `no handler for ${node.id}`, blockingFailure: true });
          return;
        }
        const result = await handler(ctx);
        let status: NodeStatus = result.status ?? 'completed';
        if (result.results && CHECK_NODE.has(node.type)) {
          const failed = result.results.filter(entry => !entry.pass);
          const blocking = failed.filter(entry => enforcementFor(options.checklist, entry.itemId, options.mode, policy.enforceObserveAsBlock) === 'block');
          if (blocking.length) status = 'failed';
          else if (failed.length) status = 'completed';
          else status = result.status === 'failed' ? 'failed' : 'completed';
        }
        const output = result.results
          ? { ...(isRecord(result.output) ? result.output : {}), results: result.results }
          : result.output;
        const record: NodeRecord = {
          round: options.round, nodeId: node.id, inputDigest, status, startedAt, finishedAt: now().toISOString(),
          ...(output !== undefined ? { output } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(status === 'failed' ? { blockingFailure: true } : {}),
        };
        settle(record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        settle({ round: options.round, nodeId: node.id, inputDigest, status: 'failed', startedAt, finishedAt: now().toISOString(), error: message, blockingFailure: true });
        await save();
        throw error;
      }
    }));
    await save();
  }

  const records = nodes.map(node => done.get(node.id)!);
  const blocked = records.some(record => record.blockingFailure === true || record.status === 'failed');
  const checksPassed = records.every(record => record.status === 'completed' && !record.blockingFailure);
  return { records, blocked, checksPassed, state };
}

export class RsiEngine {
  constructor(private readonly options: { workflow: Workflow; checklist?: NormalizedChecklist; workDirectory: string; mode: RsiMode; now?: () => Date }) {}

  runRound(round: number, handlers: Pick<RunRoundDagOptions, 'handlersById' | 'handlersByType' | 'nodes' | 'precompleted' | 'inputDigest'>): Promise<RoundDagResult> {
    return runRoundDag({ ...this.options, round, ...handlers });
  }
}

/** One round of a role workflow. The caller owns programBounce / qaRevise; this does not loop. */
export function runRoleWorkflow(options: RunRoundDagOptions): Promise<RoundDagResult> {
  return runRoundDag(options);
}
