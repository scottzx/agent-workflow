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
import { mountDshA2A, type DshA2AOptions } from './a2a.js';
export type { DshA2AOptions } from './a2a.js';
export { name, inject } from '@1agents/acp-service';
export async function apply(ctx: Context, input: Partial<Config & ServiceOptions> & { a2a?: DshA2AOptions; diagnosticsDirectory?: string } = {}): Promise<void> {
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
  const diagnosticOwner = await openDiagnostics(resolve(input.diagnosticsDirectory ?? join(config.stateDirectory, 'diagnostics')));
  const { diagnostics } = diagnosticOwner;
  let closeA2A: (() => Promise<void>) | undefined;
  const adapter = new AcpAdapter(ctx, config, diagnostics);
  ctx.effect(() => ctx.llm.registerAdapter(['1agents-acp'], adapter));
  const nativeSessions = new NativeSessions(ctx, adapter, config);
  ctx.provide('oneagentsAcpSessions', nativeSessions);
  ctx.effect(() => async () => {
    try { await closeA2A?.(); await Promise.all([nativeSessions.dispose(), adapter.dispose()]); }
    finally { await diagnosticOwner.close(); }
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/1agents-acp', handler: async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url!, 'http://localhost');
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
  if (input.a2a) closeA2A = await mountDshA2A(ctx, input.a2a, join(home, 'plugins', '1agents-acp', 'a2a'), diagnostics, {
    release: sessionId => adapter.releaseSession(sessionId),
    delete: sessionId => adapter.deleteSession(sessionId),
    status: sessionId => adapter.sessionStatus(sessionId),
  });
}
