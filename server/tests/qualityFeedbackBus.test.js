const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildQualityFeedbackPacket,
  buildQualityFeedbackRewriteSignature,
  buildQualityFeedbackSignature,
  buildQualityFeedbackWindowSummary,
  compactQualityFeedbackForPlanner,
  extractQualityFeedbackFromRiskFlags,
  formatPriorQualityFeedbackLines,
  isAutoPatchAvoidedByFeedback,
  isAutoPatchAvoidedByRiskFlags,
  mergeQualityFeedbackList,
  QUALITY_FEEDBACK_PREPARE_SUMMARY_CHARS,
  QUALITY_FEEDBACK_ROLLING_MAX,
} = require("../../shared/dist/types/qualityFeedback.js");

function assessment(overrides = {}) {
  return {
    chapterId: "ch-57",
    chapterOrder: 57,
    evaluatedAt: "2026-07-15T00:00:00.000Z",
    overallStatus: "invalid",
    recommendedAction: "repair",
    rootCauseCode: "prose_ban",
    blockingObligations: [],
    signals: [],
    observabilityTags: [],
    budget: { exhausted: false },
    ...overrides,
  };
}

test("buildQualityFeedbackSignature is stable for same rootCause/codes/order", () => {
  const a = buildQualityFeedbackSignature({
    rootCause: "prose_ban",
    codes: ["prose.ban.hud", "prose.ban.bracket"],
    chapterOrder: 57,
  });
  const b = buildQualityFeedbackSignature({
    rootCause: "prose_ban",
    codes: ["prose.ban.bracket", "prose.ban.hud"],
    chapterOrder: 57,
  });
  assert.equal(a, b);
  assert.match(a, /^qfb:/);
});

test("buildQualityFeedbackRewriteSignature appends :rewrite without mutating base", () => {
  const base = buildQualityFeedbackSignature({
    rootCause: "repetition",
    codes: ["rep.loop"],
    chapterOrder: 71,
  });
  const rewrite = buildQualityFeedbackRewriteSignature(base);
  assert.equal(rewrite, `${base}:rewrite`);
  assert.notEqual(rewrite, base);
});

test("buildQualityFeedbackPacket sets avoidRetry on discard and plateau_stop", () => {
  const discarded = buildQualityFeedbackPacket({
    assessment: assessment(),
    repairDecision: "discard",
  });
  assert.ok(discarded);
  assert.equal(discarded.avoidRetry, true);
  assert.equal(discarded.failedPatchCount, 1);
  assert.ok(discarded.mustFix.length > 0);

  const plateau = buildQualityFeedbackPacket({
    assessment: assessment({ chapterOrder: 74, chapterId: "ch-74" }),
    repairDecision: "plateau_stop",
  });
  assert.ok(plateau);
  assert.equal(plateau.avoidRetry, true);
});

test("buildQualityFeedbackPacket sets avoidRetry when budget exhausted", () => {
  const packet = buildQualityFeedbackPacket({
    assessment: assessment({
      budget: { exhausted: true },
      recommendedAction: "repair",
    }),
  });
  assert.ok(packet);
  assert.equal(packet.avoidRetry, true);
});

test("should not spam QFP for valid continue without hard codes", () => {
  const packet = buildQualityFeedbackPacket({
    assessment: assessment({
      overallStatus: "valid",
      recommendedAction: "continue",
      rootCauseCode: null,
    }),
  });
  assert.equal(packet, null);
});

test("mergeQualityFeedbackList upserts by signature and caps rolling window", () => {
  const base = buildQualityFeedbackPacket({
    assessment: assessment(),
    repairDecision: "discard",
  });
  assert.ok(base);

  const list = [base];
  for (let i = 0; i < QUALITY_FEEDBACK_ROLLING_MAX + 2; i += 1) {
    const next = buildQualityFeedbackPacket({
      assessment: assessment({
        chapterOrder: 60 + i,
        chapterId: `ch-${60 + i}`,
        rootCauseCode: "repetition",
      }),
      repairDecision: "discard",
    });
    assert.ok(next);
    list.splice(0, list.length, ...mergeQualityFeedbackList(list, next));
  }
  assert.ok(list.length <= QUALITY_FEEDBACK_ROLLING_MAX);
});

test("isAutoPatchAvoidedByRiskFlags reads qualityLoop.feedback projection", () => {
  const packet = buildQualityFeedbackPacket({
    assessment: assessment(),
    repairDecision: "discard",
  });
  assert.ok(packet);
  const riskFlags = JSON.stringify({
    qualityLoop: {
      feedback: [packet],
    },
  });
  const avoided = isAutoPatchAvoidedByRiskFlags(riskFlags);
  assert.equal(avoided.avoided, true);
  assert.match(avoided.reason, /avoidRetry|rewrite|patch/i);

  const bySignature = isAutoPatchAvoidedByFeedback([packet], packet.signature);
  assert.equal(bySignature.avoided, true);

  const clean = isAutoPatchAvoidedByRiskFlags(JSON.stringify({ qualityLoop: {} }));
  assert.equal(clean.avoided, false);
});

test("extractQualityFeedbackFromRiskFlags fails open on garbage", () => {
  assert.deepEqual(extractQualityFeedbackFromRiskFlags(null), []);
  assert.deepEqual(extractQualityFeedbackFromRiskFlags(""), []);
  assert.deepEqual(extractQualityFeedbackFromRiskFlags("{not-json"), []);
  assert.deepEqual(extractQualityFeedbackFromRiskFlags(JSON.stringify({ foo: 1 })), []);
});

test("formatPriorQualityFeedbackLines prioritizes replan/blocking and tags avoidRetry", () => {
  const soft = buildQualityFeedbackPacket({
    assessment: assessment({
      chapterOrder: 50,
      recommendedAction: "repair",
      rootCauseCode: "length_drift",
    }),
  });
  const blocking = buildQualityFeedbackPacket({
    assessment: assessment({
      chapterOrder: 57,
      recommendedAction: "repair",
      rootCauseCode: "prose_ban",
    }),
    repairDecision: "discard",
  });
  assert.ok(soft);
  assert.ok(blocking);
  const lines = formatPriorQualityFeedbackLines([soft, blocking], { maxItems: 5 });
  assert.ok(lines.length >= 1);
  assert.match(lines[0], /第57章/);
  assert.match(lines.join("\n"), /禁同签自动 patch/);
});

test("buildQualityFeedbackWindowSummary stays within prepare budget", () => {
  const packets = [];
  for (let order = 41; order <= 50; order += 1) {
    const packet = buildQualityFeedbackPacket({
      assessment: assessment({
        chapterOrder: order,
        chapterId: `ch-${order}`,
        rootCauseCode: "prose_ban",
      }),
      repairDecision: "discard",
    });
    if (packet) packets.push(packet);
  }
  const summary = buildQualityFeedbackWindowSummary(packets, QUALITY_FEEDBACK_PREPARE_SUMMARY_CHARS);
  assert.ok(summary.length > 0);
  assert.ok(summary.length <= QUALITY_FEEDBACK_PREPARE_SUMMARY_CHARS);
  assert.match(summary, /priorWindowQualityDebt/);
});

test("compactQualityFeedbackForPlanner projects planner-safe fields only", () => {
  const packet = buildQualityFeedbackPacket({
    assessment: assessment(),
    repairDecision: "discard",
  });
  assert.ok(packet);
  const compact = compactQualityFeedbackForPlanner([packet], 4);
  assert.equal(compact.length, 1);
  assert.equal(compact[0].chapterOrder, 57);
  assert.equal(compact[0].avoidRetry, true);
  assert.ok(Array.isArray(compact[0].codes));
  assert.ok(Array.isArray(compact[0].planHints));
  assert.equal(typeof compact[0].signature, "string");
});
