/** Installable Cordis bundle. Uses only existing Host services and preset registrations. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { openDiagnostics } from './diagnostics.js';
import { AcpAdapter, validateSessionPolicies, type Config } from './adapter.js';
import { discoverPresets } from './discovery.js';
import { NativeSessions } from './imports.js';
import { acquireService, resolveServiceOptions, type ServiceOptions } from './service-process.js';
import { mountDshA2A, resolveA2AWorkbench, type A2AHostRef, type DshA2AOptions } from './a2a.js';
import { createWorkbenchProcessClient } from './process-requests.js';
import { selectAcpRoute } from './preset-route.js';
import { registerNativeApprovals } from './native-approvals.js';
import type {} from '@deepseek-ai/dsh-tools';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ExecutorTicketArgs } from '@1agents/acp-service/a2a';
import { REVIEW_SUBMIT_PATH, ReviewHandBack, SUBMIT_DESCRIPTION, SUBMIT_TOOL, SUMMARY_DESCRIPTION } from './review.js';
import { createTicketGateway, runTicketTool, ticketTools } from './ticket-tools.js';
import { HANDOFF_PATH } from './handoff-spec.js';
import { syncGlobalAcpService } from './sync-global.js';
import { handoffTools } from './handoff-tools.js';
import { runHandoffTool } from './handoff-executor.js';
import { TICKET_PATH } from './ticket-spec.js';
import { createSessionDeliverHandler, SESSION_DELIVER_PATH } from './session-notice.js';
import { registerRowConfigRpc } from './row-config.js';
export type { DshA2AOptions } from './a2a.js';
export { name, inject } from '@1agents/acp-service';
export async function apply(ctx: Context, input: Partial<Config & ServiceOptions> & { a2a?: DshA2AOptions; diagnosticsDirectory?: string } = {}): Promise<void> {
  registerRowConfigRpc(ctx);
  // One plugin install updates the global acp-service CLI. A failure must not stop DSH.
  try {
    const synced = await syncGlobalAcpService();
    if (synced.updated) console.log(`acp-service global CLI updated ${synced.from ?? '(none)'} -> ${synced.version}`);
  } catch (error) { console.warn(`acp-service global CLI was not updated: ${error instanceof Error ? error.message : String(error)}`); }
  const homePath = ctx.get('dshHomePath') as ((...parts: string[]) => string) | undefined;
  const home = homePath ? homePath() : process.env.DSH_HOME || join(homedir(), '.dsh');
  const service = resolveServiceOptions(input);
  const { serviceUrl } = service;
  await ctx.effect(async () => acquireService(service));
  const presets = input.agents === undefined
    ? await discoverPresets(serviceUrl)
    : [...new Set(input.agents)].map(id => ({ id, label: id }));
  const config: Config = {
    serviceUrl, agents: presets.map(preset => preset.id),
    stateDirectory: input.stateDirectory ?? join(home, 'plugins', '1agents-acp', 'sessions'),
    reconnectAttempts: input.reconnectAttempts ?? 5, reconnectDelayMs: input.reconnectDelayMs ?? 1000,
    sessionPolicies: validateSessionPolicies(input.sessionPolicies),
  };
  if (config.agents.some(a => !/^[a-z0-9_-]+$/i.test(a))) throw new Error('agents must contain ACP registry names');
  if (!Number.isSafeInteger(config.reconnectAttempts) || config.reconnectAttempts < 0 || !Number.isSafeInteger(config.reconnectDelayMs) || config.reconnectDelayMs < 1) throw new Error('Invalid ACP reconnect policy');
  const diagnosticOwner = await openDiagnostics(resolve(input.diagnosticsDirectory ?? join(config.stateDirectory, 'diagnostics')), { onConflict: 'readonly' });
  const { diagnostics } = diagnosticOwner;
  if (diagnosticOwner.mode === 'read-only') console.warn('oneagents-acp diagnostics are read-only because another instance owns the storage');
  let closeA2A: (() => Promise<void>) | undefined;
  const a2aEnabled = Boolean(input.a2a && input.a2a.enabled !== false);
  const workbench = a2aEnabled ? await resolveA2AWorkbench(input.a2a?.workbench, input.a2a?.workbenchConfigFile) : undefined;
  const processRequests = workbench ? createWorkbenchProcessClient(workbench) : undefined;
  const adapter = new AcpAdapter(ctx, config, diagnostics, processRequests);
  ctx.effect(() => ctx.llm.registerAdapter(['1agents-acp'], adapter));
  // Archiving a Session in DSH stops its work but never reaches the service daemon, where the
  // ACP process and its device capacity slot live. Sweep the Host's archive set so an archived
  // session gives its slot back at once instead of holding it until the daemon restarts.
  ctx.effect(() => {
    const interval = Number(process.env.DSH_ACP_ARCHIVE_SWEEP_MS);
    const every = Number.isFinite(interval) && interval >= 0 ? interval : 2000;
    if (every === 0) return () => undefined;
    const timer = setInterval(() => {
      // Read the live archive set rather than a captured copy; the registry mutates it in place.
      const registry = ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly unknown[] } | undefined;
      const archived = registry?.archivedSessionIds ?? [];
      if (archived.length === 0) return;
      void adapter.releaseArchivedSessions(new Set(archived.map(String)));
    }, every);
    timer.unref?.();
    return () => clearInterval(timer);
  });
  // A Cordis listener is released with this plugin's fiber.
  if (processRequests) registerNativeApprovals(ctx, processRequests);
  const nativeSessions = new NativeSessions(ctx, adapter, config);
  ctx.provide('oneagentsAcpSessions', nativeSessions);
  ctx.effect(() => async () => {
    try { await closeA2A?.(); await Promise.all([nativeSessions.dispose(), adapter.dispose()]); }
    finally { await diagnosticOwner.close(); }
  });
  const sessionDeliverHandler = createSessionDeliverHandler(ctx);
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/1agents-acp', handler: async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === SESSION_DELIVER_PATH && req.method === 'POST') {
      await sessionDeliverHandler(req, res);
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (url.pathname !== '/api/1agents-acp/session' || !['GET', 'POST'].includes(req.method!)) { res.statusCode = 404; res.end('{}'); return; }
      const id = url.searchParams.get('id');
      if (!id || id.length > 256) throw new Error('Session id required');
      const resolved = await ctx.sessionController.resolveAgent(id as SessionId);
      if ('error' in resolved) throw resolved.error;
      const agent = resolved.agent;
      if (req.method === 'GET') { res.end(JSON.stringify(await adapter.describe(agent))); return; }
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new Error('Cross-origin configuration is not allowed');
      let body = '';
      for await (const chunk of req) { body += String(chunk); if (body.length > 16384) throw new Error('Request body too large'); }
      const value = JSON.parse(body);
      if (typeof value.configId !== 'string' || typeof value.value !== 'string') throw new Error('configId and value must be strings');
      res.end(JSON.stringify(await adapter.configure(agent, value.configId, value.value)));
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  } }));
  for (const { id: agent, label } of presets) {
    const dispose = await ctx.agentPresets.register({
      id: `oneagents-acp-${agent}`,
      name: `ACP · ${label}`,
      description: `当前会话直接连接 ${agent}；切换 Agent 请新建会话。`,
      order: 20,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '', complete: true, includeRuntimeContext: false } },
        { id: 'acp-session', name: '@1agents/acp-service/dsh/preset', config: { agent } },
      ],
    });
    ctx.effect(() => dispose);
  }
  // A preset chosen on a session that is already running is composed onto its
  // live agent instead of creating one, so the route the preset proposes is
  // never recorded and the next step rejects it. Record it here.
  ctx.on('agent-preset/selected', (sessionId: SessionId, agentPreset: string) => {
    void selectAcpRoute(ctx, sessionId, agentPreset, presets.map(preset => preset.id));
  });
  if (input.a2a) {
    const a2aHost: A2AHostRef = {};
    ctx.provide('oneagentsA2aHost', a2aHost);
    const review = await ReviewHandBack.open(join(home, 'plugins', '1agents-acp', 'review.secret'), workbench);
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: REVIEW_SUBMIT_PATH, handler: review.handler }));
    ctx.effect(() => ctx.tools.register(defineTool({
      name: SUBMIT_TOOL, description: SUBMIT_DESCRIPTION,
      parameters: { summary: { type: 'string', required: true, description: SUMMARY_DESCRIPTION } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args, exec) {
        if (!exec.agent) throw new Error(`${SUBMIT_TOOL} requires an owning agent session`);
        return { message: await review.submit(exec.agent.id, args.summary) };
      },
    })));
    // The executor's task ticket lives on the gateway; native agents handle it through these tools.
    if (workbench) {
      const gateway = createTicketGateway(workbench);
      for (const tool of ticketTools(gateway)) ctx.effect(() => ctx.tools.register(tool));
      // The executor may propose the next hop. It never dispatches it; a person decides on the workbench page.
      for (const tool of handoffTools(gateway)) ctx.effect(() => ctx.tools.register(tool));
      // ACP agents call the same tools through their session's MCP server, which comes back here.
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: TICKET_PATH,
        handler: review.ticketHandler((sessionId, tool, args) => runTicketTool(gateway, sessionId, tool, args as ExecutorTicketArgs, 'mcp')) }));
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: HANDOFF_PATH,
        handler: review.handoffHandler((sessionId, tool, args) => runHandoffTool(gateway, sessionId, tool, args, 'mcp')) }));
    }
    // ACP agents reach the same hand-back and ticket tools through a per-session MCP server. It is offered to every ACP
    // session: the connection is opened once and reused, often before a turn binds the session to its A2A task or a
    // person takes it over, so the tools themselves refuse a session that has no task.
    const origin = `${(ctx.webServer as { protocol?: string }).protocol ?? 'http:'}//127.0.0.1:${ctx.webServer.port}`;
    adapter.mcpServersFor = sessionId => review.host ? [review.mcpServer(sessionId, origin)] : [];
    closeA2A = await mountDshA2A(ctx, input.a2a, join(home, 'plugins', '1agents-acp', 'a2a'), diagnostics, {
      release: sessionId => adapter.releaseSession(sessionId),
      delete: sessionId => adapter.deleteSession(sessionId),
      status: sessionId => adapter.sessionStatus(sessionId),
    }, host => { review.host = host; a2aHost.current = host; });
  }
}
