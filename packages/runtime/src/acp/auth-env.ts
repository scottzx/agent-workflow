import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcpClientOptions } from "../types.js";
import { inheritParentEnvironment, type InheritedEnvPolicy } from "./inherited-env.js";

const AUTH_ENV_PREFIX = "ACPX_AUTH_";
// Third-party API gateways (ANTHROPIC_BASE_URL) need the model ids too: user
// settings are excluded from the spawned Claude Code's settingSources, so the
// ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL values configured there must be
// forwarded with the credentials or the agent falls back to built-in Anthropic
// model ids, which the gateway rejects ("Model not exist").
const CLAUDE_SETTINGS_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

type ClaudeSettings = {
  env?: Record<string, unknown>;
};

function readClaudeSettingsEnvironment(): Record<string, string> {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let parsed: ClaudeSettings;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as ClaudeSettings;
  } catch {
    return {};
  }

  const settingsEnv = parsed.env;
  if (!settingsEnv || typeof settingsEnv !== "object") {
    return {};
  }

  const env: Record<string, string> = {};
  for (const key of CLAUDE_SETTINGS_ENV_KEYS) {
    const value = settingsEnv[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

export function applyClaudeSettingsEnvironment(env: NodeJS.ProcessEnv): void {
  Object.assign(env, readClaudeSettingsEnvironment());
}

function toEnvToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function buildAuthEnvKey(methodId: string): string | undefined {
  const token = toEnvToken(methodId);
  return token.length > 0 ? `${AUTH_ENV_PREFIX}${token}` : undefined;
}

const authEnvKeyCache = new Map<string, string | undefined>();

function authEnvKey(methodId: string): string | undefined {
  const cached = authEnvKeyCache.get(methodId);
  if (cached !== undefined) {
    return cached;
  }
  const key = buildAuthEnvKey(methodId);
  authEnvKeyCache.set(methodId, key);
  return key;
}

export function readEnvCredential(methodId: string): string | undefined {
  const key = authEnvKey(methodId);
  if (!key) {
    return undefined;
  }
  const value = process.env[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function protectedEnvKey(key: string): string {
  return process.platform === "win32" ? key.toUpperCase() : key;
}

function isAuthEnvKey(key: string): boolean {
  return protectedEnvKey(key).startsWith(AUTH_ENV_PREFIX);
}

function authEnvSuffix(key: string): string {
  return key.slice(AUTH_ENV_PREFIX.length);
}

function protectEnvKey(protectedKeys: Set<string>, key: string): void {
  protectedKeys.add(protectedEnvKey(key));
}

function promotePrefixedAuthEnvironment(env: NodeJS.ProcessEnv): Set<string> {
  const protectedKeys = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!isAuthEnvKey(key)) {
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }

    const normalized = toEnvToken(authEnvSuffix(key));
    if (!normalized) {
      continue;
    }

    protectEnvKey(protectedKeys, key);
    protectEnvKey(protectedKeys, normalized);
    assignIfMissing(env, normalized, value);
  }
  return protectedKeys;
}

function validateAgentProcessEnv(agentProcessEnv: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(agentProcessEnv ?? {})) {
    if (
      typeof value !== "string" ||
      key.includes("=") ||
      key.includes("\u0000") ||
      value.includes("\u0000")
    ) {
      throw new Error(
        "Invalid agentProcessEnv: environment entries cannot contain NUL or names with '='",
      );
    }
  }
}

function buildAgentEnvironment(
  authCredentials: Record<string, string> | undefined,
  sessionEnv: Record<string, string> | undefined,
  agentProcessEnv: Record<string, string> | undefined,
  includeClaudeSettings = false,
  inheritedEnv?: InheritedEnvPolicy,
): NodeJS.ProcessEnv {
  validateAgentProcessEnv(agentProcessEnv);
  // Allow and block shape inheritance only; explicit grants and overlays below still apply.
  const env = inheritParentEnvironment(inheritedEnv);
  if (includeClaudeSettings) {
    applyClaudeSettingsEnvironment(env);
  }
  const protectedAuthEnvKeys = promotePrefixedAuthEnvironment(env);
  if (authCredentials) {
    for (const [methodId, credential] of Object.entries(authCredentials)) {
      addAuthCredentialEnvKeys(protectedAuthEnvKeys, methodId, credential);
      assignAuthCredentialEnv(env, methodId, credential);
    }
  }

  applySessionEnvironment(env, protectedAuthEnvKeys, [sessionEnv, agentProcessEnv]);

  return env;
}

function applySessionEnvironment(
  env: NodeJS.ProcessEnv,
  protectedAuthEnvKeys: Set<string>,
  overlays: (Record<string, string> | undefined)[],
): void {
  for (const overlay of overlays) {
    for (const [key, value] of Object.entries(overlay ?? {})) {
      if (typeof value !== "string" || protectedAuthEnvKeys.has(protectedEnvKey(key))) {
        continue;
      }
      assignSessionEnv(env, key, value);
    }
  }
}

function assignSessionEnv(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const normalizedKey = protectedEnvKey(key);
  for (const existingKey of Object.keys(env)) {
    if (protectedEnvKey(existingKey) === normalizedKey) {
      delete env[existingKey];
    }
  }
  Object.defineProperty(env, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function addAuthCredentialEnvKeys(
  protectedKeys: Set<string>,
  methodId: string,
  credential: string,
): void {
  if (typeof credential !== "string" || credential.trim().length === 0) {
    return;
  }

  if (!methodId.includes("=") && !methodId.includes("\u0000")) {
    protectEnvKey(protectedKeys, methodId);
  }

  const normalized = toEnvToken(methodId);
  if (normalized) {
    protectEnvKey(protectedKeys, `${AUTH_ENV_PREFIX}${normalized}`);
    protectEnvKey(protectedKeys, normalized);
  }
}

function assignAuthCredentialEnv(
  env: NodeJS.ProcessEnv,
  methodId: string,
  credential: string,
): void {
  if (typeof credential !== "string" || credential.trim().length === 0) {
    return;
  }

  if (!methodId.includes("=") && !methodId.includes("\u0000")) {
    assignIfMissing(env, methodId, credential);
  }

  const normalized = toEnvToken(methodId);
  if (normalized) {
    assignIfMissing(env, `${AUTH_ENV_PREFIX}${normalized}`, credential);
    assignIfMissing(env, normalized, credential);
  }
}

function assignIfMissing(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (env[key] != null) {
    return;
  }

  const normalizedKey = protectedEnvKey(key);
  if (
    process.platform === "win32" &&
    Object.entries(env).some(
      ([existingKey, existingValue]) =>
        existingValue != null && protectedEnvKey(existingKey) === normalizedKey,
    )
  ) {
    return;
  }
  env[key] = value;
}

export function resolveConfiguredAuthCredential(
  methodId: string,
  authCredentials: AcpClientOptions["authCredentials"],
): string | undefined {
  const configCredentials = authCredentials ?? {};
  return configCredentials[methodId] ?? configCredentials[toEnvToken(methodId)];
}

export function buildAgentSpawnOptions(
  cwd: string,
  authCredentials: Record<string, string> | undefined,
  sessionEnv?: Record<string, string>,
  agentProcessEnvOrClaudeSettings?: Record<string, string> | boolean,
  includeClaudeSettingsOrInheritedEnv?: boolean | InheritedEnvPolicy,
  inheritedEnv?: InheritedEnvPolicy,
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
} {
  let agentProcessEnv: Record<string, string> | undefined;
  let claudeSettings = false;
  let inheritedEnvPolicy = inheritedEnv;
  if (typeof agentProcessEnvOrClaudeSettings === "boolean") {
    claudeSettings = agentProcessEnvOrClaudeSettings;
  } else if (
    agentProcessEnvOrClaudeSettings &&
    typeof agentProcessEnvOrClaudeSettings === "object"
  ) {
    agentProcessEnv = agentProcessEnvOrClaudeSettings;
  }
  if (typeof includeClaudeSettingsOrInheritedEnv === "boolean") {
    claudeSettings = includeClaudeSettingsOrInheritedEnv;
  } else if (includeClaudeSettingsOrInheritedEnv && inheritedEnv === undefined) {
    inheritedEnvPolicy = includeClaudeSettingsOrInheritedEnv;
  }
  return {
    cwd,
    env: buildAgentEnvironment(
      authCredentials,
      sessionEnv,
      agentProcessEnv,
      claudeSettings,
      inheritedEnvPolicy,
    ),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}
