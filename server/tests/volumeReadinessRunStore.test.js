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
  // 同 runId 已 claim → 拒绝（防 auto-resume + HTTP 双 execute）
  assert.equal(tryClaimNovelRunFlight("n2", run.runId), false);
  assert.equal(tryClaimNovelRunFlight("n2", "other"), false);
  releaseNovelRunFlight("n2", run.runId);
  // release 后可再 claim 同 run
  assert.equal(tryClaimNovelRunFlight("n2", run.runId), true);
  releaseNovelRunFlight("n2", run.runId);
});

test("tryClaimNovelRunFlight rejects sibling while holder still planned (#4)", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();
  const runA = createVolumeReadinessRun({
    novelId: "n-claim-planned",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 3,
    dryRun: false,
    actionFilter: ["needs_re_review"],
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
  // claim 后尚未翻 running（execute 窗口）：仍 planned
  assert.equal(tryClaimNovelRunFlight(runA.novelId, runA.runId), true);
  assert.equal(getVolumeReadinessRun(runA.runId)?.status, "planned");
  // sibling 不得覆盖 flight
  assert.equal(tryClaimNovelRunFlight(runA.novelId, "sibling-run"), false);
  releaseNovelRunFlight(runA.novelId, runA.runId);
  assert.equal(tryClaimNovelRunFlight(runA.novelId, "sibling-run"), true);
  releaseNovelRunFlight(runA.novelId, "sibling-run");
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

test("budget_skipped is not terminal so resume can re-act after wall raise", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();
  const run = createVolumeReadinessRun({
    novelId: "n-budget-skip",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 2,
    dryRun: false,
    actionFilter: ["needs_heavy"],
    budget: {
      maxChapters: 5,
      maxHeavyRewrites: 3,
      maxLlmCalls: 60,
      maxWallMinutes: 180,
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
    chapterId: "acted",
    chapterOrder: 1,
    title: null,
    verdictBefore: "needs_heavy",
    verdictAfter: "needs_heavy",
    outcome: "repair_incomplete",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  appendVolumeReadinessChapterResult(run.runId, {
    chapterId: "skipped",
    chapterOrder: 2,
    title: null,
    verdictBefore: "needs_heavy",
    verdictAfter: null,
    outcome: "budget_skipped",
    message: "wall time budget 180m exhausted",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  const done = getCompletedChapterIds(getVolumeReadinessRun(run.runId));
  assert.equal(done.has("acted"), false, "incomplete still retriable");
  assert.equal(done.has("skipped"), false, "budget_skipped must resume after wall raise");
});


test("re_reviewed is not terminal so resume can re-act (I2)", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();
  const run = createVolumeReadinessRun({
    novelId: "n-re-reviewed",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 2,
    dryRun: false,
    actionFilter: ["needs_re_review"],
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
    chapterId: "stuck-re-reviewed",
    chapterOrder: 1,
    title: null,
    verdictBefore: "needs_re_review",
    verdictAfter: null,
    outcome: "re_reviewed",
    message: "assess missing",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  appendVolumeReadinessChapterResult(run.runId, {
    chapterId: "done-adopted",
    chapterOrder: 2,
    title: null,
    verdictBefore: "needs_patch",
    verdictAfter: "publish_ready",
    outcome: "repair_adopted",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  const done = getCompletedChapterIds(getVolumeReadinessRun(run.runId));
  assert.equal(done.has("stuck-re-reviewed"), false, "re_reviewed must resume");
  assert.equal(done.has("done-adopted"), true);
});

test("isWallBudgetExhausted + listPlannedLiveReadinessRuns skip wall-exhausted", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();
  const {
    isWallBudgetExhausted,
    listPlannedLiveReadinessRuns,
  } = require("../dist/services/novel/volume/volumeReadinessRunStore.js");

  const run = createVolumeReadinessRun({
    novelId: "n-wall-exh",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 2,
    dryRun: false,
    actionFilter: ["needs_heavy"],
    budget: {
      maxChapters: 5,
      maxHeavyRewrites: 3,
      maxLlmCalls: 60,
      maxWallMinutes: 180,
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
  assert.equal(isWallBudgetExhausted(getVolumeReadinessRun(run.runId)), false);
  // planned 且 wall 未耗尽 → auto-resume 列表包含
  const listedFresh = listPlannedLiveReadinessRuns();
  assert.ok(listedFresh.some((r) => r.runId === run.runId));

  // 模拟 wall 耗尽（185m used / 180m max）
  updateVolumeReadinessRun(run.runId, {
    wallMsUsed: 185 * 60 * 1000,
  });
  const exhausted = getVolumeReadinessRun(run.runId);
  assert.equal(isWallBudgetExhausted(exhausted), true);
  // 默认跳过 wall-exhausted planned（防 auto-resume 立刻再 budget_skip）
  const listedDefault = listPlannedLiveReadinessRuns();
  assert.equal(listedDefault.some((r) => r.runId === run.runId), false);
  // 显式 include
  const listedAll = listPlannedLiveReadinessRuns({ skipWallExhausted: false });
  assert.ok(listedAll.some((r) => r.runId === run.runId));
});

test("cancel zombie running (no flight) terminates status, not just flag", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();
  const {
    seedVolumeReadinessRunForTests,
    findOpenLiveRunForNovel,
  } = require("../dist/services/novel/volume/volumeReadinessRunStore.js");

  const now = new Date().toISOString();
  seedVolumeReadinessRunForTests({
    runId: "vrr_zombie_running",
    novelId: "n-zombie",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 20,
    rangeSource: "explicit",
    dryRun: false,
    actionFilter: ["needs_heavy"],
    budget: {
      maxChapters: 20,
      maxHeavyRewrites: 16,
      maxLlmCalls: 300,
      maxWallMinutes: 480,
    },
    status: "running",
    cancelRequested: false,
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
    results: [],
    finalSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    llmCallsUsed: 0,
    heavyRewritesUsed: 0,
    chaptersActed: 0,
    wallMsUsed: 1000,
  });

  // no tryClaim → activeNovelRuns empty, but status=running still open-live
  // (deploy-restart zombie: findActive scans status, not only flight table)
  assert.ok(findOpenLiveRunForNovel("n-zombie"));

  const cancelled = requestVolumeReadinessRunCancel("vrr_zombie_running");
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.finishedAt);
  assert.equal(findOpenLiveRunForNovel("n-zombie"), null);
});

test("cancel live running (with flight) only sets flag", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();

  const run = createVolumeReadinessRun({
    novelId: "n-live",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 2,
    dryRun: false,
    actionFilter: ["needs_heavy"],
    budget: {
      maxChapters: 5,
      maxHeavyRewrites: 3,
      maxLlmCalls: 60,
      maxWallMinutes: 180,
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
  updateVolumeReadinessRun(run.runId, { status: "running", startedAt: new Date().toISOString() });
  assert.equal(tryClaimNovelRunFlight("n-live", run.runId), true);

  const cancelled = requestVolumeReadinessRunCancel(run.runId);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.status, "running", "live flight keeps running for executor to settle");
  releaseNovelRunFlight("n-live", run.runId);
});
