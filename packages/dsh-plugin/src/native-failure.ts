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
 * Failure codes a native DSH turn may carry. DSH normalizes provider failures
 * into its own vocabulary before the turn ends, and the public category names
 * are accepted as well. A provider-shaped code is trusted only inside a real
 * failure record; see {@link nativeFailureSignal}.
 */
const nativeFailureCodes: Record<string, NativeFailureSignal> = {
  // DSH's own normalized failure codes.
  QUOTA: 'quota_exhausted', ACCOUNT_QUOTA: 'quota_exhausted',
  RATE_LIMIT: 'rateLimitExceeded',
  AUTH: 'unauthorized', ACCOUNT_SIGN_IN_REQUIRED: 'unauthorized', ACCOUNT_TOKEN_INVALID: 'unauthorized',
  INVALID_CREDENTIAL: 'unauthorized', MISSING_CREDENTIAL: 'unauthorized', NO_CREDENTIAL_STORE: 'unauthorized',
  TIMEOUT: 'TIMEOUT',
  // Public category names a host may use directly.
  quota: 'quota_exhausted', rate_limit: 'rateLimitExceeded', budget: 'sessionBudgetExceeded',
  auth: 'unauthorized', timeout: 'TIMEOUT',
};

/**
 * Provider-shaped codes. They name a cause only inside a real failure record:
 * DSH's failure record always carries the host's failure text or the HTTP status
 * that produced it, while a lone provider-shaped string carries no failure
 * context and never establishes a cause on its own.
 */
const providerFailureCodes: Record<string, NativeFailureSignal> = {
  quota_exhausted: 'quota_exhausted', insufficient_quota: 'quota_exhausted', usageLimitExceeded: 'quota_exhausted',
  usage_limit_exceeded: 'quota_exhausted',
  rateLimitExceeded: 'rateLimitExceeded', rate_limited: 'rateLimitExceeded', rate_limit_exceeded: 'rateLimitExceeded',
  sessionBudgetExceeded: 'sessionBudgetExceeded', budget_exhausted: 'sessionBudgetExceeded',
  unauthorized: 'unauthorized', auth_required: 'unauthorized', authentication_required: 'unauthorized',
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

/** The runtime signal a native failure names, if any. */
export function nativeFailureSignal(facts: NativeFailureFacts | undefined): NativeFailureSignal | undefined {
  if (!facts) return undefined;
  const code = facts.code;
  if (code) {
    const host = signalOf(nativeFailureCodes, code);
    if (host) return host;
    const http = /^HTTP_(\d{3})$/u.exec(code);
    if (http) { const byStatus = nativeFailureStatuses[Number(http[1])]; if (byStatus) return byStatus; }
    // A provider-shaped code names the cause only inside a real failure record.
    if (facts.message !== undefined || facts.status !== undefined) {
      const provider = signalOf(providerFailureCodes, code);
      if (provider) return provider;
    }
  }
  if (facts.status !== undefined) { const byStatus = nativeFailureStatuses[facts.status]; if (byStatus) return byStatus; }
  // A message that is exactly a signal names the cause; prose never does.
  const message = facts.message?.trim();
  if (message) return signalOf(nativeFailureCodes, message) ?? signalOf(providerFailureCodes, message);
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
