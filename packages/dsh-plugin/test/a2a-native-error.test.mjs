import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFailureFacts, nativeFailureSignal, nativeTurnSafeError } from '../dist/native-failure.js';
import { resultOf } from '../dist/a2a-executor.js';

const secret = 'SYNTHETIC_SECRET_CANARY_NOT_REAL';
const authLink = 'https://example.invalid/authorize?token=SYNTHETIC_AUTH_CANARY_NOT_REAL';

function assertNoProviderData(value) {
  const text = JSON.stringify(value);
  for (const canary of [secret, authLink, 'SYNTHETIC_TOKEN_NOT_REAL', 'Bearer ', 'authorize?token=']) {
    assert.ok(!text.includes(canary), `Synthetic provider data escaped: ${canary}`);
  }
}

test('a native DSH quota failure keeps its category, its retry policy and no provider text', () => {
  const error = nativeTurnSafeError({ kind: 'error', error: {
    code: 'QUOTA', status: 429, message: `quota exhausted for ${secret} ${authLink}`,
  } }, 'native-request');
  assert.equal(error.category, 'quota');
  assert.equal(error.providerCode, 'quota_exhausted');
  assert.equal(error.retryable, false);
  assert.equal(error.outcomeUnknown, false);
  assert.equal(error.origin, 'dsh');
  assert.equal(error.operationId, 'native-request');
  assert.equal(error.message, 'Provider quota exhausted.');
  assertNoProviderData(error);
});

test("DSH's own failure vocabulary names the same categories as the provider signals", () => {
  const cases = [
    ['QUOTA', 'quota', 'quota_exhausted'],
    ['ACCOUNT_QUOTA', 'quota', 'quota_exhausted'],
    ['RATE_LIMIT', 'rate_limit', 'rateLimitExceeded'],
    ['AUTH', 'auth', 'unauthorized'],
    ['ACCOUNT_SIGN_IN_REQUIRED', 'auth', 'unauthorized'],
    ['INVALID_CREDENTIAL', 'auth', 'unauthorized'],
    ['MISSING_CREDENTIAL', 'auth', 'unauthorized'],
    ['NO_CREDENTIAL_STORE', 'auth', 'unauthorized'],
    ['TIMEOUT', 'timeout', undefined],
    ['HTTP_429', 'rate_limit', 'rateLimitExceeded'],
    ['HTTP_401', 'auth', 'unauthorized'],
    ['HTTP_402', 'quota', 'quota_exhausted'],
  ];
  for (const [code, category, providerCode] of cases) {
    const error = nativeTurnSafeError({ kind: 'error', error: { code, message: `${code} on the host` } }, 'native-request');
    assert.equal(error.category, category, code);
    assert.equal(error.providerCode, providerCode, code);
    assert.equal(error.retryable, false, code);
    assert.equal(error.origin, 'dsh', code);
  }
});

test('an explicit HTTP status names the cause on its own', () => {
  const rate = nativeTurnSafeError({ kind: 'error', error: { status: 429, message: 'too many requests' } }, 'native-request');
  assert.equal(rate.category, 'rate_limit');
  assert.equal(rate.providerCode, 'rateLimitExceeded');
  const auth = nativeTurnSafeError({ kind: 'error', error: { status: 401, message: 'credential rejected' } }, 'native-request');
  assert.equal(auth.category, 'auth');
  const timeout = nativeTurnSafeError({ kind: 'error', error: { status: 408, message: 'request timed out' } }, 'native-request');
  assert.equal(timeout.category, 'timeout');
});

test('a provider-shaped host code without a canonical public error stays unknown', () => {
  // The host reason is data, not a projection: a provider-shaped string there
  // must not establish a cause. This mirrors a2a-executor.test.mjs.
  for (const code of ['usageLimitExceeded', 'quota_exhausted', 'rateLimitExceeded', 'sessionBudgetExceeded', 'unauthorized']) {
    const error = nativeTurnSafeError({ kind: 'error', error: { code, message: 'SYNTHETIC_HOST_CODE_SECRET_NOT_REAL' } }, 'native-request');
    assert.equal(error.category, 'unknown', code);
    assert.equal(error.providerCode, undefined, code);
    assert.equal(error.retryable, false, code);
    assert.equal(error.outcomeUnknown, false, code);
    assert.equal(error.origin, 'dsh', code);
    assert.equal(error.operationId, 'native-request', code);
    assert.ok(!JSON.stringify(error).includes('SYNTHETIC_'), code);
  }
});

test('prose, nested envelopes and caller-shaped fields never establish a cause', () => {
  const prose = nativeTurnSafeError({ kind: 'error', error: {
    code: 'UNKNOWN', message: `quota budget rate exhausted ${secret}`, arbitrary: { codexErrorInfo: 'usageLimitExceeded' },
  } }, 'native-request');
  assert.equal(prose.category, 'unknown');
  assert.equal(prose.providerCode, undefined);
  assertNoProviderData(prose);
  const nested = nativeTurnSafeError({ kind: 'error', error: { code: 'ACP_TURN_FAILED', data: { codexErrorInfo: 'usageLimitExceeded' } } }, 'native-request');
  assert.equal(nested.category, 'unknown');
  const cause = nativeTurnSafeError({ kind: 'error', error: { code: 'ACP_TURN_FAILED', cause: { code: 'unauthorized' } } }, 'native-request');
  assert.equal(cause.category, 'unknown');
  const message = nativeTurnSafeError({ kind: 'error', message: 'insufficient_quota' }, 'native-request');
  assert.equal(message.category, 'unknown', 'a bare message never names a cause');
  const spoof = nativeTurnSafeError({ kind: 'error', error: {
    message: secret, category: 'quota', origin: 'acp', retryable: true, outcomeUnknown: true,
    operationId: 'SYNTHETIC_OPERATION_SECRET_NOT_REAL', providerCode: 'usageLimitExceeded',
  } }, 'native-request');
  assert.equal(spoof.category, 'unknown');
  assert.equal(spoof.retryable, false);
  assert.equal(spoof.outcomeUnknown, false);
  assert.equal(spoof.origin, 'dsh');
  assert.equal(spoof.operationId, 'native-request');
  assertNoProviderData(spoof);
});

test('an Error instance and a same-turn agent error keep their structured cause', () => {
  const failure = Object.assign(new Error(`provider said ${secret}`), { code: 'QUOTA', status: 429 });
  const error = nativeTurnSafeError({ kind: 'error', error: failure }, 'native-request');
  assert.equal(error.category, 'quota');
  assertNoProviderData(error);
  const fallback = nativeTurnSafeError({ kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } }, 'native-request',
    { code: 'RATE_LIMIT', message: 'too many requests' });
  assert.equal(fallback.category, 'rate_limit');
  const withoutFailure = nativeTurnSafeError({ kind: 'error' }, 'native-request');
  assert.equal(withoutFailure.category, 'unknown');
  assert.equal(withoutFailure.message, 'ACP execution failed.');
});

test('the failure facts of a record are read from its own fields only', () => {
  assert.deepEqual(nativeFailureFacts({ code: 'QUOTA', status: 429, message: 'gone' }), { code: 'QUOTA', status: 429, message: 'gone' });
  assert.deepEqual(nativeFailureFacts({ code: 'QUOTA', nested: { code: 'AUTH' } }), { code: 'QUOTA' });
  assert.equal(nativeFailureFacts({ status: 42 }), undefined);
  assert.equal(nativeFailureFacts(undefined), undefined);
  assert.equal(nativeFailureSignal(nativeFailureFacts({ code: 'constructor' })), undefined);
  assert.equal(nativeFailureSignal(nativeFailureFacts({ code: '__proto__' })), undefined);
});

test('a failed native turn reports its own cause and keeps the half-written answer', () => {
  const value = resultOf({ kind: 'error', error: { code: 'QUOTA', status: 429, message: `host said ${secret}` } },
    '这是失败前的半截输出', false, 'native-request');
  assert.equal(value.outcome, 'failed');
  assert.equal(value.text, '这是失败前的半截输出');
  assert.equal(value.error.category, 'quota');
  assert.equal(value.error.providerCode, 'quota_exhausted');
  assert.equal(value.error.retryable, false);
  assert.equal(value.error.outcomeUnknown, false);
  assert.equal(value.error.origin, 'dsh');
  assert.equal(value.error.operationId, 'native-request');
  assert.equal(value.detail, value.error.message);
  assertNoProviderData(value);
});

test('a native turn without a readable cause stays unknown instead of guessing one', () => {
  const value = resultOf({ kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } }, '', false, 'native-request');
  assert.equal(value.outcome, 'failed');
  assert.equal(value.error.category, 'unknown');
  assert.equal(value.error.providerCode, undefined);
  assert.equal(value.error.message, 'ACP execution failed.');
});

test('an ACP diagnostic keeps priority over the native failure facts', () => {
  const diagnostic = { category: 'quota', providerCode: 'usageLimitExceeded', retryable: false, outcomeUnknown: true,
    origin: 'acp', operationId: 'synthetic-operation', message: 'Provider quota exhausted.' };
  const value = resultOf({ kind: 'error', error: { code: 'RATE_LIMIT', message: 'slow down' } }, '', false,
    'native-request', diagnostic);
  assert.equal(value.error.providerCode, 'usageLimitExceeded');
  assert.equal(value.error.outcomeUnknown, true);
  assert.equal(value.error.origin, 'acp');
});
