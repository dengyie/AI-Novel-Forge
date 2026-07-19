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

test("E1 (tight): capRollingFeedback trims to exactly MAX when overcrowded, tail = latest next", () => {
  // 断言收紧到 equal MAX：list.length > MAX 时，capRollingFeedback 必返回恰好 MAX 个元素
  // （next 永远保留，其余 slotsForRest=MAX-1 个按 sticky 优先 + 时序末尾优先填满）。
  // 这条断言比 `<= MAX+1` 严：任何把 sticky 也计入 overflow 而多留一个的回归会被抓出。
  const sticky1 = buildQualityFeedbackPacket({
    assessment: assessment({ chapterOrder: 100, chapterId: "ch-sticky-1", rootCauseCode: "length_drift" }),
    repairDecision: "discard",
  });
  const sticky2 = buildQualityFeedbackPacket({
    assessment: assessment({ chapterOrder: 101, chapterId: "ch-sticky-2", rootCauseCode: "length_drift" }),
    repairDecision: "discard",
  });
  assert.ok(sticky1 && sticky2);
  assert.equal(sticky1.avoidRetry, true);
  assert.equal(sticky2.avoidRetry, true);
  let merged = mergeQualityFeedbackList([], sticky1);
  merged = mergeQualityFeedbackList(merged, sticky2);
  // 压入 MAX+2 个非 sticky soft（patch_repair，avoidRetry=false），制造 overflow
  for (let i = 0; i < QUALITY_FEEDBACK_ROLLING_MAX + 2; i += 1) {
    const soft = buildQualityFeedbackPacket({
      assessment: assessment({
        chapterOrder: 200 + i,
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
  // 收紧：overflow 时长度必须 === MAX（不是 <= MAX+1）。
  assert.equal(merged.length, QUALITY_FEEDBACK_ROLLING_MAX, "overflow 被 cap 到恰好 MAX");
  // 两个 sticky 都应在结果里（restSticky.length>=slotsForRest=MAX-1 分支，保留最近 MAX-1 个 sticky）。
  // P2-1：具象化 sticky1 存活断言。RMAX=3 + 输入 2 sticky，slotsForRest=2=sticky 数，
  // 走 `restSticky.length>=slotsForRest` 分支 `slice(-2)` → [sticky1, sticky2, next]，
  // 两 sticky 全活。若有人误把 `slice(-slotsForRest)` 改 `slice(0, slotsForRest)`，sticky2 丢
  // 而 sticky1 留，仅断 sticky2 会漏放——故补 sticky1 断言锁两条分支方向。
  assert.ok(merged.some((f) => f.signature === sticky2.signature), "最近 sticky2 必须保留");
  assert.ok(merged.some((f) => f.signature === sticky1.signature), "sticky1 也必须存活（两 sticky 全活）");
  // 末尾必是最后一个 soft（即 next，最新发生）。
  assert.equal(merged[merged.length - 1].avoidRetry, false, "末尾是最新发生的非 sticky next");
});

test("E1 (overflow): 4 sticky > slotsForRest 时仅留最近 2 sticky 丢前 2, 长 === MAX", () => {
  // P2-2：sticky overflow 分支专测。RMAX=3, slotsForRest=2。输入 4 sticky + 1 soft,
  // restSticky.length(4) >= slotsForRest(2) → 走 `[...restSticky.slice(-2), next]`
  // = [sticky2, sticky3, soft],sticky0/sticky1 被丢,长度 3 === MAX。
  // 此分支 strict 测(2 sticky)未触达,补它锁"保留最近 MAX-1 个 sticky"的"最近"语义。
  const sticky0 = buildQualityFeedbackPacket({
    assessment: assessment({ chapterOrder: 100, chapterId: "ch-ov-stk-0", rootCauseCode: "length_drift" }),
    repairDecision: "discard",
  });
  const sticky1 = buildQualityFeedbackPacket({
    assessment: assessment({ chapterOrder: 101, chapterId: "ch-ov-stk-1", rootCauseCode: "length_drift" }),
    repairDecision: "discard",
  });
  const sticky2 = buildQualityFeedbackPacket({
    assessment: assessment({ chapterOrder: 102, chapterId: "ch-ov-stk-2", rootCauseCode: "length_drift" }),
    repairDecision: "discard",
  });
  const sticky3 = buildQualityFeedbackPacket({
    assessment: assessment({ chapterOrder: 103, chapterId: "ch-ov-stk-3", rootCauseCode: "length_drift" }),
    repairDecision: "discard",
  });
  assert.ok(sticky0 && sticky1 && sticky2 && sticky3);
  assert.equal([sticky0, sticky1, sticky2, sticky3].every((p) => p.avoidRetry), true);
  let merged = mergeQualityFeedbackList([], sticky0);
  merged = mergeQualityFeedbackList(merged, sticky1);
  merged = mergeQualityFeedbackList(merged, sticky2);
  merged = mergeQualityFeedbackList(merged, sticky3);
  // tail = 最新 soft (avoidRetry=false)
  const soft = buildQualityFeedbackPacket({
    assessment: assessment({
      chapterOrder: 200,
      chapterId: "ch-ov-soft",
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
  assert.equal(soft.avoidRetry, false);
  merged = mergeQualityFeedbackList(merged, soft);
  // 长度收敛到恰好 MAX
  assert.equal(merged.length, QUALITY_FEEDBACK_ROLLING_MAX, "4 sticky overflow cap 到 MAX");
  // 最近 2 sticky 存活（slice(-2) = [sticky2, sticky3]）
  assert.ok(merged.some((f) => f.signature === sticky2.signature), "sticky2(倒数第 3)存活");
  assert.ok(merged.some((f) => f.signature === sticky3.signature), "sticky3(倒数第 2)存活");
  // 前 2 sticky 被丢
  assert.equal(merged.some((f) => f.signature === sticky0.signature), false, "sticky0 被丢");
  assert.equal(merged.some((f) => f.signature === sticky1.signature), false, "sticky1 被丢");
  // 末尾是最新 soft (next)
  assert.equal(merged[merged.length - 1].signature, soft.signature, "末尾是最新 soft next");
  assert.equal(merged[merged.length - 1].avoidRetry, false, "末尾非 sticky");
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
