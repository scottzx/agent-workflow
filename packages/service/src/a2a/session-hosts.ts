/** Deliver identified messages to existing Codex and DSH host sessions. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

const value = z.string().min(1).max(4096).refine(text => !text.includes('\0'), 'NUL is not allowed');
const timeoutMs = z.number().int().min(1).max(300_000).default(15_000);
const httpOrigin = z.string().url().refine(text => {
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}, 'Expected an HTTP(S) origin without credentials, path, query or fragment');
const remote = value.refine(text => {
  try {
    const url = new URL(text);
    return ['ws:', 'wss:', 'unix:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}, 'Expected a WebSocket or Unix socket endpoint');
const headerName = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
const headerValue = z.string().refine(text => !/[\r\n\0]/.test(text), 'Invalid header value');

export const sessionHostSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('codex'), executable: value.default('codex'), remote: remote.optional(),
    remoteAuthTokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256).optional(),
    cwd: value.refine(text => path.isAbsolute(text), 'cwd must be absolute').optional(), timeoutMs,
  }).strict(),
  z.object({
    kind: z.literal('dsh'), url: httpOrigin,
    headers: z.record(headerName, headerValue).optional(), timeoutMs,
  }).strict(),
]).superRefine((host, ctx) => {
  if (host.kind === 'codex' && host.remoteAuthTokenEnv && !host.remote) {
    ctx.addIssue({ code: 'custom', path: ['remoteAuthTokenEnv'], message: 'remoteAuthTokenEnv requires remote' });
  }
});
export type SessionHost = z.output<typeof sessionHostSchema>;

/** Safe delivery failure; an unknown host outcome must never be retried automatically. */
export class SessionDeliveryError extends Error {
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  constructor(message: string, options: { retryable: boolean; outcomeUnknown: boolean }) {
    super(message);
    this.name = 'SessionDeliveryError';
    this.retryable = options.retryable;
    this.outcomeUnknown = options.outcomeUnknown;
  }
}

export type SessionDeliveryMode = 'queue' | 'steer';
export const sessionNoticeSchema = z.discriminatedUnion('form', [
  z.object({ form: z.literal('notice'), summary: z.string().trim().min(1).max(240).refine(text => !text.includes('\0'), 'NUL is not allowed') }).strict(),
  z.object({ form: z.literal('relay') }).strict(),
]);
export type SessionNoticeMeta = z.output<typeof sessionNoticeSchema>;
type Message = { sessionId: string; messageId: string; text: string; mode?: SessionDeliveryMode; notice?: SessionNoticeMeta; fromSessionId?: string };
const messageSchema = z.object({
  sessionId: value,
  messageId: value,
  text: z.string().min(1).refine(text => !text.includes('\0')),
  mode: z.enum(['queue', 'steer']).optional(),
  notice: sessionNoticeSchema.optional(),
  /** Optional sender identity; older DSH hosts ignore it because the body already names the sender. */
  fromSessionId: z.string().trim().min(1).max(512).optional(),
});
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const uuidPattern = new RegExp(`^${uuid}$`, 'i');
const queuedPattern = new RegExp(`^Queued message (${uuid}) for thread (${uuid})\\.?$`, 'i');
const maxReplyBytes = 64 * 1024;
function startupFailure(error: unknown): SessionDeliveryError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new SessionDeliveryError('Codex queue could not start.', {
    retryable: code !== 'E2BIG' && code !== 'EINVAL', outcomeUnknown: false,
  });
}

/** Queue one message without starting a new host session or changing its configuration. */
export async function deliverSessionMessage(
  host: SessionHost, input: Message, signal?: AbortSignal,
): Promise<{ hostReceiptId?: string }> {
  if (!messageSchema.safeParse(input).success) {
    throw new SessionDeliveryError('Invalid session message.', { retryable: false, outcomeUnknown: false });
  }
  if (host.kind === 'codex' && !uuidPattern.test(input.sessionId)) {
    throw new SessionDeliveryError('Codex target must be a thread UUID.', { retryable: false, outcomeUnknown: false });
  }
  if (signal?.aborted) {
    throw new SessionDeliveryError('Session delivery cancelled before dispatch.', { retryable: true, outcomeUnknown: false });
  }
  return host.kind === 'codex' ? deliverCodex(host, input, signal) : deliverDsh(host, input, signal);
}

function deliverCodex(
  host: Extract<SessionHost, { kind: 'codex' }>, input: Message, signal?: AbortSignal,
): Promise<{ hostReceiptId: string }> {
  return new Promise((resolve, reject) => {
    const args = ['queue', `--thread=${input.sessionId}`, `--message=${input.text}`];
    if (host.remote) args.push(`--remote=${host.remote}`);
    if (host.remoteAuthTokenEnv) args.push(`--remote-auth-token-env=${host.remoteAuthTokenEnv}`);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(host.executable, args, { cwd: host.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(startupFailure(error));
      return;
    }
    let started = child.pid !== undefined;
    let settled = false;
    let bytes = 0;
    const output: Buffer[] = [];
    const finish = (error?: SessionDeliveryError, receipt?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({ hostReceiptId: receipt! });
    };
    const fail = (message: string): void => {
      finish(new SessionDeliveryError(message, { retryable: !started, outcomeUnknown: started }));
      child.kill('SIGKILL');
    };
    const abort = (): void => fail('Codex queue delivery cancelled; acceptance could not be confirmed.');
    const timer = setTimeout(() => fail('Codex queue timed out; acceptance could not be confirmed.'), host.timeoutMs);
    child.once('spawn', () => { started = true; });
    child.once('error', error => {
      if (!started) finish(startupFailure(error));
      else fail('Codex queue failed; acceptance could not be confirmed.');
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxReplyBytes) { fail('Codex queue returned an invalid delivery receipt.'); return; }
      output.push(chunk);
    });
    // Drain diagnostics without retaining or exposing provider output or credentials.
    child.stderr!.resume();
    child.once('close', code => {
      if (settled) return;
      const receipts = Buffer.concat(output).toString('utf8').split(/\r?\n/)
        .map(line => queuedPattern.exec(line.trim())).filter(match => match !== null);
      const receipt = receipts.length === 1 ? receipts[0]! : undefined;
      const matchesThread = receipt && receipt[2]!.toLowerCase() === input.sessionId.toLowerCase();
      if (code !== 0 || !receipt || !matchesThread) {
        fail('Codex queue failed; acceptance could not be confirmed.');
        return;
      }
      finish(undefined, receipt[1]);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

const dshReplySchema = z.object({
  type: z.literal('server-response'), rpcId: z.string(),
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.object({ accepted: z.literal(true) }) }),
    z.object({ ok: z.literal(false) }),
  ]),
});

async function deliverDshRpc(
  host: Extract<SessionHost, { kind: 'dsh' }>,
  endpoint: string,
  body: Record<string, unknown>,
  messageId: string,
  signal: AbortSignal | undefined,
  allowNotFoundFallback = false,
): Promise<{ hostReceiptId: string } | 'not_found'> {
  const deadline = AbortSignal.timeout(host.timeoutMs);
  try {
    const headers = new Headers(host.headers);
    headers.set('Content-Type', 'application/json');
    const response = await fetch(new URL(endpoint, host.url), {
      method: 'POST', headers, redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      body: JSON.stringify(body),
    });
    if (allowNotFoundFallback && response.status === 404) {
      const raw = await readDshReply(response);
      // Only fall back when the route itself is absent (not an RPC-level "session not found").
      if (!dshReplySchema.safeParse(raw).success) return 'not_found';
      throw new SessionDeliveryError('DSH rejected the session message.', { retryable: false, outcomeUnknown: false });
    }
    const raw = await readDshReply(response);
    const parsed = dshReplySchema.safeParse(raw);
    if (!parsed.success || parsed.data.rpcId !== messageId) {
      throw new SessionDeliveryError('DSH returned an invalid delivery receipt.', { retryable: false, outcomeUnknown: true });
    }
    if (!parsed.data.result.ok) {
      const retryable = response.status === 429 || response.status === 503;
      throw new SessionDeliveryError('DSH rejected the session message.', { retryable, outcomeUnknown: false });
    }
    if (!response.ok) {
      throw new SessionDeliveryError('DSH returned an invalid delivery receipt.', { retryable: false, outcomeUnknown: true });
    }
    return { hostReceiptId: parsed.data.rpcId };
  } catch (error) {
    if (error instanceof SessionDeliveryError) throw error;
    // Request IDs help deduplicate ordinary retries, but do not prove admission after a lost response or host restart.
    throw new SessionDeliveryError('DSH delivery could not be confirmed.', { retryable: false, outcomeUnknown: true });
  }
}

async function deliverDsh(
  host: Extract<SessionHost, { kind: 'dsh' }>, input: Message, signal?: AbortSignal,
): Promise<{ hostReceiptId: string }> {
  if (input.notice) {
    const structured = await deliverDshRpc(
      host,
      '/api/1agents-acp/session/deliver',
      {
        type: 'client-request',
        rpcId: input.messageId,
        method: '1agents-acp/session/deliver',
        payload: { args: { request: {
          requestId: input.messageId,
          sessionId: input.sessionId,
          mode: input.mode ?? 'queue',
          text: input.text,
          form: input.notice.form,
          ...(input.notice.form === 'notice' ? { summary: input.notice.summary } : {}),
          ...(input.fromSessionId ? { fromSessionId: input.fromSessionId } : {}),
        } } },
      },
      input.messageId,
      signal,
      true,
    );
    if (structured !== 'not_found') return structured;
  }
  const result = await deliverDshRpc(
    host,
    '/api/session/prompt',
    {
      type: 'client-request', rpcId: input.messageId, method: 'session/prompt',
      payload: { args: { request: {
        requestId: input.messageId, sessionId: input.sessionId, mode: input.mode ?? 'queue',
        content: [{ type: 'text', text: input.text }],
      } } },
    },
    input.messageId,
    signal,
    false,
  );
  return result as { hostReceiptId: string };
}

async function readDshReply(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxReplyBytes) {
      throw new SessionDeliveryError('DSH returned an invalid delivery receipt.', { retryable: false, outcomeUnknown: true });
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return undefined; }
}
