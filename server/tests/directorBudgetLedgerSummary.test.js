const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDirectorBudgetLedgerSummary,
  DIRECTOR_QUALITY_LOOP_BUDGET_LIMITS,
} = require("../dist/services/novel/qualityLoopBudget.js");

function sampleEntry(overrides = {}) {
  return {
    signatureKey: "key",
    issueSignature: "content|handling_x|...",
    blockingLedgerKeys: [],
    affectedChapterWindow: { startOrder: 1, endOrder: 3, chapterOrders: [1, 2, 3], chapterIds: [] },
    patchRepairCount: 0,
    chapterRewriteCount: 0,
    windowReplanCount: 0,
    deferredCount: 0,
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

test("buildDirectorBudgetLedgerSummary returns null without autoExecution, ledger, or breaker", () => {
  assert.equal(buildDirectorBudgetLedgerSummary(null), null);
  assert.equal(buildDirectorBudgetLedgerSummary(undefined), null);
  assert.equal(buildDirectorBudgetLedgerSummary({}), null);
  assert.equal(buildDirectorBudgetLedgerSummary({ qualityLoopLedger: null }), null);
});

test("buildDirectorBudgetLedgerSummary returns zeroed summary for an empty but initialized ledger", () => {
  const summary = buildDirectorBudgetLedgerSummary({ qualityLoopLedger: { entries: [], updatedAt: null } });
  assert.ok(summary);
  assert.deepEqual(summary.totals, {
    patchRepairCount: 0,
    chapterRewriteCount: 0,
    windowReplanCount: 0,
    deferredCount: 0,
  });
  assert.equal(summary.entryCount, 0);
  assert.equal(summary.exhaustedEntryCount, 0);
});

test("buildDirectorBudgetLedgerSummary surfaces circuit breaker even with no ledger entries", () => {
  const summary = buildDirectorBudgetLedgerSummary({
    circuitBreaker: {
      status: "open",
      reason: "model_unavailable",
      failureCount: 3,
      patchFailureCount: 0,
      modelFailureCount: 3,
      usageAnomalyCount: 0,
      openedAt: "2026-08-07T02:00:00.000Z",
      recoveryAction: "switch_model",
    },
    transientModelFallbackCount: 2,
  });

  assert.equal(summary.circuitBreaker.status, "open");
  assert.equal(summary.circuitBreaker.modelFailureCount, 3);
  assert.deepEqual(summary.totals, {
    patchRepairCount: 0,
    chapterRewriteCount: 0,
    windowReplanCount: 0,
    deferredCount: 0,
  });
  assert.equal(summary.entryCount, 0);
  assert.equal(summary.exhaustedEntryCount, 0);
  assert.equal(summary.transientModelFallbackCount, 2);
});

test("buildDirectorBudgetLedgerSummary aggregates counts across entries", () => {
  const summary = buildDirectorBudgetLedgerSummary({
    qualityLoopLedger: {
      entries: [
        sampleEntry({ patchRepairCount: 2, chapterRewriteCount: 1, windowReplanCount: 1, deferredCount: 1 }),
        sampleEntry({ patchRepairCount: 1, deferredCount: 2 }),
      ],
      updatedAt: "2026-08-07T01:00:00.000Z",
    },
  });

  assert.deepEqual(summary.totals, {
    patchRepairCount: 3,
    chapterRewriteCount: 1,
    windowReplanCount: 1,
    deferredCount: 3,
  });
  assert.equal(summary.entryCount, 2);
  assert.equal(summary.budgetLimits.patchRepair, DIRECTOR_QUALITY_LOOP_BUDGET_LIMITS.patchRepair);
  assert.equal(summary.updatedAt, "2026-08-07T01:00:00.000Z");
  assert.equal(summary.circuitBreaker, null);
  assert.equal(summary.transientModelFallbackCount, 0);
});

test("buildDirectorBudgetLedgerSummary flags exhausted entries against budget limits", () => {
  const { patchRepair } = DIRECTOR_QUALITY_LOOP_BUDGET_LIMITS;
  const summary = buildDirectorBudgetLedgerSummary({
    qualityLoopLedger: {
      entries: [
        sampleEntry({ patchRepairCount: patchRepair }), // exhausted
        sampleEntry({ patchRepairCount: 0 }), // not exhausted
      ],
      updatedAt: null,
    },
  });
  assert.equal(summary.exhaustedEntryCount, 1);
});

test("buildDirectorBudgetLedgerSummary surfaces circuit breaker and transient fallback state", () => {
  const summary = buildDirectorBudgetLedgerSummary({
    qualityLoopLedger: {
      entries: [sampleEntry()],
      updatedAt: "2026-08-07T01:00:00.000Z",
    },
    circuitBreaker: {
      status: "open",
      failureCount: 5,
      patchFailureCount: 2,
      modelFailureCount: 3,
      usageAnomalyCount: 0,
      openedAt: "2026-08-07T02:00:00.000Z",
      recoveryAction: "switch_model",
    },
    transientModelFallbackCount: 2,
  });

  assert.equal(summary.circuitBreaker.status, "open");
  assert.equal(summary.circuitBreaker.failureCount, 5);
  assert.equal(summary.circuitBreaker.patchFailureCount, 2);
  assert.equal(summary.circuitBreaker.modelFailureCount, 3);
  assert.equal(summary.circuitBreaker.recoveryAction, "switch_model");
  assert.equal(summary.transientModelFallbackCount, 2);
});