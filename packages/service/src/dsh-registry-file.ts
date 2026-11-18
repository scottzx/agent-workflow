/**
 * Reading the durable workspace registry from disk.
 *
 * The registry keeps its state in memory inside the running Host and writes
 * the whole document on every change. When two Hosts share one DSH home — a
 * `dsh web` instance and the desktop app, for example — the older one keeps a
 * stale copy and would overwrite the newer one's archive set on its next
 * write. The document on disk is therefore the record the CLI plans against,
 * and the Host's own copy is checked against it before anything is written.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The registry document the workspace domain stores. */
const REGISTRY_FILENAME = 'workspace.json';

/** The archive and pin sets as the document records them. */
export interface RegistryFileState {
  readonly archivedSessionIds: readonly string[];
  readonly pinnedSessionIds: readonly string[];
  /** Whether the document was read at all. */
  readonly found: boolean;
}

/**
 * Read the durable registry document.
 *
 * @param dshHome - the DSH home directory.
 * @returns the recorded sets, or an empty result when the document is absent.
 */
export async function readRegistryFile(dshHome: string): Promise<RegistryFileState> {
  const empty: RegistryFileState = { archivedSessionIds: [], pinnedSessionIds: [], found: false };
  let text: string;
  try {
    text = await readFile(join(dshHome, 'storages', REGISTRY_FILENAME), 'utf8');
  } catch {
    return empty;
  }
  try {
    const document = JSON.parse(text) as {
      global?: { archivedSessionIds?: unknown; pinnedSessionIds?: unknown };
    };
    const archived = document.global?.archivedSessionIds;
    const pinned = document.global?.pinnedSessionIds;
    return {
      archivedSessionIds: Array.isArray(archived) ? archived.filter((id): id is string => typeof id === 'string') : [],
      pinnedSessionIds: Array.isArray(pinned) ? pinned.filter((id): id is string => typeof id === 'string') : [],
      found: true,
    };
  } catch {
    // A document that cannot be parsed is not a basis for a write decision.
    return empty;
  }
}

/**
 * How far a Host's registry is behind the durable document.
 *
 * @param hostArchived - the archive set the running Host reported.
 * @param fileArchived - the archive set the document records.
 * @returns the ids the document holds and the Host does not.
 */
export function staleArchiveIds(hostArchived: readonly string[], fileArchived: readonly string[]): string[] {
  const host = new Set(hostArchived);
  return fileArchived.filter(id => !host.has(id));
}
