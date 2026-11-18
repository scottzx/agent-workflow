/**
 * Optional automatic archiving of silent DSH sessions.
 *
 * DSH already owns the durable archive set through `ctx.workspaceRegistry`:
 * archiving a session hides it from the workspace grouping, clears its pin and
 * gates every model step for it and its subagent descendants. This module only
 * decides *when* to call that API. It never deletes sessions or changes their
 * history, and it never archives a session that DSH currently reports as
 * pinned, so a pinned session is always archived manually by the user.
 */

import { stat } from 'node:fs/promises';

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AutoArchiveConfig {
  /** Whether the periodic sweep runs. Off by default. */
  enabled: boolean;
  /** Archive sessions silent for at least this many milliseconds. */
  inactivityMs: number;
  /** Milliseconds between two sweeps. */
  scanIntervalMs: number;
  /** Milliseconds to wait after startup before the first sweep. */
  initialDelayMs: number;
}

/** Default policy: idle for seven days, check once a day, first check a minute after startup. */
export const DEFAULT_AUTO_ARCHIVE: AutoArchiveConfig = Object.freeze({
  enabled: false,
  inactivityMs: 7 * DAY_MS,
  scanIntervalMs: DAY_MS,
  initialDelayMs: 60 * 1000,
});

/** Normalize user config while preserving the shipped defaults for absent fields. */
export function resolveAutoArchiveConfig(input: Partial<AutoArchiveConfig> | undefined): AutoArchiveConfig {
  if (input === undefined || input === null || typeof input !== 'object') return { ...DEFAULT_AUTO_ARCHIVE };
  const result = { ...DEFAULT_AUTO_ARCHIVE };
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw new Error('autoArchive.enabled must be a boolean');
    result.enabled = input.enabled;
  }
  for (const key of ['inactivityMs', 'scanIntervalMs', 'initialDelayMs'] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`autoArchive.${key} must be a positive integer`);
    }
    result[key] = value;
  }
  return result;
}

/** A candidate produced by one sweep. `lastActiveAt` is epoch milliseconds. */
export interface ArchiveCandidate {
  readonly sessionId: string;
  readonly lastActiveAt: number;
}

/** The small surface of DSH services the sweep needs. Injected for testability. */
export interface AutoArchiveHost {
  /** Session summary items with `updatedAt`, from `sessionController.list({}, signal).items`. */
  listSummaries(signal?: AbortSignal): Promise<readonly { sessionId: string; updatedAt: number }[]>;
  /** Lightweight stored-session snapshots, as returned by `sessionPersistence.list()`. */
  listStored(): Promise<readonly { header: { id: string; createdAt: number }; location?: { path: string } }[]>;
  /** Session ids the user pinned; these are never auto-archived. */
  pinnedSessionIds(): readonly string[];
  /** Session ids already archived; these need no further work. */
  archivedSessionIds(): readonly string[];
  /** Whether a session is currently attached and running work in DSH. */
  isActive?(sessionId: string): boolean;
  /** Perform the durable archive. */
  archive(sessionId: string): Promise<void>;
  /** Logger-compatible sink. */
  log?(message: string): void;
}

/**
 * Build the list of sessions that have been silent long enough to archive.
 *
 * Last activity is the later of DSH's own recency (`updatedAt`, which is the
 * session creation time or its last real user message) and the modification
 * time of the durable session file. This matches both interpretations of
 * "last activity" — the last message block and the backing file's mtime — and
 * treats a session with a newer file as active. Pinned and already-archived
 * sessions are excluded; pinned sessions stay a manual archive decision.
 *
 * @param host - minimal DSH service surface.
 * @param now - current epoch milliseconds.
 * @param inactivityMs - silence threshold in milliseconds.
 * @returns sessions to archive, newest activity first.
 */
export async function findSilentSessions(
  host: AutoArchiveHost,
  now: number,
  inactivityMs: number,
): Promise<ArchiveCandidate[]> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('now must be a non-negative safe integer');
  if (!Number.isSafeInteger(inactivityMs) || inactivityMs < 1) throw new Error('inactivityMs must be a positive integer');

  const pinned = new Set(host.pinnedSessionIds());
  const archived = new Set(host.archivedSessionIds());
  const cutoff = now - inactivityMs;
  const byId = new Map<string, number>();

  // Collect every observed activity time before applying the threshold: a
  // durable file written after the last user message must be able to lift a
  // session from the candidate set even if its summary was read first.
  const record = (sessionId: string, lastActiveAt: number): void => {
    if (pinned.has(sessionId) || archived.has(sessionId)) return;
    if (!Number.isFinite(lastActiveAt) || lastActiveAt < 0) return;
    byId.set(sessionId, Math.max(byId.get(sessionId) ?? 0, lastActiveAt));
  };

  for (const summary of await host.listSummaries()) record(summary.sessionId, summary.updatedAt);

  // A durable file written after the last user message (a tool result, a
  // title/compaction update, an imported history) still counts as activity.
  await Promise.all((await host.listStored()).map(async snapshot => {
    const { id, createdAt } = snapshot.header;
    let lastActiveAt = createdAt;
    const path = snapshot.location?.path;
    if (path !== undefined) {
      try {
        lastActiveAt = Math.max(lastActiveAt, (await stat(path)).mtimeMs);
      } catch (error) {
        // A missing or unreadable artifact must not make the session look
        // newer than the header alone says; keep the header timestamp.
        host.log?.(`auto-archive: cannot stat ${path}: ${String(error)}`);
      }
    }
    record(id, lastActiveAt);
  }));

  return [...byId.entries()]
    .filter(([, lastActiveAt]) => lastActiveAt < cutoff)
    .map(([sessionId, lastActiveAt]) => ({ sessionId, lastActiveAt }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/** Run one sweep: find silent sessions and archive them one by one. */
export async function sweepAutoArchive(
  host: AutoArchiveHost,
  now: number,
  inactivityMs: number,
): Promise<{ candidates: number; archived: string[]; failed: string[] }> {
  const candidates = await findSilentSessions(host, now, inactivityMs);
  const archived: string[] = [];
  const failed: string[] = [];
  for (const { sessionId } of candidates) {
    // A live session whose turn started after the scan began has become
    // active again; leave it to the next sweep instead of stopping its work.
    if (host.isActive?.(sessionId)) continue;
    try {
      await host.archive(sessionId);
      archived.push(sessionId);
    } catch (error) {
      failed.push(sessionId);
      host.log?.(`auto-archive: failed to archive ${sessionId}: ${String(error)}`);
    }
  }
  return { candidates: candidates.length, archived, failed };
}

/** Context surface needed for timer installation. */
export interface TimerContext {
  // DSH's Context carries host services as dynamic properties; the index
  // signature keeps this accepted by both real DSH types and host shims.
  [key: string]: unknown;
  interval?: (callback: () => void, delay: number) => () => void;
  timeout?: (callback: () => void, delay: number) => () => void;
  effect?: (callback: () => (() => void) | void) => void;
  logger?: { warn?: (...args: unknown[]) => void };
}

/**
 * Install the periodic sweep on a Cordis context.
 *
 * Uses the host's disposal-aware `ctx.interval()` when the timer plugin is
 * composed and falls back to a plain interval otherwise; either way the timer
 * is cleared when the owning plugin fiber is disposed. The first sweep is
 * delayed so a freshly started DSH does not archive sessions before its
 * workspace registry and persistence listings have settled.
 *
 * @param ctx - plugin context.
 * @param config - normalized auto-archive config.
 * @param run - one sweep; called with no arguments.
 * @returns a disposer for the installed timer(s).
 */
export function installAutoArchiveTimer(
  ctx: TimerContext,
  config: AutoArchiveConfig,
  run: () => void,
): () => void {
  const disposers: Array<() => void> = [];
  const own = (dispose: () => void): void => { disposers.push(dispose); };
  const disposeAll = (): void => {
    for (const dispose of disposers.splice(0)) {
      try { dispose(); } catch (error) { ctx.logger?.warn?.('auto-archive: timer disposal failed: %s', error); }
    }
  };
  if (!config.enabled) return disposeAll;

  let intervalDispose: (() => void) | undefined;
  const startInterval = (): void => {
    if (typeof ctx.interval === 'function') {
      intervalDispose = ctx.interval(() => { void run(); }, config.scanIntervalMs);
    } else {
      const timer = setInterval(() => { void run(); }, config.scanIntervalMs);
      // Node's timer object is disposable through its own clear method.
      intervalDispose = () => clearInterval(timer);
    }
    own(intervalDispose);
  };
  if (typeof ctx.timeout === 'function') {
    own(ctx.timeout(() => { startInterval(); void run(); }, config.initialDelayMs));
  } else {
    const startTimer = setTimeout(() => { startInterval(); void run(); }, config.initialDelayMs);
    own(() => clearTimeout(startTimer));
  }
  // Keep the timer owned by this fiber even when the host mixes timer methods
  // onto a shared context; the plugin effect will dispose it on unload.
  ctx.effect?.(() => disposeAll);
  return disposeAll;
}
