/**
 * The workbench page inside a hosting DSH Web GUI.
 *
 * `dsh-a2a` owns the workbench: the page, its assets, its login session and the
 * gateway relay. A host mounts it at the same origin as the GUI so the sidebar
 * panel can embed it with a relative `/workbench/ui/` iframe.
 *
 * Unlike the standalone listener, this handler answers to the host's own browser
 * session: DSH login stands in for the workbench login, and the page is framed by
 * the host (`frameAncestors: 'self'`). Gateway credentials stay on this side.
 */
import { serveWorkbenchPage, isAgentRequest, WORKBENCH_UI_PATH } from '@1agents/acp-service/a2a-standalone';

const API = `${WORKBENCH_UI_PATH}/api`;
const BODY_LIMIT = 1024 * 1024;
/** Response headers worth passing through from the gateway; the rest are ours. */
const PASSED_HEADERS = ['content-type', 'content-disposition', 'content-security-policy', 'x-content-type-options', 'cache-control'];

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
};

async function bounded(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * @param options.workbench Gateway origin plus the bearer token and page relay secret.
 * @param options.admit     Host browser admission; returns `{ rejection }` when the request is not the owner's.
 * @param options.hostControls Returns in-process A2A host controls (`taskSession`, `sessionTask`) when `oneagents-acp` mounts A2A on this host.
 */
export function createHostWorkbench(options = {}) {
  const workbench = options.workbench;
  const gateway = workbench?.url ? new URL(workbench.url).origin : undefined;

  return async function handleHostWorkbench(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname !== API && !pathname.startsWith(`${API}/`)) {
      return serveWorkbenchPage(req, res, pathname, { frameAncestors: "'self'" });
    }

    // The host's browser login is the workbench login: no separate token in the page.
    if (options.admit) {
      const admission = options.admit(req);
      if (admission && 'rejection' in admission) {
        return json(res, admission.rejection, { error: admission.rejection === 401 ? 'login_required' : 'forbidden' });
      }
      const principal = admission?.peer?.principal;
      if (principal && principal.kind !== 'owner') return json(res, 403, { error: 'forbidden' });
    }
    // Agents and tools use the bearer API, never the person's browser session.
    if (isAgentRequest(req)) return json(res, 403, { error: 'browser_action_required' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['sec-fetch-site'] !== 'same-origin') {
      return json(res, 403, { error: 'browser_action_required' });
    }

    const route = pathname.slice(API.length);
    if (route === '/session') return json(res, 200, { authenticated: true, loginRequired: false });

    // When the in-process A2A host is mounted on this DSH instance, resolve the live
    // session so the workbench can offer "Take over in DSH". Headless executions have
    // no DSH GUI session on this host and report `headless_runtime`.
    const task = /^\/dsh\/tasks\/([^/]+)$/.exec(route);
    if (task) {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      const controls = typeof options.hostControls === 'function' ? options.hostControls() : undefined;
      if (controls) {
        const taskId = decodeURIComponent(task[1]);
        const sessionId = controls.taskSession?.(taskId);
        if (!sessionId) return json(res, 200, { available: false, reason: 'not_on_this_host' });
        const info = controls.sessionTask?.(sessionId);
        return json(res, 200, {
          available: true,
          sessionId,
          ...(info ? {
            task: {
              taskId: info.taskId,
              ...(info.jobId ? { jobId: info.jobId } : {}),
              state: info.state,
              running: info.running,
              resubmittable: info.resubmittable,
            },
          } : {}),
        });
      }
      return json(res, 200, { available: false, reason: 'headless_runtime' });
    }

    if (!gateway) {
      return json(res, 503, { error: 'workbench_not_configured', message: '未配置 workbench.url，无法连接任务网关。' });
    }
    // As on the gateway page, only the execution host opens process requests.
    if (req.method === 'POST' && /^\/tasks\/[^/]+\/process-requests$/.test(route)) {
      return json(res, 403, { error: 'browser_action_required' });
    }

    let body;
    try {
      body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bounded(req);
    } catch {
      return json(res, 413, { error: 'Request body too large' });
    }

    // The page relay secret identifies the person on this page to the gateway.
    const headers = {
      ...(workbench.token?.trim() ? { Authorization: `Bearer ${workbench.token}` } : {}),
      ...(workbench.pageRelaySecret ? { 'X-Workbench-Page-Relay': workbench.pageRelaySecret } : {}),
      ...(body ? { 'Content-Type': String(req.headers['content-type'] ?? 'application/json') } : {}),
    };

    let upstream;
    try {
      upstream = await fetch(new URL(`/workbench${route}${url.search}`, gateway), {
        method: req.method, headers, redirect: 'error', signal: AbortSignal.timeout(60_000),
        ...(body ? { body: new Uint8Array(body) } : {}),
      });
    } catch {
      return json(res, 502, { error: 'gateway_unreachable', message: '任务网关不可达。' });
    }

    const passed = {};
    for (const name of PASSED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) passed[name] = value;
    }
    res.writeHead(upstream.status, passed);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  };
}

export { WORKBENCH_UI_PATH };
