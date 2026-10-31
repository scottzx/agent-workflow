/**
 * The gateway's own workbench page. A logged-in same-origin browser reaches the same routes as the bearer API.
 * Without a configured token the page needs no login; writes still need a same-origin browser.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKBENCH_UI_PATH = '/workbench/ui';
const API_PATH = `${WORKBENCH_UI_PATH}/api`;
const COOKIE = 'acp_workbench';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const ASSETS: Record<string, string> = { 'app.js': 'text/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8' };
/** Lazy-loaded renderer chunks (markdown, highlighting) emitted by the page build. */
const CHUNK = /^chunk-[A-Za-z0-9_-]+\.js$/;
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/**
 * Built output sits in dist/workbench-ui; the source tree runs from src/a2a under tsx. Only the build
 * has app.js, so the page source directory beside src is never served.
 */
function assetDirectory(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, '../../workbench-ui'), path.resolve(here, '../../dist/workbench-ui')]
    .find(directory => existsSync(path.join(directory, 'app.js')));
}

function send(res: ServerResponse, status: number, type: string, payload: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...headers });
  res.end(payload);
}
function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  send(res, status, 'application/json', JSON.stringify(data), headers);
}

/**
 * The page and its static assets under WORKBENCH_UI_PATH. `frameAncestors` lets a host that embeds the
 * page in its own frame (DSH) allow exactly that; the gateway's own page is never framed.
 */
export async function serveWorkbenchPage(req: IncomingMessage, res: ServerResponse, pathname: string, options: { frameAncestors?: "'none'" | "'self'" } = {}): Promise<void> {
  const headers: Record<string, string> = options.frameAncestors === "'self'"
    ? { 'Content-Security-Policy': SECURITY_HEADERS['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'") } : {};
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, headers);
  const directory = assetDirectory();
  if (!directory) return sendJson(res, 503, { error: 'Workbench page is not built' }, headers);
  if (pathname === WORKBENCH_UI_PATH || pathname === `${WORKBENCH_UI_PATH}/`) {
    return send(res, 200, 'text/html; charset=utf-8', await readFile(path.join(directory, 'index.html')), headers);
  }
  const asset = pathname.slice(`${WORKBENCH_UI_PATH}/`.length);
  const type = Object.hasOwn(ASSETS, asset) ? ASSETS[asset] : CHUNK.test(asset) ? ASSETS['app.js'] : undefined;
  if (!type) return sendJson(res, 404, { error: 'No workbench page asset' }, headers);
  try { return send(res, 200, type, await readFile(path.join(directory, asset)), headers); }
  catch { return sendJson(res, 404, { error: 'No workbench page asset' }, headers); }
}

/** Agent sessions and CLI tools never act as the human reviewer. */
export function isAgentRequest(req: IncomingMessage): boolean {
  if (['x-oneagents-session-id', 'x-oneagents-session-token', 'x-oneagents-turn-id'].some(name => req.headers[name])) return true;
  const origin = String(req.headers['x-oneagents-origin'] ?? '').toLowerCase();
  return origin === 'mcp' || origin === 'cli' || Boolean(req.headers.authorization);
}

/** Same rule as the former 1agents proxy: a direct browser request whose Origin authority is this Host. */
export function sameOriginBrowser(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] !== 'same-origin') return false;
  try {
    const origin = new URL(String(req.headers.origin ?? ''));
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return false;
    if ((origin.pathname !== '' && origin.pathname !== '/') || origin.search || origin.hash) return false;
    return origin.host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
  } catch { return false; }
}

function cookieValue(req: IncomingMessage): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
}

async function readToken(req: IncomingMessage): Promise<unknown> {
  let length = 0; const chunks: Buffer[] = [];
  for await (const data of req) {
    length += data.length;
    if (length > 4096) throw new Error('Request body too large');
    chunks.push(Buffer.from(data));
  }
  return (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { token?: unknown }).token;
}

export class WorkbenchUi {
  private readonly sessions = new Map<string, number>();
  constructor(private readonly token: string | undefined, private readonly now: () => number = Date.now) {}

  /**
   * Serves the page, the login session and static assets. For an authorized page API call it returns
   * the matching /workbench route, which the caller dispatches exactly like the bearer API.
   */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<{ route: string } | undefined> {
    const pathname = url.pathname;
    if (!pathname.startsWith(`${API_PATH}/`)) return void await serveWorkbenchPage(req, res, pathname);
    if (isAgentRequest(req)) return void sendJson(res, 403, { error: 'browser_action_required', message: 'Agents and tools use the bearer workbench API, not the page.' });
    const write = req.method !== 'GET';
    if (write && !sameOriginBrowser(req)) {
      return void sendJson(res, 403, { error: 'browser_action_required', message: '请在本工作台页面提交。' });
    }
    if (pathname === `${API_PATH}/session`) return this.session(req, res);
    if (!this.authorized(req)) return void sendJson(res, 401, { error: 'login_required', message: '请先登录工作台。' });
    return { route: `/workbench${pathname.slice(API_PATH.length)}` };
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.token) return true;
    const id = cookieValue(req);
    const expires = id ? this.sessions.get(id) : undefined;
    if (!id || expires === undefined) return false;
    if (expires <= this.now()) { this.sessions.delete(id); return false; }
    return true;
  }

  private async session(req: IncomingMessage, res: ServerResponse): Promise<undefined> {
    if (req.method === 'GET') return void sendJson(res, 200, { authenticated: this.authorized(req), loginRequired: Boolean(this.token) });
    if (req.method === 'DELETE') {
      const id = cookieValue(req);
      if (id) this.sessions.delete(id);
      return void sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=${WORKBENCH_UI_PATH}; Max-Age=0` });
    }
    if (req.method !== 'POST') return void sendJson(res, 405, { error: 'Method not allowed' });
    if (!this.token) return void sendJson(res, 200, { authenticated: true });
    let supplied: unknown;
    try { supplied = await readToken(req); } catch { return void sendJson(res, 400, { error: 'invalid', message: '请求格式不正确。' }); }
    const expected = Buffer.from(this.token), given = Buffer.from(typeof supplied === 'string' ? supplied : '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return void sendJson(res, 401, { error: 'login_failed', message: '工作台令牌不正确。' });
    }
    const now = this.now();
    for (const [id, expires] of this.sessions) if (expires <= now) this.sessions.delete(id);
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, now + SESSION_MS);
    return void sendJson(res, 200, { authenticated: true },
      { 'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=${WORKBENCH_UI_PATH}; Max-Age=${SESSION_MS / 1000}` });
  }
}
