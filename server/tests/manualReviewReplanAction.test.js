const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  NovelCoreReviewService,
} = require("../dist/services/novel/novelCoreReviewService.js");
const {
  plannerService,
} = require("../dist/services/planner/PlannerService.js");
const {
  chapterQualityLoopService,
} = require("../dist/services/novel/quality/ChapterQualityLoopService.js");

async function runReviewWithAction(action) {
  const original = {
    findFirst: prisma.chapter.findFirst,
    update: prisma.chapter.update,
    transaction: prisma.$transaction,
    recordAssessment: chapterQualityLoopService.recordAssessment,
    buildReplanRecommendation: plannerService.buildReplanRecommendation,
    replan: plannerService.replan,
  };
  let replanCalls = 0;
  prisma.chapter.findFirst = async () => ({
    id: "chapter-1",
    novelId: "novel-1",
    order: 1,
    title: "第一章",
    content: "这是一段可审校的章节正文。",
    novel: { title: "测试小说" },
  });
  prisma.chapter.update = async () => ({});
  prisma.$transaction = async (runner) => runner({
    chapter: { update: async () => ({}) },
    qualityReport: { create: async () => ({}) },
  });
  chapterQualityLoopService.recordAssessment = async () => ({});
  plannerService.buildReplanRecommendation = () => ({
    recommended: true,
    action,
    reason: "审校发现结构问题",
    triggerReason: "审校发现结构问题",
    blockingIssueIds: ["issue-1"],
  });
  plannerService.replan = async () => {
    replanCalls += 1;
    return {};
  };

  try {
    const service = new NovelCoreReviewService();
    service.reviewChapterWithAudit = async () => ({
      score: {
        coherence: 90,
        repetition: 90,
        pacing: 90,
        voice: 90,
        engagement: 90,
        overall: 90,
      },
      issues: [],
      auditReports: [{ id: "audit-1", issues: [] }],
      contextPackage: null,
    });
    await service.reviewChapter("novel-1", "chapter-1");
    return replanCalls;
  } finally {
    prisma.chapter.findFirst = original.findFirst;
    prisma.chapter.update = original.update;
    prisma.$transaction = original.transaction;
    chapterQualityLoopService.recordAssessment = original.recordAssessment;
    plannerService.buildReplanRecommendation = original.buildReplanRecommendation;
    plannerService.replan = original.replan;
  }
}

test("manual review keeps local_patch_plan local and does not invoke Planner replan", async () => {
  assert.equal(await runReviewWithAction("local_patch_plan"), 0);
});

test("manual review invokes Planner exactly once for explicit stop_for_replan", async () => {
  assert.equal(await runReviewWithAction("stop_for_replan"), 1);
});
