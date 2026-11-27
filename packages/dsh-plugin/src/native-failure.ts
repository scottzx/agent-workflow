/**
 * Native DSH turn failures, projected into the runtime's public error model.
 *
 * A native `standard` session ends a failed turn with DSH's own failure record
 * and no ACP diagnostic. That record names the cause; the plugin only reads
 * its structured facts and hands the runtime a signal it recognizes. Host text,
 * tokens and stacks never enter the projection.
 */
import { toSafeError } from '@1agents/acp-service/runtime';

/** The runtime's own public failure signals. The runtime classifies them. */
export type NativeFailureSignal =
  | 'quota_exhausted' | 'rateLimitExceeded' | 'sessionBudgetExceeded' | 'unauthorized' | 'TIMEOUT';

/**
 * DSH's own stable failure codes. DSH normalizes a provider failure into this
 * vocabulary before the turn ends, so these are host facts.
 *
 * A provider-shaped code (`usageLimitExceeded`, `quota_exhausted`,
 * `unauthorized`, ...) is deliberately absent: such a string may be written by
 * any producer, and a turn reason without the canonical `publicError` must not
 * let it establish a cause.
 */
const nativeFailureCodes: Record<string, NativeFailureSignal> = {
  QUOTA: 'quota_exhausted', ACCOUNT_QUOTA: 'quota_exhausted',
  RATE_LIMIT: 'rateLimitExceeded',
  AUTH: 'unauthorized', ACCOUNT_SIGN_IN_REQUIRED: 'unauthorized', ACCOUNT_TOKEN_INVALID: 'unauthorized',
  INVALID_CREDENTIAL: 'unauthorized', MISSING_CREDENTIAL: 'unauthorized', NO_CREDENTIAL_STORE: 'unauthorized',
  TIMEOUT: 'TIMEOUT',
};

/** HTTP statuses that name a failure class on their own. */
const nativeFailureStatuses: Record<number, NativeFailureSignal> = {
  401: 'unauthorized', 402: 'quota_exhausted', 403: 'unauthorized',
  408: 'TIMEOUT', 429: 'rateLimitExceeded', 504: 'TIMEOUT',
};

/** Look up an allowlisted signal without touching inherited object members. */
function signalOf(table: Record<string, NativeFailureSignal>, key: string): NativeFailureSignal | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The structured facts of one failure record. Host text is read but never forwarded. */
export interface NativeFailureFacts { code?: string; status?: number; message?: string }

/** Read a failure record's own fields only; nested provider envelopes are never opened. */
export function nativeFailureFacts(source: unknown): NativeFailureFacts | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const code = Object.hasOwn(record, 'code') && typeof record.code === 'string' ? record.code : undefined;
  const status = Object.hasOwn(record, 'status') && typeof record.status === 'number'
    && Number.isInteger(record.status) && record.status >= 100 && record.status <= 599 ? record.status : undefined;
  const message = Object.hasOwn(record, 'message') && typeof record.message === 'string' ? record.message : undefined;
  if (code === undefined && status === undefined && message === undefined) return undefined;
  return {
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(message === undefined ? {} : { message }),
  };
}

/** The failure record of a native turn: DSH's failure record, or the turn reason itself. */
export function nativeFailureRecord(reason: unknown): unknown {
  const record = reason as { error?: unknown } | undefined;
  if (record && typeof record === 'object' && record.error !== undefined && record.error !== null) return record.error;
  return reason;
}

/**
 * The runtime signal a native failure names, if any. Only DSH's own stable
 * codes and an explicit HTTP status are trusted; prose and provider-shaped
 * codes never establish a cause.
 */
export function nativeFailureSignal(facts: NativeFailureFacts | undefined): NativeFailureSignal | undefined {
  if (!facts) return undefined;
  const code = facts.code;
  if (code) {
    const host = signalOf(nativeFailureCodes, code);
    if (host) return host;
    const http = /^HTTP_(\d{3})$/u.exec(code);
    if (http) { const byStatus = nativeFailureStatuses[Number(http[1])]; if (byStatus) return byStatus; }
  }
  if (facts.status !== undefined) { const byStatus = nativeFailureStatuses[facts.status]; if (byStatus) return byStatus; }
  return undefined;
}

/**
 * Project a native DSH turn failure into the runtime's whitelisted SafeError.
 * The runtime classifies the signal and regenerates the public message, so the
 * host's failure text, tokens and stacks never reach the caller.
 */
export function nativeFailureSafeError(signal: NativeFailureSignal | undefined, operationId: string): ReturnType<typeof toSafeError> {
  if (!signal) return toSafeError(undefined, { origin: 'dsh', operationId });
  // The runtime classifies a local timeout through its own TimeoutError rule.
  const payload = signal === 'TIMEOUT' ? Object.assign(new Error('timeout'), { name: 'TimeoutError' }) : { code: signal };
  return toSafeError(payload, { origin: 'dsh', operationId });
}

/** The public error of a native turn failure, or of a turn without a readable cause. */
export function nativeTurnSafeError(reason: unknown, operationId: string, fallback?: unknown): ReturnType<typeof toSafeError> {
  const signal = nativeFailureSignal(nativeFailureFacts(nativeFailureRecord(reason)))
    ?? nativeFailureSignal(nativeFailureFacts(fallback));
  return nativeFailureSafeError(signal, operationId);
}
