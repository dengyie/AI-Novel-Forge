const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isTransientTransportError,
  runWithTransportRetry,
  TRANSPORT_RETRY_MAX_ATTEMPTS,
} = require("../dist/llm/transportRetry.js");

test("isTransientTransportError matches timeout/network/proxy patterns", () => {
  assert.equal(isTransientTransportError(new Error("fetch failed: ECONNRESET")), true);
  assert.equal(isTransientTransportError(new Error("Request timed out after 30000ms.")), true);
  assert.equal(isTransientTransportError(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  assert.equal(isTransientTransportError(Object.assign(new Error("wall clock"), { name: "TimeoutError" })), true);
  assert.equal(isTransientTransportError(new Error("502 Bad Gateway")), true);
  assert.equal(isTransientTransportError(new Error("Cannot read properties of undefined (reading 'message')")), true);
  assert.equal(isTransientTransportError(new Error("primary structured output failed")), false);
  assert.equal(isTransientTransportError(new Error("schema_mismatch")), false);
  assert.equal(isTransientTransportError(null), false);
});

test("runWithTransportRetry recovers after transient failure", async () => {
  let attempts = 0;
  const result = await runWithTransportRetry(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("fetch failed: ECONNRESET");
    }
    return "ok";
  }, { maxAttempts: 2, backoffBaseMs: 0 });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("runWithTransportRetry does not retry non-transient errors", async () => {
  let attempts = 0;
  await assert.rejects(
    () => runWithTransportRetry(async () => {
      attempts += 1;
      throw new Error("schema validation failed permanently");
    }, { maxAttempts: 3, backoffBaseMs: 0 }),
    /schema validation failed permanently/,
  );
  assert.equal(attempts, 1);
});

test("runWithTransportRetry stops when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  let attempts = 0;
  await assert.rejects(
    () => runWithTransportRetry(async () => {
      attempts += 1;
      return "should-not-run";
    }, { signal: controller.signal, maxAttempts: 3, backoffBaseMs: 0 }),
    /user cancelled/,
  );
  assert.equal(attempts, 0);
});

test("runWithTransportRetry does not retry after abort during failure", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(
    () => runWithTransportRetry(async () => {
      attempts += 1;
      controller.abort(new Error("cancelled mid-flight"));
      throw new Error("fetch failed: socket hang up");
    }, { signal: controller.signal, maxAttempts: 3, backoffBaseMs: 0 }),
    /fetch failed|socket hang|cancelled/,
  );
  // first attempt fails as transient, but signal aborted → no further attempts
  assert.equal(attempts, 1);
});

test("TRANSPORT_RETRY_MAX_ATTEMPTS is non-negative number", () => {
  assert.equal(typeof TRANSPORT_RETRY_MAX_ATTEMPTS, "number");
  assert.ok(TRANSPORT_RETRY_MAX_ATTEMPTS >= 0);
});
