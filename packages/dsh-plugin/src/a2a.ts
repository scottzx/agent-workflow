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
  expose?: (host: A2AHostControls | undefined) => void): Promise<() => Promise<void>> {
  if (options.enabled === false) return async () => {};
  const token = await resolveA2AToken(options);
  if (!token) throw new Error('Set DSH_A2A_TOKEN, a2a.token, or a2a.tokenFile before enabling DSH A2A');
  let close = async () => {};
  await ctx.effect(async () => {
    const { workbench: _workbench, workbenchConfigFile: _workbenchConfigFile, tokenFile: _tokenFile, ...serverOptions } = options;
    const server = await createA2AServer({ ...serverOptions, token, backend: new DshA2ABackend(ctx, diagnostics, sessions),
      stateDirectory: options.stateDirectory ?? stateDirectory,
      publicUrl: options.publicUrl ?? `http://127.0.0.1:${ctx.webServer.port}`,
      storage: { onConflict: 'readonly' } });
    if (server.mode === 'read-only') console.warn('oneagents-acp A2A storage is read-only because another instance owns it');
    const routes: (() => void)[] = [];
    try {
      routes.push(ctx.webServer.register({ kind: 'exact', path: '/.well-known/agent-card.json', handler: server.cardHandler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: server.path, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/preflight`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/model-catalog`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/sessions/close`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/sessions/status`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/sessions/delete`, handler: server.handler }));
      routes.push(ctx.webServer.register({ kind: 'exact', path: `${server.path}/artifacts/content`, handler: server.handler }));
    } catch (error) {
      for (const dispose of routes.reverse()) dispose();
      await server.close();
      throw error;
    }
    let closing: Promise<void> | undefined;
    expose?.({ sessionTask: server.sessionTask, taskSession: server.taskSession, resubmit: server.resubmit });
    close = () => closing ??= (async () => {
      expose?.(undefined);
      for (const dispose of routes.reverse()) dispose();
      await server.close();
    })();
    return close;
  });
  return close;
}
