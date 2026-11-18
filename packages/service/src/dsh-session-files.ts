/**
 * Reading the modification times of durable DSH session logs.
 *
 * A session's own record of its last activity stops at its last message, but
 * its file keeps changing afterwards: a tool result, a title rewrite, a
 * compaction. The file's mtime is therefore the other half of "when was this
 * session last active", and the archive pass takes the later of the two.
 */
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

/** The session log files a session directory holds. */
const LOG_PREFIX = 'session.';
const LOG_SUFFIX = '.jsonl';

/**
 * Collect the newest modification time of every stored session.
 *
 * @param sessionsRoot - the directory holding one subdirectory per working directory.
 * @returns modification times by session id, in epoch milliseconds.
 */
export async function readSessionFileMtimes(sessionsRoot: string): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>();
  let workspaces: Dirent[];
  try {
    workspaces = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return mtimes;
  }
  await Promise.all(workspaces.filter(entry => entry.isDirectory()).map(async workspace => {
    const workspaceDir = join(sessionsRoot, workspace.name);
    let sessions: Dirent[];
    try {
      sessions = await readdir(workspaceDir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(sessions.filter(entry => entry.isDirectory()).map(async session => {
      const sessionDir = join(workspaceDir, session.name);
      let files: string[];
      try {
        files = await readdir(sessionDir);
      } catch {
        return;
      }
      const logs = files.filter(name => name.startsWith(LOG_PREFIX) && name.includes(LOG_SUFFIX));
      let latest = 0;
      for (const log of logs) {
        try {
          const info = await stat(join(sessionDir, log));
          latest = Math.max(latest, info.mtimeMs);
        } catch {
          // A log that vanished mid-read simply does not contribute.
        }
      }
      if (latest > 0) mtimes.set(session.name, Math.max(mtimes.get(session.name) ?? 0, latest));
    }));
  }));
  return mtimes;
}
