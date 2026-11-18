/**
 * Manual archiving of silent DSH sessions.
 *
 * DSH owns the durable archive set: archiving a session hides it from the
 * workspace grouping and stops every model step for it and its subagent
 * descendants. This module only decides *which* sessions to hand to that
 * API. It never deletes sessions or their logs, and a pinned session stays a
 * manual decision unless the caller explicitly opts in.
 *
 * The work runs against a live DSH Host over its Typert RPC, because the
 * workspace registry keeps its state in memory: writing the storage file
 * behind a running Host would be overwritten by its next write.
 */

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** A session as the Host reports it. */
export interface DshSessionSummary {
  readonly sessionId: string;
  /** Epoch milliseconds of the session's last recorded activity. */
  readonly updatedAt: number;
  readonly cwd?: string;
  readonly running?: boolean;
  readonly blank?: boolean;
  readonly agentAvailable?: boolean;
  readonly parentSessionId?: string;
  readonly origin?: string;
  readonly projections?: { readonly values?: { readonly title?: string } };
}

/** The registry sets the CLI reads and writes. */
export interface ArchiveRegistryState {
  readonly archivedSessionIds: readonly string[];
  readonly pinnedSessionIds: readonly string[];
}

/** The live Host calls the archive pass needs. */
export interface DshArchiveClient {
  /** Every session the Host can see, live or persisted. */
  listSessions(): Promise<readonly DshSessionSummary[]>;
  /** The registry's current archive and pin sets. */
  readRegistry(): Promise<ArchiveRegistryState>;
  /** Ask the Host to archive one session. */
  archiveSession(sessionId: string, options: { readonly stopActivity: boolean }): Promise<void>;
}

/** How the pass selects its targets. */
export interface ArchivePlanOptions {
  /** Sessions idle for at least this many milliseconds are candidates. */
  readonly inactivityMs: number;
  /** Current time in epoch milliseconds. */
  readonly now: number;
  /** Archive pinned sessions too. Off by default: a pin is the explicit "keep this visible" signal. */
  readonly includePinned?: boolean;
  /** Stop a session's running work to archive it. Off by default: running sessions are skipped. */
  readonly stopActivity?: boolean;
  /** Durable session file modification times, by session id. */
  readonly fileMtimes?: ReadonlyMap<string, number>;
}

/** One session the pass would archive, with the reason it was selected. */
export interface ArchiveCandidate {
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string;
  /** Epoch milliseconds of the session's last activity. */
  readonly lastActiveAt: number;
  /** Whole days since that activity, rounded down. */
  readonly idleDays: number;
  /** Whether the session's last activity came from its durable file. */
  readonly fromFile: boolean;
}

/** A session the pass deliberately left alone. */
export interface ArchiveSkip {
  readonly sessionId: string;
  readonly reason: 'pinned' | 'running' | 'already-archived';
  readonly title: string;
}

/** The computed plan, before anything is written. */
export interface ArchivePlan {
  readonly candidates: readonly ArchiveCandidate[];
  readonly skipped: readonly ArchiveSkip[];
  readonly totalSessions: number;
  readonly alreadyArchived: number;
}

/** The result of executing a plan. */
export interface ArchiveRunResult {
  readonly archived: readonly string[];
  readonly failed: readonly { readonly sessionId: string; readonly error: string }[];
  readonly skipped: readonly ArchiveSkip[];
}

/**
 * Compute the sessions to archive, without writing anything.
 *
 * Last activity is the later of the Host's own recency (`updatedAt`, the
 * creation time or the last real user message) and the modification time of
 * the session's durable log. That covers both readings of "last activity" —
 * the last message block and the backing file's mtime — and keeps a cold
 * session whose file was touched recently out of the candidate set.
 *
 * @param client - the live Host calls.
 * @param options - threshold, clock and selection policy.
 * @returns the plan and the sessions left alone.
 */
export async function planArchive(client: DshArchiveClient, options: ArchivePlanOptions): Promise<ArchivePlan> {
  if (!Number.isSafeInteger(options.now) || options.now < 0) throw new Error('now must be a non-negative safe integer');
  if (!Number.isSafeInteger(options.inactivityMs) || options.inactivityMs < 1) throw new Error('inactivityMs must be a positive integer');
  const [sessions, registry] = await Promise.all([client.listSessions(), client.readRegistry()]);
  const archived = new Set(registry.archivedSessionIds);
  const pinned = new Set(registry.pinnedSessionIds);
  const mtimes = options.fileMtimes ?? new Map<string, number>();
  const cutoff = options.now - options.inactivityMs;
  const candidates: ArchiveCandidate[] = [];
  const skipped: ArchiveSkip[] = [];

  for (const session of sessions) {
    if (archived.has(session.sessionId)) continue;
    const title = session.projections?.values?.title ?? '';
    if (session.running === true) {
      skipped.push({ sessionId: session.sessionId, reason: 'running', title });
      continue;
    }
    if (pinned.has(session.sessionId) && options.includePinned !== true) {
      skipped.push({ sessionId: session.sessionId, reason: 'pinned', title });
      continue;
    }
    const fileMtime = mtimes.get(session.sessionId) ?? 0;
    const fromFile = fileMtime > (session.updatedAt ?? 0);
    const lastActiveAt = Math.max(session.updatedAt ?? 0, fileMtime);
    if (lastActiveAt >= cutoff) continue;
    candidates.push({
      sessionId: session.sessionId,
      title,
      cwd: session.cwd ?? '',
      lastActiveAt,
      idleDays: Math.floor((options.now - lastActiveAt) / DAY_MS),
      fromFile,
    });
  }
  candidates.sort((left, right) => left.lastActiveAt - right.lastActiveAt);
  return {
    candidates,
    skipped,
    totalSessions: sessions.length,
    alreadyArchived: sessions.filter(session => archived.has(session.sessionId)).length,
  };
}

/**
 * Archive the planned sessions through the Host, one at a time.
 *
 * Each session is archived on its own so one refusal does not stop the rest.
 * A refusal is reported with its message; the caller decides what to do.
 *
 * @param client - the live Host calls.
 * @param plan - candidates from {@link planArchive}.
 * @param options - whether running work may be stopped.
 * @returns the archived ids and the failures.
 */
export async function runArchive(
  client: DshArchiveClient,
  plan: ArchivePlan,
  options: { readonly stopActivity?: boolean } = {},
): Promise<ArchiveRunResult> {
  const archived: string[] = [];
  const failed: { sessionId: string; error: string }[] = [];
  for (const candidate of plan.candidates) {
    try {
      await client.archiveSession(candidate.sessionId, { stopActivity: options.stopActivity === true });
      archived.push(candidate.sessionId);
    } catch (error) {
      failed.push({ sessionId: candidate.sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { archived, failed, skipped: plan.skipped };
}
