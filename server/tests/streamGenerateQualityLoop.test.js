const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  ChapterStreamGenerationOrchestrator,
} = require("../dist/services/novel/runtime/ChapterStreamGenerationOrchestrator.js");
const {
  chapterQualityLoopService,
} = require("../dist/services/novel/quality/ChapterQualityLoopService.js");

function buildScore(overrides = {}) {
  return {
    coherence: 40,
    repetition: 40,
    pacing: 35,
    voice: 35,
    engagement: 30,
    overall: 35,
    ...overrides,
  };
}

function buildFinalizedResult(overrides = {}) {
  return {
    finalContent: "重写后的新正文。",
    contentRevision: 18,
    score: buildScore(),
    issues: [{
      severity: "high",
      category: "pacing",
      evidence: "关键节拍缺失。",
      suggestion: "补齐因果承接。",
    }],
    runtimePackage: {
      meta: { riskTags: [] },
      failureClassification: { code: null, blockingObligations: [] },
      context: { chapter: { order: 6 } },
      audit: { reports: [], openIssues: [], hasBlockingIssues: true },
      timelineCheck: { status: "passed", score: 1, issues: [] },
    },
    styleReview: { status: "skipped" },
    ...overrides,
  };
}

function buildHelpers() {
  const frames = [];
  return {
    frames,
    writeFrame(frame) {
      frames.push(frame);
    },
  };
}

test("stream generate onDone records quality-loop assessment for the new content revision", async () => {
  const originalRecordAssessment = chapterQualityLoopService.recordAssessment;
  const originalChapterFindFirst = prisma.chapter.findFirst;
  const originalChapterUpdate = prisma.chapter.update;
  const originalChapterUpdateMany = prisma.chapter.updateMany;

  const recordCalls = [];
  const chapterRow = {
    id: "chapter-6",
    novelId: "novel-1",
    order: 6,
    riskFlags: JSON.stringify({
      qualityLoop: {
        evaluatedAt: "2026-08-17T16:16:46.928Z",
        feedback: [{
          version: 1,
          chapterOrder: 6,
          chapterId: "chapter-6",
          signature: "qfb:old",
          severity: "soft",
          rootCause: "length_drift",
          codes: ["length_under_soft"],
          evidence: ["旧反馈"],
          mustFix: ["旧 mustFix"],
          planHints: [],
          failedPatchCount: 0,
          avoidRetry: false,
          evaluatedAt: "2026-08-17T16:16:46.928Z",
        }],
      },
    }),
    repairHistory: null,
    chapterStatus: "needs_repair",
    generationState: "drafted",
    contentRevision: 18,
  };

  chapterQualityLoopService.recordAssessment = async (input) => {
    recordCalls.push(input);
    return {
      chapterId: input.chapterId,
      chapterOrder: input.chapterOrder,
      overallStatus: "risk",
      recommendedAction: "patch_repair",
      signals: [],
      observabilityTags: [],
      evaluatedAt: "2026-08-18T00:00:00.000Z",
    };
  };
  // recordAssessment 内部不应再触达真实 prisma（已被 stub 拦截），
  // 但编排器其它路径若误触 DB 也要 fail-fast 而不是静默写生产库。
  prisma.chapter.findFirst = async () => {
    throw new Error("unexpected prisma.chapter.findFirst in stream onDone test");
  };
  prisma.chapter.update = async () => {
    throw new Error("unexpected prisma.chapter.update in stream onDone test");
  };
  prisma.chapter.updateMany = async () => {
    throw new Error("unexpected prisma.chapter.updateMany in stream onDone test");
  };

  const orchestrator = new ChapterStreamGenerationOrchestrator({
    assembler: {
      async assemble() {
        throw new Error("assemble should not run in this test");
      },
    },
    chapterWritingGraph: {
      async createChapterStream() {
        throw new Error("createChapterStream should not run in this test");
      },
    },
    readinessService: { assertReady() {} },
    contentFinalizationService: {
      async finalizeChapterContent() {
        return buildFinalizedResult();
      },
      async markChapterStatus() {},
    },
    agentRuntime: {
      async createChapterGenRun() {
        return "run-1";
      },
      async finishChapterGenRun() {},
    },
    validateRequest: (input) => input,
    ensureNovelCharacters: async () => {},
  });

  try {
    await orchestrator.runPostStreamQualityAssessment({
      novelId: "novel-1",
      chapterId: "chapter-6",
      chapterOrder: 6,
      finalized: buildFinalizedResult(),
    });

    assert.equal(recordCalls.length, 1, "onDone must record exactly one quality-loop assessment");
    const call = recordCalls[0];
    assert.equal(call.novelId, "novel-1");
    assert.equal(call.chapterId, "chapter-6");
    assert.equal(call.chapterOrder, 6);
    assert.equal(call.expectedContentRevision, 18, "must CAS against the finalized content revision");
    assert.equal(call.score.overall, 35);
    assert.equal(call.issues.length, 1);
    assert.equal(call.source, "generate_acceptance");
    assert.ok(call.runtimePackage, "runtime package must be forwarded so signals reflect the real audit");
  } finally {
    chapterQualityLoopService.recordAssessment = originalRecordAssessment;
    prisma.chapter.findFirst = originalChapterFindFirst;
    prisma.chapter.update = originalChapterUpdate;
    prisma.chapter.updateMany = originalChapterUpdateMany;
  }
});

test("stream generate onDone swallows quality-loop CAS conflict but logs it", async () => {
  const originalRecordAssessment = chapterQualityLoopService.recordAssessment;
  const originalWarn = console.warn;
  const warnings = [];

  chapterQualityLoopService.recordAssessment = async () => {
    const error = new Error("CHAPTER_CONTENT_CONFLICT");
    error.details = { code: "CHAPTER_CONTENT_CONFLICT" };
    throw error;
  };
  console.warn = (...args) => {
    warnings.push(args);
  };

  const orchestrator = new ChapterStreamGenerationOrchestrator({
    assembler: { async assemble() { throw new Error("n/a"); } },
    chapterWritingGraph: { async createChapterStream() { throw new Error("n/a"); } },
    readinessService: { assertReady() {} },
    contentFinalizationService: {
      async finalizeChapterContent() { return buildFinalizedResult(); },
      async markChapterStatus() {},
    },
    agentRuntime: {
      async createChapterGenRun() { return "run-1"; },
      async finishChapterGenRun() {},
    },
    validateRequest: (input) => input,
    ensureNovelCharacters: async () => {},
  });

  try {
    await assert.doesNotReject(() => orchestrator.runPostStreamQualityAssessment({
      novelId: "novel-1",
      chapterId: "chapter-6",
      chapterOrder: 6,
      finalized: buildFinalizedResult(),
    }));
    assert.ok(
      warnings.some((args) => String(args[0]).includes("quality loop")),
      "CAS miss must be logged for observability, not silently swallowed",
    );
  } finally {
    chapterQualityLoopService.recordAssessment = originalRecordAssessment;
    console.warn = originalWarn;
  }
});
