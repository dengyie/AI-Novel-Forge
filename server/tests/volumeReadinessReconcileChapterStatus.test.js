const test = require("node:test");
const assert = require("node:assert/strict");

// 单测：VolumeReadinessExecutor 的「真 review 已过双门但 chapterStatus 停在非 completed」收口（Part A0）。
// 生产 ch13/ch17：reviewChapter 跑过、signals 全绿、generationState=reviewed，但 chapterStatus 卡 pending_review/home
// 的 separated markChapterGenerationState 路径），policy line 159 仅看 chapterStatus!=completed 即重判 needs_re_review，
// executor chain guard 仅 needs_heavy/needs_patch → 永久 re_review_incomplete 死环。
// A0：真 review 信号（hasTrueReview===true）+ 全门绿 + 无硬债 → 收口 chapterStatus=completed，re-assess 升 publish_ready。
const {
  createVolumeReadinessRun,
  resetVolumeReadinessRunStoreForTests,
} = require("../dist/services/novel/volume/volumeReadinessRunStore.js");
const { volumeReadinessExecutor } = require("../dist/services/novel/volume/VolumeReadinessExecutor.js");
const volumeReadinessService = require("../dist/services/novel/volume/VolumeReadinessService.js");
const { _resetSharedNovelServicesForTest, getSharedNovelServices } = require("../dist/services/novel/application/sharedNovelServices.js");
const { prisma } = require("../dist/db/prisma.js");
const {
  shouldReconcileChapterStatusAfterReview,
} = require("../dist/services/novel/volume/readiness/application/ChapterReviewStatusReconciler.js");

const STORE_DIR = require("node:path").join(__dirname, ".tmp-volume-readiness-reconcile");

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function greenSignals(overrides = {}) {
  return {
    chapterId: "c1",
    chapterOrder: 1,
    title: "一",
    chapterStatus: "pending_review",
    generationState: "reviewed",
    literaryPass: true,
    l0Clear: true,
    styleClear: true,
    hardDebtCount: 0,
    padHitCount: 0,
    hasTrueReview: true,
    contentEmpty: false,
    contentRevision: 7,
    ...overrides,
  };
}

function makeBaseRun() {
  return createVolumeReadinessRun({
    novelId: "novel-reconcile",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 1,
    dryRun: false,
    actionFilter: ["needs_re_review", "needs_patch", "needs_heavy"],
    budget: { maxChapters: 10, maxHeavyRewrites: 3, maxLlmCalls: 100, maxWallMinutes: 45 },
    plan: [
      {
        chapterId: "c1",
        chapterOrder: 1,
        title: "一",
        verdict: "needs_re_review",
        reasons: ["chapterStatus=pending_review，需真 review 收口双门"],
        signals: greenSignals(),
      },
    ],
    planSummary: {
      total: 1, publishReady: 0, needsReReview: 1, needsPatch: 0,
      needsPolish: 0, needsHeavy: 0, needsManual: 0, publishReadyRatio: 0,
    },
  });
}

test("extracted review-status reconciler fails closed unless all revision-bound gates pass", () => {
  assert.equal(
    shouldReconcileChapterStatusAfterReview("re_reviewed", "needs_re_review", greenSignals()),
    true,
  );
  assert.equal(
    shouldReconcileChapterStatusAfterReview(
      "re_reviewed",
      "needs_re_review",
      greenSignals({ contentRevision: null }),
    ),
    false,
  );
  assert.equal(
    shouldReconcileChapterStatusAfterReview(
      "re_reviewed",
      "needs_re_review",
      greenSignals({ hasTrueReview: false }),
    ),
    false,
  );
});

test("re_review：真 review 后门全绿但 chapterStatus 非 completed → 收口 completed 升 publish_ready", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    // assess 调用序列：
    //   1) 章前 pre-assess → needs_re_review（chapterStatus=pending_review，门全绿）
    //   2) reviewChapter 后 re-assess → 仍 needs_re_review（chapterStatus 未变）
    //   3) A0 收口后 refresh-assess → publish_ready
    //   之后 final summary 复用 publish_ready
    const verdictSeq = ["needs_re_review", "needs_re_review", "publish_ready"];
    let assessCalls = 0;
    const realAssess = volumeReadinessService.volumeReadinessService.assess;
    volumeReadinessService.volumeReadinessService.assess = async () => {
      const verdict = verdictSeq[Math.min(assessCalls, verdictSeq.length - 1)];
      assessCalls += 1;
      // A0 触发分支要求 after.signals 全绿 + chapterStatus !== completed
      return {
        chapters: [
          { chapterId: "c1", chapterOrder: 1, title: "一", verdict, signals: greenSignals() },
        ],
      };
    };

    let reviewCalls = 0;
    let repairCalls = 0;
    let chapterUpdateCalls = 0;
    let chapterUpdatePatch = null;
    let chapterUpdateWhere = null;
    const services = getSharedNovelServices();
    services.reviewChapter = async () => { reviewCalls += 1; };
    services.createRepairStream = async () => { repairCalls += 1; };
    const originalChapterUpdateMany = prisma.chapter.updateMany;
    prisma.chapter.updateMany = async (args) => {
      chapterUpdateCalls += 1;
      chapterUpdatePatch = args.data;
      chapterUpdateWhere = args.where;
      return { count: 1 };
    };

    try {
      const run = makeBaseRun();
      const completed = await volumeReadinessExecutor.execute(run.runId);

      assert.equal(reviewCalls, 1, "reviewChapter 被调一次");
      assert.equal(repairCalls, 0, "门已绿不该再 chain repair");
      assert.equal(chapterUpdateCalls, 1, "A0 应收口写一次 chapter.updateMany CAS");
      assert.deepEqual(chapterUpdateWhere, {
        id: "c1",
        contentRevision: 7,
        chapterStatus: "pending_review",
      });
      assert.deepEqual(chapterUpdatePatch, {
        generationState: "reviewed",
        chapterStatus: "completed",
      }, `收口应写 reviewed+completed，实得 ${JSON.stringify(chapterUpdatePatch)}`);

      const r = completed.results[completed.results.length - 1];
      assert.equal(r.verdictAfter, "publish_ready", `A0 收口后应升 publish_ready，实得 ${r.verdictAfter} / msg=${r.message}`);
      assert.ok(r.message.includes("收口 chapterStatus=completed"), `message 应体现收口：${r.message}`);
      assert.equal(completed.heavyRewritesUsed, 0);
    } finally {
      volumeReadinessService.volumeReadinessService.assess = realAssess;
      prisma.chapter.updateMany = originalChapterUpdateMany;
    }
  });
});

test("re_review：门非全绿（literaryPass=false）→ 不收口、保持 needs_re_review", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    // 全程 needs_re_review，signals literaryPass=false（门没过）→ A0 不该触发收口
    let chapterUpdateCalls = 0;
    const realAssess = volumeReadinessService.volumeReadinessService.assess;
    volumeReadinessService.volumeReadinessService.assess = async () => ({
      chapters: [
        { chapterId: "c1", chapterOrder: 1, title: "一", verdict: "needs_re_review",
          signals: greenSignals({ literaryPass: false }) },
      ],
    });
    const services = getSharedNovelServices();
    services.reviewChapter = async () => {};
    services.createRepairStream = async () => {};
    const originalChapterUpdateMany = prisma.chapter.updateMany;
    prisma.chapter.updateMany = async () => { chapterUpdateCalls += 1; return { count: 1 }; };

    try {
      const run = makeBaseRun();
      const completed = await volumeReadinessExecutor.execute(run.runId);
      assert.equal(chapterUpdateCalls, 0, "literaryPass=false 不该收口 completed");
      const r = completed.results[completed.results.length - 1];
      assert.equal(r.verdictAfter, "needs_re_review");
    } finally {
      volumeReadinessService.volumeReadinessService.assess = realAssess;
      prisma.chapter.updateMany = originalChapterUpdateMany;
    }
  });
});

test("re_review：hasTrueReview===false（evaluateOnly 合成 / ops 假 approved）→ 不收口（不放过假 approved）", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    let chapterUpdateCalls = 0;
    const realAssess = volumeReadinessService.volumeReadinessService.assess;
    volumeReadinessService.volumeReadinessService.assess = async () => ({
      chapters: [
        { chapterId: "c1", chapterOrder: 1, title: "一", verdict: "needs_re_review",
          signals: greenSignals({ hasTrueReview: false }) },
      ],
    });
    const services = getSharedNovelServices();
    services.reviewChapter = async () => {};
    services.createRepairStream = async () => {};
    const originalChapterUpdateMany = prisma.chapter.updateMany;
    prisma.chapter.updateMany = async () => { chapterUpdateCalls += 1; return { count: 1 }; };

    try {
      const run = makeBaseRun();
      const completed = await volumeReadinessExecutor.execute(run.runId);
      assert.equal(chapterUpdateCalls, 0, "hasTrueReview=false 不得伪造 completed");
      const r = completed.results[completed.results.length - 1];
      assert.equal(r.verdictAfter, "needs_re_review");
    } finally {
      volumeReadinessService.volumeReadinessService.assess = realAssess;
      prisma.chapter.updateMany = originalChapterUpdateMany;
    }
  });
});

test("re_review：硬债>0（hardDebtCount=2，其余门全绿）→ 不收口、保持 needs_re_review", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    // 4 门里 hardDebtCount 是唯一计数型守卫，与 3 个 boolean 门语义不同，独立验证
    let chapterUpdateCalls = 0;
    const realAssess = volumeReadinessService.volumeReadinessService.assess;
    volumeReadinessService.volumeReadinessService.assess = async () => ({
      chapters: [
        { chapterId: "c1", chapterOrder: 1, title: "一", verdict: "needs_re_review",
          signals: greenSignals({ hardDebtCount: 2 }) },
      ],
    });
    const services = getSharedNovelServices();
    services.reviewChapter = async () => {};
    services.createRepairStream = async () => {};
    const originalChapterUpdateMany = prisma.chapter.updateMany;
    prisma.chapter.updateMany = async () => { chapterUpdateCalls += 1; return { count: 1 }; };

    try {
      const run = makeBaseRun();
      const completed = await volumeReadinessExecutor.execute(run.runId);
      assert.equal(chapterUpdateCalls, 0, "hardDebtCount>0 不该收口 completed");
      const r = completed.results[completed.results.length - 1];
      assert.equal(r.verdictAfter, "needs_re_review");
    } finally {
      volumeReadinessService.volumeReadinessService.assess = realAssess;
      prisma.chapter.updateMany = originalChapterUpdateMany;
    }
  });
});

test("re_review：收口 CAS 未命中时不得把新 revision 标成 publish_ready", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    let refreshAssessCalls = 0;
    const realAssess = volumeReadinessService.volumeReadinessService.assess;
    volumeReadinessService.volumeReadinessService.assess = async (_novelId, options = {}) => {
      if (options.refresh) refreshAssessCalls += 1;
      return {
        chapters: [
          {
            chapterId: "c1",
            chapterOrder: 1,
            title: "一",
            verdict: "needs_re_review",
            signals: greenSignals({ contentRevision: 7 }),
          },
        ],
      };
    };
    const services = getSharedNovelServices();
    services.reviewChapter = async () => {};
    services.createRepairStream = async () => {};

    let updateWhere = null;
    const originalChapterUpdateMany = prisma.chapter.updateMany;
    prisma.chapter.updateMany = async (args) => {
      updateWhere = args.where;
      // 模拟 review 后用户保存正文，canonical revision 已从 7 推进到 8。
      return { count: 0 };
    };

    try {
      const run = makeBaseRun();
      const completed = await volumeReadinessExecutor.execute(run.runId);
      const result = completed.results[completed.results.length - 1];

      assert.deepEqual(updateWhere, {
        id: "c1",
        contentRevision: 7,
        chapterStatus: "pending_review",
      });
      assert.equal(refreshAssessCalls, 0, "CAS miss 后不得刷新并伪造 publish_ready");
      assert.equal(result.verdictAfter, "needs_re_review");
      assert.equal(result.outcome, "re_review_incomplete");
      assert.match(result.message, /正文或章节状态已并发变化/);
    } finally {
      volumeReadinessService.volumeReadinessService.assess = realAssess;
      prisma.chapter.updateMany = originalChapterUpdateMany;
    }
  });
});

test("re_review：A0 收口时 chapter.updateMany 抛错 → 兜底不阻断、降 re_review_incomplete", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    // assess 序列：pre→needs_re_review、reviewChapter 后 re-assess→needs_re_review（触发 A0）。
    // A0 内 chapter.update 抛错 → catch 兜底：verdictAfter 保持 needs_re_review，outcome 降 incomplete。
    const verdictSeq = ["needs_re_review", "needs_re_review"];
    let assessCalls = 0;
    const realAssess = volumeReadinessService.volumeReadinessService.assess;
    volumeReadinessService.volumeReadinessService.assess = async () => {
      const verdict = verdictSeq[Math.min(assessCalls, verdictSeq.length - 1)];
      assessCalls += 1;
      return {
        chapters: [
          { chapterId: "c1", chapterOrder: 1, title: "一", verdict, signals: greenSignals() },
        ],
      };
    };
    let reviewCalls = 0;
    const services = getSharedNovelServices();
    services.reviewChapter = async () => { reviewCalls += 1; };
    services.createRepairStream = async () => {};
    // A0 收口写库时抛错，验证 catch 兜底
    const originalChapterUpdateMany = prisma.chapter.updateMany;
    prisma.chapter.updateMany = async () => {
      throw new Error("db write failed (test)");
    };

    try {
      const run = makeBaseRun();
      const completed = await volumeReadinessExecutor.execute(run.runId);
      assert.equal(reviewCalls, 1, "reviewChapter 仍被调一次");
      const r = completed.results[completed.results.length - 1];
      // 收口失败后 verdictAfter 保持 needs_re_review，outcome 降 re_review_incomplete（可 resume）
      assert.equal(r.verdictAfter, "needs_re_review",
        `DB 抛错后应保持 needs_re_review，实得 ${r.verdictAfter}`);
      assert.equal(r.outcome, "re_review_incomplete",
        `DB 抛错兜底应降 re_review_incomplete，实得 ${r.outcome}`);
    } finally {
      volumeReadinessService.volumeReadinessService.assess = realAssess;
      prisma.chapter.updateMany = originalChapterUpdateMany;
    }
  });
});
