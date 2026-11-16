/**
 * Three directories, and they are not interchangeable.
 * A role publication is readable by other roles. A job directory belongs to one task.
 * An artifact space is the shared place where several tasks of one case write deliverables.
 * Path checks here are POSIX spellings announced to a remote host; the host still realpath-checks them.
 */
import { posix } from 'node:path';

const ROLE_ID = /^[A-Za-z0-9._-]{1,200}$/;

export interface ArtifactSpace {
  originSessionId: string;
  caseId: string;
  /** Absolute path on the execution host. The gateway does not create it. */
  root: string;
  recordedAt: string;
}

export function rolePublicationDirectory(cwd: string, roleId: string): string | undefined {
  if (!ROLE_ID.test(roleId)) return undefined;
  return posix.join(cwd, '.1agents', 'roles', roleId, 'published');
}

/** The role id named by `<cwd>/.1agents/roles/<roleId>/published`, if the path is exactly that. */
export function roleIdFromPublication(cwd: string, directory: string): string | undefined {
  const tail = posix.relative(posix.join(cwd, '.1agents', 'roles'), directory);
  const match = /^([A-Za-z0-9._-]+)\/published$/.exec(tail);
  return match?.[1];
}

export type SpaceKind = 'role_publication' | 'job' | 'artifact_space' | 'outside';

/** Classify an announced path. Realpath containment is the host's job; this only separates the three contracts. */
export function classifySpace(cwd: string, directory: string, jobDirectory?: string, artifactSpace?: string): SpaceKind {
  if (roleIdFromPublication(cwd, directory)) return 'role_publication';
  if (jobDirectory && directory === jobDirectory) return 'job';
  if (artifactSpace) {
    const tail = posix.relative(artifactSpace, directory);
    if (tail === '' || (tail !== '..' && !tail.startsWith('../') && !posix.isAbsolute(tail))) return 'artifact_space';
  }
  return 'outside';
}
