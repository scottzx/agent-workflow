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
  const message = typeof record.message === 'string' ? record.message : '';
  const retryable = record.retryable === true;
  const outcomeUnknown = record.outcomeUnknown === true;
  const providerCode = optionalString(record.providerCode);
  const code = optionalString(record.code);
  const detailCode = optionalString(record.detailCode);
  const origin = optionalString(record.origin, origins);
  return {
    category: category as SafeErrorCategory,
    message: message.slice(0, 512),
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
