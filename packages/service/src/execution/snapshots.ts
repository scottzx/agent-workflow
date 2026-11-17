/**
 * The frozen bytes of an accepted handoff.
 *
 * The store keeps files by their digest, so a later round of the source job cannot change what an accepted
 * handoff points at. Every read re-hashes the file: bytes that no longer match their digest are refused.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HandoffSnapshot } from './handoff.js';

export class SnapshotError extends Error {
  constructor(readonly code: 'not_found' | 'changed', message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export interface SnapshotInput {
  caseId: string;
  handoffId: string;
  files: { digest: string; name: string; mediaType?: string; bytes: Buffer }[];
}

export class SnapshotStore {
  constructor(private readonly root: string) {}

  /** The path a frozen file is stored at, relative to the store's root. */
  storedPath(caseId: string, handoffId: string, digest: string): string {
    return join(caseId, handoffId, digest);
  }

  private absolute(storedPath: string): string {
    return join(this.root, storedPath);
  }

  /** Copy the bytes in. A file that is already frozen with the same digest is left alone. */
  async freeze(input: SnapshotInput): Promise<HandoffSnapshot[]> {
    const frozenAt = new Date().toISOString();
    const output: HandoffSnapshot[] = [];
    for (const file of input.files) {
      const digest = createHash('sha256').update(file.bytes).digest('hex');
      if (digest !== file.digest) throw new SnapshotError('changed', 'The bytes do not match their digest');
      const storedPath = this.storedPath(input.caseId, input.handoffId, digest);
      const destination = this.absolute(storedPath);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const temporary = `${destination}.${process.pid}.tmp`;
      await writeFile(temporary, file.bytes, { mode: 0o400 });
      await rename(temporary, destination);
      output.push({ digest, name: file.name, size: file.bytes.length, ...(file.mediaType ? { mediaType: file.mediaType } : {}),
        storedPath, frozenAt });
    }
    return output;
  }

  /** Read the frozen bytes back. The digest is checked again on every read. */
  async read(storedPath: string, expectedDigest: string): Promise<Buffer> {
    let content: Buffer;
    try { content = await readFile(this.absolute(storedPath)); }
    catch { throw new SnapshotError('not_found', 'This frozen artifact is not available'); }
    if (createHash('sha256').update(content).digest('hex') !== expectedDigest) throw new SnapshotError('changed', 'The frozen artifact no longer matches its digest');
    return content;
  }

  /** The absolute path a frozen file lives at on this host. */
  absolutePath(storedPath: string): string { return this.absolute(storedPath); }
}
