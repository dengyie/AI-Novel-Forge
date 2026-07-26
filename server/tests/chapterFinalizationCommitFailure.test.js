const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ChapterContentFinalizationService,
} = require("../dist/services/novel/runtime/ChapterContentFinalizationService.js");

test("style rewrite commit failure stops every chapter-derived projection", async () => {
  let acceptanceCalls = 0;
  let artifactCalls = 0;
  let timelineCalls = 0;
  let commitInput = null;
  const service = new ChapterContentFinalizationService({
    qualityGateService: {
      runAcceptanceGateOnly: async () => {
        acceptanceCalls += 1;
        throw new Error("acceptance must not run before rewritten content commits");
      },
    },
    artifactSyncService: {
      syncChapterArtifacts: async () => {
        artifactCalls += 1;
      },
    },
    contentCommitService: {
      commit: async (input) => {
        commitInput = input;
        throw new Error("STYLE_REWRITE_PERSIST_FAILED");
      },
    },
    plannerService: { shouldTriggerReplanFromAudit: () => false },
    agentRuntime: { finishChapterGenRun: async () => undefined },
    postGenerationStyleReviewRunner: {
      run: async () => ({
        report: { riskScore: 80, summary: "高", violations: [], canAutoRewrite: true, appliedRuleIds: [] },
        residualReport: { riskScore: 0, summary: "干净", violations: [], canAutoRewrite: false, appliedRuleIds: [] },
        autoRewritten: true,
        originalContent: "原始草稿",
        finalContent: "改写候选",
      }),
    },
    timelineFinalizer: {
      ensurePreviousChapterFinalized: async () => {
        timelineCalls += 1;
      },
      finalizeCurrentContent: async () => {
        timelineCalls += 1;
      },
    },
  });

  await assert.rejects(
    () => service.finalizeChapterContent({
      novelId: "novel-1",
      chapterId: "chapter-1",
      expectedContentRevision: 4,
      request: {},
      contextPackage: {
        chapter: {
          id: "chapter-1",
          title: "第1章",
          order: 1,
          targetWordCount: 3000,
        },
      },
      content: "原始草稿",
      runId: null,
      startMs: null,
      deferArtifactBackgroundSync: true,
    }),
    /STYLE_REWRITE_PERSIST_FAILED/,
  );

  assert.equal(commitInput.expectedContentRevision, 4);
  assert.equal(commitInput.content, "改写候选");
  assert.equal(commitInput.source, "style_rewrite");
  assert.equal(acceptanceCalls, 0);
  assert.equal(artifactCalls, 0);
  assert.equal(timelineCalls, 0);
});
