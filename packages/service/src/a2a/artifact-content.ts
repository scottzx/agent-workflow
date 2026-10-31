/** Serve back only files the host already verified for a task; the receipt, not the caller, names what may be read. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { A2AVerifiedArtifact } from './result-metadata.js';

export const ARTIFACT_CONTENT_LIMIT = 32 * 1024 * 1024;

export class ArtifactContentError extends Error {
  constructor(readonly status: 404 | 409 | 413, readonly code: string) { super(code); }
}

/** The bytes must still match the receipt: a file edited or swapped after verification is refused, not served. */
export async function readVerifiedArtifact(artifacts: A2AVerifiedArtifact[], path: string, sha256: string): Promise<Buffer> {
  const artifact = artifacts.find(item => item.path === path && item.sha256 === sha256);
  if (!artifact) throw new ArtifactContentError(404, 'artifact-not-registered');
  if (artifact.size > ARTIFACT_CONTENT_LIMIT) throw new ArtifactContentError(413, 'artifact-too-large');
  let file;
  try {
    if (await realpath(path) !== path) throw new ArtifactContentError(409, 'artifact-changed');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof ArtifactContentError) throw error;
    throw new ArtifactContentError(409, 'artifact-unavailable');
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== artifact.size) throw new ArtifactContentError(409, 'artifact-changed');
    const content = await file.readFile();
    if (createHash('sha256').update(content).digest('hex') !== sha256) throw new ArtifactContentError(409, 'artifact-changed');
    return content;
  } finally { await file.close(); }
}
