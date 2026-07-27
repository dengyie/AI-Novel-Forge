const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  createChapterContentConflictError,
} = require("../dist/services/novel/chapterContentCas.js");
const {
  ChapterRepairFinalizer,
} = require("../dist/services/novel/runtime/repair/application/ChapterRepairFinalizer.js");

const SCORE_70 = {
  coherence: 70,
  repetition: 70,
  pacing: 70,
  voice: 70,
  engagement: 70,
  overall: 70,
};
const SCORE_92 = {
  coherence: 92,
  repetition: 92,
  pacing: 92,
  voice: 92,
  engagement: 92,
  overall: 92,
};

test("repair adoption cannot overwrite a manual edit committed after generation started", async () => {
  const originalFindFirst = prisma.chapter.findFirst;
  const originalUpdate = prisma.chapter.update;
  let artifactSyncCalls = 0;
  let committedInput = null;
  const frames = [];
  let persistedContent = "人工编辑后的正文";

  try {
    prisma.chapter.findFirst = async () => ({
      id: "chapter-1",
      order: 3,
      content: persistedContent,
      contentRevision: 8,
      repairHistory: null,
      riskFlags: null,
      qualityScore: 70,
      continuityScore: 70,
      characterScore: 70,
      pacingScore: 70,
      mustAvoid: null,
      novel: {
        storyWorldSliceJson: null,
        storyWorldSliceOverridesJson: null,
      },
    });
    prisma.chapter.update = async () => {
      throw new Error("CAS conflict path must not use unconditional chapter.update");
    };

    const finalizer = new ChapterRepairFinalizer({
      contentCommitService: {
        commit: async (input) => {
          committedInput = input;
          throw createChapterContentConflictError({
            currentContentRevision: 8,
            expectedContentRevision: input.expectedContentRevision,
          });
        },
      },
      artifactSyncService: {
        syncChapterArtifacts: async () => {
          artifactSyncCalls += 1;
        },
      },
      reviewChapterAfterRepair: async (_novelId, _chapterId, options) => ({
        score: options.content === "后台修复候选" ? SCORE_92 : SCORE_70,
        issues: [],
      }),
      resolveAuditIssues: async () => undefined,
    });

    await finalizer.finalize({
      novelId: "novel-1",
      chapterId: "chapter-1",
      baselineContentRevision: 7,
      options: { repairMode: "heavy_repair" },
      content: "后台修复候选",
      helpers: {
        writeFrame(frame) {
          frames.push(frame);
        },
      },
    });

    assert.equal(committedInput.expectedContentRevision, 7);
    assert.equal(committedInput.source, "repair_adopt");
    assert.equal(persistedContent, "人工编辑后的正文");
    assert.equal(artifactSyncCalls, 0);
    assert.equal(frames.some((frame) => frame.status === "succeeded"), false);
    assert.equal(frames.at(-1).status, "failed");
    assert.match(frames.at(-1).message, /正文.*变更|人工编辑|并发/);
  } finally {
    prisma.chapter.findFirst = originalFindFirst;
    prisma.chapter.update = originalUpdate;
  }
});

test("repair recheck CAS miss leaves newer content state untouched and does not resolve audit issues", async () => {
  const originalFindFirst = prisma.chapter.findFirst;
  const originalUpdateMany = prisma.chapter.updateMany;
  const originalTransaction = prisma.$transaction;
  const frames = [];
  let auditResolveCalls = 0;
  const updateManyCalls = [];

  try {
    prisma.chapter.findFirst = async () => ({
      id: "chapter-1",
      order: 3,
      content: "修复前正文",
      contentRevision: 7,
      repairHistory: null,
      riskFlags: null,
      qualityScore: 70,
      continuityScore: 70,
      characterScore: 70,
      pacingScore: 70,
      mustAvoid: null,
      novel: { storyWorldSliceJson: null, storyWorldSliceOverridesJson: null },
    });
    prisma.$transaction = async (callback) => callback({
      chapter: {
        updateMany: async (input) => {
          updateManyCalls.push(input);
          return { count: 0 };
        },
        findFirst: async () => ({ contentRevision: 9 }),
      },
      qualityReport: { create: async () => ({}) },
    });
    prisma.chapter.updateMany = async (input) => {
      updateManyCalls.push(input);
      return { count: 0 };
    };

    const finalizer = new ChapterRepairFinalizer({
      contentCommitService: {
        commit: async (input) => ({
          novelId: input.novelId,
          chapterId: input.chapterId,
          content: input.content,
          contentRevision: 8,
        }),
      },
      artifactSyncService: { syncChapterArtifacts: async () => undefined },
      reviewChapterAfterRepair: async (_novelId, _chapterId, options) => ({
        score: options.content === "修复候选" ? SCORE_92 : SCORE_70,
        issues: [],
      }),
      resolveAuditIssues: async () => {
        auditResolveCalls += 1;
      },
    });

    await finalizer.finalize({
      novelId: "novel-1",
      chapterId: "chapter-1",
      baselineContentRevision: 7,
      options: { repairMode: "heavy_repair", auditIssueIds: ["audit-1"] },
      content: "修复候选",
      helpers: { writeFrame: (frame) => frames.push(frame) },
    });

    assert.ok(updateManyCalls.some((input) => input.where?.contentRevision === 8));
    assert.equal(auditResolveCalls, 0);
    assert.equal(frames.at(-1).status, "failed");
    assert.match(frames.at(-1).message, /正文.*变更|并发|重新/);
  } finally {
    prisma.chapter.findFirst = originalFindFirst;
    prisma.chapter.updateMany = originalUpdateMany;
    prisma.$transaction = originalTransaction;
  }
});
