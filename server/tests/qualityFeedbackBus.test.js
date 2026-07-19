const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMustFixAndPlanHints,
  buildQualityFeedbackPacket,
  buildQualityFeedbackRewriteSignature,
  buildQualityFeedbackSignature,
  buildQualityFeedbackWindowSummary,
  compactQualityFeedbackForPlanner,
  extractQualityFeedbackFromRiskFlags,
  formatPriorQualityFeedbackLines,
  isAutoPatchAvoidedByFeedback,
  isAutoPatchAvoidedByRiskFlags,
  mergeQualityFeedbackIntoRiskFlags,
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

test("F3: mergeQualityFeedbackList moves upserted signature to the tail (latest)", () => {
  // 同 signature 后再次评估应让该 signature 落到末尾，避免 projectLatestFeedbackSummary
  // 读到较旧的其他 signature 当作"最新"。
  const sigA = buildQualityFeedbackPacket({
    assessment: assessment(),
    repairDecision: "discard",
  });
  assert.ok(sigA);
  const sigB = buildQualityFeedbackPacket({
    assessment: assessment({
      chapterOrder: 58,
      chapterId: "ch-58",
      rootCauseCode: "repetition",
    }),
    repairDecision: "discard",
  });
  assert.ok(sigB);
  assert.notEqual(sigA.signature, sigB.signature);

  // A 然后 B → 末尾是 B
  let merged = mergeQualityFeedbackList([sigA], sigB);
  assert.equal(merged[merged.length - 1].signature, sigB.signature);

  // A 再评估（带更新）→ 末尾应是 A（最新）
  const sigARedo = buildQualityFeedbackPacket({
    assessment: assessment({ rootCauseCode: "prose_ban" }),
    repairDecision: "discard",
  });
  assert.ok(sigARedo);
  merged = mergeQualityFeedbackList(merged, sigARedo);
  assert.equal(merged[merged.length - 1].signature, sigARedo.signature);
});

test("E1: mergeQualityFeedbackList does not drop sticky avoidRetry packet through rolling cap", () => {
  // 当一波不同 signature 先后产生，最早的含 avoidRetry=true 的包不应被 rolling
  // slice(MAX) 挤丢——否则下次 buildQualityFeedbackPacket 的 previousFeedback.find
  // 找不到该 signature，failedPatchCount 归零、avoidRetry 失效，plan A 硬门被绕过。
  const stickyA = buildQualityFeedbackPacket({
    assessment: assessment(),
    repairDecision: "discard",
  });
  assert.ok(stickyA);
  assert.equal(stickyA.avoidRetry, true);
  let merged = mergeQualityFeedbackList([], stickyA);
  // 再压入 MAX+2 个不同的非 sticky soft signature（patch_repair，avoidRetry=false）
  for (let i = 0; i < QUALITY_FEEDBACK_ROLLING_MAX + 2; i += 1) {
    const soft = buildQualityFeedbackPacket({
      assessment: assessment({
        chapterOrder: 60 + i,
        chapterId: `ch-soft-${i}`,
        rootCauseCode: "length_drift",
        recommendedAction: "patch_repair",
        signals: [{
          artifactType: "literary_score",
          status: "invalid",
          issueCodes: ["length_short"],
          reason: "略短",
        }],
      }),
    });
    assert.ok(soft);
    assert.equal(soft.avoidRetry, false);
    merged = mergeQualityFeedbackList(merged, soft);
  }
  // sticky A 应仍保留在列表里（即便总数超过 MAX 也允许）
  const stillHasA = merged.some((item) => item.signature === stickyA.signature);
  assert.ok(stillHasA, "sticky avoidRetry packet must survive rolling cap");
  // 末尾应是最后一个 soft（最新发生）
  assert.ok(merged.length <= QUALITY_FEEDBACK_ROLLING_MAX + 1, "total capped near MAX");
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

test("patch_repair alone is soft severity; discard/plateau stay blocking", () => {
  const soft = buildQualityFeedbackPacket({
    assessment: assessment({
      recommendedAction: "patch_repair",
      rootCauseCode: "length_drift",
      signals: [{
        artifactType: "literary_score",
        status: "invalid",
        issueCodes: ["length_short"],
        reason: "略短",
      }],
    }),
  });
  assert.ok(soft);
  assert.equal(soft.avoidRetry, false);
  assert.equal(soft.severity, "soft");

  const blocking = buildQualityFeedbackPacket({
    assessment: assessment({ recommendedAction: "patch_repair" }),
    repairDecision: "discard",
  });
  assert.ok(blocking);
  assert.equal(blocking.avoidRetry, true);
  assert.equal(blocking.severity, "blocking");
});

test("signature-scoped avoidRetry does not widen to other signatures", () => {
  const packet = buildQualityFeedbackPacket({
    assessment: assessment(),
    repairDecision: "discard",
  });
  assert.ok(packet);
  const miss = isAutoPatchAvoidedByFeedback([packet], "qfb:other-signature");
  assert.equal(miss.avoided, false);
  const hit = isAutoPatchAvoidedByFeedback([packet], packet.signature);
  assert.equal(hit.avoided, true);
  const chapterScope = isAutoPatchAvoidedByFeedback([packet]);
  assert.equal(chapterScope.avoided, true);
});

test("mergeQualityFeedbackIntoRiskFlags is projection-only on feedback key", () => {
  const packet = buildQualityFeedbackPacket({
    assessment: assessment(),
    repairDecision: "discard",
  });
  assert.ok(packet);
  const previous = JSON.stringify({
    qualityLoop: {
      overallStatus: "invalid",
      recommendedAction: "repair",
      source: "pipeline_review",
      feedback: [],
    },
    settingAlignment: { mode: "warn" },
  });
  const next = mergeQualityFeedbackIntoRiskFlags(previous, [packet]);
  const parsed = JSON.parse(next);
  assert.equal(parsed.qualityLoop.overallStatus, "invalid");
  assert.equal(parsed.qualityLoop.recommendedAction, "repair");
  assert.equal(parsed.qualityLoop.source, "pipeline_review");
  assert.equal(parsed.settingAlignment.mode, "warn");
  assert.equal(parsed.qualityLoop.feedback.length, 1);
  assert.equal(parsed.qualityLoop.feedback[0].signature, packet.signature);

  const cleared = JSON.parse(mergeQualityFeedbackIntoRiskFlags(next, []));
  assert.equal(cleared.qualityLoop.overallStatus, "invalid");
  assert.equal("feedback" in cleared.qualityLoop, false);
  assert.equal(cleared.settingAlignment.mode, "warn");
});

test("prose_ban planHints never spell banned term 称重", () => {
  const hints = buildMustFixAndPlanHints({
    rootCause: "prose_ban",
    codes: ["prose.ban.chengzhong"],
    assessment: assessment(),
  });
  const joined = [...hints.mustFix, ...hints.planHints].join("\n");
  assert.equal(joined.includes("称重"), false);
  assert.match(joined, /废弃术语|禁词|mustAvoid|prose ban/i);
});
