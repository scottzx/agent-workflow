import {
  AcpxOperationalError,
  AuthPolicyError,
  PermissionDeniedError,
  PermissionPromptUnavailableError,
} from "../errors.js";
import { AcpRuntimeError } from "../runtime/public/errors.js";
import {
  EXIT_CODES,
  OUTPUT_ERROR_CODES,
  OUTPUT_ERROR_ORIGINS,
  type ExitCode,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
  type SafeError,
  type SafeErrorCategory,
  type SafeErrorOrigin,
  QUEUE_ERROR_DETAIL_CODES,
} from "../types.js";
import {
  extractAcpError,
  formatUnknownErrorMessage,
  isAcpResourceNotFoundError,
} from "./error-shapes.js";

const AUTH_REQUIRED_ACP_CODES = new Set([-32000]);
const QUERY_CLOSED_BEFORE_RESPONSE_DETAIL = "query closed before response received";

type ErrorMeta = {
  outputCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
};

export type NormalizedOutputError = {
  code: OutputErrorCode;
  message: string;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
};

export type NormalizeOutputErrorOptions = {
  defaultCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isAuthRequiredMessage(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return [
    "auth required",
    "authentication required",
    "authorization required",
    "credential required",
    "credentials required",
    "token required",
    "login required",
  ].some((needle) => normalized.includes(needle));
}

function isAcpAuthRequiredPayload(acp: OutputErrorAcpPayload | undefined): boolean {
  if (!acp) {
    return false;
  }
  if (!AUTH_REQUIRED_ACP_CODES.has(acp.code)) {
    return false;
  }
  if (isAuthRequiredMessage(acp.message)) {
    return true;
  }

  const data = asRecord(acp.data);
  if (!data) {
    return false;
  }

  return hasAuthRequiredData(data);
}

function hasAuthRequiredData(data: Record<string, unknown>): boolean {
  return (
    data.authRequired === true || hasNonEmptyString(data.methodId) || hasNonEmptyArray(data.methods)
  );
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function isOutputErrorCode(value: unknown): value is OutputErrorCode {
  return typeof value === "string" && OUTPUT_ERROR_CODES.includes(value as OutputErrorCode);
}

function isOutputErrorOrigin(value: unknown): value is OutputErrorOrigin {
  return typeof value === "string" && OUTPUT_ERROR_ORIGINS.includes(value as OutputErrorOrigin);
}

function readOutputErrorMeta(error: unknown): ErrorMeta {
  const record = asRecord(error);
  if (!record) {
    return {};
  }

  const outputCode = isOutputErrorCode(record.outputCode) ? record.outputCode : undefined;
  const detailCode =
    typeof record.detailCode === "string" && record.detailCode.trim().length > 0
      ? record.detailCode
      : undefined;
  const origin = isOutputErrorOrigin(record.origin) ? record.origin : undefined;
  const retryable = typeof record.retryable === "boolean" ? record.retryable : undefined;

  const acp = extractAcpError(record.acp);
  return {
    outputCode,
    detailCode,
    origin,
    retryable,
    acp,
  };
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function isLocalAbortOrTimeoutError(error: unknown): boolean {
  return (error instanceof Error && error.name === "AbortError") || isTimeoutLike(error);
}

function isNoSessionLike(error: unknown): boolean {
  return error instanceof Error && error.name === "NoSessionError";
}

function isUsageLike(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "CommanderError" ||
    error.name === "InvalidArgumentError" ||
    asRecord(error)?.code === "commander.invalidArgument"
  );
}

export function formatErrorMessage(error: unknown): string {
  return formatUnknownErrorMessage(error);
}

export { extractAcpError, isAcpResourceNotFoundError };

export function isAcpQueryClosedBeforeResponseError(error: unknown): boolean {
  const acp = extractAcpError(error);
  if (!acp || acp.code !== -32603) {
    return false;
  }

  const data = asRecord(acp.data);
  const details = data?.details;
  if (typeof details !== "string") {
    return false;
  }

  return details.toLowerCase().includes(QUERY_CLOSED_BEFORE_RESPONSE_DETAIL);
}

function mapErrorCode(error: unknown): OutputErrorCode | undefined {
  if (error instanceof PermissionPromptUnavailableError) {
    return "PERMISSION_PROMPT_UNAVAILABLE";
  }
  if (error instanceof PermissionDeniedError) {
    return "PERMISSION_DENIED";
  }
  if (isTimeoutLike(error)) {
    return "TIMEOUT";
  }
  if (isNoSessionLike(error) || isAcpResourceNotFoundError(error)) {
    return "NO_SESSION";
  }
  if (isUsageLike(error)) {
    return "USAGE";
  }
  return undefined;
}

export function normalizeOutputError(
  error: unknown,
  options: NormalizeOutputErrorOptions = {},
): NormalizedOutputError {
  const meta = readOutputErrorMeta(error);
  const code = resolveOutputErrorCode(error, options, meta);
  const acp = options.acp ?? meta.acp ?? extractAcpError(error);
  return {
    code,
    message: formatErrorMessage(error),
    detailCode: resolveDetailCode(error, acp, options, meta),
    origin: meta.origin ?? options.origin,
    retryable: meta.retryable ?? options.retryable,
    acp,
  };
}

function resolveOutputErrorCode(
  error: unknown,
  options: NormalizeOutputErrorOptions,
  meta: ErrorMeta,
): OutputErrorCode {
  const code = meta.outputCode ?? mapErrorCode(error) ?? options.defaultCode ?? "RUNTIME";
  if (code === "RUNTIME" && isAcpResourceNotFoundError(error)) {
    return "NO_SESSION";
  }
  return code;
}

function resolveDetailCode(
  error: unknown,
  acp: OutputErrorAcpPayload | undefined,
  options: NormalizeOutputErrorOptions,
  meta: ErrorMeta,
): string | undefined {
  return (
    meta.detailCode ??
    options.detailCode ??
    (error instanceof AuthPolicyError || isAcpAuthRequiredPayload(acp)
      ? "AUTH_REQUIRED"
      : undefined)
  );
}

/**
 * Returns true when an error from `client.prompt()` looks transient and
 * can reasonably be retried (e.g. model-API 400/500, network hiccups that
 * surface as ACP internal errors).
 *
 * Errors that are definitively non-recoverable (auth, missing session,
 * invalid params, timeout, permission) return false.
 */
export function isRetryablePromptError(error: unknown): boolean {
  if (isNonRetryablePromptError(error)) {
    return false;
  }

  const acp = extractAcpError(error);
  if (!acp) {
    // Non-ACP errors (e.g. process crash) are not retried at the prompt level.
    return false;
  }

  // ACP internal errors (-32603) typically wrap model-API failures → retryable.
  // Parse errors (-32700) can also be transient.
  return acp.code === -32603 || acp.code === -32700;
}

function isNonRetryablePromptError(error: unknown): boolean {
  return (
    error instanceof PermissionDeniedError ||
    error instanceof PermissionPromptUnavailableError ||
    isTimeoutLike(error) ||
    isNoSessionLike(error) ||
    isUsageLike(error)
  );
}

export function exitCodeForOutputErrorCode(code: OutputErrorCode): ExitCode {
  switch (code) {
    case "USAGE":
      return EXIT_CODES.USAGE;
    case "TIMEOUT":
      return EXIT_CODES.TIMEOUT;
    case "NO_SESSION":
      return EXIT_CODES.NO_SESSION;
    case "PERMISSION_DENIED":
    case "PERMISSION_PROMPT_UNAVAILABLE":
      return EXIT_CODES.PERMISSION_DENIED;
    case "RUNTIME":
    default:
      return EXIT_CODES.ERROR;
  }
}

const PROVIDER_SIGNALS: Readonly<Record<string, SafeErrorCategory>> = {
  usageLimitExceeded: "quota",
  quota_exhausted: "quota",
  insufficient_quota: "quota",
  rateLimitExceeded: "rate_limit",
  rate_limited: "rate_limit",
  rate_limit_exceeded: "rate_limit",
  sessionBudgetExceeded: "budget",
  budget_exhausted: "budget",
  unauthorized: "auth",
  auth_required: "auth",
  authentication_required: "auth",
};

const SAFE_MESSAGES: Record<SafeErrorCategory, string> = {
  quota: "Provider quota exhausted.",
  rate_limit: "Provider rate limit reached.",
  budget: "Provider session budget exhausted.",
  auth: "Provider authentication required.",
  cancelled: "ACP execution cancelled.",
  timeout: "ACP execution timed out.",
  permission: "ACP permission denied.",
  unknown: "ACP execution failed.",
};

/** Local operational sentences. Only an exact code or exact message is shown; provider text is never copied. */
const LOCAL_OPERATIONAL_MESSAGES = {
  ACP_CAPACITY_SOFT_LIMIT:
    "Automatic ACP capacity is full; retry after an active task or process finishes.",
  ACP_CAPACITY_HARD_LIMIT:
    "Device ACP capacity is full; retry after an active task or process finishes.",
  ACP_CAPACITY_MEMORY_LIMIT:
    "Available device memory is below the ACP startup reserve; retry after memory is freed.",
  ACP_CAPACITY_STATE_UNAVAILABLE:
    "ACP capacity state is unavailable; check the local host capacity state before retrying.",
} as const;

const SAFE_CODES = new Set<string>([
  ...OUTPUT_ERROR_CODES,
  "ACP_BACKEND_MISSING",
  "ACP_BACKEND_UNAVAILABLE",
  "ACP_BACKEND_UNSUPPORTED_CONTROL",
  "ACP_DISPATCH_DISABLED",
  "ACP_INVALID_RUNTIME_OPTION",
  "ACP_SESSION_INIT_FAILED",
  "ACP_TURN_FAILED",
  "ABORTED",
]);
const SAFE_DETAILS = new Set<string>([
  ...QUEUE_ERROR_DETAIL_CODES,
  "AUTH_REQUIRED",
  "AGENT_DISCONNECTED",
  "AGENT_SPAWN_ENOENT",
  "AGENT_STARTUP_FAILED",
  "SESSION_RESUME_REQUIRED",
  "SESSION_MODE_REPLAY_FAILED",
  "SESSION_MODEL_REPLAY_FAILED",
  "SESSION_CONFIG_OPTION_REPLAY_FAILED",
  "UNSUPPORTED_PROMPT_CONTENT",
  "WATCH_OUTCOME_UNKNOWN",
]);
const SAFE_ORIGINS = new Set<string>([
  ...OUTPUT_ERROR_ORIGINS,
  "service",
  "transport",
  "dsh",
  "a2a",
]);

type SafeErrorOptions = {
  origin?: SafeErrorOrigin;
  /** A caller-owned request identifier, never a provider message. */
  operationId?: string;
  outcomeUnknown?: boolean;
  /** Decode only a direct safe record from an owned boundary, never provider data. */
  trustedProjection?: boolean;
};

const safeProjections = new WeakSet<object>();

/** Only known envelope edges are visited, with both depth and node limits. */
function safeErrorRecords(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const pending = [{ value: error, depth: 0 }];
  while (pending.length && records.length < 24) {
    const entry = pending.shift();
    if (!entry || entry.depth > 5 || seen.has(entry.value)) {
      continue;
    }
    seen.add(entry.value);
    const record = asRecord(entry.value);
    if (!record) {
      continue;
    }
    records.push(record);
    for (const key of ["error", "acp", "cause", "data"]) {
      pending.push({ value: record[key], depth: entry.depth + 1 });
    }
  }
  return records;
}

function providerSignal(value: unknown): SafeErrorCategory | undefined {
  return typeof value === "string" && Object.hasOwn(PROVIDER_SIGNALS, value)
    ? PROVIDER_SIGNALS[value]
    : undefined;
}

type ProviderCause = {
  category?: SafeErrorCategory;
  providerCode?: string;
  conflict?: boolean;
};

function collectProviderSignal(state: ProviderCause, key: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  const candidate = providerSignal(value);
  if (!candidate) {
    state.conflict ||= !isNeutralErrorSignal(key, value);
    return;
  }
  state.conflict ||= state.category !== undefined && state.category !== candidate;
  state.category = candidate;
  state.providerCode ??= value as string;
}

function safeProviderCause(
  records: Record<string, unknown>[],
  projected: Record<string, unknown> | undefined,
): ProviderCause {
  const state: ProviderCause = {};
  for (const record of records) {
    for (const key of ["codexErrorInfo", "providerCode", "code", "type"]) {
      // providerCode belongs to our direct projection, never raw provider data.
      if (key === "providerCode" && record !== projected) {
        continue;
      }
      collectProviderSignal(state, key, record[key]);
    }
  }
  return state.conflict ? { conflict: true } : state;
}

function isNeutralErrorSignal(key: string, value: unknown): boolean {
  if (key === "code" && (value === -32603 || value === -32000)) {
    return true;
  }
  if (key === "code" && typeof value === "string" && SAFE_CODES.has(value)) {
    return true;
  }
  return key === "type" && value === "error";
}

function safeStringField(
  records: Record<string, unknown>[],
  key: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  for (const record of records) {
    const value = record[key];
    if (typeof value === "string" && allowed.has(value)) {
      return value;
    }
  }
  return undefined;
}

function safeOperationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value)
    ? value
    : undefined;
}

function hasProjectionFields(record: Record<string, unknown>): boolean {
  if (typeof record.category !== "string" || !Object.hasOwn(SAFE_MESSAGES, record.category)) {
    return false;
  }
  if (typeof record.origin !== "string" || !SAFE_ORIGINS.has(record.origin)) {
    return false;
  }
  return typeof record.retryable === "boolean" && typeof record.outcomeUnknown === "boolean";
}

function projectedRecord(
  error: unknown,
  options: SafeErrorOptions,
): Record<string, unknown> | undefined {
  const record = asRecord(error);
  if (
    !record ||
    (!safeProjections.has(record) && options.trustedProjection !== true) ||
    !hasProjectionFields(record)
  ) {
    return undefined;
  }
  return record;
}

function safeLocalCode(error: unknown): string | undefined {
  if (error instanceof Error && error.name === "AbortError") {
    return "ABORTED";
  }
  if (error instanceof PermissionPromptUnavailableError) {
    return "PERMISSION_PROMPT_UNAVAILABLE";
  }
  if (error instanceof PermissionDeniedError) {
    return "PERMISSION_DENIED";
  }
  if (isTimeoutLike(error)) {
    return "TIMEOUT";
  }
  if (isNoSessionLike(error)) {
    return "NO_SESSION";
  }
  if (isUsageLike(error)) {
    return "USAGE";
  }
  return undefined;
}

function localOperationalMessage(error: unknown): string | undefined {
  const known = new Set<string>(Object.values(LOCAL_OPERATIONAL_MESSAGES));
  for (const record of safeErrorRecords(error)) {
    const code = record.code;
    if (typeof code === "string" && Object.hasOwn(LOCAL_OPERATIONAL_MESSAGES, code)) {
      return LOCAL_OPERATIONAL_MESSAGES[code as keyof typeof LOCAL_OPERATIONAL_MESSAGES];
    }
    if (typeof record.message === "string" && known.has(record.message)) {
      return record.message;
    }
  }
  return undefined;
}

function localSafeCategory(error: unknown, code?: string, detailCode?: string): SafeErrorCategory {
  if (error instanceof AuthPolicyError || isAcpAuthRequiredPayload(extractAcpError(error))) {
    return "auth";
  }
  if (isTimeoutLike(error)) {
    return "timeout";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "cancelled";
  }
  const localCategories: Readonly<Record<string, SafeErrorCategory>> = {
    AUTH_REQUIRED: "auth",
    TIMEOUT: "timeout",
    PERMISSION_DENIED: "permission",
    PERMISSION_PROMPT_UNAVAILABLE: "permission",
    ABORTED: "cancelled",
  };
  return localCategories[detailCode ?? code ?? ""] ?? "unknown";
}

function safeCategory(
  error: unknown,
  projected: Record<string, unknown> | undefined,
  provider: ProviderCause,
  code?: string,
  detailCode?: string,
): SafeErrorCategory {
  const local = localSafeCategory(error, code, detailCode);
  if (local !== "unknown") {
    return local;
  }
  if (provider.conflict) {
    return "unknown";
  }
  return provider.category ?? (projected?.category as SafeErrorCategory | undefined) ?? "unknown";
}

function safeOutcomeUnknown(
  projected: Record<string, unknown> | undefined,
  options: SafeErrorOptions,
  detailCode?: string,
): boolean {
  return (
    options.outcomeUnknown === true ||
    projected?.outcomeUnknown === true ||
    new Set(["WATCH_OUTCOME_UNKNOWN", "AGENT_DISCONNECTED"]).has(detailCode ?? "")
  );
}

function safeOrigin(
  error: unknown,
  records: Record<string, unknown>[],
  options: SafeErrorOptions,
  projected: Record<string, unknown> | undefined,
): SafeErrorOrigin {
  const local = error instanceof AcpxOperationalError ? error.origin : undefined;
  const preserved = projected?.origin as SafeErrorOrigin | undefined;
  if (preserved) {
    return preserved;
  }
  if (local) {
    return local;
  }
  const fallbackOrigin = options.origin ?? "runtime";
  if (isLocalAbortOrTimeoutError(error)) {
    return fallbackOrigin;
  }
  if (records.some((record) => typeof record.code === "number")) {
    return "acp";
  }
  return fallbackOrigin;
}

function localErrorRecord(
  error: unknown,
  projected: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!projected && error instanceof AcpRuntimeError) {
    return { code: error.code };
  }
  return projected ?? (error instanceof AcpxOperationalError ? asRecord(error) : undefined);
}

function safeCode(
  error: unknown,
  projected: Record<string, unknown> | undefined,
): string | undefined {
  const local = localErrorRecord(error, projected);
  const records = local ? [local] : [];
  return (
    safeStringField(records, "outputCode", SAFE_CODES) ??
    safeStringField(records, "code", SAFE_CODES) ??
    safeLocalCode(error)
  );
}

function safeDetailCode(
  error: unknown,
  projected: Record<string, unknown> | undefined,
): string | undefined {
  const record = localErrorRecord(error, projected);
  return safeStringField(record ? [record] : [], "detailCode", SAFE_DETAILS);
}

function safeOptionalFields(
  projected: Record<string, unknown> | undefined,
  options: SafeErrorOptions,
  provider: ProviderCause,
  code?: string,
  detailCode?: string,
): Partial<SafeError> {
  const operationId =
    safeOperationId(options.operationId) ?? safeOperationId(projected?.operationId);
  return {
    ...(provider.providerCode ? { providerCode: provider.providerCode } : {}),
    ...(operationId ? { operationId } : {}),
    ...(code ? { code } : {}),
    ...(detailCode ? { detailCode } : {}),
  };
}

/**
 * Public bridge projection. No provider text, URLs, arbitrary data or unknown
 * codes are copied. Resource categories describe failures, not retry policy.
 */
export function toSafeError(error: unknown, options: SafeErrorOptions = {}): SafeError {
  const projected = projectedRecord(error, options);
  const records = projected ? [projected] : safeErrorRecords(error);
  const provider = safeProviderCause(records, projected);
  const code = safeCode(error, projected);
  const detailCode = safeDetailCode(error, projected);
  const category = safeCategory(error, projected, provider, code, detailCode);
  const safe: SafeError = {
    ...safeOptionalFields(projected, options, provider, code, detailCode),
    message: localOperationalMessage(error) ?? SAFE_MESSAGES[category],
    category,
    retryable:
      projected?.retryable === true ||
      (error instanceof AcpxOperationalError && error.retryable === true),
    outcomeUnknown: safeOutcomeUnknown(projected, options, detailCode),
    origin: safeOrigin(error, records, options, projected),
  };
  safeProjections.add(safe);
  return safe;
}

/** Keep projection provenance when the runtime exposes a promise rejection. */
export function safeErrorRejection(error: SafeError): Error {
  const safe = toSafeError(error);
  const rejection = Object.assign(new Error(safe.message), safe);
  safeProjections.add(rejection);
  return rejection;
}
