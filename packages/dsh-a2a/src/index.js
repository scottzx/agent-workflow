/** DSH-only A2A service; runtime launch is independent of ACP. */
export { startA2AService } from './server.js';
export { HeadlessDshBackend } from './executor.js';
export { createHostWorkbench, WORKBENCH_UI_PATH } from './host-workbench.js';
import { startA2AService } from './server.js';
import { createHostWorkbench, WORKBENCH_UI_PATH } from './host-workbench.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dshSkillsDirectory, installAcpSkill, packagedSkillDirectory, packagedVersion } from './install-skill.js';

export const name = 'oneagents-dsh-a2a';
// `webServer` hosts the workbench page on the GUI origin; `connection` admits the
// owner's browser to it. Without the declaration Cordis may apply this bundle
// before those services exist, which is what produced a blank workbench panel.
export const inject = ['webServer', 'connection'];

/** Resolve `workbench` credentials from the gateway config file, as the standalone listener does. */
async function resolveWorkbench(workbench, workbenchConfigFile) {
  if (!workbenchConfigFile) return workbench;
  const fileInfo = await stat(workbenchConfigFile);
  if ((fileInfo.mode & 0o077) !== 0) throw new Error('Workbench config file must not be accessible by group or other users');
  const gateway = JSON.parse(await readFile(workbenchConfigFile, 'utf8'));
  const resolved = { ...(workbench ?? {}) };
  if (resolved.url) resolved.token = gateway.workbench?.token;
  resolved.pageRelaySecret ??= gateway.workbench?.pageRelaySecret;
  return resolved;
}

export async function apply(ctx, config = {}) {
  const { hostWorkbench, port, ...serviceConfig } = config;
  const enableHost = hostWorkbench !== false;

  // The host consumes both entries through `ctx.webServer`. Register `/workbench/ui`
  // before non-critical skill installation so the sidebar panel can detect it promptly.
  // A profile that only embeds the workbench page does not need a second listener, so
  // `port: false` skips the standalone service.
  if (enableHost) {
    const workbench = await resolveWorkbench(serviceConfig.workbench, serviceConfig.workbenchConfigFile);
    const handler = createHostWorkbench({
      workbench,
      // Absent only on a host without browser sessions; the page then trusts the host.
      admit: ctx.connection?.admit ? req => ctx.connection.admit(req) : undefined,
    });
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: WORKBENCH_UI_PATH, handler }));
  }

  try {
    const version = packagedVersion(import.meta.url);
    const placed = await installAcpSkill({ source: packagedSkillDirectory(import.meta.url), skillsDirectory: dshSkillsDirectory(), version });
    if (!placed.installed && placed.reason !== 'current') {
      console.error(`[dsh-a2a] ACP skill was not installed: ${placed.reason}`);
    }
  } catch (error) {
    console.error(`[dsh-a2a] ACP skill was not installed: ${error instanceof Error ? error.message : error}`);
  }

  if (port === false) return;

  await ctx.effect(async () => {
    try {
      const service = await startA2AService({ ...serviceConfig, port: port ?? 3080 });
      return () => service.close();
    } catch (error) {
      // A2A storage admits one writer. A second DSH instance (another profile, or a
      // desktop and a web host at once) reaches this point; the workbench page this
      // plugin already mounted stays usable, so only the standalone listener is lost.
      if (!isStorageBusy(error)) throw error;
      const owner = await storageOwner(serviceConfig.stateDirectory);
      console.error(`[dsh-a2a] A2A listener skipped: storage is held by pid ${owner ?? 'another process'}. `
        + 'Set a distinct stateDirectory for this profile to run its own listener.');
      return () => {};
    }
  });
}

/** The shared A2A store reports a lost lease with this exact message. */
function isStorageBusy(error) {
  return error instanceof Error && error.message === 'A2A storage directory is already in use by another instance';
}

/** Best-effort owner pid for the diagnostic; the lock layout is the store's own. */
async function storageOwner(stateDirectory) {
  if (!stateDirectory) return undefined;
  try {
    const directory = join(stateDirectory, '.lock');
    for (const name of await readdir(directory)) {
      const lock = JSON.parse(await readFile(join(directory, name), 'utf8'));
      if (typeof lock.pid === 'number') return lock.pid;
    }
  } catch { /* the lock may already be gone; the caller only logs it */ }
  return undefined;
}
