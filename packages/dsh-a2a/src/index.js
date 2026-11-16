/** DSH-only A2A service; runtime launch is independent of ACP. */
export { startA2AService } from './server.js';
export { HeadlessDshBackend } from './executor.js';
export { createHostWorkbench, WORKBENCH_UI_PATH } from './host-workbench.js';
import { startA2AService } from './server.js';
import { createHostWorkbench, WORKBENCH_UI_PATH } from './host-workbench.js';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dshSkillsDirectory, installAcpSkill, packagedSkillDirectory } from './install-skill.js';

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
  try {
    const packageJson = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    const placed = await installAcpSkill({ source: packagedSkillDirectory(), skillsDirectory: dshSkillsDirectory(), version: packageJson.version });
    if (!placed.installed && placed.reason !== 'current') {
      console.error(`[dsh-a2a] ACP skill was not installed: ${placed.reason}`);
    }
  } catch (error) {
    console.error(`[dsh-a2a] ACP skill was not installed: ${error instanceof Error ? error.message : error}`);
  }
  const enableHost = hostWorkbench !== false;

  // The host consumes both entries through `ctx.webServer`. A profile that only
  // embeds the workbench page does not need a second listener, so `port: false`
  // skips the standalone service.
  if (enableHost) {
    const workbench = await resolveWorkbench(serviceConfig.workbench, serviceConfig.workbenchConfigFile);
    const handler = createHostWorkbench({
      workbench,
      // Absent only on a host without browser sessions; the page then trusts the host.
      admit: ctx.connection?.admit ? req => ctx.connection.admit(req) : undefined,
    });
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: WORKBENCH_UI_PATH, handler }));
  }

  if (port === false) return;

  await ctx.effect(async () => {
    const service = await startA2AService({ ...serviceConfig, port: port ?? 3080 });
    return () => service.close();
  });
}
