/** Installable Cordis bundle. Uses only existing Host services and preset registrations. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { openDiagnostics } from './diagnostics.js';
import { AcpAdapter, ensureLlmError, validateSessionPolicies, type Config } from './adapter.js';
import { discoverPresets } from './discovery.js';
import { NativeSessions } from './imports.js';
import { acquireService, resolveServiceOptions, type ServiceOptions } from './service-process.js';
import { mountDshA2A, resolveA2AWorkbench, type A2AHostRef, type DshA2AOptions } from './a2a.js';
import { createWorkbenchProcessClient } from './process-requests.js';
import { selectAcpRoute } from './preset-route.js';
import { registerNativeApprovals } from './native-approvals.js';
import type {} from '@deepseek-ai/dsh-tools';
import type { ExecutorTicketArgs } from '@1agents/acp-service/a2a';
import { REVIEW_SUBMIT_PATH, ReviewHandBack, SUBMIT_DESCRIPTION, SUBMIT_TOOL, SUMMARY_DESCRIPTION } from './review.js';
import { ROLE_RULES_PATH } from './role-rules-spec.js';
import { readSessionRoleRules } from './role-rules-session.js';
import { createTicketGateway, runTicketTool, ticketTools } from './ticket-tools.js';
import { HANDOFF_PATH } from './handoff-spec.js';
import { syncGlobalAcpService } from './sync-global.js';
import { handoffTools } from './handoff-tools.js';
import { runHandoffTool } from './handoff-executor.js';
import { TICKET_PATH } from './ticket-spec.js';
import { createSessionDeliverHandler, SESSION_DELIVER_PATH } from './session-notice.js';
import { registerRowConfigRpc } from './row-config.js';
import { loadDshTools } from './host-runtime.js';
export type { DshA2AOptions } from './a2a.js';

/** Kept identical to packages/service/src/dsh.ts. Do not re-export them from the package root: that cycle breaks HMR. */
export const name = 'oneagents-acp';
export const inject = ['llm', 'agents', 'approval', 'userQuestions', 'commands', 'sessionProjections', 'webServer', 'sessionController', 'agentPresets', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'tools', 'connection'];

type Stop = () => void | Promise<void>;

export async function apply(ctx: Context, input: Partial<Config & ServiceOptions> & { a2a?: DshA2AOptions; diagnosticsDirectory?: string } = {}): Promise<void> {
  registerRowConfigRpc(ctx);
  // One plugin install updates the global acp-service CLI. A failure must not stop DSH.
  try {
    const synced = await syncGlobalAcpService();
    if (synced.updated) console.log(`acp-service global CLI updated ${synced.from ?? '(none)'} -> ${synced.version}`);
  } catch (error) { console.warn(`acp-service global CLI was not updated: ${error instanceof Error ? error.message : String(error)}`); }
  // Host classes are cached before any tool or adapter error is constructed.
  await ensureLlmError();
  const { defineTool } = await loadDshTools();
  const homePath = ctx.get('dshHomePath') as ((...parts: string[]) => string) | undefined;
  const home = homePath ? homePath() : process.env.DSH_HOME || join(homedir(), '.dsh');
  const service = resolveServiceOptions(input);
  const { serviceUrl } = service;
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
  let releaseService: Stop = async () => {};
  const stops: Stop[] = [];
  let armed = false;
  const rollback = async () => {
    for (const stop of [...stops].reverse()) {
      try { await stop(); } catch { /* A failed start still has to drop every registration it made. */ }
    }
    try { await releaseService(); } finally { await diagnosticOwner.close(); }
  };
  try {
    releaseService = await acquireService(service);
    const a2aEnabled = Boolean(input.a2a && input.a2a.enabled !== false);
    const workbench = a2aEnabled ? await resolveA2AWorkbench(input.a2a?.workbench, input.a2a?.workbenchConfigFile) : undefined;
    const processRequests = workbench ? createWorkbenchProcessClient(workbench) : undefined;
    const adapter = new AcpAdapter(ctx, config, diagnostics, processRequests);
    const track = (dispose: unknown) => { if (typeof dispose === 'function') stops.push(dispose as Stop); };
    track(ctx.llm.registerAdapter(['1agents-acp'], adapter));
    // Archiving a Session in DSH stops its work but never reaches the service daemon, where the
    // ACP process and its device capacity slot live. Sweep the Host's archive set so an archived
    // session gives its slot back at once instead of holding it until the daemon restarts.
    const interval = Number(process.env.DSH_ACP_ARCHIVE_SWEEP_MS);
    const every = Number.isFinite(interval) && interval >= 0 ? interval : 2000;
    if (every !== 0) {
      const timer = setInterval(() => {
        const registry = ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly unknown[] } | undefined;
        const archived = registry?.archivedSessionIds ?? [];
        if (archived.length === 0) return;
        void adapter.releaseArchivedSessions(new Set(archived.map(String)));
      }, every);
      timer.unref?.();
      stops.push(() => clearInterval(timer));
    }
    if (processRequests) track(registerNativeApprovals(ctx, processRequests));
    const nativeSessions = new NativeSessions(ctx, adapter, config);
    ctx.provide('oneagentsAcpSessions', nativeSessions);
    const sessionDeliverHandler = createSessionDeliverHandler(ctx);
    track(ctx.webServer.register({ kind: 'prefix', path: '/api/1agents-acp', handler: async (req, res) => {
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
      track(await ctx.agentPresets.register({
        id: `oneagents-acp-${agent}`,
        name: `ACP · ${label}`,
        description: `当前会话直接连接 ${agent}；切换 Agent 请新建会话。`,
        order: 20,
        plugins: [
          { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '', complete: true, includeRuntimeContext: false } },
          { id: 'acp-session', name: '@1agents/acp-service/dsh/preset', config: { agent } },
        ],
      }));
    }
    // A preset chosen on a session that is already running is composed onto its
    // live agent instead of creating one, so the route the preset proposes is
    // never recorded and the next step rejects it. Record it here.
    track(ctx.on('agent-preset/selected', (sessionId: SessionId, agentPreset: string) => {
      void selectAcpRoute(ctx, sessionId, agentPreset, presets.map(preset => preset.id));
    }));
    let review: ReviewHandBack | undefined;
    let a2aHost: A2AHostRef | undefined;
    let closeA2A: () => Promise<void> = async () => {};
    if (input.a2a) {
      a2aHost = {};
      ctx.provide('oneagentsA2aHost', a2aHost);
      review = await ReviewHandBack.open(join(home, 'plugins', '1agents-acp', 'review.secret'), workbench);
      track(ctx.webServer.register({ kind: 'exact', path: REVIEW_SUBMIT_PATH, handler: review.handler }));
      track(ctx.webServer.register({ kind: 'exact', path: ROLE_RULES_PATH,
        handler: review.roleRulesHandler((sessionId, args) => readSessionRoleRules({
          sessionId,
          roleId: args.roleId,
          ...(args.phase ? { phase: args.phase } : {}),
          resolveAgent: id => ctx.sessionController.resolveAgent(id as SessionId),
        })) }));
      track(ctx.tools.register(defineTool({
        name: SUBMIT_TOOL, description: SUBMIT_DESCRIPTION,
        parameters: { summary: { type: 'string', required: true, description: SUMMARY_DESCRIPTION } },
        output: { schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.message }] },
        async execute(args, exec) {
          if (!exec.agent) throw new Error(`${SUBMIT_TOOL} requires an owning agent session`);
          return { message: await review!.submit(exec.agent.id, args.summary) };
        },
      })));
      if (workbench) {
        const gateway = createTicketGateway(workbench);
        for (const tool of ticketTools(gateway, defineTool)) track(ctx.tools.register(tool));
        for (const tool of handoffTools(gateway, defineTool)) track(ctx.tools.register(tool));
        track(ctx.webServer.register({ kind: 'exact', path: TICKET_PATH,
          handler: review.ticketHandler((sessionId, tool, args) => runTicketTool(gateway, sessionId, tool, args as ExecutorTicketArgs, 'mcp')) }));
        track(ctx.webServer.register({ kind: 'exact', path: HANDOFF_PATH,
          handler: review.handoffHandler((sessionId, tool, args) => runHandoffTool(gateway, sessionId, tool, args, 'mcp')) }));
      }
      const origin = `${(ctx.webServer as { protocol?: string }).protocol ?? 'http:'}//127.0.0.1:${ctx.webServer.port}`;
      adapter.mcpServersFor = sessionId => review?.host ? [review.mcpServer(sessionId, origin)] : [];
      // bindEffect false: this fiber's single disposer below owns A2A close. A second
      // ctx.effect would race it, because Cordis unloads sibling effects concurrently.
      const mountedReview = review;
      const mountedHost = a2aHost;
      closeA2A = await mountDshA2A(ctx, input.a2a, join(home, 'plugins', '1agents-acp', 'a2a'), diagnostics, {
        release: sessionId => adapter.releaseSession(sessionId),
        delete: sessionId => adapter.deleteSession(sessionId),
        status: sessionId => adapter.sessionStatus(sessionId),
      }, host => { mountedReview.host = host; mountedHost.current = host; }, false);
    }
    // One effect, disposed as a single awaited chain. Sibling ctx.effect() calls run
    // concurrently on fiber unload and can release a DirectoryLease while the next
    // hot reload is already trying to take it.
    ctx.effect(() => async () => {
      const errors: unknown[] = [];
      for (const stop of [...stops].reverse()) {
        try { await stop(); } catch (error) { errors.push(error); }
      }
      if (review) review.host = undefined;
      if (a2aHost) a2aHost.current = undefined;
      try {
        await closeA2A();
        await nativeSessions.dispose();
        await adapter.dispose();
      } finally {
        try { await diagnosticOwner.close(); }
        finally { await releaseService(); }
      }
      if (errors.length) throw errors[0];
    });
    armed = true;
  } catch (error) {
    if (!armed) await rollback();
    throw error;
  }
}
