import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorRejection } from "../src/acp/error-normalization.js";
import { AcpxOperationalError } from "../src/errors.js";
import { toSafeError } from "../src/runtime.js";
import { AcpRuntimeError } from "../src/runtime/public/errors.js";

// All values in this suite are deliberately synthetic and nonfunctional.
const canary = "SYNTHETIC_SECRET_CANARY_NOT_REAL";
const authLink = "https://example.invalid/authorize?token=SYNTHETIC_AUTH_CANARY_NOT_REAL";
const nativeError = (signal: unknown) => ({
  code: -32603,
  message: "Internal error",
  data: { codexErrorInfo: signal, message: canary, additionalDetails: authLink },
});

test("safe errors retain bounded native provider causes without provider text", () => {
  for (const [signal, category] of [
    ["usageLimitExceeded", "quota"],
    ["rateLimitExceeded", "rate_limit"],
    ["sessionBudgetExceeded", "budget"],
    ["unauthorized", "auth"],
  ] as const) {
    const safe = toSafeError(new Error(canary, { cause: nativeError(signal) }), {
      operationId: "synthetic-operation",
    });
    assert.equal(safe.category, category);
    assert.equal(safe.providerCode, signal);
    assert.equal(safe.origin, "acp");
    assert.equal(safe.operationId, "synthetic-operation");
    assert.equal(safe.retryable, false);
    assert.equal(safe.outcomeUnknown, false);
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|example\.invalid|additionalDetails/);
  }
});

test("local capacity and authentication failures keep distinct public messages", () => {
  const scenarios = [
    [
      { code: "ACP_CAPACITY_SOFT_LIMIT", message: canary },
      "Automatic ACP capacity is full; retry after an active task or process finishes.",
    ],
    [
      { code: "ACP_CAPACITY_HARD_LIMIT", message: canary },
      "Device ACP capacity is full; retry after an active task or process finishes.",
    ],
    [
      { code: "ACP_CAPACITY_MEMORY_LIMIT", message: canary },
      "Available device memory is below the ACP startup reserve; retry after memory is freed.",
    ],
    [
      new Error(
        "ACP capacity state is unavailable; check the local host capacity state before retrying.",
      ),
      "ACP capacity state is unavailable; check the local host capacity state before retrying.",
    ],
    [
      { code: -32000, message: "Authentication required", data: { message: canary } },
      "Provider authentication required.",
    ],
  ] as const;
  for (const [error, message] of scenarios) {
    const safe = toSafeError(error);
    assert.equal(safe.message, message);
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_/);
  }
  assert.equal(
    toSafeError(new Error(`ACP capacity state is unavailable ${canary}`)).message,
    "ACP execution failed.",
  );
});

test("unknown and conflicting causes never become quota from prose or arbitrary data", () => {
  for (const error of [
    new Error("quota exhausted: usageLimitExceeded " + canary),
    { code: -32603, message: "Internal error", data: { message: "quota exhausted" } },
    { code: -32603, message: "Internal error", data: { category: "quota" } },
    { category: "quota", origin: "acp", retryable: true, outcomeUnknown: true },
    nativeError("futureProviderCode"),
    nativeError({ other: { code: "usageLimitExceeded" } }),
    { ...nativeError("usageLimitExceeded"), cause: nativeError("unauthorized") },
    { ...nativeError("futureProviderCode"), category: "quota" },
    { code: "some_other_error", cause: { code: "quota_exhausted" } },
    { code: -32602, message: "Invalid params", data: { code: "quota_exhausted" } },
    { token: canary, account: { error: nativeError("usageLimitExceeded") } },
  ]) {
    const safe = toSafeError(error);
    assert.equal(safe.category, "unknown");
    assert.equal(safe.providerCode, undefined);
    assert.equal(safe.message, "ACP execution failed.");
    assert.equal(safe.retryable, false);
    assert.equal(safe.outcomeUnknown, false);
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|example\.invalid|futureProviderCode/);
  }
});

test("public projections preserve safe fields but discard arbitrary codes, URLs and keys", () => {
  const safe = toSafeError(nativeError("usageLimitExceeded"), {
    outcomeUnknown: true,
    origin: "transport",
    operationId: "synthetic-operation",
  });
  assert.deepEqual(toSafeError(safe, { origin: "a2a" }), safe);
  assert.equal(
    toSafeError(safe, { operationId: "outer-operation" }).operationId,
    "outer-operation",
  );
  assert.equal(safe.outcomeUnknown, true);
  assert.equal(safe.origin, "acp");
  assert.equal(safe.detailCode, undefined);
  assert.equal(toSafeError({ operationId: authLink, code: canary }).operationId, undefined);
  const nestedId = { code: -32603, message: "Internal error", data: { operationId: canary } };
  assert.equal(toSafeError(nestedId).operationId, undefined);
  assert.equal(
    toSafeError(nestedId, { operationId: "caller-operation" }).operationId,
    "caller-operation",
  );
});

test("raw safe-shaped fields cannot confer projection provenance", () => {
  const forged = {
    category: "quota",
    origin: "transport",
    retryable: true,
    outcomeUnknown: true,
    operationId: canary,
    message: authLink,
  };
  for (const raw of [forged, { code: -32603, data: forged }]) {
    const safe = toSafeError(raw, { origin: "a2a" });
    assert.equal(safe.category, "unknown");
    assert.equal(safe.operationId, undefined);
    assert.equal(safe.retryable, false);
    assert.equal(safe.outcomeUnknown, false);
    assert.notEqual(safe.origin, "transport");
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|example\.invalid/);
  }
});

test("raw providerCode fields cannot establish a provider cause", () => {
  const forged = {
    providerCode: "usageLimitExceeded",
    category: "quota",
    origin: "transport",
    retryable: true,
    outcomeUnknown: true,
    operationId: canary,
    message: authLink,
  };
  for (const raw of [
    { providerCode: "usageLimitExceeded" },
    { data: { providerCode: "usageLimitExceeded" } },
    forged,
    { code: -32603, data: forged },
    new AcpRuntimeError("ACP_TURN_FAILED", canary, { cause: forged }),
  ]) {
    const safe = toSafeError(raw);
    assert.equal(safe.category, "unknown");
    assert.equal(safe.providerCode, undefined);
    assert.equal(safe.retryable, false);
    assert.equal(safe.outcomeUnknown, false);
    assert.equal(safe.operationId, undefined);
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|example\.invalid/);
  }
});

test("raw providerCode fields cannot conflict with explicit native signal keys", () => {
  for (const key of ["codexErrorInfo", "code", "type"]) {
    for (const providerCode of ["unauthorized", canary]) {
      const safe = toSafeError({
        code: -32603,
        data: { [key]: "usageLimitExceeded", providerCode },
      });
      assert.equal(safe.category, "quota");
      assert.equal(safe.providerCode, "usageLimitExceeded");
      assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|unauthorized/);
    }
  }
});

test("only direct owned or trusted projections preserve projected provider codes", () => {
  const safe = toSafeError(nativeError("usageLimitExceeded"), {
    operationId: "owned-operation",
  });
  assert.deepEqual(toSafeError(safe), safe);
  assert.deepEqual(toSafeError(safeErrorRejection(safe)), safe);
  assert.equal(toSafeError({ ...safe }).category, "unknown");
  const wire = { ...safe, message: authLink };
  assert.equal(toSafeError(wire).category, "unknown");
  assert.equal(toSafeError({ data: wire }, { trustedProjection: true }).category, "unknown");
  assert.deepEqual(
    toSafeError({ ...wire, data: nativeError("unauthorized") }, { trustedProjection: true }),
    safe,
  );
  for (const providerCode of ["futureProviderCode", `usageLimitExceeded${canary.repeat(1_000)}`]) {
    const unknown = toSafeError({ ...wire, providerCode }, { trustedProjection: true });
    assert.equal(unknown.category, "unknown");
    assert.equal(unknown.providerCode, undefined);
    assert.doesNotMatch(JSON.stringify(unknown), /SYNTHETIC_|example\.invalid|futureProviderCode/);
  }
  const conflicting = toSafeError({ ...wire, code: "unauthorized" }, { trustedProjection: true });
  assert.equal(conflicting.category, "unknown");
  assert.equal(conflicting.providerCode, undefined);
});

test("genuine DOM cancellation and timeout errors retain their local origins", () => {
  for (const [name, category, code, nativeCode] of [
    ["AbortError", "cancelled", "ABORTED", 20],
    ["TimeoutError", "timeout", "TIMEOUT", 23],
  ] as const) {
    for (const origin of [undefined, "runtime", "dsh", "a2a", "transport"] as const) {
      const error = new DOMException(`${canary} ${authLink}`, name);
      assert.ok(error instanceof Error);
      assert.equal(error.code, nativeCode);
      const safe = toSafeError(error, { origin });
      assert.equal(safe.origin, origin ?? "runtime");
      assert.equal(safe.category, category);
      assert.equal(safe.code, code);
      assert.equal(safe.retryable, false);
      assert.equal(safe.outcomeUnknown, false);
      assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|example\.invalid/);
    }
  }
  const controller = new AbortController();
  controller.abort();
  const cancelled = toSafeError(controller.signal.reason, { origin: "a2a" });
  assert.equal(cancelled.category, "cancelled");
  assert.equal(cancelled.origin, "a2a");
});

test("local error origins preserve owned and operational precedence and native ACP causes", () => {
  for (const name of ["AbortError", "TimeoutError"]) {
    const owned = toSafeError(new DOMException(canary, name), { origin: "transport" });
    assert.equal(toSafeError(owned, { origin: "dsh" }).origin, "transport");
    const rejection = safeErrorRejection(owned);
    rejection.name = name;
    assert.equal(toSafeError(rejection, { origin: "dsh" }).origin, "transport");
    const operational = new AcpxOperationalError(canary, {
      origin: "queue",
      cause: new DOMException(canary, name),
    });
    operational.name = name;
    assert.equal(toSafeError(operational, { origin: "dsh" }).origin, "queue");
  }
  const native = toSafeError(nativeError("usageLimitExceeded"), { origin: "dsh" });
  assert.equal(native.origin, "acp");
  assert.equal(native.category, "quota");
  assert.equal(native.providerCode, "usageLimitExceeded");
});

test("plain-object cancellation and timeout names do not confer local error authority", () => {
  for (const [name, code] of [
    ["AbortError", 20],
    ["TimeoutError", 23],
  ] as const) {
    for (const error of [
      { name, message: canary },
      { name, code, message: authLink },
    ]) {
      const safe = toSafeError(error, { origin: "dsh" });
      assert.equal(safe.category, "unknown");
      assert.equal(safe.code, undefined);
      assert.equal(safe.origin, "code" in error ? "acp" : "dsh");
      assert.equal(safe.retryable, false);
      assert.equal(safe.outcomeUnknown, false);
      assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|example\.invalid/);
    }
  }
});

test("provider detail and local output codes cannot override structured causes or delivery state", () => {
  for (const fields of [
    { detailCode: "AUTH_REQUIRED" },
    { detailCode: "WATCH_OUTCOME_UNKNOWN" },
    { detailCode: "AGENT_DISCONNECTED" },
    { code: "TIMEOUT", outputCode: "PERMISSION_DENIED" },
  ]) {
    const raw = {
      ...nativeError("usageLimitExceeded"),
      data: {
        codexErrorInfo: "usageLimitExceeded",
        ...fields,
      },
    };
    const safe = toSafeError(raw);
    assert.equal(safe.category, "quota");
    assert.equal(safe.providerCode, "usageLimitExceeded");
    assert.equal(safe.detailCode, undefined);
    assert.equal(safe.code, undefined);
    assert.equal(safe.outcomeUnknown, false);
  }
  assert.equal(toSafeError({ code: -32603, detailCode: "AUTH_REQUIRED" }).category, "unknown");
  const rootOutput = toSafeError({ ...nativeError("usageLimitExceeded"), outputCode: "TIMEOUT" });
  assert.equal(rootOutput.category, "quota");
  assert.equal(rootOutput.code, undefined);
  for (const code of ["ABORTED", "TIMEOUT", "PERMISSION_DENIED", "RUNTIME"]) {
    const rootCode = toSafeError({ code, data: { codexErrorInfo: "usageLimitExceeded" } });
    assert.equal(rootCode.category, "quota");
    assert.equal(rootCode.code, undefined);
  }
  assert.equal(toSafeError({ code: "ABORTED" }).category, "unknown");
  assert.equal(toSafeError(new DOMException(canary, "AbortError")).code, "ABORTED");
  const localRuntime = toSafeError(
    new AcpRuntimeError("ACP_SESSION_INIT_FAILED", canary, {
      cause: nativeError("usageLimitExceeded"),
    }),
  );
  assert.equal(localRuntime.code, "ACP_SESSION_INIT_FAILED");
  assert.equal(localRuntime.category, "quota");
  assert.doesNotMatch(JSON.stringify(localRuntime), /SYNTHETIC_/);
  assert.equal(toSafeError({ code: "ACP_SESSION_INIT_FAILED" }).code, undefined);
  assert.equal(
    toSafeError(
      new AcpxOperationalError(canary, {
        detailCode: "AUTH_REQUIRED",
        origin: "acp",
      }),
    ).category,
    "auth",
  );
  const uncertain = toSafeError(
    new AcpxOperationalError(canary, {
      detailCode: "WATCH_OUTCOME_UNKNOWN",
      origin: "queue",
      retryable: true,
    }),
  );
  assert.equal(uncertain.outcomeUnknown, true);
  assert.equal(uncertain.origin, "queue");
  assert.equal(uncertain.retryable, true);
  const rejection = safeErrorRejection(uncertain);
  assert.ok(rejection instanceof Error);
  assert.deepEqual(toSafeError(rejection), uncertain);
});

test("owned wire projections decode only direct fields and regenerate messages", () => {
  const safe = toSafeError(undefined, {
    origin: "transport",
    operationId: "synthetic-delivery",
    outcomeUnknown: true,
  });
  const wire = { ...safe, category: "quota", data: nativeError("unauthorized"), message: authLink };
  assert.equal(toSafeError(wire).operationId, undefined);
  const restored = toSafeError(wire, { trustedProjection: true });
  assert.equal(restored.category, "quota");
  assert.equal(restored.origin, "transport");
  assert.equal(restored.operationId, "synthetic-delivery");
  assert.equal(restored.outcomeUnknown, true);
  assert.equal(restored.providerCode, undefined);
  assert.equal(restored.message, "Provider quota exhausted.");
  assert.doesNotMatch(JSON.stringify(restored), /example\.invalid|unauthorized|data/);
  safe.message = authLink;
  assert.equal(toSafeError(safe).message, "ACP execution failed.");
});

test("safe traversal is bounded for cycles and deep envelopes", () => {
  const cycle: { cause?: unknown; message: string } = { message: canary };
  cycle.cause = cycle;
  assert.equal(toSafeError(cycle).category, "unknown");
  let deep: unknown = nativeError("usageLimitExceeded");
  for (let index = 0; index < 8; index += 1) {
    deep = { cause: deep };
  }
  assert.equal(toSafeError(deep).category, "unknown");
  assert.equal(toSafeError(new DOMException(canary, "AbortError")).category, "cancelled");
});
