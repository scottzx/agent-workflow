/** Mount the shared A2A implementation on the current DSH web host. */
import { createA2AServer, type A2AServerOptions } from '@1agents/acp-service/a2a';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { Diagnostics } from './diagnostics.js';
import { DshA2ABackend, type SessionControl } from './a2a-executor.js';

/** Optional host configuration; omitted configuration leaves A2A disabled. */
export interface DshA2AOptions extends Omit<A2AServerOptions, 'backend' | 'token' | 'stateDirectory' | 'publicUrl'> {
  enabled?: boolean;
  token?: string;
  /** Defaults to DSH_A2A_TOKEN; host credentials are never copied into tasks. */
  tokenEnv?: string;
  stateDirectory?: string;
  /** Public DSH origin, for example its Tailscale URL. */
  publicUrl?: string;
  /** Gateway workbench that records questions and plan approvals for this host's A2A turns. */
  workbench?: { url: string; token?: string };
}

/** Routes and in-flight turns are released with the owning Cordis plugin. */
export async function mountDshA2A(ctx: Context, options: DshA2AOptions, stateDirectory: string, diagnostics?: Diagnostics, sessions?: SessionControl): Promise<() => Promise<void>> {
  if (options.enabled === false) return async () => {};
  const token = options.token ?? process.env[options.tokenEnv ?? 'DSH_A2A_TOKEN'];
  if (!token) throw new Error('Set DSH_A2A_TOKEN or a2a.token before enabling DSH A2A');
  let close = async () => {};
  await ctx.effect(async () => {
    const { workbench: _workbench, ...serverOptions } = options;
    const server = await createA2AServer({ ...serverOptions, token, backend: new DshA2ABackend(ctx, diagnostics, sessions),
      stateDirectory: options.stateDirectory ?? stateDirectory,
      publicUrl: options.publicUrl ?? `http://127.0.0.1:${ctx.webServer.port}` });
    const routes: (() => void)[] = [];
    try {
      routes.push(ctx.webServer.register({ kind: 'exact', path: '/.well-known/agent-card.json', handler: server.cardHandler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: server.path, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/preflight`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/sessions/close`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/sessions/status`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/sessions/delete`, handler: server.handler }));
    } catch (error) {
      for (const dispose of routes.reverse()) dispose();
      await server.close();
      throw error;
    }
    let closing: Promise<void> | undefined;
    close = () => closing ??= (async () => {
      for (const dispose of routes.reverse()) dispose();
      await server.close();
    })();
    return close;
  });
  return close;
}
