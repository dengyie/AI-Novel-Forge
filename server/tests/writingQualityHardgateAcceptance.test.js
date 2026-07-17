/**
 * 写文质量硬门验收矩阵 A-H1…A-H11
 * docs/plans/writing-quality-hardgate-architecture-plan.md §6
 * 纯函数 + 确定性 L0 门禁；不依赖生产写书 / 不注入真实书词表。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildChapterQualityLoopAssessment,
  classifyChapterQualityLoopRiskFlags,
  hasNonDeferrableProseOrSotDebt,
  projectL0ClearFromQualityLoop,
  projectL0ClearFromRiskFlags,
} = require("../../shared/dist/types/chapterQualityLoop.js");
const {
  DEFAULT_QUALITY_IS_PASS_THRESHOLD,
  isLiteraryQualityPass,
  projectLiteraryPassFromRiskFlags,
} = require("../../shared/dist/types/literaryQualityPass.js");
const {
  decideRepairContentAdoption,
} = require("../../shared/dist/types/repairAdoptDecision.js");
const {
  evaluateLengthBudget,
  LENGTH_HARD_UNDER_RATIO,
} = require("../../shared/dist/types/chapterLengthControl.js");
const {
  detectProseQuality,
} = require("../dist/services/novel/runtime/proseQuality/ProseQualityDetector.js");
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

function codes(report) {
  return report.findings.map((finding) => finding.code);
}

function sotOpenIssue(code = "sot_banned_term", evidence = "fixture-banned-term") {
  return {
    auditType: "mode_fit",
    severity: "high",
    code,
    evidence,
    fixSuggestion: "删除或改写泄漏词。",
  };
}

function baseRuntimePackage(openIssues = []) {
  return {
    context: { chapter: { order: 1 } },
    audit: {
      reports: [],
      openIssues,
    },
    failureClassification: {
      code: "none",
      summary: "未触发全局重规划。",
      decisionReason: null,
      blockingObligations: [],
    },
  };
}

// ─── A-H1 ──────────────────────────────────────────────────────────
test("A-H1: non-empty sotBannedTerms hit → sot_banned_term + prose_quality invalid", () => {
  const report = detectProseQuality(
    "他推开门，看见了禁忌语：源核熔断。",
    { bannedTerms: ["源核熔断"], mustAvoidTerms: [] },
  );
  assert.ok(codes(report).includes("sot_banned_term"));
  assert.equal(report.hasBlockingFindings, true);

  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "ah1",
    chapterOrder: 1,
    score: score(),
    issues: [],
    runtimePackage: baseRuntimePackage([sotOpenIssue("sot_banned_term", "源核熔断")]),
    evaluatedAt: "2026-07-17T00:00:00.000Z",
  });
  const prose = assessment.signals.find((s) => s.artifactType === "prose_quality");
  assert.equal(prose?.status, "invalid");
  assert.ok(prose?.issueCodes.includes("sot_banned_term"));
  assert.equal(assessment.overallStatus, "invalid");
});

// ─── A-H2 ──────────────────────────────────────────────────────────
test("A-H2: high c/r/e + sot hit → not continue-clear; defer classify blocking", () => {
  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "ah2",
    chapterOrder: 2,
    score: score({ coherence: 95, repetition: 95, engagement: 95, overall: 95 }),
    issues: [],
    runtimePackage: baseRuntimePackage([sotOpenIssue()]),
    evaluatedAt: "2026-07-17T00:00:00.000Z",
  });
  assert.equal(isLiteraryQualityPass(assessment.score ?? score({
    coherence: 95, repetition: 95, engagement: 95,
  })), true);
  // assessment itself doesn't carry score; re-check triad on input score
  assert.equal(isLiteraryQualityPass({
    coherence: 95, repetition: 95, engagement: 95, overall: 95,
  }), true);
  assert.notEqual(assessment.recommendedAction, "continue");
  assert.equal(assessment.overallStatus, "invalid");

  const deferred = JSON.stringify({
    qualityLoop: {
      ...assessment,
      terminalAction: "defer_and_continue",
    },
  });
  assert.equal(classifyChapterQualityLoopRiskFlags(deferred), "blocking");
  assert.equal(projectL0ClearFromRiskFlags(deferred), false);
  // litPass 仍可 true，l0Clear 必 false — 正交
  assert.equal(
    projectLiteraryPassFromRiskFlags(JSON.stringify({
      qualityLoop: {
        signals: [{
          artifactType: "literary_score",
          status: "valid",
          issueCodes: [],
          metrics: { coherence: 95, repetition: 95, engagement: 95 },
        }],
      },
    })),
    true,
  );
});

// ─── A-H3 ──────────────────────────────────────────────────────────
test("A-H3: defer_and_continue + sot/HUD/critical prose → blocking (not non_blocking)", () => {
  for (const issueCode of [
    "sot_banned_term",
    "prose_system_hud",
    "prose_ai_self_reference",
  ]) {
    const riskFlags = JSON.stringify({
      qualityLoop: {
        overallStatus: "invalid",
        recommendedAction: "patch_repair",
        rootCauseCode: "draft_repair_exhausted",
        terminalAction: "defer_and_continue",
        signals: [{
          artifactType: "prose_quality",
          status: "invalid",
          issueCodes: [issueCode],
        }],
      },
    });
    assert.equal(
      classifyChapterQualityLoopRiskFlags(riskFlags),
      "blocking",
      `expected blocking for ${issueCode}`,
    );
    assert.equal(hasNonDeferrableProseOrSotDebt(JSON.parse(riskFlags).qualityLoop), true);
    assert.equal(projectL0ClearFromRiskFlags(riskFlags), false);
  }
});

// ─── A-H4 ──────────────────────────────────────────────────────────
test("A-H4: empty bannedTerms + same body → no sot_* codes (book-agnostic)", () => {
  const body = "他推开门，看见了禁忌语：源核熔断。";
  const empty = detectProseQuality(body, { bannedTerms: [], mustAvoidTerms: [] });
  assert.equal(codes(empty).some((c) => c.startsWith("sot_")), false);

  const omitted = detectProseQuality(body);
  assert.equal(codes(omitted).some((c) => c.startsWith("sot_")), false);
});

// ─── A-H5 ──────────────────────────────────────────────────────────
test("A-H5: typical 【系统…】 HUD → prose_system_hud + classify blocking", () => {
  const report = detectProseQuality([
    "门轴吱呀一声，他踏入锈蚀的舱室。",
    "【系统提示：检测到宿主异常，状态面板已开启】",
    "【HP：120/120　MP：40/80　冷却：3秒】",
    "他眉头一紧，却把视线移开。",
  ].join("\n"));
  assert.ok(codes(report).includes("prose_system_hud"));
  assert.equal(report.hasBlockingFindings, true);

  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "ah5",
    chapterOrder: 5,
    score: score(),
    issues: [],
    runtimePackage: baseRuntimePackage([{
      auditType: "mode_fit",
      severity: "high",
      code: "prose_system_hud",
      evidence: "【系统提示：…】",
      fixSuggestion: "删除系统面板结构。",
    }]),
    evaluatedAt: "2026-07-17T00:00:00.000Z",
  });
  const prose = assessment.signals.find((s) => s.artifactType === "prose_quality");
  assert.equal(prose?.status, "invalid");
  assert.ok(prose?.issueCodes.includes("prose_system_hud"));

  const deferred = JSON.stringify({
    qualityLoop: { ...assessment, terminalAction: "defer_and_continue" },
  });
  assert.equal(classifyChapterQualityLoopRiskFlags(deferred), "blocking");
  assert.equal(projectL0ClearFromRiskFlags(deferred), false);
});

// ─── A-H6 ──────────────────────────────────────────────────────────
test("A-H6: harmless fullwidth brackets / short names are not HUD", () => {
  const report = detectProseQuality([
    "他自称【裂空】，旁人只当是绰号。",
    "地图上标着【北港】两个字。",
    "她把【旧钥】塞进他掌心，没有多说。",
    // 软关键词短绰号：不得因「等级/冷却/面板」单独抬 HUD
    "他外号【等级】，同伴只当玩笑。",
    "她把那块【冷却】石塞回口袋。",
    "潮声压在城墙外，守夜人握紧刀柄。",
  ].join("\n"));
  assert.equal(codes(report).includes("prose_system_hud"), false, `codes=${codes(report).join(",")}`);
  assert.equal(report.hasBlockingFindings, false);
});

// ─── A-H6b channel-1 契约：仅 non-deferrable → invalid ───────────
test("A-H6b: channel-1 prose_quality invalid only for non-deferrable codes", () => {
  // high 但可 defer 的文风债 → risk，不得 invalid（避免 dual-channel 误硬门）
  const engineering = buildChapterQualityLoopAssessment({
    chapterId: "ah6b-eng",
    chapterOrder: 61,
    score: score(),
    issues: [],
    runtimePackage: baseRuntimePackage([{
      auditType: "mode_fit",
      severity: "high",
      code: "prose_engineering_term_leak",
      evidence: "细纲",
      fixSuggestion: "删工程词。",
    }]),
    evaluatedAt: "2026-07-17T00:00:00.000Z",
  });
  const engProse = engineering.signals.find((s) => s.artifactType === "prose_quality");
  assert.equal(engProse?.status, "risk");
  assert.equal(hasNonDeferrableProseOrSotDebt(engineering), false);
  assert.equal(projectL0ClearFromQualityLoop(engineering), true);

  // non-deferrable 即使 severity 写成 medium 也应 invalid（码集合优先）
  const hud = buildChapterQualityLoopAssessment({
    chapterId: "ah6b-hud",
    chapterOrder: 62,
    score: score(),
    issues: [],
    runtimePackage: baseRuntimePackage([{
      auditType: "mode_fit",
      severity: "medium",
      code: "prose_system_hud",
      evidence: "【系统：任务】",
      fixSuggestion: "删 HUD。",
    }]),
    evaluatedAt: "2026-07-17T00:00:00.000Z",
  });
  const hudProse = hud.signals.find((s) => s.artifactType === "prose_quality");
  assert.equal(hudProse?.status, "invalid");
  assert.equal(hasNonDeferrableProseOrSotDebt(hud), true);
  assert.equal(projectL0ClearFromQualityLoop(hud), false);
});

// ─── A-H7 ──────────────────────────────────────────────────────────
test("A-H7: !literaryPass only + defer → non_blocking; never completed", () => {
  const failScore = score({
    coherence: 70, repetition: 70, engagement: 70, overall: 70,
  });
  assert.equal(isLiteraryQualityPass(failScore), false);

  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "ah7",
    chapterOrder: 7,
    score: failScore,
    issues: [],
    evaluatedAt: "2026-07-17T00:00:00.000Z",
  });
  // 无 L0 openIssues → 不得因 literary 失败 alone 抬 non-deferrable
  assert.equal(hasNonDeferrableProseOrSotDebt(assessment), false);
  assert.equal(projectL0ClearFromQualityLoop(assessment), true);

  const deferred = JSON.stringify({
    qualityLoop: {
      ...assessment,
      terminalAction: "defer_and_continue",
    },
  });
  assert.equal(classifyChapterQualityLoopRiskFlags(deferred), "non_blocking_quality_debt");

  const update = buildChapterQualityLoopChapterUpdate({
    riskFlags: null,
    repairHistory: null,
    chapterStatus: "needs_repair",
    generationState: "approved",
  }, assessment, "pipeline_review", "defer_and_continue");
  assert.equal(update.chapterStatus, "pending_review");
  assert.notEqual(update.chapterStatus, "completed");
});

// ─── A-H8 ──────────────────────────────────────────────────────────
test("A-H8: isPass formula frozen at 80/75/75", () => {
  assert.deepEqual(DEFAULT_QUALITY_IS_PASS_THRESHOLD, {
    coherence: 80,
    repetition: 75,
    engagement: 75,
  });
  assert.equal(isLiteraryQualityPass({
    coherence: 80, repetition: 75, engagement: 75,
  }), true);
  assert.equal(isLiteraryQualityPass({
    coherence: 79, repetition: 90, engagement: 90,
  }), false);
  assert.equal(isLiteraryQualityPass({
    coherence: 90, repetition: 74, engagement: 90,
  }), false);
  assert.equal(isLiteraryQualityPass({
    coherence: 90, repetition: 90, engagement: 74,
  }), false);
});

// ─── A-H9 ──────────────────────────────────────────────────────────
test("A-H9: short chapter < target×0.6 → length tag; does not flip literaryPass alone", () => {
  assert.equal(LENGTH_HARD_UNDER_RATIO, 0.6);
  const evaluation = evaluateLengthBudget({
    content: "字".repeat(1500),
    targetWordCount: 3000,
  });
  assert.ok(evaluation);
  assert.ok(evaluation.riskTags.includes("length_under_hard"));

  const passScore = score({ coherence: 88, repetition: 88, engagement: 88, overall: 88 });
  assert.equal(isLiteraryQualityPass(passScore), true);

  const assessment = buildChapterQualityLoopAssessment({
    chapterId: "ah9",
    chapterOrder: 9,
    score: passScore,
    issues: [],
    runtimePackage: {
      ...baseRuntimePackage(),
      meta: {
        riskTags: ["length_under_hard", "ending_hook"],
      },
    },
    evaluatedAt: "2026-07-17T00:00:00.000Z",
  });
  assert.deepEqual(assessment.observabilityTags, ["length_under_hard"]);
  // 仅 length tag 不进 L0 / 不抬 blocking defer
  assert.equal(assessment.recommendedAction, "continue");
  assert.equal(hasNonDeferrableProseOrSotDebt(assessment), false);
  assert.equal(projectL0ClearFromQualityLoop(assessment), true);
  assert.equal(isLiteraryQualityPass(passScore), true);
});

// ─── A-H10 ─────────────────────────────────────────────────────────
test("A-H10: no strategy-default skip_quality_repair; no writingQualityMode main path", () => {
  const followUpSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/task/autoDirectorFollowUps/AutoDirectorFollowUpActionExecutor.ts"),
    "utf8",
  );
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
  assert.match(continueSrc, /function resolveContinuationExecutionFlags/);
  assert.match(continueSrc, /skipCurrentQualityRepair:\s*false/);
  assert.doesNotMatch(
    continueSrc,
    /return input\.continuationMode === "skip_quality_repair"/,
  );
  assert.match(
    continueSrc,
    /continuationMode === "auto_execute_range"[\s\S]{0,80}continuationMode === "skip_quality_repair"/,
  );
  assert.doesNotMatch(
    continueSrc,
    /continuationMode !== "auto_execute_range"[\s\S]{0,200}quality_repair/,
  );

  const checkpointSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/director/automation/novelDirectorAutoExecutionCheckpointRuntime.ts"),
    "utf8",
  );
  assert.match(checkpointSrc, /const canSkipCurrentQualityRepair = false/);
  assert.doesNotMatch(checkpointSrc, /source:\s*"review_skip"/);

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

// ─── A-H11 ─────────────────────────────────────────────────────────
test("A-H11: adopt discards candidate that introduces L0 (HUD / sot / critical prose)", () => {
  for (const code of ["prose_system_hud", "sot_banned_term", "prose_ai_self_reference"]) {
    const result = decideRepairContentAdoption({
      baselineScore: score({ overall: 80, coherence: 80, repetition: 80, engagement: 80 }),
      candidateScore: score({ overall: 95, coherence: 95, repetition: 95, engagement: 95 }),
      baselineBlockingCodes: [],
      candidateBlockingCodes: [code],
    });
    assert.equal(result.decision, "discard", `expected discard for introduced ${code}`);
    assert.ok(result.introducedBlockingCodes.includes(code));
  }

  // baseline 已有 L0、candidate 清掉 → 可 adopt（无新增 L0）
  const clearL0 = decideRepairContentAdoption({
    baselineScore: score({ overall: 70, coherence: 70, repetition: 70, engagement: 70 }),
    candidateScore: score({ overall: 88, coherence: 88, repetition: 88, engagement: 88 }),
    baselineBlockingCodes: ["prose_system_hud"],
    candidateBlockingCodes: [],
  });
  assert.equal(clearL0.decision, "adopt");
});

// ─── l0Clear projection (phase-3 DTO) ──────────────────────────────
test("projectL0Clear: null without qualityLoop; true when clean; false with non-deferrable", () => {
  assert.equal(projectL0ClearFromQualityLoop(null), null);
  assert.equal(projectL0ClearFromQualityLoop(undefined), null);
  assert.equal(projectL0ClearFromRiskFlags(null), null);
  assert.equal(projectL0ClearFromRiskFlags("{}"), null);
  assert.equal(projectL0ClearFromRiskFlags("not-json"), null);

  assert.equal(projectL0ClearFromQualityLoop({
    overallStatus: "valid",
    recommendedAction: "continue",
    signals: [],
  }), true);

  assert.equal(projectL0ClearFromQualityLoop({
    overallStatus: "invalid",
    recommendedAction: "patch_repair",
    terminalAction: "defer_and_continue",
    signals: [{
      artifactType: "prose_quality",
      status: "invalid",
      issueCodes: ["sot_banned_term"],
    }],
  }), false);

  // 仅 literary invalid → l0Clear 仍 true（正交）
  assert.equal(projectL0ClearFromQualityLoop({
    overallStatus: "invalid",
    recommendedAction: "patch_repair",
    terminalAction: "defer_and_continue",
    signals: [{
      artifactType: "literary_score",
      status: "invalid",
      issueCodes: ["literary:engagement"],
    }],
  }), true);
});
