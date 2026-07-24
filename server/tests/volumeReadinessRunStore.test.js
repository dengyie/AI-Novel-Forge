const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createVolumeReadinessRun,
  getVolumeReadinessRun,
  requestVolumeReadinessRunCancel,
  appendVolumeReadinessChapterResult,
  updateVolumeReadinessRun,
  resetVolumeReadinessRunStoreForTests,
  listVolumeReadinessRuns,
  getCompletedChapterIds,
  tryClaimNovelRunFlight,
  releaseNovelRunFlight,
  findActiveLiveRunForNovel,
} = require("../dist/services/novel/volume/volumeReadinessRunStore.js");

test("run store create / cancel / append / list", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();

  const run = createVolumeReadinessRun({
    novelId: "n1",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 3,
    dryRun: true,
    actionFilter: ["needs_re_review"],
    budget: {
      maxChapters: 5,
      maxHeavyRewrites: 1,
      maxLlmCalls: 10,
      maxWallMinutes: 15,
    },
    plan: [{
      chapterId: "c1",
      chapterOrder: 1,
      title: "一",
      verdict: "needs_re_review",
      reasons: ["never reviewed"],
      signals: {
        chapterId: "c1",
        chapterOrder: 1,
        chapterStatus: "pending_review",
        literaryPass: null,
        l0Clear: null,
        styleClear: null,
        hardDebtCount: 0,
        padHitCount: 0,
        hasTrueReview: false,
      },
    }],
    // 故意缺 needsPolish，store 应补 0
    planSummary: {
      total: 1,
      publishReady: 0,
      needsReReview: 1,
      needsPatch: 0,
      needsHeavy: 0,
      needsManual: 0,
      publishReadyRatio: 0,
    },
  });

  assert.ok(run.runId.startsWith("vrr_"));
  assert.equal(run.status, "planned");
  assert.equal(run.planSummary.needsPolish, 0);
  assert.equal(run.wallMsUsed, 0);
  assert.equal(getVolumeReadinessRun(run.runId)?.novelId, "n1");

  appendVolumeReadinessChapterResult(run.runId, {
    chapterId: "c1",
    chapterOrder: 1,
    title: "一",
    verdictBefore: "needs_re_review",
    verdictAfter: "needs_re_review",
    outcome: "dry_run",
    message: "ok",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });

  const after = getVolumeReadinessRun(run.runId);
  assert.equal(after.results.length, 1);
  assert.equal(after.results[0].outcome, "dry_run");

  const cancelled = requestVolumeReadinessRunCancel(run.runId);
  assert.equal(cancelled.cancelRequested, true);
  // planned → cancelled immediately
  assert.equal(cancelled.status, "cancelled");

  updateVolumeReadinessRun(run.runId, {
    status: "completed",
    finishedAt: new Date().toISOString(),
  });

  const listed = listVolumeReadinessRuns("n1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].runId, run.runId);
});


test("getCompletedChapterIds skips failed for resume retry", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();
  const {
    getCompletedChapterIds,
    tryClaimNovelRunFlight,
    releaseNovelRunFlight,
    findActiveLiveRunForNovel,
    findOpenLiveRunForNovel,
    updateVolumeReadinessRun,
  } = require("../dist/services/novel/volume/volumeReadinessRunStore.js");

  const run = createVolumeReadinessRun({
    novelId: "n2",
    fromOrder: 1,
    toOrder: 2,
    dryRun: false,
    actionFilter: ["needs_patch"],
    budget: { maxChapters: 2, maxHeavyRewrites: 1, maxLlmCalls: 10, maxWallMinutes: 15 },
    plan: [],
    planSummary: {
      total: 0, publishReady: 0, needsReReview: 0, needsPatch: 0, needsPolish: 0, needsHeavy: 0, needsManual: 0, publishReadyRatio: 0,
    },
  });
  // planned live run is "open" for createRun 互斥
  const openPlanned = findOpenLiveRunForNovel("n2");
  assert.ok(openPlanned);
  assert.equal(openPlanned.runId, run.runId);
  assert.equal(openPlanned.status, "planned");

  appendVolumeReadinessChapterResult(run.runId, {
    chapterId: "ok",
    chapterOrder: 1,
    title: null,
    verdictBefore: "needs_patch",
    verdictAfter: "publish_ready",
    outcome: "repair_adopted",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  appendVolumeReadinessChapterResult(run.runId, {
    chapterId: "bad",
    chapterOrder: 2,
    title: null,
    verdictBefore: "needs_patch",
    verdictAfter: null,
    outcome: "failed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  const live = getVolumeReadinessRun(run.runId);
  const done = getCompletedChapterIds(live);
  assert.equal(done.has("ok"), true);
  assert.equal(done.has("bad"), false);

  assert.equal(tryClaimNovelRunFlight("n2", run.runId), true);
  updateVolumeReadinessRun(run.runId, { status: "running" });
  assert.equal(findActiveLiveRunForNovel("n2")?.runId, run.runId);
  assert.equal(tryClaimNovelRunFlight("n2", "other"), false);
  releaseNovelRunFlight("n2", run.runId);
});


test("repair_incomplete / polish_incomplete / skipped_locked are not terminal (resume retry)", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();
  const run = createVolumeReadinessRun({
    novelId: "n-term",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 3,
    dryRun: false,
    actionFilter: ["needs_patch"],
    budget: {
      maxChapters: 5,
      maxHeavyRewrites: 1,
      maxLlmCalls: 10,
      maxWallMinutes: 15,
    },
    plan: [],
    planSummary: {
      total: 0,
      publishReady: 0,
      needsReReview: 0,
      needsPatch: 0,
      needsPolish: 0,
      needsHeavy: 0,
      needsManual: 0,
      publishReadyRatio: 0,
    },
  });
  appendVolumeReadinessChapterResult(run.runId, {
    chapterId: "a",
    chapterOrder: 1,
    title: null,
    verdictBefore: "needs_patch",
    verdictAfter: "needs_patch",
    outcome: "repair_incomplete",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  appendVolumeReadinessChapterResult(run.runId, {
    chapterId: "b",
    chapterOrder: 2,
    title: null,
    verdictBefore: "needs_polish",
    verdictAfter: "needs_polish",
    outcome: "polish_incomplete",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  appendVolumeReadinessChapterResult(run.runId, {
    chapterId: "c",
    chapterOrder: 3,
    title: null,
    verdictBefore: "needs_patch",
    verdictAfter: null,
    outcome: "skipped_locked",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  appendVolumeReadinessChapterResult(run.runId, {
    chapterId: "d",
    chapterOrder: 4,
    title: null,
    verdictBefore: "needs_patch",
    verdictAfter: "publish_ready",
    outcome: "repair_adopted",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  const done = getCompletedChapterIds(getVolumeReadinessRun(run.runId));
  assert.equal(done.has("a"), false);
  assert.equal(done.has("b"), false);
  assert.equal(done.has("c"), false);
  assert.equal(done.has("d"), true);
});
