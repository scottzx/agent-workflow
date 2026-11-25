/**
 * Lightweight MCP server (stdio, newline-delimited JSON-RPC 2.0) for A2A approvals and task tickets.
 * Proxies to a running local a2a-gateway (/invoke) and exposes a compact, first-class tool surface
 * so agents (or DreamMate MCP) can inspect pending approvals, answer process requests, settle ticket
 * proposals and submit coach-level execution reviews without search/inspect round-trips.
 *
 * Security boundary: all write operations through this MCP server are unconditionally stamped as
 * `kind: "coach"` and never impersonate `kind: "person"` or bypass PAGE_ONLY_ROUTES.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { processRequestAnswerSchema } from '../execution/process-request.js';

export const A2A_APPROVAL_MCP_SERVER_NAME = 'a2a-approval';
export const A2A_APPROVAL_MCP_SERVICE_ID = 'mcp-a2a-approval';
export const DEFAULT_A2A_GATEWAY_URL = 'http://127.0.0.1:36814';
export const DEFAULT_COACH_AGENT = 'dreammate-mcp';

const id = z.string().trim().min(1).max(512);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const coachOverrides = {
  coachAgent: id.optional(),
  coachSessionId: id.optional(),
};

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
  /** Default coach agent name stamped into decidedBy/by when caller omits coachAgent. */
  coachAgent?: string;
  /** Default coach session ID stamped into decidedBy/by when caller omits coachSessionId. */
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

/** Runs the A2A approval/ticket MCP server on stdio (newline-delimited JSON-RPC 2.0). Never writes logs to stdout. */
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
