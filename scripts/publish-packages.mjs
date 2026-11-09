/** Publish the immutable tarballs selected from successful CI; never rebuild. */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateArtifacts, digest } from './release-artifacts.mjs';

export function verifyPublishedArchive(archive, dist) {
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  if (dist?.integrity !== integrity) throw new Error('Published version has different archive integrity');
}

/** Compare contents and permissions when npm has changed only archive compression metadata.
 * Reject changed code, missing files, links and duplicate or unsafe entries. */
export function archiveContentDigest(archive) {
  const listing = execFileSync('tar', ['-tvf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (listing.some(line => !['-', 'd'].includes(line[0]))) throw new Error('Release archive contains links or special files');
  const names = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (names.length !== listing.length) throw new Error('Inconsistent release archive listing');
  const modes = new Map(names.map((name, i) => [name, listing[i].slice(0, 10)]));
  const entries = [...names].sort();
  if (!entries.length || new Set(entries).size !== entries.length || entries.some(name => !name.startsWith('package/') || name.split('/').includes('..'))) {
    throw new Error('Unsafe or duplicate release archive entries');
  }
  return digest(Buffer.from(JSON.stringify(entries.map(name => [name, modes.get(name), name.endsWith('/')
    ? null : digest(execFileSync('tar', ['-xOf', archive, name], { maxBuffer: 16 * 1024 * 1024 }))]))));
}

// A freshly published version took about three minutes to become readable on 2026-11-09, so wait up to five.
export async function verifyRegistryState(name, version, dependency, range, fetcher = fetchRegistry, { attempts = 30, delayMs = 10_000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resolved = await fetcher(name, version, dependency);
      if (resolved !== range) throw new Error(`Registry ${name}@${version} declares ${dependency}@${resolved ?? 'missing'}; expected ${range}`);
      console.log(`registry ok: ${name}@${version}`);
      return;
    } catch (error) {
      if (attempt === attempts || !/^E404 from registry/.test(String(error.message))) throw error;
      console.log(`Waiting for registry ${name}@${version} (${attempt}/${attempts})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function registryDocument(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) throw new Error(`E404 from registry for ${name}@${version}`);
  if (!response.ok) throw new Error(`Registry check failed: HTTP ${response.status}`);
  return response.json();
}

async function fetchRegistry(name, version, dependency) {
  const doc = await registryDocument(name, version);
  return dependency ? doc.dependencies?.[dependency] : doc.version;
}

export async function verifyExisting(archive, dist) {
  try { verifyPublishedArchive(readFileSync(archive), dist); return; }
  catch { /* Compare the complete registry artifact, never trust integrity drift. */ }
  const url = new URL(dist.tarball);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') throw new Error('Unexpected registry tarball URL');
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Registry tarball download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyPublishedArchive(bytes, dist);
  const directory = mkdtempSync(join(tmpdir(), 'acp-published-'));
  try {
    const remote = join(directory, 'published.tgz');
    writeFileSync(remote, bytes);
    if (archiveContentDigest(archive) !== archiveContentDigest(remote)) {
      throw new Error('Published version has different contents; bump the package version');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function publishPackages() {
  const sha = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // Validate the complete package before publishing.
  const artifacts = validateArtifacts(sha);
  for (const { archive, packed } of artifacts) {
    const { name, version } = packed;
    let existing;
    try { existing = await registryDocument(name, version); }
    catch (error) { if (!/^E404 from registry/.test(error.message)) throw error; }
    if (existing) {
      await verifyExisting(archive, existing.dist);
      console.log(`${name}@${version} already published with matching contents; skipping`);
    } else {
      execFileSync('npm', ['publish', archive, '--access', 'public', '--provenance', '--registry=https://registry.npmjs.org'], { stdio: 'inherit' });
    }
    await verifyRegistryState(name, version, undefined, version);
    for (const [dependency, expected] of Object.entries(packed.dependencies)) {
      await verifyRegistryState(name, version, dependency, expected);
    }
    const tag = `${name.split('/').at(-1)}-v${version}`;
    const remote = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { encoding: 'utf8' }).trim();
    if (!remote) {
      execFileSync('git', ['tag', tag]);
      execFileSync('git', ['push', 'origin', `refs/tags/${tag}`], { stdio: 'inherit' });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await publishPackages();
