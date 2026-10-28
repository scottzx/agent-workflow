/** Main-agent tools backed by standard A2A, with a durable completion inbox. */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { CancelTaskRequest, GetTaskRequest, SendMessageRequest, Task } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, type Client } from '@a2a-js/sdk/client';
import { reportAndHoldRegistration, reportToAgent } from '@1agents/dreammate-node/client';
import { z } from 'zod';
import { FileA2AStore } from './store.js';
import { A2AAutomation, automationConfigSchema, createAutomationServer } from './automation.js';
import { sessionHostSchema } from './session-hosts.js';
import { SessionDelivery, sessionBindSchema, sessionSendSchema, sessionMessageSchema, sessionResolveSchema } from './session-delivery.js';
import { artifactLinks, formatNotice, type RemoteAgentNotice } from './notices.js';
import { a2aPreflightInputSchema, a2aPreflightRequirementsSchema, a2aPreflightReportSchema } from './preflight.js';
import { a2aResultContractSchema, type A2AResultMetadata } from './result-metadata.js';
import { WORKBENCH_UI_PATH, WorkbenchUi } from './workbench-ui.js';
import { notifyDesktop } from './desktop-notify.js';
import { isAcpAgentPreset, normalizeLifecycle, oneShotShouldClose, type CloseReason, type SessionLifecycle, sessionLifecycleSchema } from './session-lifecycle.js';
import { CapacityGovernor, type CapacityInspection } from '../capacity.js';
import { CapacityQueue } from '../capacity-queue.js';
import { TargetDirectory, TARGET_METHODS, type ExecutionTargetSnapshot } from '../execution/targets.js';
import { ProjectRoleDiscovery, DISCOVERY_METHODS, projectDiscoveryConfigSchema } from '../execution/project-discovery.js';
import { deliveryProgress, deliveryException } from '../execution/delivery-progress.js';
import { JobLedger, type LedgerState, type ExecutionStatus, type LedgerPrepareInput, type LedgerObservation } from '../execution/ledger.js';
import { decideHumanReview, HumanReviewError, humanReviewDecisionSchema } from '../execution/human-review.js';
import { answerProcessRequest, createProcessRequest, expireProcessRequest, processRequestAnswerSchema, processRequestCreateSchema, processRequestSchema, ProcessRequestError, projectProcessRequest, sameProcessRequest, type ProcessRequest } from '../execution/process-request.js';
import { workbenchSnapshot, listWorkbenchTasks, listWorkbenchAgents, getWorkbenchTask, type WorkbenchListQuery } from '../execution/workbench.js';
import { AgentRegistry, AgentRegistryError, readDevelopment } from '../execution/agent-registry.js';
import { createPptDeliveryRun, recoverPptDeliveryRun, assertPptDeliveryRecoverable, advancePptDelivery, pptDeliveryInputSchema, pptDeliveryPolicySchema, pptDeliveryRecoveryInputSchema,
  scriptDirectory, scriptRevisionName, type PptDeliveryRun, type PptDeliveryChild, type PptDeliveryChildRequest, type PptDeliveryRecoveryInput } from '../execution/ppt-delivery.js';
import { advanceReportReview, createReportReviewRun, reportBindingDigest, reportRevision, reportReviewInputSchema, reportReviewPolicySchema, type ReportReviewRun } from '../execution/report-review.js';
export type { RemoteAgentNotice } from './notices.js';

const string = z.string().trim().min(1).max(512);
const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Expected an HTTP(S) URL without embedded credentials');
const configSchema = z.object({
  stateDirectory: string,
  port: z.number().int().min(0).max(65535).default(36814),
  remotes: z.record(string, z.object({ url: endpoint, token: string }).strict()),
  callback: z.object({ host: string, port: z.number().int().min(0).max(65535), url: endpoint, token: string }).strict().optional(),
  notificationTargets: z.record(string, z.object({ url: endpoint, token: string }).strict()).default({}),
  sessionHosts: z.record(string, sessionHostSchema).default({}),
  automation: automationConfigSchema.optional(),
  projectDiscovery: projectDiscoveryConfigSchema.optional(),
  pollIntervalMs: z.number().int().min(50).max(60_000).default(3000),
  pptDelivery: pptDeliveryPolicySchema.optional(),
  reportReview: reportReviewPolicySchema.optional(),
  workbench: z.object({ /** Omit on a trusted network: the page opens without login and the API needs no bearer. */ token: string.optional(), reviewerId: string.default('local-owner'), reviewerName: string.optional(), publicBaseUrl: endpoint.optional(),
    allowedOrigins: z.array(string).optional(),
    /** How long a question, plan or tool approval waits for a person. The ACP bridge's ACP_INTERACTION_TIMEOUT_MS must be at least as long. */
    requestTimeoutMinutes: z.number().int().min(1).max(24 * 60).default(5),
    /** Show a macOS notification when a request starts waiting. */
    desktopNotifications: z.boolean().default(false) }).strict().optional(),
  /** Same-machine ACP ledger. Omitted callers do not read the default home directory. */
  capacityDirectory: z.string().min(1).optional(),
  /** P3 idle close for persistent ACP sessions. idleTtlSeconds on a job overrides persistentIdleTtlSeconds. */
  sessionLifecycle: z.object({
    persistentIdleTtlSeconds: z.number().int().min(0).max(30 * 24 * 60 * 60).default(600),
    idleScanIntervalMs: z.number().int().min(50).max(10 * 60_000).default(60_000),
    inputRequiredAlertSeconds: z.number().int().min(1).max(30 * 24 * 60 * 60).default(2 * 60 * 60),
    /** remote_agent_close mode "delete" is refused unless this is set. Delete cannot be undone. */
    allowDelete: z.boolean().default(false),
  }).strict().default({ persistentIdleTtlSeconds: 600, idleScanIntervalMs: 60_000, inputRequiredAlertSeconds: 2 * 60 * 60, allowDelete: false }),
}).strict().superRefine((config, ctx) => {
  const machineTokens = [...Object.values(config.remotes).map(remote => remote.token), config.callback?.token,
    ...Object.values(config.notificationTargets).map(target => target.token), config.automation?.token];
  if (config.workbench?.token && machineTokens.includes(config.workbench.token)) {
    ctx.addIssue({ code: 'custom', path: ['workbench', 'token'], message: 'Workbench requires a separate credential from agent remotes' });
  }
  for (const [id, schedule] of Object.entries(config.automation?.schedules ?? {})) {
    if (!Object.hasOwn(config.remotes, schedule.remote)) ctx.addIssue({ code: 'custom', path: ['automation', 'schedules', id, 'remote'], message: 'Unknown automation remote' });
    if (schedule.notificationTarget && !Object.hasOwn(config.notificationTargets, schedule.notificationTarget)) ctx.addIssue({ code: 'custom', path: ['automation', 'schedules', id, 'notificationTarget'], message: 'Unknown automation notificationTarget' });
  }
});
export type A2AGatewayConfig = z.input<typeof configSchema>;
type Config = z.output<typeof configSchema>;

const originFields = { originSessionId: string };
const taskFields = { ...originFields, remote: string, taskId: string };
const prompt = z.string().min(1).max(256 * 1024).refine(value => Boolean(value.trim()), 'Prompt must contain text');
const spawnSchema = z.object({ ...originFields, remote: string, prompt,
  cwd: string.refine(value => path.posix.isAbsolute(value), 'cwd must be an absolute remote path'),
  agentPreset: string.optional(), notificationTarget: string.optional(), title: string.optional(),
  roleId: string.optional(), roleLockPath: string.refine(path.isAbsolute).optional(),
  preflight: a2aPreflightRequirementsSchema.optional(), resultContract: a2aResultContractSchema.optional(),
  clientRequestId: string.optional(), lifecycle: sessionLifecycleSchema.optional(),
  provider: string.optional(), model: string.optional(),
}).strict();
const preflightSchema = a2aPreflightInputSchema.extend({ ...originFields, remote: string }).strict();
const taskSchema = z.object(taskFields).strict();
const messageSchema = z.object({ ...taskFields, prompt, clientRequestId: string.optional(), roleId: string.optional(), roleLockPath: string.refine(path.isAbsolute).optional(), preflight: a2aPreflightRequirementsSchema.optional(), resultContract: a2aResultContractSchema.optional(), lifecycle: sessionLifecycleSchema.optional(), autoResume: z.boolean().optional(), provider: string.optional(), model: string.optional() }).strict();
const closeSchema = z.object({ ...originFields, remote: string, taskId: string.optional(), contextId: string.optional(), sessionId: string.optional(), mode: z.enum(['close', 'delete']).optional(), force: z.boolean().optional(), clientRequestId: string.optional() }).strict();
const sessionsSchema = z.object({}).strict();
const inboxSchema = z.object(originFields).strict();
const ackSchema = z.object({ ...originFields, noticeId: string }).strict();
const executionSubmitSchema = z.object({ ...originFields, targetId: string, input: z.record(z.string(), z.unknown()),
  clientRequestId: string.optional(), title: string.optional(), parentJobRef: z.object({ sourceId: string, jobId: string }).strict().optional(),
  parentAttemptId: string.optional(), purpose: string.optional(), resultRevision: string.optional(),
  replacesJobRef: z.object({ sourceId: string, jobId: string }).strict().optional() }).strict();
const executionJobSchema = z.object({ ...originFields, jobId: string }).strict();
const executionCancelSchema = executionJobSchema.extend({ cascade: z.boolean().optional() }).strict();
const executionListSchema = z.object({ ...originFields, targetId: string.optional(), executionStatus: string.optional(),
  limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }).strict();
const executionContinueSchema = executionJobSchema.extend({ input: z.record(z.string(), z.unknown()), clientRequestId: string.optional() }).strict();
const executionEventsSchema = z.object({ ...originFields, jobId: string.optional(), afterSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(500).default(100) }).strict();
const executionReviewSchema = executionJobSchema.extend({ attemptId: string, resultRevision: string, resultDigest: string,
  reviewStatus: z.enum(['pending', 'accepted', 'changes_requested']), note: string.optional() }).strict();
const EXECUTION_METHODS = {
  ...TARGET_METHODS,
  ...DISCOVERY_METHODS,
  execution_submit: { description: '向已登记目标提交任务；派发前持久保存jobId/attemptId和幂等请求。固定角色不接受cwd/preset覆盖。临时报告可用input.reportReview:{fileName}，机器文件检查与人工最终通过后父任务才完成。', parameters: z.toJSONSchema(executionSubmitSchema) },
  execution_continue: { description: '同任务显式继续或返工，新建执行轮次；旧终态不重新打开，受理未知/关闭时禁止新派发。PPT仅重试验收用input:{recoveryMode:"review_only",reviewTargetId,sourceSnapshotDirectory?}，复用冻结成稿，不派制作。', parameters: z.toJSONSchema(executionContinueSchema) },
  execution_cancel: { description: '持久关闭任务并取消执行；PPT交付默认级联全部子任务，通用任务可显式cascade=true。未知受理或失联保留未决状态，确认全部停止后才完成关闭。', parameters: z.toJSONSchema(executionCancelSchema) },
  execution_get: { description: '读取任务、执行轮次、父子关系、交付阶段进度、已有产物及关闭回执；查询进度不唤醒主会话。在途/未决历史单列。', parameters: z.toJSONSchema(executionJobSchema) },
  execution_list: { description: '按来源范围、目标与状态分页列出统一任务。', parameters: z.toJSONSchema(executionListSchema) },
  execution_events: { description: '读取本来源范围内持久任务事件，不派单。', parameters: z.toJSONSchema(executionEventsSchema) },
  execution_review: { description: '保存绑定当前执行轮次、结果版本和hash的业务接受/退回；不等于通知ack。', parameters: z.toJSONSchema(executionReviewSchema) },
  execution_inbox: { description: '读取领域交付任务的完成/需决策通知；旧A2A收件箱保持原合同。', parameters: z.toJSONSchema(inboxSchema) },
  execution_ack: { description: '确认已处理领域交付通知，不修改业务验收或执行状态。', parameters: z.toJSONSchema(ackSchema) },
};

export const REMOTE_AGENT_METHODS = {
  ...EXECUTION_METHODS,
  remote_agent_preflight: { description: '在执行宿主检查真实 cwd、任务可写目录和指定运行时依赖，不创建会话、不调用模型。ok=false 时修复检查项后再派单；spawn 的 preflight 还会在受理前重检。', parameters: z.toJSONSchema(preflightSchema) },
  remote_agent_spawn: { description: '在配置的远端 DSH 工作目录中派发独立任务，立即返回 taskId。prompt 必须包含完整上下文。cwd 是远端绝对路径；每次 spawn 创建新会话。完成事件进入 originSessionId 的持久收件箱。可选 lifecycle 省略时保持 persistent；one-shot 在完成、失败或取消后普通关闭进程，runtime 仍是 persistent。provider 与 model 只用于 standard 等非 oneagents-acp-* 预设，须一起传；宿主模型目录里没有时任务失败，不退回默认模型；省略时用 DSH 当时的默认模型。', parameters: z.toJSONSchema(spawnSchema) },
  remote_agent_get: { description: '查询当前主会话派发的远端任务。离线时返回缓存与 stale 标记，离线不等于任务失败。进程名额排队时 state 仍是 submitted，并带 capacity 的队列位置和已等时长，以及 taskSlot 与 processSlot。', parameters: z.toJSONSchema(taskSchema) },
  remote_agent_cancel: { description: '取消指定远端任务，只取消这项任务自己的执行。不能释放已经完成的会话进程；释放进程用 remote_agent_close。', parameters: z.toJSONSchema(taskSchema) },
  remote_agent_message: { description: '向同一个远端 DSH 会话发送后续指令，返回新 taskId，复用 contextId 与 cwd。未传 lifecycle 时沿用原会话策略。已关闭会话默认接回，并在任务上返回 resumed 与 restoreMethod。autoResume 为 false 时不向远端发送，返回 SESSION_CLOSED。未传 provider 与 model 时沿用该会话已选模型；传了就在本轮前切换，规则同 spawn。', parameters: z.toJSONSchema(messageSchema) },
  remote_agent_close: { description: '关闭该主会话派出的远端 ACP 进程并保留会话记录与绑定。taskId、contextId、sessionId 三选一。进行中返回 SESSION_BUSY；force 为 true 时先取消再关闭。宿主未实现时返回 UNSUPPORTED，且不把任务记成已关闭。standard 不发送 session/close。mode 为 delete 时还删除 ACP 会话记录，之后不能接回；仅在网关配置 sessionLifecycle.allowDelete 时接受，否则返回 DELETE_DISABLED，不删除 DSH 会话历史。', parameters: z.toJSONSchema(closeSchema) },
  remote_agent_sessions: { description: '按 prewarm、job、user-opened 和未标注列出本机进程租约，并给出 taskSlot 与 processSlot。只读，不关闭、不补标已经在跑的进程。', parameters: z.toJSONSchema(sessionsSchema) },
  remote_agent_list: { description: '列出当前主会话派发的远端任务。', parameters: z.toJSONSchema(inboxSchema) },
  remote_agent_inbox: { description: '读取当前主会话未确认的完成或需要输入通知。读取不删除；处理后调用 remote_agent_ack。', parameters: z.toJSONSchema(inboxSchema) },
  remote_agent_ack: { description: '确认主会话已处理指定通知。noticeId 稳定，重复确认安全。', parameters: z.toJSONSchema(ackSchema) },
  session_bind: { description: '将主会话绑定到配置的 Codex 或 DSH 宿主及其已有会话 ID。同一归属不可静默换目标；在派任务前绑定可自动接收其完成通知。', parameters: z.toJSONSchema(sessionBindSchema) },
  session_send: { description: '向已绑定的主会话可靠投递消息。messageId 是稳定幂等键；立即返回持久投递回执，通过 session_delivery_get 查询。accepted 仅表示宿主已接收入队。', parameters: z.toJSONSchema(sessionSendSchema) },
  session_delivery_get: { description: '查询本主会话的消息投递状态。unknown 必须先核实宿主是否已接收，不能盲目重发。', parameters: z.toJSONSchema(sessionMessageSchema) },
  session_delivery_resolve: { description: '核实 unknown 或处理 rejected 投递并记录依据。accepted=true 表示已确认入队；false 仅用于已证实未入队且已处理阻碍后释放重试。note 必填，不等于任务业务处理确认。', parameters: z.toJSONSchema(sessionResolveSchema) },
};

interface Job {
  remote: string;
  remoteEndpoint?: string;
  originSessionId: string;
  taskId: string;
  contextId: string;
  cwd: string;
  agentPreset?: string;
  title?: string;
  notificationTarget?: string;
  task: unknown;
  checkedAt: string;
  stale?: boolean;
  ledgerJobId?: string;
  attemptId?: string;
  sessionId?: string;
  lifecycle?: SessionLifecycle;
  sessionState?: 'attached' | 'busy' | 'idle' | 'closing' | 'closed' | 'stale' | 'deleted';
  closedAt?: string;
  closeReason?: CloseReason;
  processReleased?: true | 'pending';
}

export class RemoteAgentError extends Error {
  constructor(readonly code: 'SESSION_NOT_FOUND' | 'SESSION_DELETED' | 'SESSION_CLOSED' | 'SESSION_BUSY' | 'SESSION_CONFLICT' | 'SESSION_ATTACH_IN_PROGRESS' | 'UNSUPPORTED' | 'REMOTE_UNAVAILABLE' | 'DELETE_DISABLED', message: string) {
    super(message);
    this.name = 'RemoteAgentError';
  }
}
interface NoticeRecord { notice: RemoteAgentNotice; target?: string; acknowledged?: boolean; delivered?: boolean; sessionDeliveryId?: string }
interface ExecutionNotice { noticeId: string; messageId: string; originSessionId: string; jobId: string; attemptId: string;
  executionStatus: string; resultSummary: string; artifactLinks: any[]; createdAt: string; processedAt?: string; text: string }
interface ExecutionCancellation { jobId: string; attemptId: string; originSessionId: string; cascade: boolean; reason?: string;
  requestedAt: string; checkedAt?: string; completedAt?: string; status: 'pending' | 'blocked' | 'completed';
  targets: { jobId: string; attemptId: string; executionStatus: string; submissionStatus: string }[]; diagnostics: string[] }
interface State { version: 1 | 2; jobs: Job[]; notices: NoticeRecord[]; ledger?: LedgerState; executionNotices?: ExecutionNotice[]; executionCancellations?: Record<string, ExecutionCancellation>; pptDeliveries?: any; reportReviews?: Record<string, ReportReviewRun>; processRequests?: ProcessRequest[] }
const terminal = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
const actionable = new Set([...terminal, 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']);
const wire = (task: Task): Record<string, any> => Task.toJSON(task) as Record<string, any>;
const taskState = (job: Job): string => wire(Task.fromJSON(job.task)).status?.state ?? 'TASK_STATE_UNSPECIFIED';
const resultText = (task: Task): string => task.artifacts.flatMap(artifact => artifact.parts
  .filter(part => part.content?.$case === 'text').map(part => part.content!.value)).join('\n') ||
  task.status?.message?.parts.filter(part => part.content?.$case === 'text').map(part => part.content!.value).join('\n') || '';

function atomicJson(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const dir = openSync(path.dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export class RemoteAgentGateway {
  readonly config: Config;
  readonly automation?: A2AAutomation;
  readonly sessions: SessionDelivery;
  readonly targets: TargetDirectory;
  readonly agents: AgentRegistry;
  readonly projectDiscovery?: ProjectRoleDiscovery;
  readonly ledger: JobLedger;
  private readonly lease: FileA2AStore;
  private readonly stateFile: string;
  private readonly state: State;
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly probeCards = new Map<string, { until: number; result: Promise<unknown> }>();
  private readonly probeFailures = new Map<string, number>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly delivering = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly advancingDeliveries = new Map<string, Promise<void>>();
  private readonly canceling = new Map<string, Promise<void>>();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private readonly automaticCloseStopped = new Set<string>();
  private readonly now: () => number;
  private idleScannedAt = Number.NEGATIVE_INFINITY;
  /** taskId and status timestamp of INPUT_REQUIRED turns already warned about. */
  private readonly inputRequiredAlerts = new Map<string, { sessionId?: string; contextId: string; since: string }>();
  private closeFailures = 0;
  private reconciling?: Promise<void>;
  private workbenchQueue: Promise<void> = Promise.resolve();
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(input: A2AGatewayConfig, options: { now?: () => number } = {}) {
    this.config = configSchema.parse(input);
    this.now = options.now ?? Date.now;
    if (!path.isAbsolute(this.config.stateDirectory)) throw new Error('stateDirectory must be absolute');
    mkdirSync(this.config.stateDirectory, { recursive: true, mode: 0o700 });
    // Reuse the A2A store's tested single-owner lease, in a separate empty
    // directory: local restarts must never mark remote executions failed.
    this.lease = new FileA2AStore(path.join(this.config.stateDirectory, 'lease'));
    this.stateFile = path.join(this.config.stateDirectory, 'gateway.json');
    try {
      this.state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as State;
      if (![1, 2].includes(this.state.version) || !Array.isArray(this.state.jobs) || !Array.isArray(this.state.notices)) throw new Error('Invalid gateway state');
      for (const job of this.state.jobs) {
        string.parse(job.originSessionId); string.parse(job.remote); string.parse(job.taskId);
        if (Task.fromJSON(job.task).id !== job.taskId) throw new Error('Invalid gateway task ID');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.lease.close(); throw error; }
      this.state = { version: 1, jobs: [], notices: [] };
    }
    try {
      this.sessions = new SessionDelivery(this.config.stateDirectory, this.config.sessionHosts);
      this.targets = new TargetDirectory(this.config.stateDirectory, this.config.remotes);
      this.targets.ensureLegacyRemotes();
      this.agents = new AgentRegistry(this.config.stateDirectory);
      this.ledger = new JobLedger(this.state.ledger, next => {
        atomicJson(this.stateFile, { ...this.state, version: 2, ledger: next });
        this.state.ledger = next; this.state.version = 2;
      });
      this.ledger.recoverAfterRestart();
      this.ledger.migrateLegacy(this.state.jobs.filter(job => !job.ledgerJobId).map(job => ({ ...job,
        executionStatus: this.standardState(taskState(job)), providerState: taskState(job), createdAt: null,
        sessionId: Task.fromJSON(job.task).metadata?.['1agents']?.sessionId,
        resultSummary: resultText(Task.fromJSON(job.task)), artifactLinks: artifactLinks(Task.fromJSON(job.task)),
        targetSnapshot: this.legacySnapshot(job) })));
      for (const job of this.state.jobs) {
        const migrated = this.ledger.findByBackend(job.originSessionId, { remote: job.remote, taskId: job.taskId });
        if (!job.ledgerJobId && migrated) { job.ledgerJobId = migrated.job.jobId; job.attemptId = migrated.attempt.attemptId; }
        // Upgrade cached completed results without contacting the host, dispatching work or creating notices.
        if (job.attemptId && taskState(job) === 'TASK_STATE_COMPLETED') {
          const attempt = this.ledger.getAttempt(job.attemptId);
          if (!attempt.result?.resultRevision || !attempt.result.resultDigest) this.ledger.observe(job.attemptId,
            { ...this.resultObservation(Task.fromJSON(job.task)), checkedAt: job.checkedAt, stale: job.stale ?? false });
        }
      }
      this.state.ledger = this.ledger.snapshot(); this.state.version = 2;
      this.state.executionNotices ??= [];
      this.state.reportReviews ??= {};
      this.state.executionCancellations ??= {};
      this.state.pptDeliveries ??= { version: 1, runs: {} };
      if (this.state.processRequests !== undefined && !Array.isArray(this.state.processRequests)) throw new Error('Invalid gateway state');
      this.state.processRequests = z.array(processRequestSchema).parse(this.state.processRequests ?? []);
      for (const run of Object.values(this.state.pptDeliveries.runs) as PptDeliveryRun[]) {
        const attempt = this.ledger.getAttempt(run.attemptId);
        if (attempt.submissionStatus === 'prepared') this.ledger.markDispatching(attempt.attemptId);
        if (this.ledger.getAttempt(attempt.attemptId).submissionStatus !== 'accepted') {
          // The durable local run is positive admission evidence, never a remote retry.
          this.ledger.accept(attempt.attemptId, { provider: 'resident_role', runId: attempt.attemptId },
            { executionStatus: run.executionStatus, phase: run.phase });
        }
      }
      this.save();
      if (this.config.automation) this.automation = new A2AAutomation(this, this.config.automation);
      if (this.config.projectDiscovery) {
        this.projectDiscovery = new ProjectRoleDiscovery({ stateDirectory: path.join(this.config.stateDirectory, 'project-discovery'), config: this.config.projectDiscovery });
        this.projectDiscovery.start();
      }
    }
    catch (error) { void this.projectDiscovery?.close().catch(() => {}); this.lease.close(); throw error; }
    this.timer = setInterval(() => { void this.reconcile().catch(() => {}); }, this.config.pollIntervalMs);
    this.timer.unref();
    void this.reconcile().catch(() => {});
  }

  private save(): void { atomicJson(this.stateFile, this.state); }
  private standardState(value: string): ExecutionStatus {
    return ({ TASK_STATE_SUBMITTED: 'submitted', TASK_STATE_WORKING: 'working', TASK_STATE_INPUT_REQUIRED: 'input_required',
      TASK_STATE_AUTH_REQUIRED: 'auth_required', TASK_STATE_COMPLETED: 'completed', TASK_STATE_FAILED: 'failed',
      TASK_STATE_CANCELED: 'canceled', TASK_STATE_REJECTED: 'rejected' } as Record<string, ExecutionStatus>)[value] ?? 'unknown';
  }
  private legacySnapshot(job: Job) {
    try { return this.targetSnapshot(this.targets.resolve(`legacy:${job.remote}`, { cwd: job.cwd, prompt: 'Legacy task migration', ...(job.agentPreset ? { agentPreset: job.agentPreset } : {}) })); }
    catch { return { targetId: `legacy:${job.remote}`, provider: 'a2a', remote: job.remote, cwd: job.cwd, agentPreset: job.agentPreset, historicalConfigUnknown: true }; }
  }
  /** A continuation keeps the channel frozen on its current attempt. A new task is admitted from the registry. */
  private developmentFor(target: { targetId: string; kind: string; name: string }, jobId?: string) {
    if (!jobId) return this.agents.admit(target);
    const job = this.ledger.snapshot().jobs[jobId];
    const attempt = job ? this.ledger.snapshot().attempts[job.currentAttemptId] : undefined;
    return readDevelopment(attempt?.targetSnapshot?.development);
  }
  private targetSnapshot(resolved: ExecutionTargetSnapshot) {
    return { targetId: resolved.target.targetId, targetKind: resolved.target.kind, targetName: resolved.target.name,
      configVersion: resolved.configVersion, connectionId: resolved.connection.connectionId,
      connectionVersion: resolved.connectionVersion, provider: resolved.target.binding.driver === 'ppt_delivery' ? 'resident_role' : 'a2a',
      roleId: resolved.target.binding.roleId, binding: resolved.target.binding, remote: resolved.remote, endpoint: resolved.endpoint, cwd: resolved.cwd,
      agentPreset: resolved.agentPreset, capabilities: resolved.target.capabilities };
  }
  private ledgerView(originSessionId: string, jobId: string) {
    const view = this.ledger.get(originSessionId, jobId);
    const attempt = view.attempts.find(item => item.attemptId === view.currentAttemptId)!;
    const raw = this.state.jobs.find(item => item.attemptId === attempt.attemptId);
    const delivery = this.state.pptDeliveries?.runs[attempt.attemptId] as PptDeliveryRun | undefined;
    const report = this.state.reportReviews?.[attempt.attemptId];
    return { ...view, ...(delivery ? { deliveryProgress: deliveryProgress(delivery) } : {}),
      ...(report ? { reportProgress: { stage: report.stage, phase: report.phase, reportPath: report.reportPath, fileCheck: report.fileCheck, humanReview: report.humanReviews.at(-1) } } : {}),
      ...(this.state.executionCancellations?.[attempt.attemptId] ? { cancellation: structuredClone(this.state.executionCancellations[attempt.attemptId]) } : {}), attemptId: attempt.attemptId, submissionStatus: attempt.submissionStatus,
      backendRunRef: attempt.backendRunRef, phase: attempt.phase, stale: attempt.stale,
      resultSummary: view.result?.resultSummary, artifactLinks: view.result?.artifactLinks ?? [],
      resultDigest: view.result?.resultDigest, resultRevision: view.result?.resultRevision,
      ...(raw ? { remote: raw.remote, taskId: raw.taskId, contextId: raw.contextId,
        sessionId: Task.fromJSON(raw.task).metadata?.['1agents']?.sessionId,
        resultMetadata: Task.fromJSON(raw.task).metadata?.['1agents']?.result } : {}) };
  }
  private async submitExecution(input: z.output<typeof executionSubmitSchema>, options: { jobId?: string; previous?: Job; deliveryRecovery?: PptDeliveryRun; deliveryRecoveryInput?: PptDeliveryRecoveryInput; notificationOrigin?: string; requestDigestInput?: unknown } = {}) {
    const replay = this.ledger.replay({ ...input, requestDigestInput: options.requestDigestInput, jobId: options.jobId, operation: options.jobId ? 'continue' : 'submit', targetSnapshot: { targetId: input.targetId } });
    if (replay) return { ...this.ledgerView(input.originSessionId, replay.job.jobId), attemptId: replay.attempt.attemptId, requestedAttempt: replay.attempt };
    this.assertDispatchOpen(input.originSessionId, options.jobId ?? input.parentJobRef?.jobId);
    const resolved = this.targets.resolve(input.targetId, input.input);
    if (options.previous && (options.previous.remote !== resolved.remote || (options.previous.remoteEndpoint && options.previous.remoteEndpoint !== resolved.endpoint) || options.previous.cwd !== resolved.cwd || options.previous.agentPreset !== resolved.agentPreset)) {
      throw new RemoteAgentError('SESSION_CONFLICT', 'Continue must preserve the original remote, cwd and preset');
    }
    const reportRequest = input.input.reportReview;
    if (reportRequest !== undefined && (options.jobId || resolved.target.kind !== 'agent_host' || !this.config.reportReview || !this.config.workbench)) throw new Error('Report review requires a new temporary agent_host task and configured report/workbench policy');
    if (reportRequest !== undefined) reportReviewInputSchema.parse(reportRequest);
    const development = this.developmentFor(resolved.target, options.jobId);
    const prepared = this.ledger.prepare({ ...input, requestDigestInput: options.requestDigestInput, jobId: options.jobId, targetSnapshot: { ...this.targetSnapshot(resolved), ...(development ? { development } : {}), ...(reportRequest !== undefined ? { provider: 'report_review', targetKind: 'workflow', driver: 'report_review' } : {}) },
      operation: options.jobId ? 'continue' : 'submit' });
    if (prepared.idempotent) return this.ledgerView(input.originSessionId, prepared.job.jobId);
    const { job, attempt } = prepared;
    let sent = false;
    try {
      if (reportRequest !== undefined) {
        const { reportReview: _review, ...authorInput } = resolved.input;
        const run = await createReportReviewRun({ sourceId: this.ledger.sourceId, jobId: job.jobId, attemptId: attempt.attemptId,
          originSessionId: input.originSessionId, title: input.title ?? '项目架构分析报告', targetId: input.targetId, remote: resolved.remote,
          cwd: resolved.cwd!, authorInput, reviewerId: this.config.workbench!.reviewerId }, this.config.reportReview!, reportReviewInputSchema.parse(reportRequest));
        this.state.reportReviews![attempt.attemptId] = run;
        this.ledger.markDispatching(attempt.attemptId);
        this.ledger.accept(attempt.attemptId, { provider: 'report_review', runId: attempt.attemptId }, { executionStatus: 'working', phase: run.phase });
        return this.ledgerView(input.originSessionId, job.jobId);
      }
      if (resolved.target.binding.driver === 'ppt_delivery') {
        if (options.jobId && !options.deliveryRecovery) throw new Error('PPT continuation requires a verified recovery checkpoint');
        const roleInput = pptDeliveryInputSchema.parse(input.input);
        if (!this.config.pptDelivery) throw new Error('PPT delivery role policy is not configured');
        const run = options.deliveryRecovery ? await recoverPptDeliveryRun(options.deliveryRecovery, attempt.attemptId, options.deliveryRecoveryInput)
          : await createPptDeliveryRun({ sourceId: this.ledger.sourceId, jobId: job.jobId, attemptId: attempt.attemptId,
            originSessionId: input.originSessionId, input: roleInput, policy: { ...this.config.pptDelivery,
              ...(this.config.workbench ? { humanReviewerId: this.config.workbench.reviewerId } : {}) } });
        this.state.pptDeliveries.runs[attempt.attemptId] = run;
        this.ledger.markDispatching(attempt.attemptId);
        this.ledger.accept(attempt.attemptId, { provider: 'resident_role', runId: attempt.attemptId }, { executionStatus: 'working', phase: 'preparing' });
        return this.ledgerView(input.originSessionId, job.jobId);
      }
      const fields = resolved.input;
      const provider = fields.provider === undefined ? undefined : string.parse(fields.provider);
      const model = fields.model === undefined ? undefined : string.parse(fields.model);
      if ((provider === undefined) !== (model === undefined)) throw new Error('provider and model must be passed together');
      if (provider && isAcpAgentPreset(resolved.agentPreset)) throw new Error('provider and model apply only to standard presets; oneagents-acp-* presets switch models through session/set_config_option');
      const preflight = fields.preflight === undefined ? undefined : a2aPreflightRequirementsSchema.parse(fields.preflight);
      const requirements = resolved.directoryPolicy ? { ...preflight, allowedDirectories: resolved.directoryPolicy.allowedDirectories } : preflight;
      const declaredContract = fields.resultContract === undefined ? undefined : a2aResultContractSchema.parse(fields.resultContract);
      const resultContract = declaredContract && options.notificationOrigin ? { ...declaredContract, jobId: job.jobId } : declaredContract;
      const networkRole = resolved.target.binding.skillPolicy === 'network_pinned' ? resolved.target.binding.roleId : undefined;
      if (resolved.target.binding.skillPolicy && !networkRole) throw new Error('Network skill policy requires a fixed roleId');
      const explicitRole = resolved.target.kind === 'agent_host' && fields.roleId !== undefined ? string.parse(fields.roleId) : undefined;
      const roleLockPath = fields.roleLockPath === undefined ? undefined
        : z.string().min(1).refine(path.isAbsolute, 'Expected an absolute role lock path').parse(fields.roleLockPath);
      await this.checkDispatch(resolved.remote, resolved.cwd!, requirements, resolved.endpoint);
      const client = await this.client(resolved.remote, resolved.endpoint);
      // Target changes/disable during asynchronous preflight must win before sending.
      const fresh = this.targets.resolve(input.targetId, input.input);
      if (fresh.configVersion !== resolved.configVersion || fresh.connectionVersion !== resolved.connectionVersion) throw new Error('Execution target changed before dispatch');
      this.assertDispatchOpen(input.originSessionId, options.jobId ?? input.parentJobRef?.jobId);
      this.ledger.markDispatching(attempt.attemptId); sent = true;
      const lifecycle = this.jobLifecycle(fields.lifecycle, options.previous?.lifecycle);
      const task = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: attempt.attemptId, role: 'ROLE_USER',
        ...(options.previous ? { contextId: options.previous.contextId } : {}), parts: [{ text: prompt.parse(fields.prompt) }] },
        metadata: { '1agents': { ...(!options.previous ? { cwd: resolved.cwd, ...(resolved.agentPreset ? { agentPreset: resolved.agentPreset } : {}) } : {}),
          ...(explicitRole ? { roleId: explicitRole } : !options.previous && networkRole ? { roleId: networkRole } : {}), ...(roleLockPath ? { roleLockPath } : {}),
          ...(requirements ? { preflight: requirements } : {}), ...(resultContract ? { resultContract } : {}), ...(provider ? { provider, model } : {}),
          execution: { jobId: job.jobId, attemptId: attempt.attemptId } } },
        configuration: { returnImmediately: true, ...(this.config.callback ? { taskPushNotificationConfig: { url: this.config.callback.url,
          authentication: { scheme: 'Bearer', credentials: this.config.callback.token } } } : {}) } }), this.auth(resolved.remote));
      if (!('id' in task)) throw new Error('Remote did not return an A2A Task');
      this.accept(task, { remote: resolved.remote, remoteEndpoint: resolved.endpoint, originSessionId: options.notificationOrigin ?? input.originSessionId, cwd: resolved.cwd!,
        agentPreset: resolved.agentPreset, title: input.title ?? (typeof fields.title === 'string' ? fields.title : undefined),
        notificationTarget: typeof fields.notificationTarget === 'string' ? fields.notificationTarget : undefined,
        ledgerJobId: job.jobId, attemptId: attempt.attemptId, ...(lifecycle ? { lifecycle } : {}) });
      return this.ledgerView(input.originSessionId, job.jobId);
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : 'Execution dispatch failed';
      if (sent) this.ledger.markUnknown(attempt.attemptId, diagnostic);
      else if (this.ledger.getAttempt(attempt.attemptId).submissionStatus !== 'known_not_submitted')
        this.ledger.knownNotSubmitted(attempt.attemptId, { executionStatus: 'rejected', diagnostic });
      return { ...this.ledgerView(input.originSessionId, job.jobId), error: diagnostic };
    }
  }
  private childView(origin: string, jobId: string): PptDeliveryChild {
    return this.ledgerView(origin, jobId) as PptDeliveryChild;
  }
  private async advanceDelivery(run: PptDeliveryRun): Promise<void> {
    const existing = this.advancingDeliveries.get(run.attemptId);
    if (existing) return existing;
    const operation = this.advanceDeliveryOnce(run); this.advancingDeliveries.set(run.attemptId, operation);
    try { await operation; } finally { this.advancingDeliveries.delete(run.attemptId); }
  }
  private async advanceDeliveryOnce(run: PptDeliveryRun): Promise<void> {
    const rootOrigin = run.originSessionId;
    const submitChild = async (request: PptDeliveryChildRequest, previous?: PptDeliveryChild) => {
      if (request.parentJobRef.sourceId !== run.sourceId || request.parentJobRef.jobId !== run.jobId || request.parentAttemptId !== run.attemptId) throw new Error('Delivery child parent scope mismatch');
      if (![run.policy.summaryTargetId, run.policy.makerTargetId, run.policy.reviewTargetId, ...Object.values(run.policy.backupTargets ?? {})].includes(request.targetId)) throw new Error('Delivery child target is outside frozen policy');
      if (this.ledger.get(rootOrigin, run.jobId).currentAttemptId !== run.attemptId) throw new Error('Delivery attempt is no longer current');
      const raw = previous ? this.state.jobs.find(item => item.attemptId === previous.attemptId) : undefined;
      if (previous && !raw) throw new Error('Previous delivery child has no A2A backend reference');
      const originalChild = previous ? this.ledger.get(rootOrigin, previous.jobId) : undefined;
      if (originalChild && originalChild.parentJobRef?.jobId !== run.jobId) throw new Error('Recovered child belongs to another parent');
      // Reusing an existing child never reparents its Job. The new parent round records reuse in its recovery receipt.
      return await this.submitExecution({ ...request, originSessionId: rootOrigin,
        ...(originalChild ? { parentJobRef: originalChild.parentJobRef, parentAttemptId: originalChild.parentAttemptId } : {}) }, { notificationOrigin: request.originSessionId,
        ...(previous ? { jobId: previous.jobId, previous: raw } : {}) }) as PptDeliveryChild;
    };
    await advancePptDelivery(run, {
      persist: async saved => { this.state.pptDeliveries.runs[saved.attemptId] = saved; this.save(); },
      submitChild: request => submitChild(request),
      continueChild: request => submitChild(request, request.child),
      getChild: async child => this.childView(rootOrigin, child.jobId),
      ackChild: async child => {
        const raw = this.state.jobs.find(item => item.attemptId === child.attemptId);
        if (!raw) return;
        for (const record of this.state.notices.filter(item => item.notice.taskId === raw.taskId && item.notice.originSessionId === raw.originSessionId)) record.acknowledged = true;
        this.save();
      },
      updateParent: async update => {
        if (run.cancellationRequestedAt) return;
        this.ledger.observe(run.attemptId, { executionStatus: update.executionStatus, phase: update.phase,
          ...(update.resultSummary ? { resultSummary: update.resultSummary } : {}),
          ...(update.artifactLinks ? { artifactLinks: update.artifactLinks } : {}),
          ...(update.deliveryReceipt ? { structuredResultRef: update.deliveryReceipt,
            resultDigest: String(update.deliveryReceipt.resultDigest ?? run.validation?.artifactDigest ?? ''), resultRevision: `revision-${run.revision}` } : {}),
          ...(update.error ? { diagnostic: update.error } : {}) });
        if (update.executionStatus !== 'working') this.executionNotice(run, update.resultSummary ?? update.error ?? 'PPT delivery requires attention', update.artifactLinks ?? []);
      },
    });
  }
  private executionNotice(run: PptDeliveryRun, resultSummary: string, links: any[]): void {
    const pendingReview = run.executionStatus === 'input_required' && run.phase === 'awaiting_human' && !run.cancellationRequestedAt
      ? run.humanReviews?.find(review => review.status === 'pending' && review.attemptId === run.attemptId && review.revision === scriptRevisionName(run)) : undefined;
    const noticeId = createHash('sha256').update(JSON.stringify([run.sourceId, run.jobId, run.attemptId, run.revision, run.executionStatus,
      ...(pendingReview ? [pendingReview.reviewId] : [])])).digest('hex');
    if (this.state.executionNotices!.some(item => item.noticeId === noticeId)) return;
    if (run.executionStatus !== 'completed') {
      const partial = deliveryException(run, resultSummary);
      if (!resultSummary.includes('\n\n已完成：')) resultSummary = partial.summary;
      if (!links.length) links = partial.artifacts;
    }
    const artifactLinks = links.map(item => ({ url: item.url, mediaType: item.mediaType, sha256: item.sha256, size: item.size }));
    const reviewUrl = this.config.workbench?.publicBaseUrl ? new URL(this.config.workbench.publicBaseUrl) : undefined;
    if (reviewUrl && pendingReview) reviewUrl.hash = `acp/tasks/${encodeURIComponent(run.jobId)}?review=${encodeURIComponent(pendingReview.reviewId)}`;
    const reviewEntry = pendingReview ? `\n\n${reviewUrl ? `[打开文字稿审核](${reviewUrl.href})` : '请用户打开本机 A2A 网关的任务工作台页面（/workbench/ui/）→「待我确认」。'}\n审核版本：${pendingReview.revision}；审核请求：${pendingReview.reviewId}。\n人工决定必须在审核页记录，execution_review 和通知已读均不能替代。` : '';
    const text = `[任务交付通知] ${pendingReview ? '文字稿待人工确认' : run.executionStatus === 'completed' ? '任务已完成' : run.executionStatus === 'canceled' ? '任务已取消' : '任务需要处理'}\n${run.input.projectName} PPT\n\n${resultSummary}\n\n` +
      artifactLinks.map(item => `[${item.mediaType?.includes('presentation') ? (run.executionStatus === 'completed' ? '最终 PPT' : '已有 PPT（未完成最终验收）') : '预览产物'}](${item.url})`).join('\n') +
      reviewEntry +
      `\n\n请通过 a2a-gateway 的 execution_get 或 execution_inbox 读取交付回执；业务接受调用 execution_review，通知处理调用 execution_ack，两者分别记录。\n---\n任务定位信息：\n${JSON.stringify({ noticeId, sourceId: run.sourceId, jobId: run.jobId, attemptId: run.attemptId, originSessionId: run.originSessionId })}`;
    this.state.executionNotices!.push({ noticeId, messageId: `execution-notice:${noticeId}`, originSessionId: run.originSessionId,
      jobId: run.jobId, attemptId: run.attemptId, executionStatus: run.executionStatus, resultSummary, artifactLinks, createdAt: new Date().toISOString(), text });
    this.save();
  }
  private async advanceReport(run: ReportReviewRun): Promise<void> {
    const existing = this.advancingDeliveries.get(run.attemptId);
    if (existing) return existing;
    const operation = advanceReportReview(run, {
      persist: value => { this.state.reportReviews![value.attemptId] = value; this.save(); },
      child: attemptId => this.ledger.getAttempt(attemptId),
      submit: async (value, prompt, previous) => {
        this.assertDispatchOpen(value.originSessionId, value.jobId);
        const prior = previous ? this.state.jobs.find(job => job.attemptId === previous.attemptId) : undefined;
        if (previous && !prior) throw new Error('Original report author session is unavailable');
        const result = await this.submitExecution({ originSessionId: value.originSessionId, targetId: value.targetId,
          title: `${value.title}：临时执行`, input: { ...value.authorInput, cwd: value.directory, prompt },
          clientRequestId: `${value.jobId}:${reportRevision(value)}:author`,
          parentJobRef: { sourceId: value.sourceId, jobId: value.jobId }, parentAttemptId: value.attemptId, purpose: 'architecture_report' },
          { ...(prior ? { jobId: previous!.jobId, previous: prior } : {}), notificationOrigin: `report-review:${value.jobId}` });
        return { jobId: result.jobId, attemptId: result.attemptId };
      },
      update: value => this.updateReport(value),
    });
    this.advancingDeliveries.set(run.attemptId, operation);
    try { await operation; } finally { this.advancingDeliveries.delete(run.attemptId); }
  }
  private updateReport(run: ReportReviewRun): void {
    this.ledger.observe(run.attemptId, { executionStatus: run.executionStatus, phase: run.phase, resultSummary: run.resultSummary,
      ...(run.digest ? { resultDigest: run.digest, resultRevision: reportRevision(run), structuredResultRef: {
        reportPath: run.reportPath, snapshotPath: run.snapshotPath, fileCheck: run.fileCheck,
        humanReview: run.humanReviews.at(-1),
      } } : {}) });
    // Only final task outcomes reach the delegator; child completion and human waiting stay in the workbench.
    if (!['completed', 'failed', 'canceled'].includes(run.executionStatus)) return;
    const noticeId = createHash('sha256').update(JSON.stringify([run.sourceId, run.jobId, run.attemptId, reportRevision(run), run.executionStatus])).digest('hex');
    if (this.state.executionNotices!.some(notice => notice.noticeId === noticeId)) return;
    const text = `[报告任务通知] ${run.executionStatus === 'completed' ? '人工已确认，任务完成' : '任务未完成'}\n${run.title}\n${run.resultSummary ?? ''}\n报告：${run.reportPath}\n请单次读取 execution_get 回执，记录结论后 execution_ack。\n---\n${JSON.stringify({ noticeId, sourceId: run.sourceId, jobId: run.jobId, attemptId: run.attemptId, originSessionId: run.originSessionId })}`;
    this.state.executionNotices!.push({ noticeId, messageId: `execution-notice:${noticeId}`, originSessionId: run.originSessionId,
      jobId: run.jobId, attemptId: run.attemptId, executionStatus: run.executionStatus, resultSummary: run.resultSummary ?? '', artifactLinks: [], createdAt: new Date().toISOString(), text });
    this.save();
  }
  private async decideReportReview(run: ReportReviewRun, reviewId: string, input: unknown) {
    const review = run.humanReviews.find(item => item.reviewId === reviewId);
    if (!review) throw new Error('Review not found in authorized task');
    const decision = humanReviewDecisionSchema.parse(input), replay = review.history.some(item => item.clientRequestId === decision.clientRequestId);
    if (!replay && (this.state.executionCancellations?.[run.attemptId] || ['completed', 'failed', 'canceled'].includes(run.executionStatus))) throw new HumanReviewError('already_decided', 'Report task is no longer awaiting a decision');
    let digest = run.digest ?? '';
    if (!replay && decision.action === 'approve') {
      try { digest = await reportBindingDigest(run); }
      catch { throw new HumanReviewError('version_conflict', 'Report bytes changed or are unavailable; this version cannot be approved'); }
    }
    const config = this.config.workbench!;
    const result = decideHumanReview(review, decision, { id: config.reviewerId, displayName: config.reviewerName, source: '1agents-web' },
      { attemptId: run.attemptId, revision: reportRevision(run), digest });
    if (!result.idempotent) {
      const next = { ...run, humanReviews: run.humanReviews.map(item => item.reviewId === reviewId ? result.review : item) };
      const reportReviews = { ...this.state.reportReviews, [run.attemptId]: next };
      atomicJson(this.stateFile, { ...this.state, reportReviews }); this.state.reportReviews = reportReviews;
    }
    const current = this.state.reportReviews![run.attemptId]!;
    if (current.humanReviews.some(item => item.resume?.status === 'pending')) void this.advanceReport(current).catch(() => {});
    return this.workbenchTask(run.jobId);
  }
  private cancellationJobs(origin: string, jobId: string, cascade: boolean): string[] {
    const found = new Set<string>();
    const visit = (id: string): void => {
      if (found.has(id)) return;
      found.add(id);
      const job = this.ledger.get(origin, id);
      if (cascade) for (const child of job.children) visit(child.jobId);
    };
    visit(jobId); return [...found].reverse();
  }
  private assertDispatchOpen(origin: string, jobId?: string): void {
    const seen = new Set<string>();
    while (jobId && !seen.has(jobId)) {
      seen.add(jobId);
      if (Object.values(this.state.executionCancellations ?? {}).some(item => item.jobId === jobId)) throw new Error('Job is closing or closed; no further dispatch is allowed');
      const job = this.ledger.get(origin, jobId), run = this.state.pptDeliveries?.runs[job.currentAttemptId] as PptDeliveryRun | undefined;
      if (job.executionStatus === 'canceled' || run?.cancellationRequestedAt || run?.executionStatus === 'canceled'
        || run?.humanReviews?.some(review => review.status === 'canceled')) throw new Error('Job is closing or closed; no further dispatch is allowed');
      jobId = job.parentJobRef?.jobId;
    }
  }
  private async cancelExecution(origin: string, jobId: string, cascade?: boolean, reason?: string) {
    const job = this.ledger.get(origin, jobId), run = this.state.pptDeliveries.runs[job.currentAttemptId] as PptDeliveryRun | undefined;
    if (this.state.reportReviews?.[job.currentAttemptId] && cascade === false) throw new Error('Report cancellation must include its child task');
    if (run && cascade === false) throw new Error('PPT delivery cancellation must include its child tasks');
    let record = this.state.executionCancellations![job.currentAttemptId];
    if (record && cascade === true && !record.cascade) { record.cascade = true; record.status = 'pending'; }
    if (!record) {
      record = { jobId, attemptId: job.currentAttemptId, originSessionId: origin, cascade: cascade ?? Boolean(run || this.state.reportReviews?.[job.currentAttemptId]),
        requestedAt: new Date().toISOString(), status: 'pending', targets: [], diagnostics: [], ...(reason ? { reason } : {}) };
      this.state.executionCancellations![record.attemptId] = record;
    }
    // Close admission synchronously and durably, before waiting for an in-flight submit or contacting a backend.
    for (const id of this.cancellationJobs(origin, jobId, record.cascade)) {
      const view = this.ledger.get(origin, id);
      for (const attempt of view.attempts) {
        const delivery = this.state.pptDeliveries.runs[attempt.attemptId] as PptDeliveryRun | undefined;
        if (delivery && !['completed', 'failed', 'canceled'].includes(delivery.executionStatus)) {
          delivery.cancellationRequestedAt ??= record.requestedAt;
          if (delivery.humanWaitStartedAt) {
            delivery.humanWaitingMs = (delivery.humanWaitingMs ?? 0) + Math.max(0, Date.parse(record.requestedAt) - Date.parse(delivery.humanWaitStartedAt));
            delete delivery.humanWaitStartedAt;
          }
          delivery.phase = 'canceling_children'; delivery.updatedAt = new Date().toISOString();
          delivery.humanReviews = delivery.humanReviews?.map(review => review.status === 'pending'
            ? { ...review, status: 'canceled', updatedAt: delivery.updatedAt } : review);
        }
      }
    }
    this.save();
    if (!['completed', 'failed', 'canceled', 'rejected'].includes(job.executionStatus)) this.ledger.requestCancellation(job.currentAttemptId);
    await this.reconcileCancellation(record);
    return this.ledgerView(origin, jobId);
  }
  private async reconcileCancellation(record: ExecutionCancellation): Promise<void> {
    const existing = this.canceling.get(record.attemptId);
    if (existing) return existing;
    const operation = this.performCancellation(record);
    this.canceling.set(record.attemptId, operation);
    try { await operation; } finally { this.canceling.delete(record.attemptId); }
  }
  private async performCancellation(record: ExecutionCancellation): Promise<void> {
    if (record.status === 'completed') return;
    const origin = record.originSessionId;
    // A send already on the wire may still return a child. Wait for its owner, then enumerate the real ledger again.
    for (const id of this.cancellationJobs(origin, record.jobId, record.cascade)) {
      for (const attempt of this.ledger.get(origin, id).attempts) await this.advancingDeliveries.get(attempt.attemptId);
    }
    const ids = this.cancellationJobs(origin, record.jobId, record.cascade), localRuns: PptDeliveryRun[] = [], localReports: ReportReviewRun[] = [];
    for (const id of ids) {
      for (const attempt of this.ledger.get(origin, id).attempts) {
        if (['completed', 'failed', 'canceled', 'rejected'].includes(attempt.executionStatus)) continue;
        const report = this.state.reportReviews?.[attempt.attemptId];
        if (report) { localReports.push(report); continue; }
        const delivery = this.state.pptDeliveries.runs[attempt.attemptId] as PptDeliveryRun | undefined;
        if (delivery) {
          if (['completed', 'failed', 'canceled'].includes(delivery.executionStatus)) {
            const partial = deliveryException(delivery, delivery.resultSummary ?? delivery.diagnostics.at(-1) ?? 'Delivery terminated');
            this.ledger.observe(attempt.attemptId, delivery.parentUpdatePending ?? { executionStatus: delivery.executionStatus,
              phase: delivery.phase, resultSummary: partial.summary, artifactLinks: partial.artifacts });
            delete delivery.parentUpdatePending;
          } else localRuns.push(delivery);
          continue;
        }
        try {
          const raw = this.state.jobs.find(item => item.attemptId === attempt.attemptId);
          if (raw) await this.invokeMethod('remote_agent_cancel', { originSessionId: raw.originSessionId, remote: raw.remote, taskId: raw.taskId });
          else if (attempt.submissionStatus === 'prepared') this.ledger.knownNotSubmitted(attempt.attemptId, { executionStatus: 'canceled', diagnostic: 'Closed before dispatch' });
          else throw new Error(`Cannot confirm backend admission for ${attempt.attemptId}`);
        } catch (error) {
          const diagnostic = error instanceof Error ? error.message : 'Cancellation could not be confirmed';
          if (!record.diagnostics.includes(diagnostic)) record.diagnostics.push(diagnostic);
        }
      }
    }
    const localIds = new Set([...localRuns, ...localReports].map(run => run.attemptId));
    const targets = ids.flatMap(id => this.ledger.get(origin, id).attempts).map(attempt => ({ jobId: attempt.jobId, attemptId: attempt.attemptId,
      executionStatus: attempt.executionStatus, submissionStatus: attempt.submissionStatus }));
    const unresolved = targets.filter(item => !localIds.has(item.attemptId)
      && (!['completed', 'failed', 'canceled', 'rejected'].includes(item.executionStatus) || item.submissionStatus === 'submission_unknown'));
    if (!unresolved.length) for (const run of localRuns) {
      run.executionStatus = 'canceled'; run.phase = 'user_canceled'; run.updatedAt = new Date().toISOString();
      delete run.pending; delete run.parentUpdatePending;
      run.transitions.push({ at: run.updatedAt, stage: run.stage, phase: run.phase, reason: 'User closed task; all delegated executions confirmed terminal' });
      for (const item of run.children) {
        const observed = this.ledger.getAttempt(item.child.attemptId);
        item.child.executionStatus = observed.executionStatus; item.child.submissionStatus = observed.submissionStatus;
      }
      if (run.currentChild) run.currentChild.executionStatus = this.ledger.getAttempt(run.currentChild.attemptId).executionStatus;
      const partial = deliveryException(run, '任务已按用户要求停止；后续派单已关闭，子任务已确认停止。已有产物保留。');
      run.resultSummary = partial.summary;
      this.ledger.observe(run.attemptId, { executionStatus: 'canceled', phase: run.phase, resultSummary: partial.summary, artifactLinks: partial.artifacts });
      this.executionNotice(run, partial.summary, partial.artifacts);
    }
    if (!unresolved.length) for (const run of localReports) {
      run.executionStatus = 'canceled'; run.phase = 'user_canceled'; run.updatedAt = new Date().toISOString();
      run.humanReviews = run.humanReviews.map(review => review.status === 'pending' ? { ...review, status: 'canceled', updatedAt: run.updatedAt } : review);
      this.save(); this.updateReport(run);
    }
    record.status = unresolved.length ? 'blocked' : 'completed';
    record.targets = ids.flatMap(id => this.ledger.get(origin, id).attempts).map(attempt => ({ jobId: attempt.jobId, attemptId: attempt.attemptId,
      executionStatus: attempt.executionStatus, submissionStatus: attempt.submissionStatus }));
    record.checkedAt = new Date().toISOString();
    if (record.status === 'completed') record.completedAt = record.checkedAt;
    this.save();
  }
  private async probeTarget(targetId: string) {
    const target = this.targets.getTarget(targetId), connection = this.targets.getConnection(target.connectionId);
    if (!target.enabled || !connection.enabled || target.kind === 'workflow') return this.targets.invoke('execution_target_probe', { targetId });
    const checkedAt = new Date().toISOString(), baseTtl = connection.probePolicy?.ttlMs ?? 60_000;
    const checkedScope = ['agent_card']; let connectionStatus: 'reachable' | 'unreachable' = 'reachable';
    let targetStatus: 'ready' | 'misconfigured' | 'unavailable' = 'ready'; let reasonCode: string | undefined;
    try {
      const key = `${connection.connectionId}:${connection.connectionVersion}`;
      let probe = this.probeCards.get(key);
      if (!probe || probe.until <= Date.now()) {
        const result = this.client(connection.remote, connection.endpoint).then(client => client.getAgentCard(this.auth(connection.remote)));
        probe = { until: Date.now() + baseTtl, result }; this.probeCards.set(key, probe);
      }
      await probe.result;
      if (target.binding.cwd) {
        const report = await this.preflight(connection.remote, { cwd: target.binding.cwd,
          ...(target.binding.allowedDirectories ? { allowedDirectories: target.binding.allowedDirectories } : {}) }, connection.endpoint);
        checkedScope.push('cwd_realpath_permissions', ...(target.binding.allowedDirectories ? ['directory_scope'] : []));
        if (!report.ok) { targetStatus = 'misconfigured'; reasonCode = 'remote_preflight_failed'; }
      }
    } catch { connectionStatus = 'unreachable'; targetStatus = 'unavailable'; reasonCode = 'read_only_probe_failed'; }
    const failureKey = `${targetId}:${target.configVersion}:${connection.connectionVersion}`;
    const failureCount = targetStatus === 'ready' ? 0 : (this.probeFailures.get(failureKey) ?? 0) + 1;
    this.probeFailures.set(failureKey, failureCount);
    const ttl = targetStatus === 'ready' ? baseTtl : Math.min(600_000, baseTtl * 2 ** Math.min(failureCount, 6));
    const health = { targetId, configVersion: target.configVersion, connectionId: target.connectionId,
      connectionVersion: connection.connectionVersion, checkedAt, validUntil: new Date(Date.now() + ttl).toISOString(), checkedScope,
      connectionStatus, targetStatus, failureCount, ...(reasonCode ? { reasonCode } : {}) };
    this.targets.recordProbe(health);
    return { ...this.targets.invoke('execution_target_probe', { targetId }) as any, performed: true, health,
      unverified: ['arbitrary_task_success', 'model_quota', ...(target.binding.agentPreset ? ['preset_existence'] : [])] };
  }
  private client(remote: string, pinnedEndpoint?: string): Promise<Client> {
    const configured = this.config.remotes[remote];
    if (!configured) throw new Error(`Unknown remote: ${remote}`);
    const config = { ...configured, url: pinnedEndpoint ?? configured.url }, key = `${remote}:${config.url}`;
    let pending = this.clients.get(key);
    if (!pending) {
      const fetchImpl: typeof fetch = async (input, init) => {
        if (this.closed) throw new Error('Gateway is closed');
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== new URL(config.url).origin) throw new Error('Agent Card endpoint must use the configured remote origin');
        const controller = new AbortController();
        this.controllers.add(controller);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]);
        try { return await fetch(input, { ...init, signal, redirect: 'error' }); }
        finally { this.controllers.delete(controller); }
      };
      pending = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl }), clientConfig: { polling: true } }).createFromUrl(config.url);
      this.clients.set(key, pending);
      void pending.catch(() => { if (this.clients.get(key) === pending) this.clients.delete(key); });
    }
    return pending;
  }
  private auth(remote: string) { return { serviceParameters: { Authorization: `Bearer ${this.config.remotes[remote]!.token}` } }; }
  private async preflight(remote: string, input: z.output<typeof a2aPreflightInputSchema>, pinnedEndpoint?: string) {
    const configured = this.config.remotes[remote];
    const config = configured ? { ...configured, url: pinnedEndpoint ?? configured.url } : undefined;
    if (!config) throw new Error(`Unknown remote: ${remote}`);
    const client = await this.client(remote, config.url), card = await client.getAgentCard(this.auth(remote));
    const endpoint = card.supportedInterfaces.find(value => value.protocolBinding === 'JSONRPC')?.url;
    if (!endpoint) throw new Error('Remote does not advertise a JSONRPC endpoint');
    const url = new URL(endpoint);
    if (url.origin !== new URL(config.url).origin || url.username || url.password) throw new Error('Preflight endpoint must use the configured remote origin');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/preflight`; url.search = ''; url.hash = '';
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const response = await fetch(url, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
        body: JSON.stringify(input), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Remote preflight failed (HTTP ${response.status})`); }
      return a2aPreflightReportSchema.parse(await response.json());
    } finally { this.controllers.delete(controller); }
  }
  private async checkDispatch(remote: string, cwd: string, requirements?: z.output<typeof a2aPreflightRequirementsSchema>, pinnedEndpoint?: string): Promise<void> {
    if (!requirements) return;
    const report = await this.preflight(remote, { cwd, ...requirements }, pinnedEndpoint);
    if (!report.ok) throw new Error(`Remote preflight rejected dispatch: ${report.checks.filter(check => !check.ok).map(check => check.id).join(', ')}`);
  }
  private job(params: z.output<typeof taskSchema>): Job {
    const job = this.state.jobs.find(value => value.remote === params.remote && value.taskId === params.taskId && value.originSessionId === params.originSessionId);
    if (!job) throw new Error('Task not found for this origin session');
    return job;
  }
  private view(job: Job) {
    const task = Task.fromJSON(job.task);
    const meta = task.metadata?.['1agents'] as { sessionId?: string; preflight?: unknown; result?: unknown; capacity?: unknown; taskSlot?: unknown; processSlot?: unknown; resumed?: unknown; restoreMethod?: unknown; provider?: unknown; model?: unknown } | undefined;
    const result = job.attemptId ? this.ledger.getAttempt(job.attemptId).result : undefined;
    return { remote: job.remote, taskId: job.taskId, contextId: job.contextId, originSessionId: job.originSessionId,
      ...(job.ledgerJobId ? { jobId: job.ledgerJobId, attemptId: job.attemptId, sourceId: this.ledger.sourceId } : {}),
      cwd: job.cwd, agentPreset: job.agentPreset, sessionId: meta?.sessionId ?? job.sessionId,
      preflight: meta?.preflight, resultMetadata: meta?.result,
      ...(meta?.capacity ? { capacity: meta.capacity } : {}),
      ...(meta?.taskSlot ? { taskSlot: meta.taskSlot } : {}),
      ...(meta?.processSlot ? { processSlot: meta.processSlot } : {}),
      ...(meta?.resumed === true ? { resumed: true } : {}),
      ...(meta?.restoreMethod === 'session/load' || meta?.restoreMethod === 'session/resume' ? { restoreMethod: meta.restoreMethod } : {}),
      ...(typeof meta?.provider === 'string' && typeof meta.model === 'string' ? { provider: meta.provider, model: meta.model } : {}),
      ...(job.lifecycle ? { lifecycle: job.lifecycle } : {}),
      ...(job.sessionState ? { sessionState: job.sessionState } : {}),
      ...(job.processReleased !== undefined ? { processReleased: job.processReleased } : {}),
      resultRevision: result?.resultRevision, resultDigest: result?.resultDigest,
      state: taskState(job), result: resultText(task), artifactLinks: artifactLinks(task), checkedAt: job.checkedAt, stale: Boolean(job.stale) };
  }
  private resultObservation(task: Task): LedgerObservation {
    const metadata = task.metadata?.['1agents']?.result as A2AResultMetadata | undefined;
    return { executionStatus: this.standardState(wire(task).status?.state), providerState: wire(task).status?.state,
      resultSummary: resultText(task), artifactLinks: artifactLinks(task),
      resultArtifacts: metadata?.artifacts ?? [], ...(metadata?.recordPath ? { structuredResultRef: metadata.recordPath } : {}) };
  }
  private accept(task: Task, fields: Omit<Job, 'task' | 'taskId' | 'contextId' | 'checkedAt'>): Job {
    const target = task.metadata?.['1agents'] as Record<string, unknown> | undefined;
    const job: Job = { ...fields, taskId: task.id, contextId: task.contextId, task: wire(task), checkedAt: new Date().toISOString(),
      cwd: typeof target?.cwd === 'string' ? target.cwd : fields.cwd,
      agentPreset: typeof target?.agentPreset === 'string' ? target.agentPreset : fields.agentPreset };
    this.state.jobs.push(job);
    this.update(job, task);
    return job;
  }
  private update(job: Job, task: Task): void {
    if (task.id !== job.taskId || task.contextId !== job.contextId) throw new Error('Remote returned a different task');
    const previous = Task.fromJSON(job.task);
    if ((terminal.has(taskState(job)) && !terminal.has(wire(task).status?.state)) ||
      Date.parse(previous.status?.timestamp ?? '') > Date.parse(task.status?.timestamp ?? '')) return;
    job.task = wire(task); job.checkedAt = new Date().toISOString(); job.stale = false;
    const meta = task.metadata?.['1agents'] as { sessionId?: unknown } | undefined;
    if (typeof meta?.sessionId === 'string' && meta.sessionId) job.sessionId = meta.sessionId;
    const state = taskState(job);
    if (actionable.has(state)) {
      const reason = state === 'TASK_STATE_CANCELED' && job.attemptId ? this.state.executionCancellations?.[job.attemptId]?.reason : undefined;
      const noticeId = createHash('sha256').update(JSON.stringify([job.remote, job.taskId, state, task.status?.timestamp])).digest('hex');
      if (!this.state.notices.some(value => value.notice.noticeId === noticeId)) this.state.notices.push({
        ...(this.sessions.hasBinding(job.originSessionId) ? { sessionDeliveryId: `a2a-notice:${noticeId}` } : { target: job.notificationTarget }),
        notice: { noticeId, originSessionId: job.originSessionId, remote: job.remote, taskId: job.taskId, contextId: job.contextId,
          cwd: job.cwd, agentPreset: job.agentPreset, title: job.title, state, result: reason ? `${reason}\n\n${resultText(task)}`.trim() : resultText(task),
          ...(artifactLinks(task).length ? { artifactLinks: artifactLinks(task) } : {}), createdAt: new Date().toISOString() } });
    }
    if (job.attemptId) {
      const observed = { ...this.resultObservation(task), stale: false };
      if (this.ledger.getAttempt(job.attemptId).submissionStatus !== 'accepted') this.ledger.accept(job.attemptId,
        { provider: 'a2a', remote: job.remote, endpoint: job.remoteEndpoint, taskId: task.id, contextId: task.contextId, sessionId: task.metadata?.['1agents']?.sessionId }, observed);
      else this.ledger.observe(job.attemptId, observed);
    } else this.save();
    if (oneShotShouldClose(job.lifecycle, state, this.taskAcknowledged(job, state))) this.releaseOneShot(job);
  }
  private async refresh(job: Job): Promise<void> {
    const key = `${job.remote}:${job.taskId}`;
    const previous = this.refreshing.get(key);
    if (previous) return previous;
    const pending = (async () => {
      try { const client = await this.client(job.remote, job.remoteEndpoint); this.update(job, await client.getTask(GetTaskRequest.fromJSON({ id: job.taskId }), this.auth(job.remote))); }
      catch { job.stale = true;
        if (job.attemptId) this.ledger.observe(job.attemptId, { stale: true }); else this.save(); }
    })();
    this.refreshing.set(key, pending);
    try { await pending; } finally { this.refreshing.delete(key); }
  }
  async reconcile(): Promise<void> {
    if (this.closed) return;
    if (this.reconciling) return this.reconciling;
    const pending = (async () => {
      await Promise.allSettled(this.targets.listTargets().filter(target => target.enabled && target.kind !== 'workflow' && !this.targets.getHealth(target.targetId))
        .map(target => this.probeTarget(target.targetId)));
      await Promise.allSettled(this.state.jobs.filter(job => !terminal.has(taskState(job))).map(job => this.refresh(job)));
      if (this.closed) return;
      for (const cancellation of Object.values(this.state.executionCancellations ?? {})) {
        if (cancellation.status !== 'completed') await this.reconcileCancellation(cancellation);
      }
      for (const run of Object.values(this.state.pptDeliveries.runs) as PptDeliveryRun[]) {
        if (this.closed) break;
        if (run.cancellationRequestedAt && run.executionStatus !== 'canceled') continue;
        if (run.executionStatus === 'working' || run.parentUpdatePending || run.humanReviews?.some(review => review.resume?.status === 'pending')) {
          try { await this.advanceDelivery(run); }
          catch (error) { run.diagnostics.push(error instanceof Error ? error.message : 'Delivery reconciliation failed'); this.save(); }
        }
        if (run.executionStatus !== 'working' && !run.parentUpdatePending) this.executionNotice(run,
          run.resultSummary ?? this.ledgerView(run.originSessionId, run.jobId).resultSummary ?? run.diagnostics.at(-1) ?? 'PPT delivery requires attention', run.validation?.artifacts ?? []);
      }
      for (const run of Object.values(this.state.reportReviews ?? {})) {
        if (this.closed) break;
        if (this.state.executionCancellations?.[run.attemptId]) continue;
        if (run.executionStatus === 'working' || run.humanReviews.some(review => review.resume?.status === 'pending') || ['completed', 'failed', 'canceled'].includes(run.executionStatus)) {
          try { await this.advanceReport(run); }
          catch (error) { run.resultSummary = `报告协调器等待处理：${error instanceof Error ? error.message : 'unknown error'}`; this.save(); }
        }
      }
      // The persisted notice owns its route. Later bindings must not double-deliver old webhooks.
      if (this.sessions.healthy) for (const record of this.state.notices) {
        if (!record.sessionDeliveryId) continue;
        if (record.acknowledged) { this.sessions.acknowledgeNotice(record.notice.originSessionId, record.notice.noticeId); continue; }
        const notice = record.notice;
        // Keep already-persisted queue text immutable across notification format upgrades.
        if (this.sessions.hasDelivery(notice.originSessionId, record.sessionDeliveryId)) continue;
        this.sessions.enqueue({ originSessionId: notice.originSessionId, messageId: record.sessionDeliveryId,
          text: formatNotice(notice) });
      }
      if (this.sessions.healthy) await this.sessions.reconcile();
      if (this.sessions.healthy) {
        for (const notice of this.state.executionNotices ?? []) {
          if (!notice.processedAt && this.sessions.hasBinding(notice.originSessionId) && !this.sessions.hasDelivery(notice.originSessionId, notice.messageId)) {
            this.sessions.enqueue({ originSessionId: notice.originSessionId, messageId: notice.messageId, text: notice.text });
          }
        }
        await this.sessions.reconcile();
      }
      await Promise.allSettled(this.state.notices.filter(record => record.target && !record.delivered && !record.acknowledged).map(record => this.deliver(record)));
      for (const job of this.state.jobs) {
        if (this.closed) break;
        if (oneShotShouldClose(job.lifecycle, taskState(job), this.taskAcknowledged(job, taskState(job)))) this.releaseOneShot(job);
      }
      await this.reconcileIdleSessions();
      await this.automation?.reconcileAcknowledgements();
    })();
    this.reconciling = pending;
    try { await pending; } finally { this.reconciling = undefined; }
  }
  private async deliver(record: NoticeRecord): Promise<void> {
    const id = record.notice.noticeId;
    const target = this.config.notificationTargets[record.target!];
    if (!target || this.delivering.has(id)) return;
    this.delivering.add(id);
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const response = await fetch(target.url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}`, 'Idempotency-Key': id }, body: JSON.stringify(record.notice) });
      await response.body?.cancel();
      if (response.ok) { record.delivered = true; this.save(); }
    } catch { /* Durable outbox retries on the next tick, with the same ID. */ }
    finally { this.controllers.delete(controller); this.delivering.delete(id); }
  }
  async invoke(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error('Gateway is closed');
    const operation = this.invokeMethod(method, params);
    this.operations.add(operation);
    try { return await operation; } finally { this.operations.delete(operation); }
  }
  private async invokeMethod(method: string, params: unknown): Promise<unknown> {
    if (Object.hasOwn(DISCOVERY_METHODS, method)) {
      if (!this.projectDiscovery) throw new Error('Project discovery is disabled; configure projectDiscovery in the trusted gateway configuration');
      return this.projectDiscovery.invoke(method, params);
    }
    if (Object.hasOwn(TARGET_METHODS, method)) {
      if (method === 'execution_target_probe') return this.probeTarget(z.object({ targetId: string }).strict().parse(params).targetId);
      return this.targets.invoke(method, params);
    }
    if (method === 'execution_submit') return this.submitExecution(executionSubmitSchema.parse(params));
    if (method === 'execution_continue') {
      const input = executionContinueSchema.parse(params), job = this.ledger.get(input.originSessionId, input.jobId);
      const replay = this.ledger.replay({ originSessionId: input.originSessionId, jobId: job.jobId,
        operation: 'continue', title: job.title, targetSnapshot: { targetId: job.targetId },
        input: input.input, requestDigestInput: input.input, clientRequestId: input.clientRequestId });
      if (replay) return { ...this.ledgerView(input.originSessionId, job.jobId), attemptId: replay.attempt.attemptId, requestedAttempt: replay.attempt };
      const attempt = job.attempts.find(item => item.attemptId === job.currentAttemptId)!;
      if (job.unresolvedAttemptIds.length) throw new Error('Job has submission_unknown or unresolved attempts; reconcile before continuing');
      if (this.state.reportReviews?.[attempt.attemptId]) throw new Error('Report workflow continues only through its version-bound human review');
      const delivery = this.state.pptDeliveries.runs[attempt.attemptId];
      if (delivery) {
        this.assertDispatchOpen(input.originSessionId, job.jobId);
        const recovery = Object.keys(input.input).length ? pptDeliveryRecoveryInputSchema.safeParse(input.input) : undefined;
        if (recovery && !recovery.success) throw new Error('PPT recovery preserves the frozen input; use {} or {recoveryMode:"review_only",reviewTargetId,sourceSnapshotDirectory?}');
        const recoveryInput = recovery?.data;
        if (job.inFlightAttemptIds.length) throw new Error('PPT parent still has in-flight execution rounds');
        assertPptDeliveryRecoverable(delivery, recoveryInput);
        if (recoveryInput) {
          for (const childId of this.cancellationJobs(input.originSessionId, job.jobId, true)) {
            const child = this.ledger.get(input.originSessionId, childId);
            if (child.inFlightAttemptIds.length || child.unresolvedAttemptIds.length) throw new Error('PPT recovery has unresolved or running descendants');
          }
          const reviewer = this.targets.resolve(recoveryInput.reviewTargetId, { prompt: 'Independent review recovery preflight' });
          if (reviewer.target.binding.driver === 'ppt_delivery') throw new Error('Independent reviewer must be an A2A execution target');
        }
        const current = this.targets.resolve(job.targetId, attempt.input as Record<string, unknown>);
        if (!current.target.capabilities?.continue) throw new Error('PPT target does not enable checkpoint continuation');
        const snapshot = attempt.targetSnapshot;
        if (current.remote !== snapshot.remote || current.endpoint !== snapshot.endpoint || current.cwd !== snapshot.cwd
            || current.agentPreset !== snapshot.agentPreset || current.target.binding.roleId !== snapshot.roleId
            || current.target.binding.driver !== 'ppt_delivery') throw new Error('PPT checkpoint recovery cannot change its host or role');
        return this.submitExecution({ originSessionId: input.originSessionId, targetId: job.targetId, title: job.title,
          input: attempt.input as Record<string, unknown>, clientRequestId: input.clientRequestId },
          { jobId: job.jobId, deliveryRecovery: delivery, deliveryRecoveryInput: recoveryInput, requestDigestInput: input.input });
      }
      const previous = this.state.jobs.find(item => item.attemptId === attempt.attemptId);
      if (!previous) throw new Error('Continue is unsupported for this provider');
      return this.submitExecution({ originSessionId: input.originSessionId, targetId: job.targetId, title: job.title,
        input: { ...(attempt.input as Record<string, unknown>), ...input.input }, clientRequestId: input.clientRequestId }, { jobId: job.jobId, previous, requestDigestInput: input.input });
    }
    if (method === 'execution_get') {
      const input = executionJobSchema.parse(params), job = this.ledger.get(input.originSessionId, input.jobId);
      const raw = this.state.jobs.find(item => item.attemptId === job.currentAttemptId);
      if (raw) await this.refresh(raw);
      return this.ledgerView(input.originSessionId, input.jobId);
    }
    if (method === 'execution_cancel') {
      const input = executionCancelSchema.parse(params);
      return this.cancelExecution(input.originSessionId, input.jobId, input.cascade);
    }
    if (method === 'execution_list') {
      const input = executionListSchema.parse(params);
      const jobs = this.ledger.list(input.originSessionId).filter(job => (!input.targetId || job.targetId === input.targetId) && (!input.executionStatus || job.executionStatus === input.executionStatus));
      return { jobs: jobs.slice(input.offset, input.offset + input.limit), total: jobs.length, offset: input.offset, limit: input.limit };
    }
    if (method === 'execution_events') {
      const input = executionEventsSchema.parse(params);
      const events = this.ledger.events(input.originSessionId, input.jobId, input.afterSequence), page = events.slice(0, input.limit);
      return { sourceId: this.ledger.sourceId, events: page, hasMore: events.length > page.length, nextSequence: page.at(-1)?.sequence };
    }
    if (method === 'execution_review') {
      const { originSessionId, jobId, ...review } = executionReviewSchema.parse(params);
      return this.ledger.acceptance(originSessionId, jobId, review);
    }
    if (method === 'execution_inbox') {
      const { originSessionId } = inboxSchema.parse(params);
      return { notices: this.state.executionNotices!.filter(item => item.originSessionId === originSessionId && !item.processedAt)
        .map(({ text: _text, ...notice }) => notice) };
    }
    if (method === 'execution_ack') {
      const input = ackSchema.parse(params), notice = this.state.executionNotices!.find(item => item.originSessionId === input.originSessionId && item.noticeId === input.noticeId);
      if (!notice) throw new Error('Execution notice not found in origin scope');
      notice.processedAt ??= new Date().toISOString(); this.save();
      this.sessions.acknowledgeMessage(input.originSessionId, notice.messageId);
      return { acknowledged: true, noticeId: notice.noticeId, processedAt: notice.processedAt };
    }
    if (method === 'remote_agent_preflight') {
      const { remote, originSessionId: _origin, ...input } = preflightSchema.parse(params);
      return this.preflight(remote, input);
    }
    if (method === 'session_bind') return this.sessions.bind(sessionBindSchema.parse(params));
    if (method === 'session_send') {
      const input = sessionSendSchema.parse(params);
      if (input.messageId.startsWith('a2a-notice:') || input.messageId.startsWith('execution-notice:')) throw new Error('The a2a-notice: and execution-notice: message ID namespaces are reserved for task notifications');
      const result = this.sessions.enqueue(input);
      void this.reconcile().catch(() => {});
      return result;
    }
    if (method === 'session_delivery_get') return this.sessions.get(sessionMessageSchema.parse(params));
    if (method === 'session_delivery_resolve') {
      const result = this.sessions.resolve(sessionResolveSchema.parse(params));
      void this.reconcile().catch(() => {});
      return result;
    }
    if (method === 'remote_agent_spawn') {
      const input = spawnSchema.parse(params);
      if (input.notificationTarget && !this.config.notificationTargets[input.notificationTarget]) throw new Error('Unknown notificationTarget');
      const { originSessionId, remote, clientRequestId, title, ...fields } = input;
      const submitted = await this.submitExecution({ originSessionId, targetId: `legacy:${remote}`, input: fields, clientRequestId, title });
      if ('error' in submitted) throw new Error(`${submitted.error}; jobId=${submitted.jobId}; attemptId=${submitted.attemptId}`);
      const raw = this.state.jobs.find(item => item.attemptId === submitted.attemptId);
      if (!raw) throw new Error(`Task admission unresolved; jobId=${submitted.jobId}; attemptId=${submitted.attemptId}`);
      return this.view(raw);
    }
    if (method === 'remote_agent_get' || method === 'remote_agent_cancel') {
      const job = this.job(taskSchema.parse(params));
      if (method === 'remote_agent_cancel') {
        if (job.attemptId) this.ledger.requestCancellation(job.attemptId);
        const client = await this.client(job.remote, job.remoteEndpoint);
        this.update(job, await client.cancelTask(CancelTaskRequest.fromJSON({ id: job.taskId }), this.auth(job.remote)));
      } else await this.refresh(job);
      return this.view(job);
    }
    if (method === 'remote_agent_message') {
      const input = messageSchema.parse(params), previous = this.job(input);
      if (previous.sessionState === 'deleted') throw new RemoteAgentError('SESSION_DELETED', 'Session was deleted');
      if (input.autoResume === false && (previous.sessionState === 'closed' || previous.sessionState === 'closing')) {
        throw new RemoteAgentError('SESSION_CLOSED', 'Session is closed');
      }
      if (!previous.ledgerJobId) throw new Error('Task has no unified job association');
      const record = this.ledger.get(input.originSessionId, previous.ledgerJobId);
      const target = this.targets.getTarget(record.targetId);
      const submitted = await this.submitExecution({ originSessionId: input.originSessionId, targetId: record.targetId,
        clientRequestId: input.clientRequestId, title: previous.title,
        input: { ...(target.kind === 'agent_host' ? { cwd: previous.cwd, ...(previous.agentPreset ? { agentPreset: previous.agentPreset } : {}) } : {}), prompt: input.prompt,
          ...(input.preflight ? { preflight: input.preflight } : {}), ...(input.resultContract ? { resultContract: input.resultContract } : {}),
          ...(input.roleId ? { roleId: input.roleId } : {}), ...(input.roleLockPath ? { roleLockPath: input.roleLockPath } : {}),
          ...(input.lifecycle ? { lifecycle: input.lifecycle } : previous.lifecycle ? { lifecycle: previous.lifecycle } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}), ...(input.model !== undefined ? { model: input.model } : {}),
          ...(previous.notificationTarget ? { notificationTarget: previous.notificationTarget } : {}) } }, { jobId: previous.ledgerJobId, previous });
      if ('error' in submitted) throw new Error(`${submitted.error}; jobId=${submitted.jobId}; attemptId=${submitted.attemptId}`);
      const raw = this.state.jobs.find(item => item.attemptId === submitted.attemptId);
      if (!raw) throw new Error(`Task admission unresolved; jobId=${submitted.jobId}; attemptId=${submitted.attemptId}`);
      return this.view(raw);
    }
    if (method === 'remote_agent_list' || method === 'remote_agent_inbox') {
      const { originSessionId } = inboxSchema.parse(params);
      return method === 'remote_agent_list' ? { tasks: this.state.jobs.filter(job => job.originSessionId === originSessionId).map(job => this.view(job)) } :
        { notices: this.state.notices.filter(record => record.notice.originSessionId === originSessionId && !record.acknowledged).map(record => record.notice) };
    }
    if (method === 'remote_agent_ack') {
      const input = ackSchema.parse(params);
      const notice = this.state.notices.find(record => record.notice.originSessionId === input.originSessionId && record.notice.noticeId === input.noticeId);
      if (!notice) throw new Error('Notice not found for this origin session');
      notice.acknowledged = true; this.save();
      this.sessions.acknowledgeNotice(input.originSessionId, input.noticeId);
      const acked = this.state.jobs.find(item => item.originSessionId === input.originSessionId && item.taskId === notice.notice.taskId);
      if (acked && oneShotShouldClose(acked.lifecycle, notice.notice.state, true)) this.releaseOneShot(acked);
      return { acknowledged: true, noticeId: input.noticeId };
    }
    if (method === 'remote_agent_close') {
      const input = closeSchema.parse(params);
      const present = [input.taskId, input.contextId, input.sessionId].filter(value => value !== undefined);
      if (present.length !== 1) throw new RemoteAgentError('SESSION_CONFLICT', 'Provide exactly one of taskId, contextId, or sessionId');
      if (input.mode === 'delete' && !this.config.sessionLifecycle.allowDelete) throw new RemoteAgentError('DELETE_DISABLED', 'Session delete is disabled on this gateway');
      return this.performClose(input, 'explicit');
    }
    if (method === 'remote_agent_sessions') {
      sessionsSchema.parse(params ?? {});
      return this.capacityReport(true);
    }
    throw new Error(`Unknown method: ${method}`);
  }
  /** Push events are hints. GetTask remains authoritative, including after missed callbacks. */
  async receivePush(event: unknown): Promise<void> {
    const value = z.object({ task: z.object({ id: string }).passthrough().optional(), statusUpdate: z.object({ taskId: string }).passthrough().optional(),
      artifactUpdate: z.object({ taskId: string }).passthrough().optional() }).passthrough().parse(event);
    const taskId = value.task?.id ?? value.statusUpdate?.taskId ?? value.artifactUpdate?.taskId;
    if (!taskId) throw new Error('Missing A2A event task ID');
    await Promise.allSettled(this.state.jobs.filter(job => job.taskId === taskId).map(job => this.refresh(job)));
  }
  private workbenchProjection() {
    const config = this.config.workbench;
    if (!config) throw new Error('Workbench is not configured');
    const runs = Object.values(this.state.pptDeliveries.runs) as PptDeliveryRun[];
    const reportRuns = Object.values(this.state.reportReviews ?? {});
    return workbenchSnapshot({ ledger: this.ledger.snapshot(), runs, reportRuns, reviews: [...runs.flatMap(run => run.humanReviews ?? []), ...reportRuns.flatMap(run => run.humanReviews)],
      processRequests: this.state.processRequests ?? [], actorId: config.reviewerId, ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}) });
  }
  private workbench<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.workbenchQueue.then(operation);
    this.workbenchQueue = run.then(() => {}, () => {});
    return run;
  }
  private writeProcessRequest(request: ProcessRequest): void {
    const items = this.state.processRequests ?? [];
    const index = items.findIndex(item => item.requestId === request.requestId);
    const next = items.slice();
    if (index < 0) next.push(request); else next[index] = request;
    this.state.processRequests = next;
    this.save();
  }
  workbenchList(query: WorkbenchListQuery = {}) { return listWorkbenchTasks(this.workbenchProjection(), query); }
  workbenchAgents() {
    const residents = this.targets.listTargets().filter(target => target.kind === 'resident_agent').map(target => ({
      targetId: target.targetId, name: target.name, ...(target.binding.roleId ? { roleId: target.binding.roleId } : {}),
      ...(target.binding.agentPreset ? { agentPreset: target.binding.agentPreset } : {}) }));
    return listWorkbenchAgents(this.workbenchProjection(), this.agents.snapshot(), residents);
  }
  createWorkbenchAgent(input: unknown) { return this.workbench(async () => ({ draft: this.agents.create(input), ...this.workbenchAgents() })); }
  updateWorkbenchAgent(agentId: string, input: unknown) { return this.workbench(async () => ({ draft: this.agents.update(agentId, input), ...this.workbenchAgents() })); }
  publishWorkbenchAgent(agentId: string, input: unknown) { return this.workbench(async () => ({ release: this.agents.publish(agentId, input), ...this.workbenchAgents() })); }
  workbenchTask(jobId: string) { return getWorkbenchTask(this.workbenchProjection(), jobId); }
  /** Only the dedicated HTTP workbench calls this; it is deliberately absent from the agent tool catalogue. */
  async decideWorkbenchReview(jobId: string, reviewId: string, input: unknown) {
    return this.workbench(async () => {
      if (this.closed) throw new Error('Gateway is closed');
      const scope = this.workbenchTask(jobId), config = this.config.workbench!;
      await this.advancingDeliveries.get(scope.currentAttemptId);
      const report = this.state.reportReviews?.[scope.currentAttemptId];
      if (report) return this.decideReportReview(report, reviewId, input);
      const run = this.state.pptDeliveries.runs[scope.currentAttemptId] as PptDeliveryRun | undefined;
      const review = run?.humanReviews?.find(item => item.reviewId === reviewId && item.jobId === jobId);
      if (!run || !review) throw new Error('Review not found in authorized task');
      const decision = humanReviewDecisionSchema.parse(input);
      const replay = review.history.some(item => item.clientRequestId === decision.clientRequestId);
      if (!replay && (run.cancellationRequestedAt || ['completed', 'failed', 'canceled'].includes(run.executionStatus))) {
        throw new HumanReviewError('already_decided', 'Task is no longer awaiting a human decision');
      }
      let currentDigest = run.scriptDigest ?? '';
      if (!replay && review.revision === scriptRevisionName(run)) {
        try { currentDigest = createHash('sha256').update(readFileSync(path.join(scriptDirectory(run), 'slide-script.json'))).digest('hex'); }
        catch { throw new HumanReviewError('version_conflict', 'The reviewed content snapshot is unavailable'); }
      }
      const result = decideHumanReview(review, decision, { id: config.reviewerId,
        ...(config.reviewerName ? { displayName: config.reviewerName } : {}), source: '1agents-web' },
      { attemptId: scope.currentAttemptId, revision: scriptRevisionName(run), digest: currentDigest });
      if (!result.idempotent) {
        const nextRun = { ...run, humanReviews: run.humanReviews!.map(item => item.reviewId === reviewId ? result.review : item) };
        const nextDeliveries = { ...this.state.pptDeliveries, runs: { ...this.state.pptDeliveries.runs, [run.attemptId]: nextRun } };
        atomicJson(this.stateFile, { ...this.state, pptDeliveries: nextDeliveries });
        this.state.pptDeliveries = nextDeliveries;
      }
      const current = this.state.pptDeliveries.runs[run.attemptId] as PptDeliveryRun;
      if (current.humanReviews?.some(item => item.resume?.status === 'pending')) void this.advanceDelivery(current).catch(() => {});
      return this.workbenchTask(jobId);
    });
  }
  /** Records a question or plan approval against the running attempt. The workbench token never travels in A2A metadata. */
  async openProcessRequest(jobId: string, input: unknown) {
    return this.workbench(async () => {
      if (this.closed) throw new Error('Gateway is closed');
      const scope = this.workbenchTask(jobId);
      const parsed = processRequestCreateSchema.parse(input);
      if (parsed.jobId !== jobId) throw new ProcessRequestError('invalid', 'Process request job does not match the task');
      let attempt;
      try { attempt = this.ledger.getAttempt(parsed.attemptId); }
      catch { throw new ProcessRequestError('invalid', 'Process request attempt was not found'); }
      if (attempt.jobId !== jobId || attempt.attemptId !== scope.currentAttemptId) throw new ProcessRequestError('invalid', 'Process request attempt is not current');
      if (['completed', 'failed', 'canceled', 'rejected'].includes(scope.executionStatus)) throw new ProcessRequestError('already_decided', 'Task is no longer running');
      if (parsed.requestId) {
        const existing = this.state.processRequests?.find(item => item.requestId === parsed.requestId);
        if (existing) {
          if (!sameProcessRequest(existing, parsed)) throw new ProcessRequestError('idempotency_conflict', 'requestId conflicts with a recorded process request');
          return projectProcessRequest(existing);
        }
      }
      const config = this.config.workbench;
      const created = createProcessRequest(parsed, undefined, config ? config.requestTimeoutMinutes * 60_000 : undefined);
      this.writeProcessRequest(created);
      if (config?.desktopNotifications) {
        const what = created.kind === 'permission' ? `工具「${created.toolTitle}」等待批准` : created.kind === 'plan' ? '计划等待批准' : '问题等待回答';
        notifyDesktop(`任务工作台 · ${scope.title}`.slice(0, 120), `${what}，${config.requestTimeoutMinutes} 分钟内处理`.slice(0, 240), config.publicBaseUrl);
      }
      return created;
    });
  }
  processRequest(jobId: string, requestId: string) {
    const request = this.workbenchTask(jobId).processRequests.find(item => item.requestId === requestId);
    if (!request) throw new ProcessRequestError('not_found', 'Process request not found in authorized task');
    return request;
  }
  /** Completes the stored request. The caller must still finish the original userQuestions wait; this does not send another prompt. */
  async answerProcessRequest(jobId: string, requestId: string, input: unknown) {
    let stop: { origin: string; reason: string } | undefined;
    const task = await this.workbench(async () => {
      if (this.closed) throw new Error('Gateway is closed');
      this.workbenchTask(jobId);
      const stored = this.state.processRequests?.find(item => item.requestId === requestId && item.jobId === jobId);
      if (!stored) throw new ProcessRequestError('not_found', 'Process request not found in authorized task');
      const parsed = processRequestAnswerSchema.parse(input);
      if (stored.status === 'pending' && Date.parse(stored.deadlineAt) <= Date.now() && stored.answer?.clientRequestId !== parsed.clientRequestId) {
        this.writeProcessRequest(expireProcessRequest(stored));
        throw new ProcessRequestError('expired', 'This process request has expired');
      }
      let result;
      try { result = answerProcessRequest(stored, parsed); }
      catch (error) {
        if (error instanceof ProcessRequestError && error.code === 'expired' && stored.status === 'pending') this.writeProcessRequest(expireProcessRequest(stored));
        throw error;
      }
      if (!result.idempotent) this.writeProcessRequest(result.request);
      const view = this.workbenchTask(jobId);
      if (parsed.stopTask && !result.idempotent) stop = { origin: view.originSessionId,
        reason: `人工拒绝工具调用并停止任务${stored.toolTitle ? `（${stored.toolTitle.slice(0, 200)}）` : ''}${parsed.note ? `：${parsed.note}` : ''}` };
      return view;
    });
    // Recorded first, so the waiting agent sees the rejection before the cancel lands.
    if (!stop) return task;
    await this.cancelExecution(stop.origin, jobId, undefined, stop.reason);
    return this.workbenchTask(jobId);
  }
  private jobLifecycle(value: unknown, previous?: SessionLifecycle): SessionLifecycle | undefined {
    if (value === undefined) return previous;
    return normalizeLifecycle(value, this.config.sessionLifecycle.persistentIdleTtlSeconds);
  }
  /**
   * P3. A persistent ACP session closes once the host confirms it is attached and idle and its
   * last turn ended more than idleTtlSeconds ago. Busy, INPUT_REQUIRED and unknown status stay open.
   */
  private async reconcileIdleSessions(): Promise<void> {
    const policy = this.config.sessionLifecycle;
    const now = this.now();
    if (now - this.idleScannedAt < policy.idleScanIntervalMs) return;
    this.idleScannedAt = now;
    const contexts = new Map<string, Job[]>();
    for (const job of this.state.jobs) {
      const key = `${job.originSessionId}\0${job.remote}\0${job.contextId}`;
      contexts.set(key, [...(contexts.get(key) ?? []), job]);
    }
    for (const jobs of contexts.values()) {
      if (this.closed) return;
      for (const job of jobs) if (taskState(job) === 'TASK_STATE_INPUT_REQUIRED') this.alertInputRequired(job, now);
      if (jobs.some(job => !terminal.has(taskState(job)))) continue;
      const job = jobs.at(-1)!;
      if (!isAcpAgentPreset(job.agentPreset) || !job.sessionId || job.sessionState === 'closed' || job.sessionState === 'closing' || job.sessionState === 'deleted') continue;
      const lifecycle = job.lifecycle ?? normalizeLifecycle(undefined, policy.persistentIdleTtlSeconds);
      if (lifecycle.mode !== 'persistent' || lifecycle.idleTtlSeconds === 0) continue;
      const ttlMs = lifecycle.idleTtlSeconds * 1000;
      const endedAt = Date.parse(Task.fromJSON(job.task).status?.timestamp ?? '');
      if (!Number.isFinite(endedAt) || now - endedAt < ttlMs) continue;
      let status: { attached?: unknown; activeTurn?: unknown; lastUsedAt?: unknown };
      try { status = await this.postSession(job.remote, 'status', { sessionId: job.sessionId, contextId: job.contextId }, job.remoteEndpoint); }
      catch { continue; }
      if (status.attached !== true || status.activeTurn !== false) continue;
      const lastUsedAt = typeof status.lastUsedAt === 'string' ? Date.parse(status.lastUsedAt) : Number.NaN;
      if (Number.isFinite(lastUsedAt) && now - lastUsedAt < ttlMs) continue;
      try { await this.performClose({ originSessionId: job.originSessionId, remote: job.remote, contextId: job.contextId }, 'idle-ttl'); }
      catch (error) {
        if (error instanceof RemoteAgentError && error.code === 'SESSION_BUSY') continue;
        this.closeFailures += 1;
        console.warn(`A2A idle close failed session=${job.sessionId} context=${job.contextId} code=${error instanceof RemoteAgentError ? error.code : 'REMOTE_UNAVAILABLE'}`);
      }
    }
  }
  /** Warns once per INPUT_REQUIRED turn after the alert window. The process is never closed for this. */
  private alertInputRequired(job: Job, now: number): void {
    const since = Task.fromJSON(job.task).status?.timestamp ?? '';
    const sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs) || now - sinceMs < this.config.sessionLifecycle.inputRequiredAlertSeconds * 1000) return;
    const key = `${job.taskId}\0${since}`;
    if (this.inputRequiredAlerts.has(key)) return;
    this.inputRequiredAlerts.set(key, { ...(job.sessionId ? { sessionId: job.sessionId } : {}), contextId: job.contextId, since });
    console.warn(`A2A input required for too long session=${job.sessionId ?? ''} context=${job.contextId} task=${job.taskId} since=${since}`);
  }
  /** Read-only lifecycle counts for /health. Close reasons and resumes are counted per context from saved jobs. */
  lifecycleReport() {
    const contexts = new Map<string, Job[]>();
    for (const job of this.state.jobs) {
      const key = `${job.originSessionId}\0${job.remote}\0${job.contextId}`;
      contexts.set(key, [...(contexts.get(key) ?? []), job]);
    }
    const closeReasons: Record<CloseReason, number> = { explicit: 0, 'one-shot': 0, 'idle-ttl': 0 };
    const restoreMethods = { 'session/load': 0, 'session/resume': 0 };
    let busy = 0, processReleasePending = 0;
    for (const jobs of contexts.values()) {
      if (jobs.some(job => !terminal.has(taskState(job)))) busy += 1;
      const last = jobs.at(-1)!;
      if (last.closeReason) closeReasons[last.closeReason] += 1;
      if (last.processReleased === 'pending') processReleasePending += 1;
      for (const job of jobs) {
        const method: unknown = Task.fromJSON(job.task).metadata?.['1agents']?.restoreMethod;
        if (method === 'session/load' || method === 'session/resume') restoreMethods[method] += 1;
      }
    }
    const current = [...this.inputRequiredAlerts.entries()].filter(([key]) => {
      const job = this.state.jobs.find(item => item.taskId === key.split('\0')[0]);
      return job !== undefined && taskState(job) === 'TASK_STATE_INPUT_REQUIRED' && Task.fromJSON(job.task).status?.timestamp === key.split('\0')[1];
    }).map(([, alert]) => alert);
    return { busy, inputRequiredAlerts: current, closeReasons, restoreMethods, closeFailures: this.closeFailures, processReleasePending };
  }
  private taskAcknowledged(job: Job, state: string): boolean {
    return this.state.notices.some(record => record.acknowledged === true && record.notice.taskId === job.taskId
      && record.notice.originSessionId === job.originSessionId && record.notice.state === state);
  }
  private releaseOneShot(job: Job): void {
    if (this.automaticCloseStopped.has(job.remote)) return;
    if (job.closeReason || job.sessionState === 'closed' || job.sessionState === 'closing' || job.sessionState === 'deleted') return;
    const key = `${job.remote}\0${job.contextId}\0one-shot`;
    if (this.closingSessions.has(key)) return;
    const operation = this.finishClose(job).finally(() => {
      if (this.closingSessions.get(key) === operation) this.closingSessions.delete(key);
    });
    this.closingSessions.set(key, operation);
  }
  private async finishClose(job: Job): Promise<void> {
    try {
      await this.performClose({ originSessionId: job.originSessionId, remote: job.remote, contextId: job.contextId }, 'one-shot');
    } catch (error) {
      if (error instanceof RemoteAgentError && error.code === 'UNSUPPORTED') this.automaticCloseStopped.add(job.remote);
      else this.closeFailures += 1;
      console.warn(`A2A session close failed session=${job.sessionId ?? ''} context=${job.contextId} task=${job.taskId} code=${error instanceof RemoteAgentError ? error.code : 'REMOTE_UNAVAILABLE'}`);
    }
  }
  private jobsForClose(input: { originSessionId: string; remote: string; taskId?: string; contextId?: string; sessionId?: string }): Job[] {
    const owned = this.state.jobs.filter(job => job.originSessionId === input.originSessionId && job.remote === input.remote);
    const sessionOf = (job: Job): string | undefined => job.sessionId ?? (Task.fromJSON(job.task).metadata?.['1agents']?.sessionId as string | undefined);
    if (input.taskId) {
      const job = owned.find(item => item.taskId === input.taskId);
      return job ? owned.filter(item => item.contextId === job.contextId) : [];
    }
    if (input.contextId) return owned.filter(item => item.contextId === input.contextId);
    return owned.filter(item => sessionOf(item) === input.sessionId);
  }
  private markClosed(jobs: Job[], reason: CloseReason, processReleased: true | 'pending', deleted = false): void {
    const closedAt = new Date().toISOString();
    const sessionState = deleted ? 'deleted' : processReleased === true ? 'closed' : 'closing';
    for (const job of jobs) {
      job.sessionState = sessionState;
      job.closedAt = closedAt;
      job.closeReason = reason;
      job.processReleased = processReleased;
    }
    this.save();
  }
  private async performClose(input: { originSessionId: string; remote: string; taskId?: string; contextId?: string; sessionId?: string; mode?: 'close' | 'delete'; force?: boolean }, reason: CloseReason) {
    const deleting = input.mode === 'delete';
    const jobs = this.jobsForClose(input);
    if (!jobs.length) throw new RemoteAgentError('SESSION_NOT_FOUND', 'Session not found for this origin session');
    const contexts = new Set(jobs.map(job => job.contextId));
    if (contexts.size !== 1) throw new RemoteAgentError('SESSION_CONFLICT', 'Session identifier matches more than one context');
    const contextId = jobs[0]!.contextId;
    if (jobs.every(job => job.sessionState === 'deleted' || (!deleting && (job.sessionState === 'closed' || job.sessionState === 'closing')))) {
      const sample = jobs[0]!;
      return { remote: input.remote, contextId, sessionId: sample.sessionId, state: sample.sessionState === 'deleted' ? 'deleted' as const : 'closed' as const, alreadyClosed: true,
        processReleased: sample.processReleased ?? 'pending', canceledTaskIds: [] as string[], ...(sample.agentPreset?.startsWith('oneagents-acp-') ? { acp: true } : sample.agentPreset ? { acp: false } : {}) };
    }
    const busy = jobs.filter(job => !terminal.has(taskState(job)));
    const canceledTaskIds: string[] = [];
    if (busy.length && !input.force) throw new RemoteAgentError('SESSION_BUSY', 'Session is busy');
    if (busy.length && input.force) {
      for (const job of busy) {
        if (job.attemptId) this.ledger.requestCancellation(job.attemptId);
        try {
          const client = await this.client(job.remote, job.remoteEndpoint);
          this.update(job, await client.cancelTask(CancelTaskRequest.fromJSON({ id: job.taskId }), this.auth(job.remote)));
          canceledTaskIds.push(job.taskId);
        } catch (error) {
          if (error instanceof RemoteAgentError) throw error;
          if (!terminal.has(taskState(job))) throw new RemoteAgentError('SESSION_BUSY', 'Session is busy');
        }
      }
    }
    const sessionId = jobs.map(job => job.sessionId).find((value): value is string => typeof value === 'string' && value.length > 0);
    const state = deleting ? 'deleted' as const : 'closed' as const;
    if (!sessionId) {
      this.markClosed(jobs, reason, true, deleting);
      return { remote: input.remote, contextId, state, alreadyClosed: false, processReleased: true as const, canceledTaskIds, acp: false };
    }
    const result = await this.postSession(input.remote, deleting ? 'delete' : 'close', { sessionId, contextId }, jobs[0]!.remoteEndpoint) as { processReleased?: unknown; acp?: unknown; alreadyClosed?: unknown };
    const processReleased = result.processReleased === true ? true : 'pending';
    this.markClosed(jobs, reason, processReleased, deleting);
    return { remote: input.remote, contextId, sessionId, state, alreadyClosed: result.alreadyClosed === true,
      processReleased, canceledTaskIds, ...(typeof result.acp === 'boolean' ? { acp: result.acp } : {}) };
  }
  private async postSession(remote: string, action: 'close' | 'status' | 'delete', body: unknown, pinnedEndpoint?: string): Promise<Record<string, unknown>> {
    const configured = this.config.remotes[remote];
    const config = configured ? { ...configured, url: pinnedEndpoint ?? configured.url } : undefined;
    if (!config) throw new RemoteAgentError('REMOTE_UNAVAILABLE', 'Unknown remote');
    const client = await this.client(remote, config.url), card = await client.getAgentCard(this.auth(remote));
    const endpoint = card.supportedInterfaces.find(value => value.protocolBinding === 'JSONRPC')?.url;
    if (!endpoint) throw new RemoteAgentError('REMOTE_UNAVAILABLE', 'Remote does not advertise a JSONRPC endpoint');
    const url = new URL(endpoint);
    if (url.origin !== new URL(config.url).origin || url.username || url.password) throw new RemoteAgentError('REMOTE_UNAVAILABLE', 'Session endpoint must use the configured remote origin');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/sessions/${action}`; url.search = ''; url.hash = '';
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const response = await fetch(url, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
        body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      const payload = await response.json().catch(() => ({})) as { error?: unknown; processReleased?: unknown; acp?: unknown; alreadyClosed?: unknown };
      if (response.status === 501 || payload.error === 'UNSUPPORTED') throw new RemoteAgentError('UNSUPPORTED', `Remote host does not support session ${action}`);
      if (!response.ok) {
        const code = payload.error === 'SESSION_NOT_FOUND' || payload.error === 'SESSION_BUSY' || payload.error === 'SESSION_CONFLICT' || payload.error === 'REMOTE_UNAVAILABLE'
          ? payload.error : 'REMOTE_UNAVAILABLE';
        throw new RemoteAgentError(code, code === 'SESSION_NOT_FOUND' ? 'Session not found for this origin session' : 'Remote session close failed');
      }
      return payload;
    } finally { this.controllers.delete(controller); }
  }
  /** Read-only ledger view. strict requests fail when the directory is unset or the ledger cannot be read. */
  async capacityReport(strict = false): Promise<(CapacityInspection & { processSlot: CapacityInspection['processSlot'] & { headWaitMs: number } }) | undefined> {
    if (!this.config.capacityDirectory) {
      if (strict) throw new Error('ACP capacity directory is not configured');
      return;
    }
    try {
      const governor = new CapacityGovernor({ directory: this.config.capacityDirectory });
      const queue = new CapacityQueue({ directory: this.config.capacityDirectory });
      const report = await governor.inspect();
      return { ...report, processSlot: { ...report.processSlot, headWaitMs: await queue.headWaitMs('process') } };
    } catch (error) {
      if (!strict) return;
      throw new Error(error instanceof Error && error.message.startsWith('ACP capacity') ? error.message : 'ACP capacity state is unavailable');
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await this.projectDiscovery?.close();
    await this.workbenchQueue;
    await this.sessions.close();
    await Promise.allSettled([...this.refreshing.values(), ...this.operations, ...this.advancingDeliveries.values(), ...(this.reconciling ? [this.reconciling] : [])]);
    // Delivery promises release their controllers after abort; HTTP requests
    // may have already succeeded, so any retry keeps the stable notice ID.
    this.lease.close();
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  let length = 0; const chunks: Buffer[] = [];
  for await (const data of req) {
    length += data.length;
    if (length > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(Buffer.from(data));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
}
function authenticated(req: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(req.headers.authorization ?? '');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function listen(server: http.Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return (server.address() as AddressInfo).port;
}
/** Only a missing bind address is retried. A busy port or a permission error is a bad configuration. */
export function isRetryableCallbackBindError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL';
}
/** Keeps trying `bind` after EADDRNOTAVAIL. Any other error rejects without another sleep. */
export async function retryCallbackBind(options: {
  bind: () => Promise<void>;
  signal: AbortSignal;
  onPending: (error: unknown, at: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
}): Promise<void> {
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  let waitMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  for (;;) {
    options.signal.throwIfAborted();
    try {
      await options.bind();
      return;
    } catch (error) {
      if (!isRetryableCallbackBindError(error)) throw error;
      options.onPending(error, new Date().toISOString());
      await sleep(waitMs, options.signal);
      waitMs = Math.min(waitMs * 2, maxDelayMs);
    }
  }
}
async function stop(server: http.Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
// The node rejects the whole registration when a method descriptor breaks its
// contract, and its HTTP reason hides the offending method. Mirror the rule
// here so the operator learns which method to fix.
function methodContractViolations(methods: Record<string, { description?: unknown; parameters?: unknown }>): string[] {
  return Object.entries(methods).flatMap(([name, method]) => {
    const description = typeof method?.description === 'string' ? method.description.trim() : '';
    const parameters = method?.parameters as { type?: unknown } | undefined;
    if (!description) return [`method "${name}" requires a non-empty description`];
    if (!parameters || typeof parameters !== 'object' || parameters.type !== 'object') {
      return [`method "${name}" parameters must be an object schema with type: "object"`];
    }
    return [];
  });
}

export async function serveA2AGateway(input: A2AGatewayConfig, options: { report?: boolean } = {}) {
  const gateway = new RemoteAgentGateway(input);
  const workbenchUi = gateway.config.workbench ? new WorkbenchUi(gateway.config.workbench.token) : undefined;
  const callbackHealth: { state?: 'pending' | 'listening' } = {};
  const server = http.createServer((req, res) => { void (async () => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        const slots = await gateway.capacityReport();
        return json(res, gateway.sessions.healthy ? 200 : 503, {
          status: gateway.sessions.healthy ? 'ok' : 'degraded', service: 'a2a-gateway', remotes: Object.keys(gateway.config.remotes),
          sessionDelivery: gateway.sessions.healthy ? 'ok' : 'storage-unavailable',
          ...(slots ? { taskSlot: slots.taskSlot, processSlot: slots.processSlot } : {}),
          sessions: gateway.lifecycleReport(),
          ...(callbackHealth.state === 'pending' ? { callback: 'pending' } : {}) });
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const page = url.pathname === WORKBENCH_UI_PATH || url.pathname.startsWith(`${WORKBENCH_UI_PATH}/`);
      if (page || url.pathname.startsWith('/workbench/')) {
        if (!gateway.config.workbench || !workbenchUi) return json(res, 503, { error: 'Workbench is not configured' });
        // The page reaches the same routes as the bearer API once its own login and origin checks pass.
        let pathname = url.pathname;
        if (page) {
          const routed = await workbenchUi.handle(req, res, url);
          if (!routed) return;
          pathname = routed.route;
        } else {
          if (gateway.config.workbench.token && !authenticated(req, gateway.config.workbench.token)) return json(res, 401, { error: 'Unauthorized' });
          if (req.headers.origin) return json(res, 403, { error: 'Use the authenticated workbench page' });
        }
        if (req.method === 'GET' && pathname === '/workbench/tasks') {
          const query = z.object({ filter: z.enum(['all', 'pending', 'working', 'failed']).optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() }).strict().parse(Object.fromEntries(url.searchParams));
          return json(res, 200, gateway.workbenchList(query));
        }
        const agentCreate = req.method === 'POST' && pathname === '/workbench/agents';
        const agentChange = /^\/workbench\/agents\/([^/]+)\/(settings|publish)$/.exec(pathname);
        if (pathname === '/workbench/agents' || agentChange) {
          if (url.search) return json(res, 400, { error: 'Invalid workbench parameters' });
        }
        if (req.method === 'GET' && pathname === '/workbench/agents') return json(res, 200, gateway.workbenchAgents());
        if (agentCreate || agentChange) {
          if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
          try {
            const payload = await body(req);
            if (agentCreate) return json(res, 200, await gateway.createWorkbenchAgent(payload));
            const agentId = decodeURIComponent(agentChange![1]!), action = agentChange![2];
            return json(res, 200, await (action === 'publish' ? gateway.publishWorkbenchAgent(agentId, payload) : gateway.updateWorkbenchAgent(agentId, payload)));
          } catch (error) {
            if (error instanceof AgentRegistryError) {
              const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400;
              return json(res, status, { error: error.code, message: error.message });
            }
            if (error instanceof z.ZodError) return json(res, 400, { error: 'Invalid workbench parameters' });
            throw error;
          }
        }
        if (url.search) return json(res, 404, { error: 'No workbench route' });
        const route = /^\/workbench\/tasks\/([^/]+)(.*)$/.exec(pathname);
        if (!route) return json(res, 404, { error: 'No workbench route' });
        const jobId = decodeURIComponent(route[1]!), rest = route[2] ?? '';
        // Only the DSH host opens process requests; the page can read and answer them.
        if (page && rest === '/process-requests') return json(res, 403, { error: 'browser_action_required', message: 'Process requests are opened by the execution host.' });
        const review = /^\/reviews\/([^/]+)\/decisions$/.exec(rest);
        const answer = /^\/process-requests\/([^/]+)\/answers$/.exec(rest);
        const one = /^\/process-requests\/([^/]+)$/.exec(rest);
        try {
          if (rest === '' && req.method === 'GET') return json(res, 200, gateway.workbenchTask(jobId));
          if (review && req.method === 'POST') return json(res, 200, await gateway.decideWorkbenchReview(jobId, decodeURIComponent(review[1]!), await body(req)));
          if (rest === '/process-requests' && req.method === 'POST') return json(res, 200, await gateway.openProcessRequest(jobId, await body(req)));
          if (answer && req.method === 'POST') return json(res, 200, await gateway.answerProcessRequest(jobId, decodeURIComponent(answer[1]!), await body(req)));
          if (one && req.method === 'GET') return json(res, 200, gateway.processRequest(jobId, decodeURIComponent(one[1]!)));
          if (rest === '' || review || answer || one || rest === '/process-requests') return json(res, 405, { error: 'Method not allowed' });
          return json(res, 404, { error: 'No workbench route' });
        } catch (error) {
          if (error instanceof HumanReviewError) return json(res, error.code === 'forbidden' ? 403 : 409, { error: error.code, message: error.message });
          if (error instanceof ProcessRequestError) {
            const status = error.code === 'forbidden' ? 403 : error.code === 'not_found' ? 404 : error.code === 'invalid' ? 400 : 409;
            return json(res, status, { error: error.code, message: error.message });
          }
          if (error instanceof z.ZodError) return json(res, 400, { error: 'Invalid workbench parameters' });
          return json(res, 404, { error: error instanceof Error ? error.message : 'Task not found' });
        }
      }
      if (req.method !== 'POST' || req.url !== '/invoke') return json(res, 404, { error: 'No route' });
      // Local tools are trusted. The separate tailnet receiver below never exposes /invoke.
      if (req.headers.origin) return json(res, 403, { error: 'Browser-origin invocation is not allowed' });
      const request = z.object({ method: string.optional(), capability: string.optional(), params: z.unknown() }).parse(await body(req));
      return json(res, 200, await gateway.invoke(request.method ?? request.capability ?? '', request.params));
    } catch (error) { json(res, 400, { error: error instanceof z.ZodError ? 'Invalid method parameters' : error instanceof Error ? error.message : 'Invocation failed' }); }
  })(); });
  const callbackServers = new Set<http.Server>();
  const callbackAbort = new AbortController();
  let callbackPort: number | undefined;
  let automationServer: http.Server | undefined;
  let automationPort: number | undefined;
  const callbackHandler = gateway.config.callback ? (req: IncomingMessage, res: ServerResponse) => { void (async () => {
    const callback = gateway.config.callback!;
    if (!authenticated(req, callback.token)) return json(res, 401, { error: 'Unauthorized' });
    if (req.method !== 'POST' || req.url !== new URL(callback.url).pathname) return json(res, 404, { error: 'No route' });
    try { const event = await body(req); json(res, 202, { accepted: true }); void gateway.receivePush(event).catch(() => {}); }
    catch { json(res, 400, { error: 'Invalid A2A event' }); }
  })(); } : undefined;
  const bindCallback = async (): Promise<void> => {
    if (!gateway.config.callback || !callbackHandler) return;
    if (callbackAbort.signal.aborted) throw callbackAbort.signal.reason ?? new Error('callback stopped');
    const receiver = http.createServer(callbackHandler);
    callbackServers.add(receiver);
    try {
      callbackPort = await listen(receiver, gateway.config.callback.port, gateway.config.callback.host);
      if (callbackAbort.signal.aborted) {
        await stop(receiver);
        throw callbackAbort.signal.reason ?? new Error('callback stopped');
      }
      callbackHealth.state = 'listening';
    } catch (error) {
      callbackServers.delete(receiver);
      receiver.close(() => {});
      throw error;
    }
  };
  try {
    const port = await listen(server, gateway.config.port, '127.0.0.1');
    if (gateway.config.callback) {
      const callback = gateway.config.callback;
      try {
        await bindCallback();
      } catch (error) {
        if (!isRetryableCallbackBindError(error)) throw error;
        callbackHealth.state = 'pending';
        console.error(`[a2a-gateway] ${new Date().toISOString()} callback listen pending: ${callback.host}:${callback.port} ${error instanceof Error ? error.message : String(error)}`);
        void retryCallbackBind({
          bind: bindCallback,
          signal: callbackAbort.signal,
          onPending: (cause, at) => console.error(`[a2a-gateway] ${at} callback listen pending: ${callback.host}:${callback.port} ${cause instanceof Error ? cause.message : String(cause)}`),
        }).catch(cause => {
          if (callbackAbort.signal.aborted) return;
          console.error(`[a2a-gateway] ${new Date().toISOString()} callback listen failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      }
    }
    if (gateway.config.automation && gateway.automation) {
      automationServer = createAutomationServer(gateway.automation);
      automationPort = await listen(automationServer, gateway.config.automation.port, gateway.config.automation.host);
    }
    const entry = { id: 'a2a-gateway', name: 'DSH 远端智能体', kind: 'agent_runtime' as const,
      capabilities: Object.keys(REMOTE_AGENT_METHODS), execution: 'http' as const, port, reachability: 'localhost' as const, health: '/health', methods: REMOTE_AGENT_METHODS,
      metadata: { local_only_methods: [...Object.keys(TARGET_METHODS), ...Object.keys(DISCOVERY_METHODS)] } };
    const contractViolations = methodContractViolations(REMOTE_AGENT_METHODS);
    if (contractViolations.length) console.error(`[a2a-gateway] DreamMate registration contract violated: ${contractViolations.join('; ')}`);
    const registration = options.report === false ? undefined : await reportAndHoldRegistration(entry);
    if (registration && !registration.ok) console.error(`[a2a-gateway] DreamMate registration failed: ${registration.reason ?? 'unknown reason'}`);
    // Node's directory is ephemeral. Re-report after a Node restart; this never registers new execution targets.
    const reporting = options.report === false ? undefined : setInterval(() => {
      void reportToAgent(entry).then(result => {
        if (!result.ok) console.error(`[a2a-gateway] DreamMate re-registration failed: ${result.reason ?? 'unknown reason'}`);
      }).catch(error => {
        console.error(`[a2a-gateway] DreamMate re-registration error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 15_000);
    reporting?.unref();
    let closing: Promise<void> | undefined;
    return { gateway, port, callbackPort, automationPort, registration, close: async () => {
      closing ??= (async () => {
        if (reporting) clearInterval(reporting);
        callbackAbort.abort();
        // Stop the Reader before draining HTTP requests that may be awaiting a scan.
        await gateway.projectDiscovery?.close();
        // Stop accepting requests and drain their ledger writes while this instance
        // still owns the storage lease. Automation continuations and its admission
        // queue can outlive the gateway operation they awaited.
        await Promise.all([stop(server), ...[...callbackServers].map(item => stop(item)), ...(automationServer ? [stop(automationServer)] : [])]);
        await gateway.close();
      })();
      await closing;
    } };
  } catch (error) {
    callbackAbort.abort();
    await Promise.all([stop(server), ...[...callbackServers].map(item => stop(item)), ...(automationServer ? [stop(automationServer)] : [])]);
    await gateway.close(); throw error;
  }
}
