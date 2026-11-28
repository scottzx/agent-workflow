/**
 * Structured non-user notice/relay delivery into a DSH session so A2A process-request wakeups
 * render as DSH's native collapsed ContextFormed notice rows instead of human chat bubbles.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { MessageCorrelation } from '@1agents/acp-service/a2a';
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';

export const SESSION_DELIVER_PATH = '/api/1agents-acp/session/deliver';
export const NOTICE_SOURCE_KIND = '1agents-acp';
export const CONTEXT_SUMMARY_MAX_CHARS = 120;
const MAX_BODY_BYTES = 300 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const controlChars = /[\u0000-\u001f\u007f]+/g;

export interface SessionNoticeInput {
  requestId: string;
  sessionId: string;
  mode: 'queue' | 'steer';
  text: string;
  form: 'notice' | 'relay';
  summary?: string;
  /** Sender of a cross-session message; older gateways omit it because the body already names the sender. */
  fromSessionId?: string;
  /** Which context the message belongs to (L0 `MessageCorrelation`); absent keeps the old source shape. */
  correlation?: MessageCorrelation;
}

const CORRELATION_KEYS = ['ticket_id', 'team_id', 'job_id', 'a2a_task_id', 'pending_approval_id'] as const;
const MAX_CORRELATION_VALUE = 512;
const controlCharRun = /[\u0000-\u001f\u007f]/;

/**
 * Strictly validate the optional L0 `MessageCorrelation` tags. Unknown keys, non-strings, empty values,
 * control characters and over-long values are rejected before the delivery reaches the agent, so a
 * malformed request is a 400 instead of a half-tagged message in the host queue. An empty object
 * carries no context and is treated as absent, which keeps the un-correlated source shape byte-identical.
 */
function parseCorrelation(raw: unknown): MessageCorrelation | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid correlation');
  const record = raw as Record<string, unknown>;
  const parsed: Record<string, string> = {};
  for (const key of Object.keys(record)) {
    if (!(CORRELATION_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown correlation field: ${key}`);
    const value = record[key];
    if (typeof value !== 'string') throw new Error(`Invalid correlation.${key}`);
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_CORRELATION_VALUE || controlCharRun.test(trimmed)) throw new Error(`Invalid correlation.${key}`);
    parsed[key] = trimmed;
  }
  return Object.keys(parsed).length ? parsed as MessageCorrelation : undefined;
}

const MERGE_HEADER = /^\[队列合并 · 共 \d+ 条消息\]\n\n/;

/** Matches `@deepseek-ai/dsh-llm`'s `boundContextSummary` (120 chars, single-line). */
export function boundNoticeSummary(summary: string): string {
  const clean = summary.replace(controlChars, ' ').replace(/\s+/g, ' ').trim();
  return clean.length <= CONTEXT_SUMMARY_MAX_CHARS ? clean : `${clean.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`;
}

function sameDelivery(message: UserMessage | undefined, requestId: string): boolean {
  if (!message) return false;
  if (message.id === requestId) return true;
  const source = message.source as { kind?: unknown; rpcId?: unknown; rpcIds?: unknown } | undefined;
  if (source?.kind !== NOTICE_SOURCE_KIND) return false;
  if (source.rpcId === requestId) return true;
  // A merged queue message carries every original request id, so each retry still deduplicates.
  return Array.isArray(source.rpcIds) && source.rpcIds.includes(requestId);
}

function messageText(message: UserMessage): string {
  // `content` is a readonly host type; read it as unknown so one shape check covers both arrays and strings.
  const content: unknown = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text : '')
    .filter(Boolean).join('\n');
}

/**
 * The host's immutable pending-input queue. Declared locally because the real `@deepseek-ai/dsh-agent`
 * package does not export that helper type; the single source of truth is the DSH host contract
 * `packages/core/agent/src/runtime-types.ts` (`Inbox.replace(messageId, newMessage): boolean`).
 * `types/dsh-host.d.ts` (`AgentInbox`) documents the same shape for unlinked typechecks.
 */
interface PendingInbox {
  readonly nextTurn?: readonly UserMessage[];
  readonly nextStep?: readonly UserMessage[];
  replace?(messageId: MessageId, next: UserMessage): boolean;
  [key: string]: unknown;
}

/**
 * Merge one queue delivery into the not-yet-consumed `1agents-acp` tail of `inbox.nextTurn`.
 *
 * The host owns that message: real DSH `UserMessage.content`/`source` are `readonly` and deep-frozen,
 * so this never assigns into the tail. It builds a new immutable message and swaps it through the
 * host's own `inbox.replace`. The host then persists it via its normal `agent/inbox/spliced` event.
 * Returns true only when the host confirmed the swap; every other outcome (no replace API, unknown
 * id, concurrent consumption, over-limit body) returns false so the caller falls back to
 * `agent.followup` and no queued message is ever lost. `steer` never reaches this path.
 */
function replacePendingQueueTail(inbox: unknown, input: SessionNoticeInput): boolean {
  if (!inbox || typeof inbox !== 'object') return false;
  const host = inbox as PendingInbox;
  const queue = host.nextTurn;
  if (!Array.isArray(queue) || queue.length === 0) return false;
  const tail = queue[queue.length - 1] as UserMessage | undefined;
  const source = tail?.source as { kind?: unknown; rpcId?: unknown; rpcIds?: unknown; form?: unknown; summary?: unknown;
    fromSessionId?: unknown; correlation?: unknown } | undefined;
  if (!tail || source?.kind !== NOTICE_SOURCE_KIND) return false;
  if (tail.id === undefined || typeof host.replace !== 'function') return false;
  const previousIds = Array.isArray(source.rpcIds)
    ? source.rpcIds.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  const originalId = typeof source.rpcId === 'string' ? source.rpcId : undefined;
  const ids = [...new Set([...previousIds, ...(originalId ? [originalId] : []), input.requestId])];
  const body = messageText(tail).replace(MERGE_HEADER, '');
  const mergedText = `[队列合并 · 共 ${ids.length} 条消息]\n\n${body}\n\n—— 第 ${ids.length} 条 ——\n${input.text}`;
  if (Buffer.byteLength(mergedText, 'utf8') > MAX_TEXT_BYTES) return false;
  const form = source.form === 'notice' || input.form === 'notice' ? 'notice' : 'relay';
  const previousSummary = typeof source.summary === 'string' ? source.summary : undefined;
  const summary = form === 'notice'
    ? boundNoticeSummary([previousSummary, input.summary].filter(Boolean).join('；'))
    : undefined;
  const existingFrom = typeof source.fromSessionId === 'string' ? source.fromSessionId : undefined;
  const mergedSource: Record<string, unknown> = { kind: NOTICE_SOURCE_KIND, form, rpcIds: ids };
  const original = originalId ?? previousIds[0];
  if (original) mergedSource.rpcId = original;
  if (summary) mergedSource.summary = summary;
  const fromSessionId = existingFrom ?? input.fromSessionId;
  if (fromSessionId) mergedSource.fromSessionId = fromSessionId;
  // A merged tail already belongs to one context; keep it rather than letting a later message retag it.
  const existingCorrelation = source.correlation && typeof source.correlation === 'object' ? source.correlation as MessageCorrelation : undefined;
  const correlation = existingCorrelation ?? input.correlation;
  if (correlation) mergedSource.correlation = correlation;
  const nextMessage: UserMessage = {
    id: tail.id,
    role: tail.role,
    content: [{ type: 'text', text: mergedText }],
    source: mergedSource as unknown as UserMessage['source'],
  };
  try {
    return host.replace(tail.id, nextMessage) === true;
  } catch {
    // A host that rejects the swap must still receive the new message as its own queued turn.
    return false;
  }
}

function parseInput(raw: unknown): { rpcId: string; request: SessionNoticeInput } {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid request payload');
  const envelope = raw as {
    type?: unknown;
    rpcId?: unknown;
    method?: unknown;
    payload?: { args?: { request?: unknown } };
  };
  if (envelope.type !== 'client-request' || envelope.method !== '1agents-acp/session/deliver') {
    throw new Error('Unsupported session delivery RPC envelope');
  }
  const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId.trim() : '';
  const req = envelope.payload?.args?.request as Record<string, unknown> | undefined;
  if (!rpcId || rpcId.length > 512 || !req || typeof req !== 'object') throw new Error('Missing delivery request fields');
  const requestId = typeof req.requestId === 'string' ? req.requestId.trim() : '';
  const sessionId = typeof req.sessionId === 'string' ? req.sessionId.trim() : '';
  const text = typeof req.text === 'string' ? req.text : '';
  const mode = req.mode === 'steer' ? 'steer' : req.mode === 'queue' ? 'queue' : undefined;
  const form = req.form === 'notice' ? 'notice' : req.form === 'relay' ? 'relay' : undefined;
  const summary = typeof req.summary === 'string' ? boundNoticeSummary(req.summary) : undefined;
  const fromSessionId = typeof req.fromSessionId === 'string' ? req.fromSessionId.trim() : undefined;
  const correlation = parseCorrelation(req.correlation);
  if (!requestId || requestId.length > 512 || requestId !== rpcId) throw new Error('Invalid requestId');
  if (!sessionId || sessionId.length > 256) throw new Error('Invalid sessionId');
  if (!text.trim() || text.includes('\0') || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('Invalid text');
  if (!mode || !form) throw new Error('Invalid delivery mode or form');
  if (form === 'notice' && !summary) throw new Error('Notice delivery requires a non-empty summary');
  if (fromSessionId !== undefined && (!fromSessionId || fromSessionId.length > 512)) throw new Error('Invalid fromSessionId');
  return { rpcId, request: {
    requestId, sessionId, mode, text, form,
    ...(summary ? { summary } : {}),
    ...(fromSessionId ? { fromSessionId } : {}),
    ...(correlation ? { correlation } : {}),
  } };
}

/** Delivers an idempotent `1agents-acp` ContextFormed message to a DSH agent via `steer` or `followup`. */
export async function deliverSessionNotice(
  ctx: Context,
  input: SessionNoticeInput,
): Promise<{ accepted: true; deduplicated?: true }> {
  const resolved = await ctx.sessionController.resolveAgent(input.sessionId as SessionId);
  if ('error' in resolved) {
    const error = new Error(`Session ${input.sessionId} not found`) as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  const agent = resolved.agent;
  const pending = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])];
  const events = typeof agent.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents() : [];
  const alreadyPresent = pending.some((msg: UserMessage) => sameDelivery(msg, input.requestId))
    || events.some(event => event.type === 'user/message' && sameDelivery((event as { data?: UserMessage }).data, input.requestId));
  if (alreadyPresent) return { accepted: true, deduplicated: true };

  // `rpcIds` is only added once a queue message is merged, so an unmerged source keeps its old shape.
  const source = {
    kind: NOTICE_SOURCE_KIND,
    form: input.form,
    rpcId: input.requestId,
    ...(input.form === 'notice' ? { summary: boundNoticeSummary(input.summary ?? '') } : {}),
    ...(input.fromSessionId ? { fromSessionId: input.fromSessionId } : {}),
    ...(input.correlation ? { correlation: input.correlation } : {}),
  };
  const message: UserMessage = {
    id: input.requestId as MessageId,
    role: 'user',
    content: [{ type: 'text', text: input.text }],
    source: source as unknown as UserMessage['source'],
  };
  if (input.mode === 'steer') agent.steer(message);
  else if (!replacePendingQueueTail(agent.inbox, input)) agent.followup(message);
  await ctx.sessionPersistence?.flush?.();
  return { accepted: true };
}

/** HTTP handler for `POST /api/1agents-acp/session/deliver` using DSH's `server-response` RPC envelope. */
export function createSessionDeliverHandler(ctx: Context): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    let rpcId = '';
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        res.statusCode = 403;
        res.end(JSON.stringify({ type: 'server-response', rpcId: '', result: { ok: false, error: { message: 'Cross-origin delivery is not allowed' } } }));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > MAX_BODY_BYTES) {
          res.statusCode = 413;
          res.end(JSON.stringify({ type: 'server-response', rpcId: '', result: { ok: false, error: { message: 'Request body too large' } } }));
          return;
        }
        chunks.push(buf);
      }
      const parsed = parseInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      rpcId = parsed.rpcId;
      await deliverSessionNotice(ctx, parsed.request);
      res.statusCode = 200;
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { accepted: true } } }));
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 400;
      res.statusCode = status;
      const message = status === 404 ? 'Session not found' : (error instanceof Error ? error.message : 'Invalid session delivery request');
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { message } } }));
    }
  };
}
