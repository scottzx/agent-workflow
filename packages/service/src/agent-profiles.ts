/**
 * Session-level agent profiles: one native ACP Agent CLI, several isolated accounts.
 *
 * A profile is an extra Agent id that the service advertises next to the built-in
 * registry (`agy2`, for example). Sessions that select it spawn the same adapter as
 * its underlying Agent, with a profile-scoped child environment — usually `HOME`,
 * which is what separates browser-login credential stores such as macOS keychain
 * items and `~/.codex`, `~/.claude` or `~/.gemini` directories.
 *
 * The profile id is the only thing the client sees. The underlying Agent, the
 * environment overlay and the credential location never leave this process.
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { createAgentRegistry } from '@1agents/acp-service/runtime';

export interface AgentProfile {
  /** Advertised Agent id, for example `agy2`. */
  readonly id: string;
  /** Built-in registry id whose adapter this profile launches. */
  readonly agent: string;
  /** Roster label; defaults to `<agent> · <id>`. */
  readonly label: string;
  /** Absolute home directory for the child process. Expands `~/`. */
  readonly home?: string;
  /** Additional child-only environment entries. */
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentProfileSet {
  /** The file the profiles came from; it need not exist. */
  readonly file: string;
  readonly profiles: readonly AgentProfile[];
  readonly byId: ReadonlyMap<string, AgentProfile>;
}

export interface AgentProfileOptions {
  /** Overrides `ACP_PROFILES_FILE` and the default location. */
  file?: string;
  /** Environment used to locate the file; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Known Agent ids that a profile may wrap; defaults to the built-in registry. */
  agents?: readonly string[];
}

const PROFILE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_IDS = new Set(['constructor', 'prototype', '__proto__', 'profile']);
const MAX_ENV_VALUE = 4096;

/**
 * Child environment entries a profile may set. Credentials and Agent homes live in
 * these variables; anything else (PATH, NODE_OPTIONS, DYLD_*, SSH_AUTH_SOCK, …) would
 * change how the adapter itself is launched, so it is rejected instead of ignored.
 */
const ENV_ALLOW: readonly RegExp[] = [
  /^HOME$/,
  /^XDG_[A-Z_]+$/,
  /^CODEX_HOME$/,
  /^CLAUDE_[A-Z_]+$/,
  /^GEMINI_[A-Z_]+$/,
  /^JETSKI_[A-Z_]+$/,
  /^AGY_[A-Z_]+$/,
  /^ANTIGRAVITY_[A-Z_]+$/,
  /^GROK_[A-Z_]+$/,
];

/** `$DSH_HOME/plugins/1agents-acp/profiles.json`, overridable for standalone services. */
export function defaultAgentProfilesFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ACP_PROFILES_FILE?.trim();
  if (explicit) return resolvePath(explicit);
  const dshHome = env.DSH_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.dsh');
  return join(dshHome, 'plugins', '1agents-acp', 'profiles.json');
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return resolvePath(value);
}

function fail(file: string, message: string): never {
  throw new Error(`Invalid agent profiles in ${file}: ${message}`);
}

function parseProfile(
  file: string,
  id: string,
  raw: unknown,
  options: { home: string; agents: Set<string> },
): AgentProfile {
  if (!PROFILE_ID.test(id)) {
    fail(file, `"${id}" is not a valid Agent id (lowercase letters, digits, "_" and "-", starting with a letter)`);
  }
  if (RESERVED_IDS.has(id)) fail(file, `"${id}" is a reserved name`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(file, `profiles.${id} must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!['agent', 'label', 'home', 'env'].includes(key)) {
      fail(file, `profiles.${id}.${key} is not a supported field (agent, label, home, env)`);
    }
  }
  const agent = typeof entry.agent === 'string' ? entry.agent.trim() : '';
  if (!agent) fail(file, `profiles.${id}.agent is required`);
  if (!options.agents.has(agent)) {
    fail(file, `profiles.${id}.agent "${agent}" is not a known Agent (${[...options.agents].sort().join(', ')})`);
  }
  if (agent === id) fail(file, `profiles.${id} would shadow the built-in Agent "${agent}"`);

  let label = typeof entry.label === 'string' ? entry.label.trim() : '';
  if (!label) label = `${agent} · ${id}`;
  if (label.length > 60) fail(file, `profiles.${id}.label must be at most 60 characters`);

  let home: string | undefined;
  if (entry.home !== undefined) {
    if (typeof entry.home !== 'string' || !entry.home.trim()) fail(file, `profiles.${id}.home must be a non-empty string`);
    home = expandHome(entry.home.trim(), options.home);
    if (!isAbsolute(home)) fail(file, `profiles.${id}.home must be absolute`);
  }

  const env: Record<string, string> = {};
  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)) {
      fail(file, `profiles.${id}.env must be an object of string values`);
    }
    for (const [name, value] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof value !== 'string') fail(file, `profiles.${id}.env.${name} must be a string`);
      if (value.length > MAX_ENV_VALUE) fail(file, `profiles.${id}.env.${name} is too long`);
      if (!ENV_ALLOW.some(pattern => pattern.test(name))) {
        fail(file, `profiles.${id}.env.${name} is not an allowed variable (credential/home variables only)`);
      }
      if (name === 'HOME' && home && expandHome(value, options.home) !== home) {
        fail(file, `profiles.${id} sets both home and env.HOME with different values`);
      }
      env[name] = value.startsWith('~/') ? join(options.home, value.slice(2)) : value;
    }
  }
  if (!home && env.HOME) home = expandHome(env.HOME, options.home);

  return Object.freeze({
    id,
    agent,
    label,
    ...(home ? { home } : {}),
    env: Object.freeze({ ...env }),
  });
}

/** Reads and validates the profile file. A missing file is an empty set, not an error. */
export function loadAgentProfiles(options: AgentProfileOptions = {}): AgentProfileSet {
  const env = options.env ?? process.env;
  const file = options.file ? resolvePath(options.file) : defaultAgentProfilesFile(env);
  const agents = new Set(options.agents ?? createAgentRegistry().list());
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { file, profiles: [], byId: new Map() };
    throw new Error(`Cannot read agent profiles ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse agent profiles ${file}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(file, 'expected an object with a "profiles" map');
  }
  const root = parsed as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== 'profiles') fail(file, `"${key}" is not a supported top-level field (profiles)`);
  }
  const entries = root.profiles ?? {};
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    fail(file, '"profiles" must be an object keyed by Agent id');
  }
  const home = env.HOME?.trim() || homedir();
  const profiles = Object.entries(entries as Record<string, unknown>)
    .map(([id, raw]) => parseProfile(file, id, raw, { home, agents }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { file, profiles, byId: new Map(profiles.map(profile => [profile.id, profile])) };
}

/** Child-only environment overlay for one profile. `HOME` is the account boundary. */
export function profileEnvironment(profile: AgentProfile): Record<string, string> {
  return profile.home ? { HOME: profile.home, ...profile.env } : { ...profile.env };
}

/**
 * Resolves one session's spawn target: the profile's underlying Agent plus the child
 * environment overlay, with server-side profile entries winning over client entries.
 */
export function resolveAgentLaunch(
  id: string,
  sessionEnv?: Record<string, string>,
  options: AgentProfileOptions & { ensureHome?: boolean } = {},
): { agent: string; env?: Record<string, string> } {
  const profile = resolveAgentProfile(id, options);
  if (!profile) return { agent: id };
  // A profile home that does not exist yet must not turn into a CLI that writes its
  // state into the wrong place, so create it before the first spawn.
  if (options.ensureHome && profile.home) mkdirSync(profile.home, { recursive: true, mode: 0o700 });
  const overlay = profileEnvironment(profile);
  if (Object.keys(overlay).length === 0) return { agent: profile.agent, ...(sessionEnv ? { env: sessionEnv } : {}) };
  return { agent: profile.agent, env: { ...(sessionEnv ?? {}), ...overlay } };
}

interface ProfileCache {
  readonly file: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly set: AgentProfileSet;
}

let cache: ProfileCache | undefined;

/** Cached lookup for the session path: reloads only when the file changes on disk. */
export function resolveAgentProfile(id: string, options: AgentProfileOptions = {}): AgentProfile | undefined {
  if (!id || typeof id !== 'string') return undefined;
  const env = options.env ?? process.env;
  const file = options.file ? resolvePath(options.file) : defaultAgentProfilesFile(env);
  let stamp: { mtimeMs: number; size: number };
  try {
    const stat = statSync(file);
    stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    cache = undefined;
    return undefined;
  }
  if (!cache || cache.file !== file || cache.mtimeMs !== stamp.mtimeMs || cache.size !== stamp.size) {
    cache = { file, ...stamp, set: loadAgentProfiles({ ...options, file }) };
  }
  return cache.set.byId.get(id);
}
