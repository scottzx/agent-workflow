/**
 * Manual takeover hand-back. A person finishes an A2A task in its DSH session; when they are satisfied the
 * agent calls submit_to_review, the host re-verifies the job's artifacts and the gateway records a new result
 * revision awaiting business acceptance. Native DSH agents get a tool; ACP agents get a stdio MCP server whose
 * calls come back here over loopback, each bound to its own session by an HMAC token. The same server carries the
 * executor's ticket tools for an A2A task session, so an ACP executor handles its ticket like a native one.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import type { A2AHostControls } from './a2a.js';
import { TICKET_PATH, TICKET_TOOLS, type TicketTool } from './ticket-spec.js';

export const SUBMIT_TOOL = 'submit_to_review';
export const SUBMIT_DESCRIPTION = '仅用于从 A2A 工作台接管的会话：用户明确确认成果没问题后调用，把本会话 A2A 任务的交付总结与作业目录 artifacts.json 清单中的产物重新提交回工作流，生成新的结果版本并进入业务验收。调用前先把产物写入作业目录并更新清单；用户未确认时不要调用。';
export const SUMMARY_DESCRIPTION = '交付总结：本次人工接管做了哪些修改、最终产物是什么。';
export const REVIEW_SUBMIT_PATH = '/1agents-acp/review-submit';
const MCP_SCRIPT = fileURLToPath(new URL('./review-mcp.js', import.meta.url));

async function hostSecret(file: string): Promise<Buffer> {
  try { const value = Buffer.from((await readFile(file, 'utf8')).trim(), 'base64url'); if (value.length === 32) return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Persisted so an ACP agent process that outlives a DSH restart keeps a valid token.
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const value = randomBytes(32), handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(value.toString('base64url')); } finally { await handle.close(); }
  return value;
}

const loopback = (address?: string) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

export class ReviewHandBack {
  /** Set while the A2A host is mounted. */
  host?: A2AHostControls;
  private constructor(private readonly secret: Buffer, private readonly workbench?: { url: string; token?: string }) {}

  static async open(secretFile: string, workbench?: { url: string; token?: string }): Promise<ReviewHandBack> {
    return new ReviewHandBack(await hostSecret(secretFile), workbench);
  }

  /** Hand the session's task back and let the gateway read it now; returns the agent-facing outcome. */
  async submit(sessionId: string, summary: string): Promise<string> {
    if (!this.host) throw new Error('A2A is not enabled on this DSH host');
    const result = await this.host.resubmit({ sessionId, summary });
    let refreshed = false;
    if (this.workbench && result.jobId) {
      // A webhook may already be on its way; this read only makes the new revision visible at once.
      const headers: Record<string, string> = this.workbench.token?.trim() ? { Authorization: `Bearer ${this.workbench.token}` } : {};
      try {
        const response = await fetch(new URL(`/workbench/tasks/${encodeURIComponent(result.jobId)}/refresh`, new URL(this.workbench.url).origin),
          { method: 'POST', headers, signal: AbortSignal.timeout(10_000) });
        await response.body?.cancel(); refreshed = response.ok;
      } catch { /* The stored snapshot stays authoritative. */ }
    }
    return `已提交回工作流：任务 ${result.jobId ?? result.taskId} 生成新的结果版本，等待业务验收；作业目录清单中的 ${result.artifacts.length} 个产物已重新校验 sha256。`
      + (refreshed ? '' : '工作台会在网关收到回调后更新。');
  }

  private token(sessionId: string): string { return createHmac('sha256', this.secret).update(sessionId).digest('base64url'); }

  /** The stdio MCP server an ACP agent starts for one session; the token only acts for that session. */
  mcpServer(sessionId: string, origin: string): McpServerStdio {
    return { name: '1agents-review', command: process.execPath, args: [MCP_SCRIPT], env: [
      { name: 'ONEAGENTS_REVIEW_URL', value: new URL(REVIEW_SUBMIT_PATH, origin).href },
      { name: 'ONEAGENTS_TICKET_URL', value: new URL(TICKET_PATH, origin).href },
      { name: 'ONEAGENTS_REVIEW_SESSION', value: sessionId },
      { name: 'ONEAGENTS_REVIEW_TOKEN', value: this.token(sessionId) },
    ] };
  }

  /** A loopback call from the MCP server, checked against its session's token; replies itself and returns nothing when refused. */
  private async authorized(req: IncomingMessage, reply: (status: number, body: unknown) => void): Promise<{ sessionId: string; body: Record<string, unknown> } | undefined> {
    if (req.method !== 'POST') return void reply(405, { error: 'Method not allowed' });
    if (!loopback(req.socket.remoteAddress) || req.headers.origin) return void reply(403, { error: 'Forbidden' });
    const sessionId = req.headers['x-oneagents-session'], authorization = req.headers.authorization;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || !authorization?.startsWith('Bearer ')) return void reply(401, { error: 'Unauthorized' });
    const expected = Buffer.from(this.token(sessionId)), given = Buffer.from(authorization.slice(7));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return void reply(401, { error: 'Unauthorized' });
    try {
      let body = '';
      for await (const chunk of req) { body += String(chunk); if (body.length > 96 * 1024) throw new Error('too large'); }
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return { sessionId, body: parsed as Record<string, unknown> };
    } catch { return void reply(400, { error: 'Invalid request' }); }
  }

  /** Loopback callback from the MCP server. */
  readonly handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = replier(res), call = await this.authorized(req, reply);
    if (!call) return;
    const { sessionId } = call, summary = call.body.summary;
    if (typeof summary !== 'string') return reply(400, { error: 'summary must be a string' });
    try { reply(200, { text: await this.submit(sessionId, summary) }); }
    catch (error) {
      const code = (error as { code?: unknown }).code;
      reply(typeof code === 'string' ? 409 : 500, { error: error instanceof Error ? error.message : String(error), ...(typeof code === 'string' ? { code } : {}) });
    }
  };

  /** The MCP server's ticket tools for its session; `run` is the same call DSH's native tools make. */
  ticketHandler(run: (sessionId: string, tool: TicketTool, args: Record<string, unknown>) => Promise<string>) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const reply = replier(res), call = await this.authorized(req, reply);
      if (!call) return;
      const tool = TICKET_TOOLS.find(spec => spec.name === call.body.tool)?.name, args = call.body.arguments ?? {};
      if (!tool || typeof args !== 'object' || Array.isArray(args)) return reply(400, { error: 'Unknown ticket tool or invalid arguments' });
      try { reply(200, { text: await run(call.sessionId, tool, args as Record<string, unknown>) }); }
      catch (error) { reply(409, { error: error instanceof Error ? error.message : String(error) }); }
    };
  }
}

const replier = (res: ServerResponse) => (status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body));
};
