/** Mount the shared A2A implementation on the current DSH web host. */
import { readFile, stat } from 'node:fs/promises';
import { createA2AServer, type A2AServerOptions } from '@1agents/acp-service/a2a';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { DiagnosticLog } from './diagnostics.js';
import { DshA2ABackend, type SessionControl } from './a2a-executor.js';

/** Optional host configuration; omitted configuration leaves A2A disabled. */
export interface DshA2AOptions extends Omit<A2AServerOptions, 'backend' | 'token' | 'stateDirectory' | 'publicUrl'> {
  enabled?: boolean;
  token?: string;
  /** Defaults to DSH_A2A_TOKEN; host credentials are never copied into tasks. */
  tokenEnv?: string;
  /** 0600 file holding the bearer token so profile YAML never inlines secrets. */
  tokenFile?: string;
  stateDirectory?: string;
  /** Public DSH origin, for example its Tailscale URL or shared loopback port. */
  publicUrl?: string;
  /** Gateway workbench that records questions and plan approvals for this host's A2A turns.
   * `pageRelaySecret` matches the gateway's workbench.pageRelaySecret so this host's page can publish and decide reviews. */
  workbench?: { url: string; token?: string; pageRelaySecret?: string };
  /** 0600 gateway config JSON from which `workbench.token` and `pageRelaySecret` can be loaded. */
  workbenchConfigFile?: string;
}

/** In-process takeover controls of the mounted host; absent while A2A is disabled or closed. */
export type A2AHostControls = Pick<Awaited<ReturnType<typeof createA2AServer>>, 'sessionTask' | 'taskSession' | 'resubmit'>;

/** Live reference shared via Cordis so `/workbench/ui` can resolve in-process A2A sessions. */
export interface A2AHostRef {
  current?: A2AHostControls;
}

declare module '@deepseek-ai/cordis' {
  interface Context { oneagentsA2aHost?: A2AHostRef }
}

export async function resolveA2AToken(options: Pick<DshA2AOptions, 'token' | 'tokenEnv' | 'tokenFile'>): Promise<string | undefined> {
  const direct = options.token ?? process.env[options.tokenEnv ?? 'DSH_A2A_TOKEN'];
  if (direct) return direct;
  if (!options.tokenFile) return undefined;
  const info = await stat(options.tokenFile);
  if ((info.mode & 0o077) !== 0) throw new Error('A2A token file must not be accessible by group or other users');
  const raw = await readFile(options.tokenFile, 'utf8');
  const token = raw.trim();
  if (!token || Buffer.byteLength(raw) > 4096) throw new Error('A2A token file is empty or exceeds 4096 bytes');
  return token;
}

export async function resolveA2AWorkbench(
  workbench: DshA2AOptions['workbench'],
  workbenchConfigFile?: string,
): Promise<DshA2AOptions['workbench']> {
  if (!workbenchConfigFile) return workbench;
  const info = await stat(workbenchConfigFile);
  if ((info.mode & 0o077) !== 0) throw new Error('Workbench config file must not be accessible by group or other users');
  const gateway = JSON.parse(await readFile(workbenchConfigFile, 'utf8')) as {
    workbench?: { token?: string; pageRelaySecret?: string };
  };
  if (!workbench) return undefined;
  const resolved = { ...workbench };
  if (resolved.url && resolved.token === undefined && gateway.workbench?.token !== undefined) {
    resolved.token = gateway.workbench.token;
  }
  if (resolved.pageRelaySecret === undefined && gateway.workbench?.pageRelaySecret !== undefined) {
    resolved.pageRelaySecret = gateway.workbench.pageRelaySecret;
  }
  return resolved;
}

/** Routes and in-flight turns are released with the owning Cordis plugin. */
export async function mountDshA2A(ctx: Context, options: DshA2AOptions, stateDirectory: string, diagnostics?: DiagnosticLog, sessions?: SessionControl,
  expose?: (host: A2AHostControls | undefined) => void, bindEffect = true): Promise<() => Promise<void>> {
  if (options.enabled === false) return async () => {};
  const token = await resolveA2AToken(options);
  if (!token) throw new Error('Set DSH_A2A_TOKEN, a2a.token, or a2a.tokenFile before enabling DSH A2A');
  let close = async () => {};
  const start = async () => {
    const { workbench: _workbench, workbenchConfigFile: _workbenchConfigFile, tokenFile: _tokenFile, ...serverOptions } = options;
    const server = await createA2AServer({ ...serverOptions, token, backend: new DshA2ABackend(ctx, diagnostics, sessions),
      stateDirectory: options.stateDirectory ?? stateDirectory,
      publicUrl: options.publicUrl ?? `http://127.0.0.1:${ctx.webServer.port}`,
      storage: { onConflict: 'readonly' } });
    if (server.mode === 'read-only') console.warn('oneagents-acp A2A storage is read-only because another instance owns it');
    const routes: (() => void)[] = [];
    /**
     * Unregister every route. One failing disposer must not skip the others: the
     * A2A storage lease is only released by server.close(), and a route left
     * registered would answer requests for a plugin that is already gone.
     */
    const releaseRoutes = (): unknown[] => {
      const errors: unknown[] = [];
      for (const dispose of [...routes].reverse()) {
        try { dispose(); } catch (error) { errors.push(error); }
      }
      routes.length = 0;
      return errors;
    };
    const failures: unknown[] = [];
    try {
      routes.push(ctx.webServer.register({ kind: 'exact', path: '/.well-known/agent-card.json', handler: server.cardHandler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: server.path, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/preflight`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/model-catalog`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/sessions/close`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/sessions/status`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/sessions/delete`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/artifacts/content`, handler: server.handler }));
      expose?.({ sessionTask: server.sessionTask, taskSession: server.taskSession, resubmit: server.resubmit });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      failures.push(...releaseRoutes());
      // The storage lease lives on the server, so it is released even when the
      // route registration failed halfway.
      try { await server.close(); } catch (error) { failures.push(error); }
      throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'A2A mount failed');
    }
    let closing: Promise<void> | undefined;
    close = () => closing ??= (async () => {
      const errors: unknown[] = [];
      try { expose?.(undefined); } catch (error) { errors.push(error); }
      errors.push(...releaseRoutes());
      // server.close() releases the A2A DirectoryLease. It must run even when a
      // route disposer threw, or the next hot reload degrades to read-only.
      try { await server.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'A2A close failed');
    })();
    return close;
  };
  if (!bindEffect) {
    await start();
    return close;
  }
  await ctx.effect(start);
  return close;
}
