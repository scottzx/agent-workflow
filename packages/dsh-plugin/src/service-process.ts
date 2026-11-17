/** Own local ACP service processes; existing and remote servers keep their external owner. */
import { execFile } from 'node:child_process';
import { fork } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ServiceOptions {
  serviceUrl: string;
  /**
   * `external`: connect only; the daemon has its own owner.
   * `auto`: connect, or fork a child that this host owns and stops on dispose.
   * `launchd`: connect, or wake a registered service manager that keeps the process
   *            alive on its own; this host never owns or stops it.
   */
  serviceMode: 'auto' | 'external' | 'launchd';
  serviceStartupTimeoutMs: number;
  serviceShutdownTimeoutMs: number;
  /** Service manager label woken in `launchd` mode. */
  serviceManagerLabel: string;
}
interface Lease { users: number; ready: Promise<() => Promise<void>>; closing?: Promise<void> }
const leases = new Map<string, Lease>();

const MODES = ['auto', 'external', 'launchd'];
/** launchd labels are reverse-DNS-ish; keep this strict because it reaches launchctl. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate lifecycle options before any process or connection is created. */
export function resolveServiceOptions(input: Partial<ServiceOptions>): ServiceOptions {
  const result = {
    serviceUrl: input.serviceUrl ?? 'http://127.0.0.1:36812',
    // The ACP daemon is a shared local service. Host plugins connect to it by default;
  // per-host child ownership remains available only through the explicit `auto` mode.
  serviceMode: input.serviceMode ?? 'external',
    serviceStartupTimeoutMs: input.serviceStartupTimeoutMs ?? 15_000,
    serviceShutdownTimeoutMs: input.serviceShutdownTimeoutMs ?? 5_000,
    serviceManagerLabel: input.serviceManagerLabel ?? 'com.1agents.acp-service',
  };
  const url = new URL(result.serviceUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('serviceUrl must use http or https');
  if (!MODES.includes(result.serviceMode)) throw new Error(`serviceMode must be one of ${MODES.join(', ')}`);
  if (!LABEL.test(result.serviceManagerLabel)) throw new Error('serviceManagerLabel must be a plain launchd label');
  for (const value of [result.serviceStartupTimeoutMs, result.serviceShutdownTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('ACP service timeouts must be integers between 1 and 2147483647');
  }
  if (url.port === '0') throw new Error('serviceUrl needs a stable, nonzero port for saved sessions');
  return result;
}

function refused(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(refused);
  if ('code' in error && error.code === 'ECONNREFUSED') return true;
  return 'cause' in error && refused(error.cause);
}

async function running(url: URL, timeout: number): Promise<boolean> {
  let response: Response;
  try { response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(timeout), redirect: 'error' }); }
  catch (error) { if (refused(error)) return false; throw new Error(`ACP health check failed at ${url.origin}`, { cause: error }); }
  if (!response.ok) throw new Error(`ACP health check failed: HTTP ${response.status} at ${url.origin}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('service' in body) || body.service !== 'acp-service' || !('status' in body) || body.status !== 'ok') {
    throw new Error(`The listener at ${url.origin} is not a healthy ACP service`);
  }
  return true;
}

/**
 * Wake a service manager that owns the process, then wait for it to answer.
 *
 * The host only asks for the service to exist; the manager keeps it alive and
 * restarts it, so this host's exit never stops it. Nothing here is recorded for
 * shutdown, which is what separates this from `auto`.
 */
async function wake(options: ServiceOptions, url: URL): Promise<() => Promise<void>> {
  if (await running(url, options.serviceStartupTimeoutMs)) return async () => {};
  const domain = `gui/${process.getuid?.() ?? ''}`;
  const target = `${domain}/${options.serviceManagerLabel}`;
  // `kickstart` only reaches a service the domain already knows. An installed but
  // unloaded agent still has its plist, so bootstrap it first and kickstart after.
  const started = await execFileAsync('launchctl', ['kickstart', '-p', target], { timeout: options.serviceStartupTimeoutMs })
    .then(() => true, () => false);
  if (!started && !await bootstrap(options, domain)) {
    throw new Error(`ACP service manager ${options.serviceManagerLabel} is neither running nor loadable; install its launchd plist first`);
  }
  // A manager may report success before the port is accepting; poll until healthy.
  const deadline = Date.now() + options.serviceStartupTimeoutMs;
  for (;;) {
    try { if (await running(url, Math.max(1_000, deadline - Date.now()))) return async () => {}; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    if (Date.now() >= deadline) throw new Error(`ACP service at ${url.origin} did not become healthy after the service manager started`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** Load the agent from the user's LaunchAgents directory; false when no plist is installed. */
async function bootstrap(options: ServiceOptions, domain: string): Promise<boolean> {
  const home = process.env.HOME;
  if (!home) return false;
  const plist = `${home}/Library/LaunchAgents/${options.serviceManagerLabel}.plist`;
  try { await access(plist); } catch { return false; }
  const loaded = await execFileAsync('launchctl', ['bootstrap', domain, plist], { timeout: options.serviceStartupTimeoutMs })
    .then(() => true, () => false);
  // Bootstrap can report failure for an agent that is already loaded; kickstart decides.
  await execFileAsync('launchctl', ['kickstart', '-p', `${domain}/${options.serviceManagerLabel}`], { timeout: options.serviceStartupTimeoutMs })
    .catch(() => {});
  return loaded || await running(new URL(options.serviceUrl), 2_000).catch(() => false);
}

async function start(options: ServiceOptions, url: URL): Promise<() => Promise<void>> {
  if (await running(url, options.serviceStartupTimeoutMs)) return async () => {};
  const child = fork(fileURLToPath(new URL('./service-worker.js', import.meta.url)), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let ended = false;
  child.once('error', error => ready.reject(error));
  child.once('close', (code, signal) => {
    ended = true;
    ready.reject(new Error(`Managed ACP service exited (${signal ?? code})`));
    closed.resolve();
  });
  child.on('message', message => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if (message.type === 'ready') ready.resolve();
    if (message.type === 'error' && 'message' in message && typeof message.message === 'string') ready.reject(new Error(message.message));
  });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    if (ended) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), options.serviceShutdownTimeoutMs);
    try { await closed.promise; } finally { clearTimeout(timer); }
  })();
  const timer = setTimeout(() => ready.reject(new Error(`ACP service startup timed out after ${options.serviceStartupTimeoutMs}ms`)), options.serviceStartupTimeoutMs);
  child.send({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80), shutdownTimeoutMs: options.serviceShutdownTimeoutMs }, error => { if (error) ready.reject(error); });
  try {
    await ready.promise;
    if (!await running(url, options.serviceStartupTimeoutMs)) throw new Error('ACP service exited during startup');
    return stop;
  } catch (error) {
    await stop();
    throw error;
  } finally { clearTimeout(timer); }
}

/** Acquire a shared local process lease; release waits for owned process exit, never kills an existing server. */
export async function acquireService(options: ServiceOptions): Promise<() => Promise<void>> {
  const url = new URL(options.serviceUrl);
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if (options.serviceMode === 'external' || !local) return async () => {};
  const key = url.origin;
  let lease = leases.get(key);
  if (lease?.closing) { await lease.closing; return acquireService(options); }
  if (!lease) {
    // `launchd` wakes the manager once per origin too; its release is a no-op, so
    // sharing one lease never hands the process to this host.
    lease = { users: 0, ready: options.serviceMode === 'launchd' ? wake(options, url) : start(options, url) };
    leases.set(key, lease);
  }
  lease.users++;
  let stop: () => Promise<void>;
  try { stop = await lease.ready; }
  catch (error) { if (--lease.users === 0) leases.delete(key); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (--lease.users !== 0) return;
    lease.closing = stop();
    try { await lease.closing; } finally { if (leases.get(key) === lease) leases.delete(key); }
  };
}
