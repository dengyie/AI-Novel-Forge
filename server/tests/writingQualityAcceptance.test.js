/**
 * 写文质量 P0 验收矩阵 A1–A8（docs/plans/writing-quality-architecture-plan.md §10）
 * 纯函数 + 确定性 L0 门禁，不依赖生产写书。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  decideRepairContentAdoption,
  formatRepairAdoptHistoryLine,
  appendRepairAdoptHistoryLine,
} = require("../../shared/dist/types/repairAdoptDecision.js");
const {
  DEFAULT_QUALITY_IS_PASS_THRESHOLD,
  isLiteraryQualityPass,
} = require("../../shared/dist/types/literaryQualityPass.js");
const {
  buildChapterQualityLoopAssessment,
} = require("../../shared/dist/types/chapterQualityLoop.js");
const {
  detectProseQuality,
} = require("../dist/services/novel/runtime/proseQuality/ProseQualityDetector.js");
const {
  chapterStatePairAfterLiteraryQualityGate,
  chapterStatePairAfterManualQualityReview,
} = require("../dist/services/novel/chapterLifecycleState.js");
const {
  buildChapterQualityLoopChapterUpdate,
} = require("../dist/services/novel/quality/ChapterQualityLoopService.js");

function score(partial = {}) {
  return {
    coherence: 90,
    repetition: 90,
    pacing: 90,
    voice: 90,
    engagement: 90,
    overall: 90,
    ...partial,
  };
}

// ─── A1 ────────────────────────────────────────────────────────────
test("A1: repair candidate lower overall or new L0 hard → discard (content path stays baseline)", () => {
  const regress = decideRepairContentAdoption({
    baselineScore: score({ overall: 88 }),
    candidateScore: score({ overall: 80 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
  });
  assert.equal(regress.decision, "discard");

  const l0 = decideRepairContentAdoption({
    baselineScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 95, coherence: 95, repetition: 95, engagement: 95 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: ["prose_ai_self_reference"],
  });
  assert.equal(l0.decision, "discard");
  assert.ok(l0.introducedBlockingCodes.includes("prose_ai_self_reference"));
});

// ─── A2 ────────────────────────────────────────────────────────────
test("A2: adopt records decision line with hashes in repairHistory", () => {
  const adoption = decideRepairContentAdoption({
    baselineScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 88, coherence: 88, repetition: 88, engagement: 88 }),
    baselineBlockingCodes: [],
    candidateBlockingCodes: [],
  });
  assert.equal(adoption.decision, "adopt");

  const line = formatRepairAdoptHistoryLine({
    decision: adoption.decision,
    reason: adoption.reason,
    baselineOverall: 70,
    candidateOverall: 88,
    baselineHash: "abc12345deadbeef",
    candidateHash: "fedcba9876543210",
    evaluatedAt: "2026-07-15T00:00:00.000Z",
  });
  assert.match(line, /decision=adopt/);
  assert.match(line, /base=abc12345dead/);
  assert.match(line, /cand=fedcba987654/);
  assert.match(line, /overall=70->88/);

  const history = appendRepairAdoptHistoryLine(null, line);
  assert.match(history, /decision=adopt/);
  assert.match(history, /base=abc12345dead/);
});

// ─── A3 ────────────────────────────────────────────────────────────
test("A3: isLiteraryQualityPass freezes 80/75/75 boundaries", () => {
  assert.deepEqual(DEFAULT_QUALITY_IS_PASS_THRESHOLD, {
    coherence: 80,
    repetition: 75,
    engagement: 75,
  });
  assert.equal(isLiteraryQualityPass({
    coherence: 80,
    repetition: 75,
    engagement: 75,
  }), true);
  assert.equal(isLiteraryQualityPass({
    coherence: 79,
    repetition: 90,
    engagement: 90,
  }), false);
  assert.equal(isLiteraryQualityPass({
    coherence: 90,
    repetition: 74,
    engagement: 90,
  }), false);
  assert.equal(isLiteraryQualityPass({
    coherence: 90,
    repetition: 90,
    engagement: 74,
  }), false);
});

// ─── A4 ────────────────────────────────────────────────────────────
test("A4: qualityLoop literary signals use isPass floors (no 65/68 dual track)", () => {
  const passAssessment = buildChapterQualityLoopAssessment({
    chapterId: "a4-pass",
    chapterOrder: 1,
    score: score({ coherence: 80, repetition: 75, engagement: 75, overall: 80 }),
    issues: [],
    evaluatedAt: "2026-07-15T00:00:00.000Z",
  });
  const literaryPass = passAssessment.signals.find((s) => s.artifactType === "literary_score");
  assert.equal(literaryPass?.status, "valid");

  // 旧 retention 阈值曾用 engagement 65；现网 isPass engagement 门是 75
  const failAtOldPass = buildChapterQualityLoopAssessment({
    chapterId: "a4-old-track",
    chapterOrder: 2,
    score: score({ coherence: 90, repetition: 90, engagement: 70, overall: 85 }),
    issues: [],
    evaluatedAt: "2026-07-15T00:00:00.000Z",
  });
  const literaryFail = failAtOldPass.signals.find((s) => s.artifactType === "literary_score");
  assert.ok(literaryFail);
  assert.notEqual(literaryFail.status, "valid");
  assert.equal(isLiteraryQualityPass({
    coherence: 90,
    repetition: 90,
    engagement: 70,
  }), false);
});

// ─── A5 ────────────────────────────────────────────────────────────
test("A5: L0 blocking (prose / SoT / mustAvoid) blocks recommendedAction=continue", () => {
  const prose = detectProseQuality("作为AI语言模型，我无法继续写小说。");
  assert.equal(prose.hasBlockingFindings, true);

  const sot = detectProseQuality("主角开启了废弃术语甲流程评估异能。", {
    bannedTerms: ["废弃术语甲"],
  });
  assert.ok(sot.findings.some((f) => f.code === "sot_banned_term"));
  assert.equal(sot.hasBlockingFindings, true);

  // 字面 + 归一化：plain 与「」包装均应命中
  const mustAvoid = detectProseQuality("他使用了禁忌术裂空斩。", {
    mustAvoidTerms: ["裂空斩"],
  });
  assert.ok(mustAvoid.findings.some((f) => f.code === "sot_must_avoid_leak"));
  assert.equal(mustAvoid.hasBlockingFindings, true);
  const mustAvoidWrapped = detectProseQuality("他使用了禁忌术「裂空斩」。", {
    mustAvoidTerms: ["裂空斩"],
  });
  assert.ok(mustAvoidWrapped.findings.some((f) => f.code === "sot_must_avoid_leak"));

  const blockingCodes = [
    ...prose.findings.filter((f) => f.severity === "high" || f.severity === "critical").map((f) => f.code),
    ...sot.findings.filter((f) => f.severity === "high" || f.severity === "critical").map((f) => f.code),
    ...mustAvoid.findings.filter((f) => f.severity === "high" || f.severity === "critical").map((f) => f.code),
  ];
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "a5-l0",
    chapterOrder: 3,
    score: score({ overall: 95, coherence: 95, repetition: 95, engagement: 95 }),
    issues: [],
    runtimePackage: {
      context: { chapter: { order: 3 } },
      audit: {
        reports: [],
        openIssues: blockingCodes.map((code) => ({
          auditType: "mode_fit",
          severity: "high",
          code,
          evidence: code,
          fixSuggestion: "清除硬伤",
        })),
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
  assert.notEqual(assessment.recommendedAction, "continue");
});

// ─── A6 ────────────────────────────────────────────────────────────
test("A6: !literaryPass cannot quality-over-approve / completed", () => {
  assert.deepEqual(chapterStatePairAfterLiteraryQualityGate(false), {
    generationState: "reviewed",
    chapterStatus: "needs_repair",
  });
  assert.deepEqual(chapterStatePairAfterManualQualityReview(false), {
    generationState: "reviewed",
    chapterStatus: "needs_repair",
  });
  assert.deepEqual(chapterStatePairAfterLiteraryQualityGate(true), {
    generationState: "approved",
    chapterStatus: "completed",
  });

  // pipeline generation bump 不得在无 literaryPass 证明时写 completed
  assert.deepEqual(
    require("../dist/services/novel/chapterLifecycleState.js")
      .mergeChapterPatchForGenerationStateBump({}, "approved"),
    { generationState: "approved" },
  );
  assert.deepEqual(
    require("../dist/services/novel/chapterLifecycleState.js")
      .mergeChapterPatchForGenerationStateBump({}, "approved", { literaryPass: true }),
    { generationState: "approved", chapterStatus: "completed" },
  );

  const failScore = score({ coherence: 70, repetition: 70, engagement: 70, overall: 70 });
  assert.equal(isLiteraryQualityPass(failScore), false);
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "a6",
    chapterOrder: 4,
    score: failScore,
    issues: [],
    evaluatedAt: "2026-07-15T00:00:00.000Z",
  });
  const update = buildChapterQualityLoopChapterUpdate({
    riskFlags: null,
    repairHistory: null,
    chapterStatus: "needs_repair",
    generationState: "approved",
  }, assessment, "pipeline_review", "defer_and_continue");
  assert.equal(update.chapterStatus, "pending_review");
  assert.notEqual(update.chapterStatus, "completed");
});

// ─── A7 ────────────────────────────────────────────────────────────
test("A7: no default-true skip_quality_repair strategy mapping in follow-up / continue", () => {
  const followUpSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/task/autoDirectorFollowUps/AutoDirectorFollowUpActionExecutor.ts"),
    "utf8",
  );
  // resolveContinueContinuationMode 必须恒返回 auto_execute_range，不得按质量检查点映射 skip
  assert.match(followUpSrc, /function resolveContinueContinuationMode/);
  assert.match(followUpSrc, /return "auto_execute_range"/);
  assert.doesNotMatch(
    followUpSrc,
    /currentItemKey === "quality_repair"[\s\S]{0,120}\? "skip_quality_repair"/,
  );

  const continueSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/director/runtime/novelDirectorContinueRuntime.ts"),
    "utf8",
  );
  assert.match(continueSrc, /function shouldSkipCurrentQualityRepair/);
  assert.match(continueSrc, /return input\.continuationMode === "skip_quality_repair"/);
  // 不得再有 auto_execute_range + quality 检查点的隐式 skip 分支
  assert.doesNotMatch(
    continueSrc,
    /continuationMode !== "auto_execute_range"[\s\S]{0,200}quality_repair/,
  );
});

// ─── A8 ────────────────────────────────────────────────────────────
test("A8: no writingQualityMode main path in shared quality + server runtime gates", () => {
  const roots = [
    path.join(__dirname, "../../shared/types"),
    path.join(__dirname, "../src/services/novel/runtime"),
    path.join(__dirname, "../src/services/novel/quality"),
  ];
  const hits = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|js)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, "utf8");
        if (text.includes("writingQualityMode")) {
          hits.push(full);
        }
      }
    };
    walk(root);
  }
  assert.deepEqual(hits, [], `unexpected writingQualityMode hits: ${hits.join(", ")}`);
});
