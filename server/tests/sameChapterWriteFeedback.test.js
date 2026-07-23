const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSameChapterWriteFeedbackFromEmpty,
  buildSameChapterWriteFeedbackFromChineseGate,
  buildSameChapterWriteFeedbackFromError,
  applySameChapterWriteFeedbackToAssembled,
  packSameChapterWriteFeedbackLines,
  hasSameChapterWriteFeedbackLines,
  formatSameChapterWriteFeedbackLog,
  SAME_CHAPTER_WRITE_FEEDBACK_MARKER,
} = require("../dist/services/novel/runtime/sameChapterWriteFeedback.js");
const {
  ChapterEmptyContentError,
} = require("../dist/services/novel/runtime/chapterEmptyContentError.js");
const {
  ChapterChineseProseGateError,
} = require("../dist/services/novel/runtime/chapterChineseProseGateError.js");
const {
  buildChapterWriterContextBlocks,
} = require("../dist/prompting/prompts/novel/chapterLayeredContext.js");

test("buildSameChapterWriteFeedbackFromEmpty produces labeled mustFix lines", () => {
  const error = new ChapterEmptyContentError({
    novelId: "n1",
    chapterId: "c1",
    chapterOrder: 3,
    source: "test",
    rawLength: 2,
    trimmedLength: 0,
  });
  const feedback = buildSameChapterWriteFeedbackFromEmpty(error);
  assert.equal(feedback.kind, "empty_content");
  assert.ok(feedback.codes.includes("empty_content"));
  assert.ok(feedback.lines.some((line) => line.includes("本章上枪")));
  assert.ok(feedback.mustFix.some((item) => item.includes("中文叙事")));
});

test("buildSameChapterWriteFeedbackFromChineseGate keeps meta evidence before generic mustFix", () => {
  const error = new ChapterChineseProseGateError({
    novelId: "n1",
    chapterId: "c1",
    chapterOrder: 12,
    source: "test",
    reason: "english_meta",
    metaMarker: "We need to write",
    cjkCount: 10,
    latinCount: 900,
    rawLength: 1200,
  });
  const feedback = buildSameChapterWriteFeedbackFromChineseGate(error);
  assert.equal(feedback.kind, "chinese_prose_gate");
  assert.ok(feedback.codes.includes("chinese_prose_gate"));
  assert.ok(feedback.mustFix.some((item) => /We need|英文/i.test(item)));
  // P1: meta evidence must appear in packed lines (not truncated by line cap).
  assert.ok(
    feedback.lines.some((line) => line.includes("We need to write")),
    `expected meta evidence in lines, got ${JSON.stringify(feedback.lines)}`,
  );
  assert.ok(
    feedback.lines.some((line) => line.includes("english_meta") || line.includes("reason=english_meta")),
    `expected reason evidence in lines, got ${JSON.stringify(feedback.lines)}`,
  );
  assert.ok(feedback.lines[0].includes("中文硬门"));
  // Evidence lines should appear before "必须" lines after the header.
  const metaIdx = feedback.lines.findIndex((line) => line.includes("We need to write"));
  const mustIdx = feedback.lines.findIndex((line) => line.includes("必须："));
  assert.ok(metaIdx > 0 && mustIdx > metaIdx, "evidence should be packed before mustFix");
});

test("packSameChapterWriteFeedbackLines prioritizes evidence under tight cap", () => {
  const lines = packSameChapterWriteFeedbackLines({
    kind: "chinese_prose_gate",
    mustFix: ["fix-a 很长很长", "fix-b", "fix-c"],
    evidence: ["meta=We need Paragraph plan", "reason=english_meta; cjk=1; latin=99"],
    codes: ["chinese_prose_gate", "english_meta"],
    maxLines: 5,
  });
  assert.equal(lines.length <= 5, true);
  assert.ok(lines.some((line) => line.includes("We need")));
  assert.ok(lines.some((line) => line.includes("english_meta")));
  assert.ok(hasSameChapterWriteFeedbackLines(lines));
});

test("buildSameChapterWriteFeedbackFromError returns null for transport-like errors", () => {
  assert.equal(buildSameChapterWriteFeedbackFromError(new Error("socket hang up")), null);
  assert.equal(buildSameChapterWriteFeedbackFromError(null), null);
});

test("applySameChapterWriteFeedbackToAssembled prepends lines without mutating original", () => {
  const original = {
    novel: { id: "n1", title: "t" },
    chapter: { id: "c1", title: "ch", order: 1, content: null, expectation: null },
    contextPackage: {
      priorQualityFeedback: ["上章债：重复"],
      chapterWriteContext: {
        priorQualityFeedback: ["上章债：重复"],
        chapterMission: { title: "x" },
      },
    },
  };
  const lines = ["【本章上枪】必须：输出中文正文"];
  const next = applySameChapterWriteFeedbackToAssembled(original, lines);

  assert.notEqual(next, original);
  assert.notEqual(next.contextPackage, original.contextPackage);
  assert.deepEqual(original.contextPackage.priorQualityFeedback, ["上章债：重复"]);
  assert.deepEqual(next.contextPackage.priorQualityFeedback, [
    "【本章上枪】必须：输出中文正文",
    "上章债：重复",
  ]);
  assert.deepEqual(next.contextPackage.chapterWriteContext.priorQualityFeedback, [
    "【本章上枪】必须：输出中文正文",
    "上章债：重复",
  ]);
  assert.equal(next.contextPackage.chapterWriteContext.chapterMission.title, "x");
});

test("applySameChapterWriteFeedbackToAssembled no-ops on empty lines", () => {
  const assembled = {
    contextPackage: { priorQualityFeedback: ["a"] },
  };
  assert.equal(applySameChapterWriteFeedbackToAssembled(assembled, []), assembled);
  assert.equal(applySameChapterWriteFeedbackToAssembled(assembled, null), assembled);
});

test("formatSameChapterWriteFeedbackLog marks injected when willRetry", () => {
  const feedback = buildSameChapterWriteFeedbackFromChineseGate(new ChapterChineseProseGateError({
    novelId: "n1",
    chapterId: "c1",
    chapterOrder: 1,
    source: "t",
    reason: "english_meta",
    metaMarker: "We need",
    cjkCount: 0,
    latinCount: 10,
    rawLength: 10,
  }));
  const log = formatSameChapterWriteFeedbackLog({
    feedback,
    willRetry: true,
    novelId: "n1",
    chapterId: "c1",
    chapterOrder: 1,
    attempt: 1,
  });
  assert.equal(log.injected, true);
  assert.equal(log.kind, "chinese_prose_gate");
  assert.ok(log.lineCount > 0);
  assert.equal(
    formatSameChapterWriteFeedbackLog({ feedback, willRetry: false }).injected,
    false,
  );
});

test("writer context block protects same-chapter feedback from summary drops", () => {
  const withGun = {
    bookContract: null,
    macroConstraints: null,
    volumeWindow: null,
    chapterMission: {
      chapterId: "c1",
      chapterOrder: 1,
      title: "t",
      objective: "o",
      missionSummary: "m",
      taskSheet: null,
      targetWordCount: 1000,
      planRole: null,
      hookTarget: "h",
      mustAdvance: [],
      mustPreserve: [],
      riskNotes: [],
    },
    nextAction: "write_chapter",
    chapterStateGoal: null,
    protectedSecrets: [],
    payoffDirectives: [],
    obligationContract: {
      mustHitNow: [],
      mustPreserve: [],
      requiredPayoffTouches: [],
      requiredCharacterAppearances: [],
      requiredGoalChanges: [],
      canDefer: [],
      forbiddenCrossings: [],
    },
    chapterBoundary: null,
    lengthBudget: null,
    scenePlan: null,
    participants: [],
    characterHardFacts: [],
    characterBehaviorGuides: [],
    activeRelationStages: [],
    pendingCandidateGuards: [],
    localStateSummary: "s",
    openConflictSummaries: [],
    ledgerPendingItems: [],
    ledgerUrgentItems: [],
    ledgerOverdueItems: [],
    recentChapterSummaries: [],
    previousChapterTail: null,
    priorQualityFeedback: [
      "【本章上枪·中文硬门失败】下一枪必须改正：",
      "【本章上枪】证据：meta=We need",
    ],
    openingAntiRepeatHint: "x",
    styleContract: null,
    styleConstraints: [],
    continuationConstraints: [],
    ragFacts: [],
    completedMilestones: [],
    recentScenePatterns: [],
  };

  const blocks = buildChapterWriterContextBlocks(withGun);
  const feedbackBlock = blocks.find((b) => b.id === "prior_quality_feedback");
  assert.ok(feedbackBlock, "prior_quality_feedback block should exist");
  assert.equal(feedbackBlock.allowSummary, false);
  assert.equal(feedbackBlock.required, true);
  assert.ok(feedbackBlock.content.includes(SAME_CHAPTER_WRITE_FEEDBACK_MARKER));

  const priorOnly = {
    ...withGun,
    priorQualityFeedback: ["第3章 [soft/repetition] 避免重复开场"],
  };
  const priorBlocks = buildChapterWriterContextBlocks(priorOnly);
  const priorBlock = priorBlocks.find((b) => b.id === "prior_quality_feedback");
  assert.ok(priorBlock);
  assert.equal(priorBlock.allowSummary, true);
  assert.equal(priorBlock.required, false);
});
