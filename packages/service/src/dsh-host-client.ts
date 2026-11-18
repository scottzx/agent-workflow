/**
 * Talking to a running DSH Host over its Typert RPC.
 *
 * The Host exposes its business services under `/api/<namespace>/<method>`
 * with a JSON envelope. A browser session authenticates with a signed cookie;
 * this module mints the same cookie from the local credential store, so the
 * CLI acts as the Host's owner on the same machine that owns the Host.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ArchiveRegistryState, DshArchiveClient, DshSessionSummary } from './dsh-archive.js';
import { staleArchiveIds } from './dsh-registry-file.js';

/** The credential record holding the browser-session signing secret. */
const BROWSER_SESSION_RECORD = 'client-connection/browser-session';
/** The cookie prefix the Host expects. */
const COOKIE_PREFIX = 'dsh-auth-';
/** Cookie lifetime the CLI mints. */
const COOKIE_LIFETIME_MS = 24 * 60 * 60 * 1000;
/**
 * The id the CLI passes when it only wants the registry's current sets.
 *
 * Session ids are UUIDs or `session-<uuid>` forms, so this can never name a
 * real session; `unarchiveSession` and `unpinSession` therefore return the
 * complete sets without changing anything.
 */
const REGISTRY_PROBE_ID = 'acp-service-cli-registry-probe';

/** A Host endpoint the CLI can reach. */
export interface DshEndpoint {
  readonly origin: string;
  readonly authority: string;
}

/** An RPC failure reported by the Host. */
export class DshRpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DshRpcError';
  }
}

const base64url = (bytes: Buffer): string =>
  bytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/**
 * Read the browser-session signing secret from the local credential store.
 *
 * The store is a YAML document; this reads the one field it needs rather than
 * taking a YAML dependency, and never returns the secret to the caller.
 *
 * @param credentialsPath - path to the credential document.
 * @returns the signing secret.
 */
export function readBrowserSessionSecret(credentialsPath: string): Buffer {
  let text: string;
  try {
    text = readFileSync(credentialsPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${credentialsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const start = text.indexOf(BROWSER_SESSION_RECORD);
  if (start < 0) throw new Error(`${credentialsPath} has no ${BROWSER_SESSION_RECORD} record`);
  const secret = text.slice(start, start + 2048).match(/secret:\s*([A-Za-z0-9_-]+)/);
  if (!secret) throw new Error(`${credentialsPath} has no browser-session secret`);
  return Buffer.from(secret[1], 'base64url');
}

/**
 * Mint the signed browser-session cookie for one authority.
 *
 * @param secret - the signing secret from the credential store.
 * @param authority - the host:port the cookie is scoped to.
 * @returns the cookie header value.
 */
export function mintSessionCookie(secret: Buffer, authority: string): string {
  const issuedAt = Date.now();
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + COOKIE_LIFETIME_MS };
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = base64url(createHmac('sha256', secret).update(body).digest());
  const name = COOKIE_PREFIX + createHash('sha256').update(authority).digest('base64url');
  return `${name}=v1.${body}.${signature}`;
}

/**
 * List the loopback TCP ports this machine is listening on.
 *
 * The desktop app binds an ephemeral port, so the CLI discovers the Host by
 * probing local listeners rather than by a configured address.
 *
 * @returns the loopback ports, ascending.
 */
export function listLoopbackPorts(): number[] {
  let output = '';
  try {
    output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const ports = new Set<number>();
  for (const line of output.split('\n').slice(1)) {
    // The NAME column holds the bound address, such as `127.0.0.1:51971` or
    // `*:51971`, followed by the connection state.
    const match = line.match(/TCP\s+\S*?:(\d+)\s+\(LISTEN\)\s*$/);
    if (!match) continue;
    const port = Number.parseInt(match[1], 10);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/**
 * Ask one origin whether it is a DSH Host that answers the session API.
 *
 * @param origin - the origin to probe.
 * @param cookie - the minted cookie for that origin's authority.
 * @returns whether the origin answered a session list.
 */
export async function probeHost(origin: string, cookie: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'session/list', payload: { args: { _request: {} } } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { result?: { ok?: boolean } };
    return body?.result?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Find a reachable DSH Host.
 *
 * An explicit origin is authoritative: the CLI uses the first named origin
 * that answers, so a caller can target one instance on purpose. Without one
 * the CLI probes the machine's loopback listeners, because the desktop app
 * binds an ephemeral port that nothing else records; there it prefers a Host
 * whose registry already holds every archived id, since two Hosts can share
 * one DSH home and the older one's copy would drop the newer archives on its
 * next write.
 *
 * @param origins - explicit origins from the command line.
 * @param secret - the browser-session signing secret.
 * @param documentArchived - archive ids the durable document records, when known.
 * @returns the chosen origin.
 */
export async function discoverHost(
  origins: readonly string[],
  secret: Buffer,
  documentArchived?: readonly string[],
): Promise<DshEndpoint> {
  const explicit: string[] = [];
  for (const origin of origins) {
    const normalized = origin.replace(/\/+$/, '');
    if (!explicit.includes(normalized)) explicit.push(normalized);
  }
  const probe = async (origin: string): Promise<DshEndpoint | undefined> => {
    const authority = new URL(origin).host;
    return await probeHost(origin, mintSessionCookie(secret, authority)) ? { origin, authority } : undefined;
  };
  if (explicit.length > 0) {
    for (const origin of explicit) {
      const endpoint = await probe(origin);
      if (endpoint) return endpoint;
    }
    throw new Error(`none of the given --url origins answered as a DSH Host: ${explicit.join(', ')}`);
  }
  const candidates = listLoopbackPorts().map(port => `http://127.0.0.1:${port}`);
  const answering: DshEndpoint[] = [];
  // Probe in small batches so one unresponsive listener cannot stall discovery.
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = candidates.slice(index, index + 8);
    const results = await Promise.all(batch.map(probe));
    for (const result of results) if (result) answering.push(result);
  }
  if (answering.length === 0) {
    throw new Error(`no reachable DSH Host found (tried ${candidates.length} local endpoint(s)); pass --url with the Host origin`);
  }
  if (documentArchived === undefined || documentArchived.length === 0) return answering[0];
  for (const endpoint of answering) {
    const client = new DshHostClient(endpoint, mintSessionCookie(secret, endpoint.authority));
    try {
      const registry = await client.readRegistry();
      if (staleArchiveIds(registry.archivedSessionIds, documentArchived).length === 0) return endpoint;
    } catch {
      // A Host that cannot report its registry is not preferred, but it still
      // answered; it stays in the fallback set.
    }
  }
  return answering[0];
}

/** A live DSH Host reached over RPC. */
export class DshHostClient implements DshArchiveClient {
  private rpcId = 0;
  /** The archive set this Host most recently reported, for the freshness check. */
  private lastArchivedSessionIds: readonly string[] = [];

  constructor(private readonly endpoint: DshEndpoint, private readonly cookie: string) {}

  /**
   * Call one Host method.
   *
   * @param method - the `namespace/method` endpoint.
   * @param args - the method's arguments.
   * @returns the decoded result value.
   */
  async call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    this.rpcId += 1;
    const response = await fetch(`${this.endpoint.origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `acp-service-${this.rpcId}`,
        method,
        payload: { args },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new DshRpcError(`http/${response.status}`, `${method} returned HTTP ${response.status}`);
    const body = await response.json() as {
      result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
    };
    if (body?.result?.ok !== true) {
      const error = body?.result?.error;
      throw new DshRpcError(error?.code ?? 'gateway/unknown', error?.message ?? `${method} failed`);
    }
    return body.result.value as T;
  }

  async listSessions(): Promise<readonly DshSessionSummary[]> {
    const value = await this.call<{ items?: DshSessionSummary[] }>('session/list', { _request: {} });
    return value.items ?? [];
  }

  async readRegistry(): Promise<ArchiveRegistryState> {
    // `unarchiveSession` and `unpinSession` are documented no-ops for an id
    // that is not in the set, and each returns the complete resulting set.
    // The sentinel is not a session id, so neither call can change anything.
    const archived = await this.call<{ archivedSessionIds?: string[] }>('workspace/unarchiveSession', {
      request: { sessionId: REGISTRY_PROBE_ID },
    });
    const pinned = await this.call<{ pinnedSessionIds?: string[] }>('workspace/unpinSession', {
      request: { sessionId: REGISTRY_PROBE_ID },
    });
    this.lastArchivedSessionIds = archived.archivedSessionIds ?? [];
    return {
      archivedSessionIds: this.lastArchivedSessionIds,
      pinnedSessionIds: pinned.pinnedSessionIds ?? [],
    };
  }

  async archiveSession(sessionId: string, options: { readonly stopActivity: boolean }): Promise<void> {
    await this.call('workspace/archiveSession', { request: { sessionId, stopActivity: options.stopActivity } });
  }

  /**
   * Refuse to write through a Host whose registry is behind the document.
   *
   * The Host holds the registry in memory and rewrites the whole document on
   * every change, so a Host that started before another Host wrote the
   * document would drop the newer archive entries. The command reports this
   * instead of silently undoing someone else's archives.
   *
   * @param documentArchived - the archive set the durable document records.
   * @throws DshRpcError when the Host is behind the document.
   */
  async assertRegistryFresh(documentArchived: readonly string[]): Promise<void> {
    const stale = staleArchiveIds(this.lastArchivedSessionIds, documentArchived);
    if (stale.length > 0) {
      throw new DshRpcError(
        'dsh/registry-stale',
        `this DSH instance is behind the durable registry: it is missing ${stale.length} archived session(s) that are recorded on disk. `
        + 'Restart this DSH instance so it reloads the registry, then run the command again.',
      );
    }
  }
}
