/**
 * The gateway's task workbench page, served by DSH at the same path so the page needs no change. DSH's own
 * browser login stands in for the workbench login: every API call must be admitted as the owner, and the
 * plugin forwards it to the gateway's bearer API with a token the browser never sees.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { WORKBENCH_UI_PATH, isAgentRequest, serveWorkbenchPage } from '@1agents/acp-service/a2a';
import type { A2AHostControls } from './a2a.js';

const API = `${WORKBENCH_UI_PATH}/api`;
const BODY_LIMIT = 1024 * 1024;
const PASSED_HEADERS = ['content-type', 'content-disposition', 'content-security-policy', 'x-content-type-options', 'cache-control'];

export interface WorkbenchProxyOptions {
  /** Gateway origin and bearer token (the same as a2a.workbench). */
  workbench?: { url: string; token?: string };
  host: () => A2AHostControls | undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function bounded(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function workbenchHandler(ctx: Context, options: WorkbenchProxyOptions) {
  const gateway = options.workbench ? new URL(options.workbench.url).origin : undefined;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== API && !url.pathname.startsWith(`${API}/`)) return serveWorkbenchPage(req, res, url.pathname, { frameAncestors: "'self'" });
    const admission = ctx.connection.admit(req);
    if ('rejection' in admission) return json(res, admission.rejection, { error: admission.rejection === 401 ? 'login_required' : 'forbidden' });
    // Hosts with delegated principals admit non-owners too; earlier hosts admit only the owner's browser.
    const principal = (admission.peer as { principal?: { kind?: string } }).principal;
    if (principal && principal.kind !== 'owner') return json(res, 403, { error: 'forbidden' });
    // The reviewer is the person in the browser, never an agent or tool reusing the cookie.
    if (isAgentRequest(req)) return json(res, 403, { error: 'browser_action_required' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['sec-fetch-site'] !== 'same-origin') return json(res, 403, { error: 'browser_action_required' });
    const route = url.pathname.slice(API.length);
    if (route === '/session') return json(res, 200, { authenticated: true, loginRequired: false });
    const session = /^\/dsh\/sessions\/([^/]+)$/.exec(route);
    if (session) {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      const id = decodeURIComponent(session[1]!);
      if (id.length > 256) return json(res, 400, { error: 'Invalid session id' });
      const available = await ctx.sessionController.inspect(id as SessionId).then(found => found != null, () => false);
      const task = available ? options.host()?.sessionTask(id) : undefined;
      return json(res, 200, { available, ...(task ? { task } : {}) });
    }
    if (!gateway) return json(res, 503, { error: 'workbench_not_configured', message: '未配置 a2a.workbench，无法连接任务网关。' });
    // As on the gateway page, only the execution host opens process requests.
    if (req.method === 'POST' && /^\/tasks\/[^/]+\/process-requests$/.test(route)) return json(res, 403, { error: 'browser_action_required' });
    let body: Buffer | undefined;
    try { body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bounded(req); }
    catch { return json(res, 413, { error: 'Request body too large' }); }
    const headers: Record<string, string> = { ...(options.workbench!.token?.trim() ? { Authorization: `Bearer ${options.workbench!.token}` } : {}),
      ...(body ? { 'Content-Type': String(req.headers['content-type'] ?? 'application/json') } : {}) };
    let response: Response;
    try {
      response = await fetch(new URL(`/workbench${route}${url.search}`, gateway), { method: req.method, headers, ...(body ? { body: new Uint8Array(body) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(60_000) });
    } catch { return json(res, 502, { error: 'gateway_unreachable', message: '任务网关不可达。' }); }
    const passed: Record<string, string> = {};
    for (const name of PASSED_HEADERS) { const value = response.headers.get(name); if (value) passed[name] = value; }
    res.writeHead(response.status, passed);
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
