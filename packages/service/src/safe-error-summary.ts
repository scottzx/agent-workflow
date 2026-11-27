/** The whitelisted failure facts a remote task, ledger record or notice may carry. */
import type { SafeErrorCategory, SafeErrorOrigin } from '@1agents/acp-service/runtime';

/**
 * A bounded projection of the runtime's SafeError. Only these fields are
 * carried; provider text, credentials and arbitrary data never are.
 */
export interface SafeErrorSummary {
  category: SafeErrorCategory;
  message: string;
  retryable: boolean;
  outcomeUnknown?: boolean;
  providerCode?: string;
  code?: string;
  detailCode?: string;
  origin?: SafeErrorOrigin;
}

const categories: ReadonlySet<string> = new Set<SafeErrorCategory>([
  'quota', 'rate_limit', 'budget', 'auth', 'cancelled', 'timeout', 'permission', 'unknown',
]);
const origins: ReadonlySet<string> = new Set<SafeErrorOrigin>([
  'cli', 'runtime', 'queue', 'acp', 'service', 'transport', 'dsh', 'a2a',
]);

/** A machine code is a short identifier. Anything else is not a code. */
const identifier = /^[A-Za-z0-9._:-]{1,64}$/u;

/** Control characters and line breaks never belong in a rendered field. */
const control = /[\u0000-\u001f\u007f]+/gu;

/** Strip control characters, collapse whitespace and bound the length of a rendered text. */
export function safeErrorText(value: unknown, limit = 512): string {
  if (typeof value !== 'string') return '';
  return value.replace(control, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function optionalIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || !identifier.test(value)) return undefined;
  return value;
}

function optionalString(value: unknown, allowed?: ReadonlySet<string>): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (allowed && !allowed.has(value)) return undefined;
  return value;
}

/**
 * Project a remote failure into the whitelisted summary. A malformed or
 * unrecognised record yields no summary rather than a partial one.
 */
export function safeErrorSummary(value: unknown): SafeErrorSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const category = optionalString(record.category);
  if (!category || !categories.has(category)) return undefined;
  const retryable = record.retryable === true;
  const outcomeUnknown = record.outcomeUnknown === true;
  const providerCode = optionalIdentifier(record.providerCode);
  const code = optionalIdentifier(record.code);
  const detailCode = optionalIdentifier(record.detailCode);
  const origin = optionalString(record.origin, origins);
  return {
    category: category as SafeErrorCategory,
    message: safeErrorText(record.message),
    retryable,
    ...(outcomeUnknown ? { outcomeUnknown } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(code ? { code } : {}),
    ...(detailCode ? { detailCode } : {}),
    ...(origin ? { origin: origin as SafeErrorOrigin } : {}),
  };
}

/**
 * The compact failure facts a notice carries: the cause, its retry policy and
 * the safe public message, without the transport bookkeeping.
 */
export function noticeErrorSummary(value: unknown): SafeErrorSummary | undefined {
  const summary = safeErrorSummary(value);
  if (!summary) return undefined;
  return {
    category: summary.category, message: summary.message, retryable: summary.retryable,
    ...(summary.outcomeUnknown !== undefined ? { outcomeUnknown: summary.outcomeUnknown } : {}),
    ...(summary.providerCode ? { providerCode: summary.providerCode } : {}),
    ...(summary.code ? { code: summary.code } : {}),
  };
}
