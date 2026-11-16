import { WorkbenchUi, WORKBENCH_UI_PATH } from '../dist/shared/a2a/workbench-ui.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** Browser session terminates here; gateway credentials never reach the browser. */
export function createWorkbench(options, loginToken) {
  const ui = new WorkbenchUi(loginToken);
  const gateway = options?.url ? new URL(options.url).origin : undefined;
  return async (req, res, url) => {
    const routed = await ui.handle(req, res, url);
    if (!routed) return;
    const route = routed.route;
    // Standalone headless has no parent DSH GUI to receive open-session events.
    if (/^\/workbench\/dsh\/tasks\/[^/]+$/.test(route)) return json(res, 200, { available: false, reason: 'headless_runtime' });
    if (!gateway) return json(res, 503, { error: 'workbench_not_configured', message: '请配置 workbench.url 连接任务网关。' });
    if (req.method === 'POST' && /^\/workbench\/tasks\/[^/]+\/process-requests$/.test(route)) return json(res, 403, { error: 'browser_action_required' });
    const chunks = []; let length = 0;
    if (!['GET', 'HEAD'].includes(req.method)) {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 1024 * 1024) return json(res, 413, { error: 'Request body too large' });
        chunks.push(chunk);
      }
    }
    const headers = {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.pageRelaySecret ? { 'X-Workbench-Page-Relay': options.pageRelaySecret } : {}),
      ...(chunks.length ? { 'Content-Type': String(req.headers['content-type'] ?? 'application/json') } : {}),
    };
    try {
      const upstream = await fetch(new URL(`${route}${url.search}`, gateway), {
        method: req.method, headers, redirect: 'error', signal: AbortSignal.timeout(60000),
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const passed = { 'Cache-Control': 'no-store' };
      for (const name of ['content-type', 'content-disposition', 'x-content-type-options']) {
        const value = upstream.headers.get(name); if (value) passed[name] = value;
      }
      res.writeHead(upstream.status, passed);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { json(res, 502, { error: 'gateway_unreachable' }); }
  };
}
export { WORKBENCH_UI_PATH };
