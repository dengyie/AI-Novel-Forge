const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createVolumeReadinessRun,
  getVolumeReadinessRun,
  resetVolumeReadinessRunStoreForTests,
} = require("../dist/services/novel/volume/volumeReadinessRunStore.js");
const {
  volumeReadinessExecutor,
  mapRepairOutcomeFromFrames,
} = require("../dist/services/novel/volume/VolumeReadinessExecutor.js");

test("dryRun marks every plan chapter dry_run without side effects", async () => {
  if (typeof resetVolumeReadinessRunStoreForTests === "function") {
    resetVolumeReadinessRunStoreForTests();
  }
  const run = createVolumeReadinessRun({
    novelId: "novel-dry",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 3,
    dryRun: true,
    actionFilter: ["needs_re_review", "needs_patch", "needs_polish", "needs_heavy"],
    budget: {
      maxChapters: 10,
      maxHeavyRewrites: 3,
      maxLlmCalls: 60,
      maxWallMinutes: 45,
    },
    plan: [
      {
        chapterId: "c1",
        chapterOrder: 1,
        title: "一",
        verdict: "needs_re_review",
        reasons: ["no review"],
        signals: { chapterId: "c1", chapterOrder: 1 },
      },
      {
        chapterId: "c2",
        chapterOrder: 2,
        title: "二",
        verdict: "needs_polish",
        reasons: ["pad residual"],
        signals: { chapterId: "c2", chapterOrder: 2 },
      },
      {
        chapterId: "c3",
        chapterOrder: 3,
        title: "三",
        verdict: "needs_heavy",
        reasons: ["literary fail"],
        signals: { chapterId: "c3", chapterOrder: 3 },
      },
    ],
    planSummary: {
      total: 3,
      publishReady: 0,
      needsReReview: 1,
      needsPatch: 0,
      needsPolish: 1,
      needsHeavy: 1,
      needsManual: 0,
      publishReadyRatio: 0,
    },
  });

  const completed = await volumeReadinessExecutor.execute(run.runId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.results.length, 3);
  assert.ok(completed.results.every((r) => r.outcome === "dry_run"));
  assert.equal(completed.chaptersActed, 0);
  assert.equal(completed.llmCallsUsed, 0);
  assert.equal(completed.heavyRewritesUsed, 0);
});

test("mapRepairOutcomeFromFrames still fail-closed", () => {
  assert.equal(
    mapRepairOutcomeFromFrames([{ phase: "completed", message: "mystery" }]).outcome,
    "failed",
  );
});
