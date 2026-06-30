const test = require("node:test");
const assert = require("node:assert/strict");

const {
  rankPendingByChapterAge,
} = require("../dist/services/novel/production/ContextAssemblyService.js");

function payoff(overrides = {}) {
  return {
    id: overrides.id ?? `p-${Math.random().toString(16).slice(2)}`,
    ledgerKey: overrides.ledgerKey ?? "k",
    title: overrides.title ?? "t",
    summary: overrides.summary ?? "",
    scopeType: overrides.scopeType ?? "volume",
    currentStatus: overrides.currentStatus ?? "pending_payoff",
    targetStartChapterOrder: overrides.targetStartChapterOrder ?? null,
    targetEndChapterOrder: overrides.targetEndChapterOrder ?? null,
    firstSeenChapterOrder: overrides.firstSeenChapterOrder ?? null,
    lastTouchedChapterOrder: overrides.lastTouchedChapterOrder ?? null,
    lastTouchedChapterId: null,
    setupChapterId: null,
    payoffChapterId: null,
    statusReason: null,
    confidence: null,
    createdAt: null,
    updatedAt: null,
  };
}

test("rankPendingByChapterAge ranks older payoffs first by chapter age", () => {
  const ranked = rankPendingByChapterAge([
    payoff({ id: "recent", firstSeenChapterOrder: 20, targetEndChapterOrder: 25 }),
    payoff({ id: "old", firstSeenChapterOrder: 4, targetEndChapterOrder: 15 }),
    payoff({ id: "mid", firstSeenChapterOrder: 12, targetEndChapterOrder: 18 }),
  ], 22);

  assert.deepEqual(ranked.map((item) => item.id), ["old", "mid", "recent"]);
});

test("rankPendingByChapterAge falls back to targetStartChapterOrder when firstSeen missing", () => {
  const ranked = rankPendingByChapterAge([
    payoff({ id: "a", targetStartChapterOrder: 20 }),
    payoff({ id: "b", targetStartChapterOrder: 5 }),
  ], 22);

  assert.deepEqual(ranked.map((item) => item.id), ["b", "a"]);
});

test("rankPendingByChapterAge breaks ties by earlier targetEndChapterOrder", () => {
  const ranked = rankPendingByChapterAge([
    payoff({ id: "later-deadline", firstSeenChapterOrder: 5, targetEndChapterOrder: 20 }),
    payoff({ id: "sooner-deadline", firstSeenChapterOrder: 5, targetEndChapterOrder: 15 }),
  ], 22);

  assert.deepEqual(ranked.map((item) => item.id), ["sooner-deadline", "later-deadline"]);
});

test("rankPendingByChapterAge does not mutate input array", () => {
  const input = [
    payoff({ id: "recent", firstSeenChapterOrder: 20 }),
    payoff({ id: "old", firstSeenChapterOrder: 4 }),
  ];
  const snapshot = input.map((item) => item.id);
  rankPendingByChapterAge(input, 22);
  assert.deepEqual(input.map((item) => item.id), snapshot);
});

test("rankPendingByChapterAge sorts unknown-anchor payoffs last", () => {
  const ranked = rankPendingByChapterAge([
    payoff({ id: "old", firstSeenChapterOrder: 4 }),
    payoff({ id: "unknown", targetStartChapterOrder: null, targetEndChapterOrder: 10 }),
    payoff({ id: "recent", firstSeenChapterOrder: 20 }),
  ], 22);

  assert.deepEqual(ranked.map((item) => item.id), ["old", "recent", "unknown"]);
});
