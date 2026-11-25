/**
 * Lightweight MCP server (stdio, newline-delimited JSON-RPC 2.0) for A2A task dispatch, approvals
 * and task tickets. Proxies to a running local a2a-gateway (/invoke) and exposes a compact,
 * first-class MCP tool surface so agents (via DreamMate MCP or standalone stdio MCP clients) can
 * dispatch tasks, bind sessions, inspect pending approvals, answer process requests, settle ticket
 * proposals and submit coach-level reviews without calling raw HTTP ports or search/inspect loops.
 *
 * Security boundary: all write operations through this MCP server are unconditionally stamped as
 * `kind: "coach"` and never impersonate `kind: "person"` or bypass PAGE_ONLY_ROUTES.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { processRequestAnswerSchema } from '../execution/process-request.js';
import { sessionLifecycleSchema } from './session-lifecycle.js';

export const A2A_APPROVAL_MCP_SERVER_NAME = 'a2a-approval';
export const A2A_APPROVAL_MCP_SERVICE_ID = 'mcp-a2a-approval';
export const DEFAULT_A2A_GATEWAY_URL = 'http://127.0.0.1:36814';
export const DEFAULT_COACH_AGENT = 'dreammate-mcp';

const id = z.string().trim().min(1).max(512);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const promptText = z.string().min(1).max(256 * 1024).refine(value => Boolean(value.trim()), 'prompt must contain text');
const coachOverrides = {
  coachAgent: id.optional(),
  coachSessionId: id.optional(),
};

const emptyArgsSchema = z.object({}).strict();

const sessionBindArgsSchema = z.object({
  originSessionId: id,
  host: id,
  sessionId: id,
}).strict();

const taskDispatchArgsSchema = z.object({
  originSessionId: id,
  targetId: id.optional(),
  remote: id.optional(),
  cwd: id.optional(),
  prompt: promptText.optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  agentPreset: id.optional(),
  title: id.optional(),
  roleId: id.optional(),
  provider: id.optional(),
  model: id.optional(),
  lifecycle: sessionLifecycleSchema.optional(),
  notificationTarget: id.optional(),
  caseId: id.optional(),
  handoffId: id.optional(),
  purpose: id.optional(),
  resultRevision: id.optional(),
  parentJobRef: z.object({ sourceId: id, jobId: id }).strict().optional(),
  parentAttemptId: id.optional(),
  replacesJobRef: z.object({ sourceId: id, jobId: id }).strict().optional(),
  clientRequestId: id.optional(),
  ...coachOverrides,
}).strict();

const taskGetArgsSchema = z.object({
  originSessionId: id,
  jobId: id.optional(),
  remote: id.optional(),
  taskId: id.optional(),
}).strict();

const taskListArgsSchema = z.object({
  originSessionId: id,
  targetId: id.optional(),
  executionStatus: id.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
}).strict();

const taskContinueArgsSchema = z.object({
  originSessionId: id,
  jobId: id,
  prompt: promptText.optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  clientRequestId: id.optional(),
  ...coachOverrides,
}).strict();

const taskCancelArgsSchema = z.object({
  originSessionId: id,
  jobId: id,
  cascade: z.boolean().optional(),
}).strict();

const noticeAckArgsSchema = z.object({
  originSessionId: id,
  noticeId: id,
  kind: z.enum(['remote', 'execution']).optional(),
}).strict();

const pendingApprovalsArgsSchema = z.object({
  originSessionId: id.optional(),
  jobId: id.optional(),
  includeResolved: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

const scopedJobArgsSchema = z.object({
  originSessionId: id,
  jobId: id,
}).strict();

const processAnswerArgsSchema = z.object({
  originSessionId: id,
  jobId: id,
  requestId: id,
  outcome: z.enum(['approved', 'rejected', 'accepted', 'cancelled', 'abandoned']),
  note: z.string().trim().min(1).max(2000).optional(),
  stopTask: z.boolean().optional(),
  answers: processRequestAnswerSchema.shape.answers,
  clientRequestId: id.optional(),
  ...coachOverrides,
}).strict();

const ticketProposalArgsSchema = z.object({
  originSessionId: id,
  jobId: id,
  proposalId: id,
  state: z.enum(['accepted', 'rejected', 'done']),
  note: z.string().trim().max(2000).optional(),
  ...coachOverrides,
}).strict();

const executionReviewArgsSchema = z.object({
  originSessionId: id,
  jobId: id,
  attemptId: id,
  resultRevision: id,
  resultDigest: sha256,
  reviewStatus: z.enum(['accepted', 'changes_requested', 'pending']),
  note: z.string().trim().max(4000).optional(),
  ...coachOverrides,
}).strict();

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const A2A_APPROVAL_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'a2a_target_list',
    description: '列出已登记的 A2A 执行目标（固定角色 resident_agent、通用宿主 agent_host、路径智能体及健康状态），不派单。',
    inputSchema: z.toJSONSchema(emptyArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_session_bind',
    description: '将发起方 originSessionId 绑定到已配置的宿主会话（如 host="dsh-local" 或 "codex-local"），用于自动接收过程审批 steer 提醒与任务完成通知。',
    inputSchema: z.toJSONSchema(sessionBindArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_task_dispatch',
    description: '通过 MCP 发起 A2A 子任务（无需直连 HTTP 端口）：支持两种模式——① 传 targetId + (prompt 或 input) 向已登记目标/固定角色提交（execution_submit）；② 传 remote + cwd + prompt 直接向远端宿主派发（remote_agent_spawn）。自动补齐幂等 clientRequestId 并强制记录 initiatedBy 为 coach。派单后立即返回 taskId/jobId，不阻塞等待完成。',
    inputSchema: z.toJSONSchema(taskDispatchArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_task_get',
    description: '单次查询 A2A 任务当前状态、执行轮次与结果：传 jobId 查询统一账本（execution_get），或传 remote + taskId 查询远端任务（remote_agent_get）。禁止循环轮询。',
    inputSchema: z.toJSONSchema(taskGetArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_task_list',
    description: '按 originSessionId 分页列出该主会话发起的 A2A 任务，可按 targetId 或 executionStatus 过滤。',
    inputSchema: z.toJSONSchema(taskListArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_task_continue',
    description: '对已有 A2A 任务显式继续或返工（新建执行轮次），传 prompt 或 input；自动补齐 clientRequestId 并记录 initiatedBy 为 coach。',
    inputSchema: z.toJSONSchema(taskContinueArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_task_cancel',
    description: '取消并持久关闭指定 A2A 任务；可选 cascade=true 级联取消子任务。',
    inputSchema: z.toJSONSchema(taskCancelArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_notice_ack',
    description: '确认已处理 A2A 任务通知（支持 remote_agent_ack 与 execution_ack；省略 kind 时自动匹配）。',
    inputSchema: z.toJSONSchema(noticeAckArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_pending_approvals',
    description: '列出当前待审批的 A2A 过程请求（工具权限 permission、计划审批 plan、提问 question）以及待裁决的任务单改进提议与活跃任务单。可按 originSessionId 或 jobId 过滤；省略参数返回全部待处理项。',
    inputSchema: z.toJSONSchema(pendingApprovalsArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_process_requests',
    description: '查询指定 A2A 任务上的全部过程请求（含待处理、已回答、已取消、已过期及审批人与理由）。',
    inputSchema: z.toJSONSchema(scopedJobArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_process_answer',
    description: '审批或答复 A2A 子任务的过程请求（permission 用 approved/rejected/cancelled；plan 用 approved/rejected/abandoned；question 用 accepted+answers 或 cancelled）。高危操作拒绝并立即终止子任务传 stopTask=true。自动生成幂等 clientRequestId，强制以教练身份（coach）落盘，不冒充页面人类审批。',
    inputSchema: z.toJSONSchema(processAnswerArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_ticket_get',
    description: '读取指定 A2A 任务的任务单详情（状态、轮次、程序检查/质检意见 items、改进提议 proposals 与历史）。',
    inputSchema: z.toJSONSchema(scopedJobArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_ticket_proposal_decide',
    description: '裁决任务单上的一条改进提议（state: accepted/rejected/done，可选 note），运行结束后也可操作。强制以教练身份（coach）落盘。',
    inputSchema: z.toJSONSchema(ticketProposalArgsSchema) as Record<string, unknown>,
  },
  {
    name: 'a2a_execution_review',
    description: '为已完成结果的 A2A 任务记录版本绑定业务验收结论（reviewStatus: accepted/changes_requested/pending），必须绑定 attemptId、resultRevision 与 64 位 SHA256 resultDigest。强制以教练身份（coach）落盘；不替代页面强人工审核关口。',
    inputSchema: z.toJSONSchema(executionReviewArgsSchema) as Record<string, unknown>,
  },
];

export interface A2AApprovalMcpOptions {
  /** Base URL of the local a2a-gateway HTTP server (default: http://127.0.0.1:36814). */
  gatewayUrl?: string;
  /** Default coach agent name stamped into decidedBy/by/initiatedBy when caller omits coachAgent. */
  coachAgent?: string;
  /** Default coach session ID stamped into decidedBy/by/initiatedBy when caller omits coachSessionId. */
  coachSessionId?: string;
  /** Request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Server version advertised in MCP initialize response. */
  version?: string;
  /** Optional fetch implementation for testing. */
  fetch?: typeof globalThis.fetch;
}

export interface McpToolCallResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function normalizeGatewayUrl(raw?: string): string {
  const value = (raw ?? process.env.A2A_GATEWAY_URL ?? DEFAULT_A2A_GATEWAY_URL).trim();
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('gatewayUrl must be an HTTP(S) URL without credentials');
  }
  return parsed.origin;
}

function formatError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

export function createA2AApprovalMcpHandler(options: A2AApprovalMcpOptions = {}) {
  const gatewayOrigin = normalizeGatewayUrl(options.gatewayUrl);
  const invokeEndpoint = new URL('/invoke', gatewayOrigin).href;
  const defaultCoachAgent = (options.coachAgent ?? process.env.A2A_MCP_COACH_AGENT ?? DEFAULT_COACH_AGENT).trim() || DEFAULT_COACH_AGENT;
  const defaultCoachSessionId = (options.coachSessionId ?? process.env.A2A_MCP_COACH_SESSION_ID ?? '').trim() || undefined;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const version = options.version ?? '1.0.1';
  const fetchFn = options.fetch ?? globalThis.fetch;

  const coachActor = (originSessionId: string, coachAgent?: string, coachSessionId?: string) => ({
    kind: 'coach' as const,
    agent: coachAgent ?? defaultCoachAgent,
    sessionId: coachSessionId ?? defaultCoachSessionId ?? originSessionId,
  });

  async function invokeGateway(method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await fetchFn(invokeEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : {}; }
    catch { parsed = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) {
      const message = parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `a2a-gateway HTTP ${response.status}`;
      throw new Error(message);
    }
    return parsed;
  }

  async function invokeTool(name: string, rawArgs: unknown): Promise<McpToolCallResult> {
    try {
      const args = rawArgs === undefined ? {} : rawArgs;
      let data: unknown;
      switch (name) {
        case 'a2a_target_list': {
          emptyArgsSchema.parse(args);
          data = await invokeGateway('execution_target_list', {});
          break;
        }
        case 'a2a_session_bind': {
          const input = sessionBindArgsSchema.parse(args);
          data = await invokeGateway('session_bind', input);
          break;
        }
        case 'a2a_task_dispatch': {
          const input = taskDispatchArgsSchema.parse(args);
          const hasTarget = Boolean(input.targetId);
          const hasRemote = Boolean(input.remote);
          if (hasTarget === hasRemote) {
            throw new Error('Provide either targetId (registered target/role) or remote (direct spawn), not both');
          }
          const initiatedBy = coachActor(input.originSessionId, input.coachAgent, input.coachSessionId);
          const clientRequestId = input.clientRequestId ?? `mcp:${randomUUID()}`;
          if (hasTarget) {
            const taskInput: Record<string, unknown> = { ...(input.input ?? {}) };
            if (input.prompt !== undefined && taskInput.prompt === undefined) taskInput.prompt = input.prompt;
            if (input.cwd !== undefined && taskInput.cwd === undefined) taskInput.cwd = input.cwd;
            if (input.agentPreset !== undefined && taskInput.agentPreset === undefined) taskInput.agentPreset = input.agentPreset;
            if (input.roleId !== undefined && taskInput.roleId === undefined) taskInput.roleId = input.roleId;
            if (input.provider !== undefined && taskInput.provider === undefined) taskInput.provider = input.provider;
            if (input.model !== undefined && taskInput.model === undefined) taskInput.model = input.model;
            if (input.lifecycle !== undefined && taskInput.lifecycle === undefined) taskInput.lifecycle = input.lifecycle;
            if (input.notificationTarget !== undefined && taskInput.notificationTarget === undefined) taskInput.notificationTarget = input.notificationTarget;
            const payload: Record<string, unknown> = {
              originSessionId: input.originSessionId,
              targetId: input.targetId,
              input: taskInput,
              clientRequestId,
              initiatedBy,
            };
            if (input.title !== undefined) payload.title = input.title;
            if (input.caseId !== undefined) payload.caseId = input.caseId;
            if (input.handoffId !== undefined) payload.handoffId = input.handoffId;
            if (input.purpose !== undefined) payload.purpose = input.purpose;
            if (input.resultRevision !== undefined) payload.resultRevision = input.resultRevision;
            if (input.parentJobRef !== undefined) payload.parentJobRef = input.parentJobRef;
            if (input.parentAttemptId !== undefined) payload.parentAttemptId = input.parentAttemptId;
            if (input.replacesJobRef !== undefined) payload.replacesJobRef = input.replacesJobRef;
            data = await invokeGateway('execution_submit', payload);
          } else {
            if (!input.cwd) throw new Error('cwd is required when dispatching by remote');
            if (!input.prompt) throw new Error('prompt is required when dispatching by remote');
            const payload: Record<string, unknown> = {
              originSessionId: input.originSessionId,
              remote: input.remote,
              cwd: input.cwd,
              prompt: input.prompt,
              clientRequestId,
              initiatedBy,
            };
            if (input.agentPreset !== undefined) payload.agentPreset = input.agentPreset;
            if (input.title !== undefined) payload.title = input.title;
            if (input.roleId !== undefined) payload.roleId = input.roleId;
            if (input.provider !== undefined) payload.provider = input.provider;
            if (input.model !== undefined) payload.model = input.model;
            if (input.lifecycle !== undefined) payload.lifecycle = input.lifecycle;
            if (input.notificationTarget !== undefined) payload.notificationTarget = input.notificationTarget;
            data = await invokeGateway('remote_agent_spawn', payload);
          }
          break;
        }
        case 'a2a_task_get': {
          const input = taskGetArgsSchema.parse(args);
          if (input.jobId) {
            if (input.remote || input.taskId) throw new Error('Provide either jobId or remote+taskId, not both');
            data = await invokeGateway('execution_get', { originSessionId: input.originSessionId, jobId: input.jobId });
          } else if (input.remote && input.taskId) {
            data = await invokeGateway('remote_agent_get', { originSessionId: input.originSessionId, remote: input.remote, taskId: input.taskId });
          } else {
            throw new Error('Provide either jobId or both remote and taskId');
          }
          break;
        }
        case 'a2a_task_list': {
          const input = taskListArgsSchema.parse(args);
          data = await invokeGateway('execution_list', input);
          break;
        }
        case 'a2a_task_continue': {
          const input = taskContinueArgsSchema.parse(args);
          const taskInput: Record<string, unknown> = { ...(input.input ?? {}) };
          if (input.prompt !== undefined && taskInput.prompt === undefined) taskInput.prompt = input.prompt;
          if (!Object.keys(taskInput).length) throw new Error('Provide prompt or input when continuing a task');
          data = await invokeGateway('execution_continue', {
            originSessionId: input.originSessionId,
            jobId: input.jobId,
            input: taskInput,
            clientRequestId: input.clientRequestId ?? `mcp:${randomUUID()}`,
            initiatedBy: coachActor(input.originSessionId, input.coachAgent, input.coachSessionId),
          });
          break;
        }
        case 'a2a_task_cancel': {
          const input = taskCancelArgsSchema.parse(args);
          const payload: Record<string, unknown> = { originSessionId: input.originSessionId, jobId: input.jobId };
          if (input.cascade !== undefined) payload.cascade = input.cascade;
          data = await invokeGateway('execution_cancel', payload);
          break;
        }
        case 'a2a_notice_ack': {
          const input = noticeAckArgsSchema.parse(args);
          const ackParams = { originSessionId: input.originSessionId, noticeId: input.noticeId };
          if (input.kind === 'execution') {
            data = await invokeGateway('execution_ack', ackParams);
          } else if (input.kind === 'remote') {
            data = await invokeGateway('remote_agent_ack', ackParams);
          } else {
            try {
              data = await invokeGateway('remote_agent_ack', ackParams);
            } catch (error) {
              if (error instanceof Error && /not found/i.test(error.message)) {
                data = await invokeGateway('execution_ack', ackParams);
              } else {
                throw error;
              }
            }
          }
          break;
        }
        case 'a2a_pending_approvals': {
          const input = pendingApprovalsArgsSchema.parse(args);
          data = await invokeGateway('execution_pending_approvals', input);
          break;
        }
        case 'a2a_process_requests': {
          const input = scopedJobArgsSchema.parse(args);
          data = await invokeGateway('execution_process_requests', input);
          break;
        }
        case 'a2a_process_answer': {
          const input = processAnswerArgsSchema.parse(args);
          const payload: Record<string, unknown> = {
            originSessionId: input.originSessionId,
            jobId: input.jobId,
            requestId: input.requestId,
            clientRequestId: input.clientRequestId ?? `mcp:${randomUUID()}`,
            outcome: input.outcome,
            decidedBy: coachActor(input.originSessionId, input.coachAgent, input.coachSessionId),
          };
          if (input.note !== undefined) payload.note = input.note;
          if (input.stopTask === true) payload.stopTask = true;
          if (input.answers !== undefined) payload.answers = input.answers;
          data = await invokeGateway('execution_process_answer', payload);
          break;
        }
        case 'a2a_ticket_get': {
          const input = scopedJobArgsSchema.parse(args);
          data = await invokeGateway('ticket_get', input);
          break;
        }
        case 'a2a_ticket_proposal_decide': {
          const input = ticketProposalArgsSchema.parse(args);
          const payload: Record<string, unknown> = {
            originSessionId: input.originSessionId,
            jobId: input.jobId,
            proposalId: input.proposalId,
            state: input.state,
            by: coachActor(input.originSessionId, input.coachAgent, input.coachSessionId),
          };
          if (input.note !== undefined) payload.note = input.note;
          data = await invokeGateway('ticket_proposal', payload);
          break;
        }
        case 'a2a_execution_review': {
          const input = executionReviewArgsSchema.parse(args);
          const payload: Record<string, unknown> = {
            originSessionId: input.originSessionId,
            jobId: input.jobId,
            attemptId: input.attemptId,
            resultRevision: input.resultRevision,
            resultDigest: input.resultDigest,
            reviewStatus: input.reviewStatus,
            decidedBy: coachActor(input.originSessionId, input.coachAgent, input.coachSessionId),
          };
          if (input.note !== undefined) payload.note = input.note;
          data = await invokeGateway('execution_review', payload);
          break;
        }
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
      const isObject = Boolean(data && typeof data === 'object' && !Array.isArray(data));
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        ...(isObject ? { structuredContent: data as Record<string, unknown> } : {}),
      };
    } catch (error) {
      return { content: [{ type: 'text', text: formatError(error) }], isError: true };
    }
  }

  async function handleJsonRpc(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const { id: reqId, method, params } = message;
    // JSON-RPC notifications have no id and expect no reply.
    if (reqId === undefined) return undefined;
    if (method === 'initialize') {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
      return {
        jsonrpc: '2.0',
        id: reqId,
        result: {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: A2A_APPROVAL_MCP_SERVER_NAME, version },
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id: reqId, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id: reqId, result: { tools: A2A_APPROVAL_MCP_TOOLS } };
    if (method === 'tools/call') {
      const toolName = typeof params?.name === 'string' ? params.name : '';
      if (!A2A_APPROVAL_MCP_TOOLS.some(tool => tool.name === toolName)) {
        return { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: `Unknown tool: ${toolName}` } };
      }
      const result = await invokeTool(toolName, params?.arguments);
      return { jsonrpc: '2.0', id: reqId, result };
    }
    return { jsonrpc: '2.0', id: reqId, error: { code: -32601, message: `Method not found: ${String(method ?? '')}` } };
  }

  return { tools: A2A_APPROVAL_MCP_TOOLS, invokeTool, handleJsonRpc };
}

/** Runs the A2A dispatch/approval/ticket MCP server on stdio (newline-delimited JSON-RPC 2.0). Never writes logs to stdout. */
export async function runA2AApprovalMcpStdio(
  options: A2AApprovalMcpOptions = {},
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<void> {
  const handler = createA2AApprovalMcpHandler(options);
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const write = (response: JsonRpcResponse) => {
    output.write(`${JSON.stringify(response)}\n`);
  };
  const rl = createInterface({ input, crlfDelay: Infinity });
  const inFlight = new Set<Promise<void>>();
  await new Promise<void>(resolve => {
    rl.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: JsonRpcRequest;
      try { message = JSON.parse(trimmed) as JsonRpcRequest; }
      catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const task = handler.handleJsonRpc(message)
        .then(reply => { if (reply) write(reply); })
        .catch(error => {
          if (message.id !== undefined) {
            write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: formatError(error) } });
          }
        })
        .finally(() => { inFlight.delete(task); });
      inFlight.add(task);
    });
    rl.once('close', () => {
      void Promise.allSettled([...inFlight]).then(() => resolve());
    });
  });
}
