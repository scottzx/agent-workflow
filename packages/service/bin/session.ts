/**
 * `acp-service session send`: one-shot cross-session message through a running a2a-gateway.
 * The sender identity is mandatory, so a message can never be queued anonymously; missing
 * `--from` and both known environment variables fail closed with exit code 1.
 */
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:36814';
const SENDER_ENV_VARS = ['DSH_SESSION_ID', 'ONEAGENTS_SESSION_ID'] as const;
const MODES = ['queue', 'steer'] as const;
type Mode = (typeof MODES)[number];

export const SESSION_SEND_USAGE = `用法:
  acp-service session send --to <sessionId> [选项] <text...>

向另一个会话投递一条跨会话留言。接收方正文会带上 msg_from_session_id，便于识别发件方。
该留言进入目标会话的同一待发队列，会与 A2A 任务通知自动合并为一次宿主投递。

选项:
  --to <sessionId>          接收方会话 ID（必填）
  --from <sessionId>        发件方会话 ID；省略时读 DSH_SESSION_ID / ONEAGENTS_SESSION_ID，仍缺失则退出码 1
  --host <host>             接收方宿主别名；省略时按目标会话的绑定或唯一宿主解析
  --mode queue|steer        投递模式（默认 queue；steer 绝不合并）
  --summary <text>          通知摘要，最多 240 字符
  --message-id <id>         稳定幂等键；省略时由网关生成 session-msg:<uuid>
  --text <text>             正文；不传时使用位置参数拼接
  --url <url>               a2a-gateway 地址（默认 ${DEFAULT_GATEWAY_URL}）
  --json                    输出网关原始 JSON 回执
  -h, --help                显示帮助信息
`;

export interface SessionSendPlan {
  toSessionId: string;
  fromSessionId: string;
  toHost?: string;
  mode?: Mode;
  summary?: string;
  messageId?: string;
  url: string;
  json: boolean;
  text: string;
}

/** Parse flags and positional text. Throws before any network call, so bad input never reaches the gateway. */
export function parseSessionSendArgs(args: string[], env: NodeJS.ProcessEnv = process.env): SessionSendPlan {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  const booleanFlags = new Set(['json']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const equals = arg.indexOf('=');
    const name = (equals > 0 ? arg.slice(2, equals) : arg.slice(2)).trim();
    if (booleanFlags.has(name)) { flags.set(name, 'true'); continue; }
    if (!name) throw new Error(`Invalid option ${arg}`);
    if (equals > 0) { flags.set(name, arg.slice(equals + 1)); continue; }
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for --${name}`);
    flags.set(name, next);
    index += 1;
  }
  const known = new Set(['to', 'from', 'host', 'mode', 'summary', 'message-id', 'text', 'url', 'json']);
  for (const name of flags.keys()) {
    if (!known.has(name)) throw new Error(`Unknown option --${name}`);
  }
  const toSessionId = (flags.get('to') ?? '').trim();
  if (!toSessionId) throw new Error('缺少接收方会话：请传 --to <sessionId>');
  const flagFrom = (flags.get('from') ?? '').trim();
  const fromSessionId = flagFrom || SENDER_ENV_VARS.map(name => (env[name] ?? '').trim()).find(Boolean) || '';
  if (!fromSessionId) {
    throw new Error('缺少发件方身份：请传 --from <sessionId>，或设置 DSH_SESSION_ID / ONEAGENTS_SESSION_ID');
  }
  const text = ((flags.get('text') ?? '').trim() || positional.join(' ').trim());
  if (!text) throw new Error('缺少留言正文：请传 <text...> 或 --text <text>');
  const mode = (flags.get('mode') ?? '').trim() || undefined;
  if (mode && !(MODES as readonly string[]).includes(mode)) throw new Error(`不支持的 --mode: ${mode}（可用 queue 或 steer）`);
  const summary = (flags.get('summary') ?? '').trim() || undefined;
  if (summary && summary.length > 240) throw new Error('--summary 最多 240 个字符');
  const toHost = (flags.get('host') ?? '').trim() || undefined;
  const messageId = (flags.get('message-id') ?? '').trim() || undefined;
  if (messageId && /^(?:a2a-notice:|execution-notice:|process-request:)/.test(messageId)) {
    throw new Error('messageId 不能使用 a2a-notice: / execution-notice: / process-request: 保留前缀');
  }
  const url = (flags.get('url') ?? '').trim() || DEFAULT_GATEWAY_URL;
  return {
    toSessionId, fromSessionId, text, url,
    json: flags.get('json') === 'true',
    ...(toHost ? { toHost } : {}),
    ...(mode ? { mode: mode as Mode } : {}),
    ...(summary ? { summary } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

/** CLI entrypoint. Any failure is reported on stderr and sets exit code 1; it never sends without a sender. */
export async function runSessionCli(args: string[]): Promise<void> {
  try {
    if (!args.length || args.includes('--help') || args.includes('-h')) {
      console.log(SESSION_SEND_USAGE);
      return;
    }
    if (args[0] !== 'send') throw new Error('Unknown session command; run acp-service session --help');
    const plan = parseSessionSendArgs(args.slice(1));
    const { url, json, ...params } = plan;
    const response = await fetch(new URL('/invoke', url), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'session_message_send', params }),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await response.text();
    let data: unknown;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { data = { error: raw || `HTTP ${response.status}` }; }
    if (!response.ok) {
      const message = data && typeof data === 'object' && 'error' in data && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `a2a-gateway HTTP ${response.status}`;
      throw new Error(message);
    }
    if (json) { console.log(JSON.stringify(data, null, 2)); return; }
    const receipt = data as { messageId?: string; toHost?: string; toSessionId?: string; status?: string; queuedOn?: string };
    console.log(`已投递跨会话留言 ${receipt.messageId ?? plan.messageId ?? ''} → ${receipt.toHost ?? plan.toHost ?? ''}:${receipt.toSessionId ?? plan.toSessionId}（status=${receipt.status ?? 'unknown'}，queuedOn=${receipt.queuedOn ?? 'unknown'}）`);
  } catch (error) {
    console.error(`acp-service session: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
