const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildChapterQualityLoopAssessment,
  classifyChapterQualityLoopRiskFlags,
  hasContinuableChapterQualityLoopRiskFlags,
} = require("../../shared/dist/types/chapterQualityLoop.js");
const {
  buildChapterQualityLoopChapterUpdate,
} = require("../dist/services/novel/quality/ChapterQualityLoopService.js");

function score(overrides = {}) {
  return {
    coherence: 88,
    repetition: 88,
    pacing: 86,
    voice: 85,
    engagement: 88,
    overall: 87,
    ...overrides,
  };
}

test("buildChapterQualityLoopAssessment continues when quality signals are valid", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-1",
    chapterOrder: 1,
    score: score(),
    issues: [],
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  assert.equal(assessment.overallStatus, "valid");
  assert.equal(assessment.recommendedAction, "continue");
  assert.equal(assessment.patchFirstRequired, false);
  assert.equal(assessment.recheckRequired, false);
  // retention + literary_score + continuity + prose + rolling_window
  assert.equal(assessment.signals.length, 5);
  const literary = assessment.signals.find((signal) => signal.artifactType === "literary_score");
  assert.equal(literary?.status, "valid");
});

test("buildChapterQualityLoopAssessment copies length riskTags into observabilityTags without changing action", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-length",
    chapterOrder: 3,
    score: score(),
    issues: [],
    evaluatedAt: "2026-04-30T00:00:00.000Z",
    runtimePackage: {
      meta: {
        riskTags: ["length_over_hard", "ending_hook", "length_over_soft"],
      },
      failureClassification: { code: null, blockingObligations: [] },
      context: { chapter: { order: 3 } },
      audit: { reports: [], openIssues: [], hasBlockingIssues: false },
      timelineCheck: { status: "passed", score: 1, issues: [] },
    },
  });

  assert.equal(assessment.recommendedAction, "continue");
  assert.deepEqual(assessment.observabilityTags, ["length_over_hard", "length_over_soft"]);
});

test("buildChapterQualityLoopAssessment requires patch-first repair for local quality risk", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-2",
    chapterOrder: 2,
    score: score({ engagement: 68, overall: 70 }),
    issues: [{
      severity: "high",
      category: "pacing",
      evidence: "结尾缺少推进和拉力。",
      fixSuggestion: "补强结尾钩子。",
    }],
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  assert.equal(assessment.overallStatus, "risk");
  assert.equal(assessment.recommendedAction, "patch_repair");
  assert.equal(assessment.patchFirstRequired, true);
  assert.equal(assessment.recheckRequired, true);
  const literary = assessment.signals.find((signal) => signal.artifactType === "literary_score");
  // engagement 68 vs floor 75 → gap 7 < 10 → risk（非 far-miss invalid）
  assert.equal(literary?.status, "risk");
  assert.ok(literary?.issueCodes.includes("literary:engagement"));
});

test("buildChapterQualityLoopAssessment routes rolling window failures to replan", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-3",
    chapterOrder: 3,
    score: score(),
    issues: [],
    runtimePackage: {
      context: {
        chapter: { order: 3 },
      },
      audit: {
        reports: [],
        openIssues: [],
      },
      replanRecommendation: {
        recommended: true,
        action: "stop_for_replan",
        reason: "连续三章推进偏离主线。",
        blockingIssueIds: ["issue-1"],
        blockingLedgerKeys: [],
        affectedChapterOrders: [3, 4],
      },
      failureClassification: {
        code: "replan_required",
        summary: "章节职责与计划窗口失配。",
        decisionReason: "需要重排邻近章节。",
        blockingObligations: [{
          kind: "goal_change",
          summary: "角色目标变化未兑现。",
          evidence: "正文没有体现目标变化。",
        }],
      },
    },
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  assert.equal(assessment.overallStatus, "invalid");
  assert.equal(assessment.recommendedAction, "replan");
  assert.equal(assessment.patchFirstRequired, true);
  assert.equal(assessment.recheckRequired, true);
  assert.equal(assessment.budget.nextAction, "patch_repair");
  assert.equal(
    assessment.signals.find((signal) => signal.artifactType === "rolling_window_review").status,
    "invalid",
  );
  assert.equal(assessment.rootCauseCode, "replan_required");
  assert.equal(assessment.blockingObligations[0].kind, "goal_change");
});

test("buildChapterQualityLoopAssessment keeps local replan suggestions as patch repair", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-local-plan",
    chapterOrder: 4,
    score: score({ overall: 74, engagement: 72 }),
    issues: [{
      severity: "high",
      category: "pacing",
      evidence: "本章缺少明确结果。",
      fixSuggestion: "补一个局部兑现结果。",
    }],
    runtimePackage: {
      context: {
        chapter: { order: 4 },
      },
      audit: {
        reports: [],
        openIssues: [],
      },
      replanRecommendation: {
        recommended: true,
        action: "local_patch_plan",
        reason: "局部章节计划需要修正。",
        blockingIssueIds: ["issue-local"],
        blockingLedgerKeys: [],
        affectedChapterOrders: [4],
      },
      failureClassification: {
        code: "draft_obligation_unmet",
        summary: "章节局部义务未满足。",
        decisionReason: "需要局部修复。",
        blockingObligations: [],
      },
    },
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  assert.equal(assessment.recommendedAction, "patch_repair");
  assert.notEqual(assessment.rootCauseCode, "replan_required");
});

test("buildChapterQualityLoopAssessment treats low repetition control as a repair risk", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-repetition",
    chapterOrder: 5,
    score: score({ repetition: 60 }),
    issues: [],
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  assert.equal(assessment.overallStatus, "invalid");
  assert.equal(assessment.recommendedAction, "patch_repair");
  assert.equal(assessment.budget.nextAction, "patch_repair");
  const literary = assessment.signals.find((signal) => signal.artifactType === "literary_score");
  // repetition 60 vs floor 75 → gap 15 ≥ 10 → invalid
  assert.equal(literary?.status, "invalid");
  assert.ok(literary?.issueCodes.includes("literary:repetition"));
});

test("buildChapterQualityLoopAssessment includes prose quality risk as local patch repair input", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-prose-risk",
    chapterOrder: 6,
    score: score(),
    issues: [],
    runtimePackage: {
      context: {
        chapter: { order: 6 },
      },
      audit: {
        reports: [],
        openIssues: [{
          auditType: "mode_fit",
          severity: "high",
          code: "prose_negative_flip",
          evidence: "第 3 行：不是害怕，而是清醒。",
          fixSuggestion: "改成具体动作和感官细节。",
        }],
      },
      failureClassification: {
        code: "none",
        summary: "未触发全局重规划。",
        decisionReason: null,
        blockingObligations: [],
      },
    },
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  const proseSignal = assessment.signals.find((signal) => signal.artifactType === "prose_quality");
  assert.equal(proseSignal.status, "risk");
  assert.deepEqual(proseSignal.issueCodes, ["prose_negative_flip"]);
  assert.equal(assessment.overallStatus, "risk");
  assert.equal(assessment.recommendedAction, "patch_repair");
  assert.equal(assessment.rootCauseCode, "none");
});

test("buildChapterQualityLoopAssessment keeps advisory prose findings non-blocking", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-prose-advisory",
    chapterOrder: 7,
    score: score(),
    issues: [],
    runtimePackage: {
      context: {
        chapter: { order: 7 },
      },
      audit: {
        reports: [],
        openIssues: [{
          auditType: "mode_fit",
          severity: "medium",
          code: "prose_long_paragraph",
          evidence: "第 8 行：段落过长。",
          fixSuggestion: "拆成更短段落。",
        }],
      },
      failureClassification: {
        code: "none",
        summary: "未触发全局重规划。",
        decisionReason: null,
        blockingObligations: [],
      },
    },
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  const proseSignal = assessment.signals.find((signal) => signal.artifactType === "prose_quality");
  assert.equal(proseSignal.status, "valid");
  assert.deepEqual(proseSignal.issueCodes, ["prose_long_paragraph"]);
  assert.equal(assessment.recommendedAction, "continue");
});

test("buildChapterQualityLoopAssessment escalates repeated quality signatures by budget", () => {
  const first = buildChapterQualityLoopAssessment({
    chapterId: "chapter-budget",
    chapterOrder: 6,
    score: score({ repetition: 60 }),
    issues: [],
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });
  const history = [
    `[quality_loop 2026-04-30T00:00:00.000Z] status=${first.overallStatus} action=${first.recommendedAction} signature=${first.budget.signature} attempt=1/3 budget=${first.budget.nextAction}`,
    `[quality_loop 2026-04-30T00:01:00.000Z] status=${first.overallStatus} action=${first.recommendedAction} signature=${first.budget.signature} attempt=2/3 budget=rewrite_chapter`,
    `[quality_loop 2026-04-30T00:02:00.000Z] status=${first.overallStatus} action=${first.recommendedAction} signature=${first.budget.signature} attempt=3/3 budget=replan_window`,
  ].join("\n");

  const exhausted = buildChapterQualityLoopAssessment({
    chapterId: "chapter-budget",
    chapterOrder: 6,
    score: score({ repetition: 60 }),
    issues: [],
    previousRepairHistory: history,
    evaluatedAt: "2026-04-30T00:03:00.000Z",
  });

  assert.equal(exhausted.recommendedAction, "manual_gate");
  assert.equal(exhausted.budget.attempt, 4);
  assert.equal(exhausted.budget.nextAction, "hard_stop");
  assert.equal(exhausted.budget.exhausted, true);
});

test("buildChapterQualityLoopChapterUpdate clears stale repair state after a valid repair recheck", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-4",
    chapterOrder: 4,
    score: score(),
    issues: [],
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  const update = buildChapterQualityLoopChapterUpdate({
    riskFlags: JSON.stringify({ qualityLoop: { recommendedAction: "patch_repair" } }),
    repairHistory: "[quality_loop old] status=invalid action=replan",
    chapterStatus: "needs_repair",
    generationState: "reviewed",
  }, assessment, "repair_recheck");

  assert.equal(update.chapterStatus, "pending_review");
  assert.equal(typeof update.riskFlags, "string");
  const riskFlags = JSON.parse(update.riskFlags);
  assert.equal(riskFlags.qualityLoop.recommendedAction, "continue");
  assert.equal(riskFlags.qualityLoop.source, "repair_recheck");
});

test("deferred timeline extraction marks continuity risk but continues without patch", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-deferred-timeline",
    chapterOrder: 4,
    score: score(),
    issues: [],
    runtimePackage: {
      context: {
        chapter: { order: 4 },
      },
      audit: {
        reports: [],
        openIssues: [{
          code: "timeline_unclear_time_anchor",
          auditType: "continuity",
          severity: "low",
          description: "时间线抽取已移出热路径。",
          evidence: "timeline_extraction_deferred",
        }],
      },
      timelineCheck: {
        status: "warning",
        score: 0.9,
        issues: [{
          type: "unclear_time_anchor",
          severity: "info",
          message: "时间线抽取已移出章节接收热路径。",
          evidence: "timeline_extraction_deferred",
        }],
      },
      failureClassification: {
        code: "none",
        blockingObligations: [],
      },
    },
    evaluatedAt: "2026-07-11T00:00:00.000Z",
  });

  const continuity = assessment.signals.find((signal) => signal.artifactType === "continuity_state");
  assert.equal(continuity?.status, "risk");
  assert.ok(continuity?.issueCodes.includes("timeline_extraction_deferred"));
  assert.equal(assessment.overallStatus, "risk");
  assert.equal(assessment.recommendedAction, "continue");
  assert.equal(assessment.patchFirstRequired, false);
  assert.equal(assessment.recheckRequired, false);

  const riskFlags = JSON.stringify({ qualityLoop: assessment });
  assert.equal(classifyChapterQualityLoopRiskFlags(riskFlags), "non_blocking_quality_debt");
  assert.equal(hasContinuableChapterQualityLoopRiskFlags(riskFlags), true);
});

test("buildChapterQualityLoopChapterUpdate marks exhausted auto repair as deferred continue", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-5",
    chapterOrder: 5,
    score: score({ engagement: 69, overall: 70 }),
    issues: [{
      severity: "high",
      category: "pacing",
      evidence: "结尾仍然缺少推进。",
      fixSuggestion: "补足章节收束。",
    }],
    evaluatedAt: "2026-04-30T00:00:00.000Z",
  });

  const update = buildChapterQualityLoopChapterUpdate({
    riskFlags: JSON.stringify({ qualityLoop: { recommendedAction: "patch_repair" } }),
    repairHistory: "[quality_loop old] status=invalid action=patch_repair",
    chapterStatus: "needs_repair",
    generationState: "reviewed",
  }, assessment, "repair_recheck", "defer_and_continue");

  assert.equal(update.chapterStatus, "pending_review");
  assert.equal(typeof update.riskFlags, "string");
  const riskFlags = JSON.parse(update.riskFlags);
  assert.equal(riskFlags.qualityLoop.terminalAction, "defer_and_continue");
  assert.equal(riskFlags.qualityLoop.source, "repair_recheck");
  assert.match(update.repairHistory, /terminal=defer_and_continue/);
});

test("buildChapterQualityLoopChapterUpdate never completes on defer even if generation already approved (A6)", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-defer-no-complete",
    chapterOrder: 6,
    score: score({ coherence: 70, repetition: 70, engagement: 70, overall: 70 }),
    issues: [],
    evaluatedAt: "2026-07-15T00:00:00.000Z",
  });

  const update = buildChapterQualityLoopChapterUpdate({
    riskFlags: null,
    repairHistory: null,
    chapterStatus: "needs_repair",
    generationState: "approved",
  }, assessment, "pipeline_review", "defer_and_continue");

  // defer 记债可读，但 !literaryPass 不得质量过审 completed
  assert.equal(update.chapterStatus, "pending_review");
  assert.notEqual(update.chapterStatus, "completed");
});

test("quality loop projection classifies deferred patch repair as non-blocking debt", () => {
  const riskFlags = JSON.stringify({
    qualityLoop: {
      overallStatus: "invalid",
      recommendedAction: "patch_repair",
      rootCauseCode: "draft_repair_exhausted",
      terminalAction: "defer_and_continue",
    },
  });

  assert.equal(classifyChapterQualityLoopRiskFlags(riskFlags), "non_blocking_quality_debt");
  assert.equal(hasContinuableChapterQualityLoopRiskFlags(riskFlags), true);
});

test("quality loop projection classifies deferred prose risk as non-blocking debt", () => {
  const riskFlags = JSON.stringify({
    qualityLoop: {
      overallStatus: "risk",
      recommendedAction: "patch_repair",
      rootCauseCode: "draft_repair_exhausted",
      terminalAction: "defer_and_continue",
      signals: [{
        artifactType: "prose_quality",
        status: "risk",
        issueCodes: ["prose_ai_self_reference"],
      }],
    },
  });

  assert.equal(classifyChapterQualityLoopRiskFlags(riskFlags), "non_blocking_quality_debt");
  assert.equal(hasContinuableChapterQualityLoopRiskFlags(riskFlags), true);
});

test("quality loop projection treats deferred local obligation gaps as non-blocking debt", () => {
  const riskFlags = JSON.stringify({
    qualityLoop: {
      overallStatus: "risk",
      recommendedAction: "patch_repair",
      rootCauseCode: "draft_obligation_unmet",
      terminalAction: "defer_and_continue",
      blockingObligations: [{ kind: "must_hit_now", summary: "补足本章目标变化" }],
    },
  });

  assert.equal(classifyChapterQualityLoopRiskFlags(riskFlags), "non_blocking_quality_debt");
  assert.equal(hasContinuableChapterQualityLoopRiskFlags(riskFlags), true);
});

test("quality loop projection keeps replan required blocking even when deferred", () => {
  const riskFlags = JSON.stringify({
    qualityLoop: {
      overallStatus: "invalid",
      recommendedAction: "replan",
      rootCauseCode: "replan_required",
      terminalAction: "defer_and_continue",
      blockingObligations: [{ kind: "must_hit_now", summary: "比武环节" }],
    },
  });

  assert.equal(classifyChapterQualityLoopRiskFlags(riskFlags), "blocking");
  assert.equal(hasContinuableChapterQualityLoopRiskFlags(riskFlags), false);
});

test("quality loop projection treats valid continue as none despite residual blockingObligations", () => {
  const riskFlags = JSON.stringify({
    qualityLoop: {
      overallStatus: "valid",
      recommendedAction: "continue",
      rootCauseCode: "draft_obligation_unmet",
      blockingObligations: [{ kind: "must_hit_now", summary: "历史快照残留义务" }],
    },
  });

  assert.equal(classifyChapterQualityLoopRiskFlags(riskFlags), "none");
  assert.equal(hasContinuableChapterQualityLoopRiskFlags(riskFlags), true);
});

test("buildChapterQualityLoopAssessment treats high sot_* openIssues as prose risk", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "chapter-sot-leak",
    chapterOrder: 8,
    score: score(),
    issues: [],
    runtimePackage: {
      context: {
        chapter: { order: 8 },
      },
      audit: {
        reports: [],
        openIssues: [{
          auditType: "mode_fit",
          severity: "high",
          code: "sot_must_avoid_leak",
          evidence: "正文出现 mustAvoid 词：源核熔断。",
          fixSuggestion: "删除或改写泄漏词。",
        }],
      },
      failureClassification: {
        code: "none",
        summary: "未触发全局重规划。",
        decisionReason: null,
        blockingObligations: [],
      },
    },
    evaluatedAt: "2026-07-15T00:00:00.000Z",
  });

  const proseSignal = assessment.signals.find((signal) => signal.artifactType === "prose_quality");
  assert.equal(proseSignal?.status, "risk");
  assert.deepEqual(proseSignal?.issueCodes, ["sot_must_avoid_leak"]);
  assert.equal(assessment.overallStatus, "risk");
  assert.equal(assessment.recommendedAction, "patch_repair");
});
