/**
 * AI 味 / 开篇声线 / styleClear 里程碑验收套件（mock / 纯函数 / 源码扫描，不打真网）。
 * 与 writingQualityAcceptance A7/A-H10 纪律对齐：禁止 skip_quality_repair 策略化、禁止 writingQualityMode 主路径。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  detectProseQuality,
} = require("../dist/services/novel/runtime/proseQuality/ProseQualityDetector.js");
const {
  pickBetterStyleCandidate,
  scoreTextForHotspotPick,
} = require("../dist/services/novel/runtime/styleReview/HotspotParagraphRewrite.js");
const {
  projectStyleClear,
  hasBlockingPronounProseFromIssueCodes,
} = require("../../shared/dist/types/styleClearGate.js");
const {
  buildChapterQualityLoopAssessment,
  projectStyleClearFromQualityLoop,
  isNonDeferrableProseOrSotIssueCode,
  hasNonDeferrableProseOrSotDebt,
  NON_DEFERRABLE_PROSE_OR_SOT_ISSUE_CODES,
} = require("../../shared/dist/types/chapterQualityLoop.js");
const {
  chapterStatePairAfterQualityGates,
} = require("../dist/services/novel/chapterLifecycleState.js");
const {
  buildWriterStyleContractText,
  OPEN_CHAPTER_PRONOUN_HINT,
  OPEN_CHAPTER_STYLE_HINT_MAX_ORDER,
} = require("../dist/services/styleEngine/styleContractText.js");

function stackDraft(count = 5) {
  // 句首他连续堆叠（L0 hard run≥4）
  return Array.from({ length: count }, () => "他走到窗边。").join("");
}

function cleanDraft() {
  return [
    "何屿把钥匙塞进袖口，维修通道的冷风贴着小臂往上爬。",
    "外城灯火一层层暗下去，脚步声在铁梯上断成碎片。",
    "女二没回头，只把半份账户截图按在他掌心。",
    "反压的入口已经找到，下一刀必须落在黑市账本上。",
    "远处警报还没响，但空气已经变紧。",
    "他终于把名字说出口——何屿，不是代号。",
    "铁门合上时，走廊只剩水滴敲钢板的声音。",
    "这一次，他们不再等别人开口。",
  ].join("");
}

function baseLoopInput(overrides = {}) {
  return {
    chapterId: "ch-accept",
    chapterOrder: 1,
    score: {
      coherence: 90,
      pacing: 90,
      repetition: 90,
      engagement: 90,
      voice: 90,
      overall: 90,
    },
    issues: [],
    runtimePackage: {
      context: { chapter: { order: 1 } },
      audit: { reports: [], openIssues: [] },
      failureClassification: {
        code: "none",
        summary: "",
        decisionReason: null,
        blockingObligations: [],
      },
      styleReview: {
        autoRewritten: false,
        report: {
          riskScore: 10,
          summary: "",
          canAutoRewrite: false,
          appliedRuleIds: [],
          violations: [],
        },
        residualReport: {
          riskScore: 10,
          summary: "",
          canAutoRewrite: false,
          appliedRuleIds: [],
          violations: [],
        },
      },
    },
    ...overrides,
  };
}

// ─── A1: ch1 stack 不得假 completed；清 pronoun L0 后才可 styleClear ─────────
test("acceptance: ch1-like stack draft cannot complete without rewrite path clearing pronoun L0", () => {
  const stacked = stackDraft(5);
  const prose = detectProseQuality(stacked);
  const codes = prose.findings.map((f) => f.code);
  assert.ok(
    codes.includes("prose_pronoun_subject_stack"),
    "stack draft must trip prose_pronoun_subject_stack",
  );
  assert.equal(isNonDeferrableProseOrSotIssueCode("prose_pronoun_subject_stack"), true);
  assert.ok(
    NON_DEFERRABLE_PROSE_OR_SOT_ISSUE_CODES.includes("prose_pronoun_subject_stack"),
  );

  // literaryPass 真但 pronoun hard → styleClear false → 不得 completed
  const styleClearBlocked = projectStyleClear({
    residualRiskScore: 0,
    hasBlockingPronounProse: hasBlockingPronounProseFromIssueCodes(codes),
    chapterOrder: 1,
  });
  assert.equal(styleClearBlocked, false);
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: false }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );

  // qualityLoop：blocking pronoun → style_pronoun invalid + non-deferrable debt
  const assessmentBlocked = buildChapterQualityLoopAssessment(baseLoopInput({
    chapterOrder: 1,
    runtimePackage: {
      context: { chapter: { order: 1 } },
      audit: {
        reports: [],
        openIssues: [
          {
            auditType: "mode_fit",
            severity: "high",
            code: "prose_pronoun_subject_stack",
            evidence: stacked.slice(0, 40),
            fixSuggestion: "改用专名起句",
          },
        ],
      },
      failureClassification: {
        code: "none",
        summary: "",
        decisionReason: null,
        blockingObligations: [],
      },
      styleReview: {
        autoRewritten: false,
        report: {
          riskScore: 55,
          summary: "",
          canAutoRewrite: true,
          appliedRuleIds: ["l0:prose_pronoun_subject_stack"],
          violations: [],
        },
        residualReport: {
          riskScore: 55,
          summary: "",
          canAutoRewrite: true,
          appliedRuleIds: [],
          violations: [],
        },
      },
    },
  }));
  assert.equal(projectStyleClearFromQualityLoop(assessmentBlocked), false);
  assert.equal(hasNonDeferrableProseOrSotDebt(assessmentBlocked), true);
  assert.notEqual(assessmentBlocked.recommendedAction, "continue");

  // 模拟 rewrite 清掉 stack → styleClear 可 true，双门 completed
  const cleaned = cleanDraft();
  const cleanCodes = detectProseQuality(cleaned).findings.map((f) => f.code);
  assert.equal(
    hasBlockingPronounProseFromIssueCodes(cleanCodes),
    false,
    "cleaned draft must not keep hard pronoun L0",
  );
  const styleClearOk = projectStyleClear({
    residualRiskScore: 10,
    hasBlockingPronounProse: false,
    chapterOrder: 1,
  });
  assert.equal(styleClearOk, true);
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: true }),
    {
      generationState: "approved",
      chapterStatus: "completed",
    },
  );

  // 开篇 style_contract 固定声线提示
  assert.equal(OPEN_CHAPTER_STYLE_HINT_MAX_ORDER, 3);
  assert.match(OPEN_CHAPTER_PRONOUN_HINT, /开篇忌连续句首他\/她/);
  const contractText = buildWriterStyleContractText(
    {
      narrative: {
        key: "narrative",
        title: "叙事",
        summary: "高压",
        lines: ["高压"],
        text: "叙事: 高压",
        hasContent: true,
      },
      character: {
        key: "character", title: "角色", summary: "", lines: [], text: "", hasContent: false,
      },
      language: {
        key: "language", title: "语言", summary: "", lines: [], text: "", hasContent: false,
      },
      rhythm: {
        key: "rhythm", title: "节奏", summary: "", lines: [], text: "", hasContent: false,
      },
      antiAi: {
        key: "antiAi", title: "反AI味", summary: "", lines: [], text: "", hasContent: false,
      },
      selfCheck: {
        key: "selfCheck", title: "自检", summary: "", lines: [], text: "", hasContent: false,
      },
      meta: {
        effectiveStyleProfileId: "s1",
        taskStyleProfileId: null,
        activeSourceTargets: [],
        activeSourceLabels: [],
        writerIncludedSections: ["narrative"],
        plannerIncludedSections: ["narrative"],
        droppedSections: [],
        maturity: "structured",
        usesGlobalAntiAiBaseline: false,
        globalAntiAiRuleIds: [],
        styleAntiAiRuleIds: [],
      },
    },
    { chapterOrder: 1 },
  );
  assert.match(contractText, /【开篇声线】/);
  assert.match(contractText, /开篇忌连续句首他\/她；优先专名与动作起句/);
});

// ─── A2: rewrite 引入 HUD 丢弃；baseline 保留；仍 not styleClear ─────────────
test("acceptance: rewrite introducing HUD is discarded; baseline retained; still not styleClear", () => {
  const baseline = stackDraft(5);
  const hudPoison = `【系统】任务完成。${baseline}`;
  const stillStack = "他推门。他坐下。他端杯。他沉默。他起身。他离开。";

  // 纯函数 pick：HUD 候选 hardRegression 丢弃；无更好候选 → baseline
  const picked = pickBetterStyleCandidate({
    baseline,
    candidates: [hudPoison, stillStack],
    score: (text) => scoreTextForHotspotPick(text, baseline.replace(/\s+/g, "").length),
  });
  assert.equal(picked.content, baseline, "HUD / 无改善候选不得采纳");
  assert.equal(picked.adoptedIndex, null);
  assert.ok(!picked.content.includes("【系统】"));

  // score 层：HUD 触发 hardRegression
  const hudScore = scoreTextForHotspotPick(hudPoison, baseline.replace(/\s+/g, "").length);
  assert.equal(hudScore.hardRegression, true);

  // baseline 仍有 pronoun hard → styleClear false（即使 literaryPass）
  const baseCodes = detectProseQuality(baseline).findings.map((f) => f.code);
  assert.ok(baseCodes.includes("prose_pronoun_subject_stack"));
  assert.equal(
    projectStyleClear({
      residualRiskScore: 0,
      hasBlockingPronounProse: true,
      chapterOrder: 1,
    }),
    false,
  );
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: false }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
});

// ─── A3: 中盘仅 residual 记债，非 non-deferrable L0，styleClear true + continue ─
test("acceptance: mid-book residual-only does not set non-deferrable L0 but records style_residual debt signal", () => {
  const assessment = buildChapterQualityLoopAssessment(baseLoopInput({
    chapterId: "ch-40",
    chapterOrder: 40,
    runtimePackage: {
      context: { chapter: { order: 40 } },
      audit: { reports: [], openIssues: [] },
      failureClassification: {
        code: "none",
        summary: "",
        decisionReason: null,
        blockingObligations: [],
      },
      styleReview: {
        autoRewritten: true,
        report: {
          riskScore: 60,
          summary: "pre-rewrite",
          canAutoRewrite: true,
          appliedRuleIds: [],
          violations: [],
        },
        residualReport: {
          riskScore: 50,
          summary: "residual only",
          canAutoRewrite: true,
          appliedRuleIds: [],
          violations: [],
        },
      },
    },
  }));

  const residualSignal = assessment.signals.find((s) => s.artifactType === "style_residual");
  assert.ok(residualSignal, "must record style_residual debt");
  assert.equal(residualSignal.status, "risk");

  const pronounSignal = assessment.signals.find((s) => s.artifactType === "style_pronoun");
  assert.ok(pronounSignal);
  assert.equal(pronounSignal.status, "valid");

  // residual-only 不是 non-deferrable L0 债
  assert.equal(hasNonDeferrableProseOrSotDebt(assessment), false);
  assert.equal(isNonDeferrableProseOrSotIssueCode("residual=50"), false);

  // 中盘 styleClear true + continue
  assert.equal(projectStyleClearFromQualityLoop(assessment), true);
  assert.equal(assessment.recommendedAction, "continue");
  assert.equal(
    projectStyleClear({
      residualRiskScore: 50,
      hasBlockingPronounProse: false,
      chapterOrder: 40,
    }),
    true,
  );
  // 双门可 completed（文学过 + 文风中盘 residual-only 放行）
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: true }),
    {
      generationState: "approved",
      chapterStatus: "completed",
    },
  );
});

// ─── A4: 禁止 skip_quality_repair 策略默认 + 无 writingQualityMode 主路径 ─────
test("acceptance: no skip_quality_repair strategy default in continue/follow-up mapping", () => {
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

  // 本里程碑新增/触达路径也不得引入 writingQualityMode 主架构
  const roots = [
    path.join(__dirname, "../../shared/types"),
    path.join(__dirname, "../src/services/novel/runtime"),
    path.join(__dirname, "../src/services/novel/quality"),
    path.join(__dirname, "../src/services/styleEngine"),
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
