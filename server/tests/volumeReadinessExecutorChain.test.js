const test = require("node:test");
const assert = require("node:assert/strict");

// 单测：VolumeReadinessExecutor 的同章链式 re_review→repair（Part A）。
// 离线、零 DB：stub volumeReadinessService.assess 调用序列控制 verdictAfter，
// stub novelService.reviewChapter / createRepairStream 避免触达 prisma/orchestrator。
const {
  createVolumeReadinessRun,
  resetVolumeReadinessRunStoreForTests,
} = require("../dist/services/novel/volume/volumeReadinessRunStore.js");
const { volumeReadinessExecutor } = require("../dist/services/novel/volume/VolumeReadinessExecutor.js");
const volumeReadinessService = require("../dist/services/novel/volume/VolumeReadinessService.js");
const { _resetSharedNovelServicesForTest, getSharedNovelServices } = require("../dist/services/novel/application/sharedNovelServices.js");

const STORE_DIR = require("node:path").join(__dirname, ".tmp-volume-readiness-chain");

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// 从 ChapterRuntimeCoordinator.createRepairStream 推断的返回 shape：{ stream, onDone }
function makeAdoptStream() {
  const frames = [{ phase: "completed", status: "succeeded", message: "已采纳 adopt" }];
  return {
    stream: (async function* () { /* no text chunks; onDone carries status */ })(),
    onDone: async (_full, helpers) => {
      for (const f of frames) {
        helpers.writeFrame(f);
      }
    },
  };
}

function makeBaseRun({ actionFilter } = {}) {
  return createVolumeReadinessRun({
    novelId: "novel-chain",
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 1,
    dryRun: false,
    actionFilter: actionFilter ?? ["needs_re_review", "needs_patch", "needs_heavy"],
    budget: {
      maxChapters: 10,
      maxHeavyRewrites: 3,
      maxLlmCalls: 100,
      maxWallMinutes: 45,
    },
    plan: [
      {
        chapterId: "c1",
        chapterOrder: 1,
        title: "一",
        verdict: "needs_re_review",
        reasons: ["no true review"],
        signals: { chapterId: "c1", chapterOrder: 1 },
      },
    ],
    planSummary: {
      total: 1,
      publishReady: 0,
      needsReReview: 1,
      needsPatch: 0,
      needsPolish: 0,
      needsHeavy: 0,
      needsManual: 0,
      publishReadyRatio: 0,
    },
  });
}

test("chains re_review→heavy repair when post-review verdict is needs_heavy and budget allows", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    // stub assess 调用序列：
    //   1) 章前 pre-assess → needs_re_review（不跳过动作）
    //   2) 动作后 re-assess → needs_heavy（触发链式）
    //   3) 链式后再 re-assess → publish_ready
    //   之后（final summary）也复用同样 verdictAfter（保持 publish_ready）
    const verdictSeq = ["needs_re_review", "needs_heavy", "publish_ready"];
    let assessCalls = 0;
    const realAssess = volumeReadinessService.volumeReadinessService.assess;
    volumeReadinessService.volumeReadinessService.assess = async () => {
      assessCalls += 1;
      const verdict = verdictSeq[Math.min(assessCalls - 1, verdictSeq.length - 1)];
      return {
        chapters: [{ chapterId: "c1", chapterOrder: 1, title: "一", verdict }],
      };
    };

    let reviewCalls = 0;
    let repairCalls = 0;
    const services = getSharedNovelServices();
    services.reviewChapter = async () => {
      reviewCalls += 1;
    };
    services.createRepairStream = async () => {
      repairCalls += 1;
      return makeAdoptStream();
    };

    try {
      const run = makeBaseRun();
      const completed = await volumeReadinessExecutor.execute(run.runId);

      assert.equal(reviewCalls, 1, "reviewChapter 被调一次");
      assert.equal(repairCalls, 1, "链式 createRepairStream 被调一次");
      assert.ok(completed.results.length >= 1, "应至少有一条结果");
      const r = completed.results[completed.results.length - 1];
      assert.equal(r.outcome, "repair_adopted", `链式 adopt 应记 repair_adopted，实得 ${r.outcome} / msg=${r.message}`);
      assert.equal(r.verdictAfter, "publish_ready");
      assert.ok(r.message.includes("re_review→heavy_repair"), `message 应体现链式：${r.message}`);
      assert.equal(completed.heavyRewritesUsed, 1);
    } finally {
      volumeReadinessService.volumeReadinessService.assess = realAssess;
    }
  });
});

test("does NOT chain when actionFilter excludes the post-review verdict", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    // actionFilter 不含 needs_heavy → 链式判定条件不满足 → 不动 createRepairStream。
    const verdictSeq = ["needs_re_review", "needs_heavy"];
    let assessCalls = 0;
    const realAssess = volumeReadinessService.volumeReadinessService.assess;
    volumeReadinessService.volumeReadinessService.assess = async () => {
      assessCalls += 1;
      const verdict = verdictSeq[Math.min(assessCalls - 1, verdictSeq.length - 1)];
      return {
        chapters: [{ chapterId: "c1", chapterOrder: 1, title: "一", verdict }],
      };
    };

    let repairCalls = 0;
    const services = getSharedNovelServices();
    services.reviewChapter = async () => {};
    services.createRepairStream = async () => {
      repairCalls += 1;
      return makeAdoptStream();
    };

    try {
      const run = makeBaseRun({ actionFilter: ["needs_re_review", "needs_patch"] });
      const completed = await volumeReadinessExecutor.execute(run.runId);

      assert.equal(repairCalls, 0, "actionFilter 不含 heavy → 不应触发 createRepairStream");
      const r = completed.results[completed.results.length - 1];
      assert.equal(r.outcome, "re_review_incomplete",
        `未过门且未链式应降 re_review_incomplete，实得 ${r.outcome} / msg=${r.message}`);
      assert.equal(completed.heavyRewritesUsed, 0);
    } finally {
      volumeReadinessService.volumeReadinessService.assess = realAssess;
    }
  });
});

test("bypasses chain when heavy budget exhausted → budget-skipped annotation, no repair", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    const verdictSeq = ["needs_re_review", "needs_heavy"];
    let assessCalls = 0;
    const realAssess = volumeReadinessService.volumeReadinessService.assess;
    volumeReadinessService.volumeReadinessService.assess = async () => {
      assessCalls += 1;
      const verdict = verdictSeq[Math.min(assessCalls - 1, verdictSeq.length - 1)];
      return {
        chapters: [{ chapterId: "c1", chapterOrder: 1, title: "一", verdict }],
      };
    };

    let repairCalls = 0;
    const services = getSharedNovelServices();
    services.reviewChapter = async () => {};
    services.createRepairStream = async () => {
      repairCalls += 1;
      return makeAdoptStream();
    };

    try {
      const run = createVolumeReadinessRun({
        novelId: "novel-chain-budget",
        volumeOrder: 1,
        fromOrder: 1,
        toOrder: 1,
        dryRun: false,
        actionFilter: ["needs_re_review", "needs_heavy"],
        budget: {
          maxChapters: 10,
          maxHeavyRewrites: 0, // heavy 预算耗尽
          maxLlmCalls: 100,
          maxWallMinutes: 45,
        },
        plan: [
          {
            chapterId: "c1",
            chapterOrder: 1,
            title: "一",
            verdict: "needs_re_review",
            reasons: ["no true review"],
            signals: { chapterId: "c1", chapterOrder: 1 },
          },
        ],
        planSummary: {
          total: 1, publishReady: 0, needsReReview: 1,
          needsPatch: 0, needsPolish: 0, needsHeavy: 0, needsManual: 0, publishReadyRatio: 0,
        },
      });
      const completed = await volumeReadinessExecutor.execute(run.runId);

      assert.equal(repairCalls, 0, "heavy 预算耗尽 → 不应触发 createRepairStream");
      const r = completed.results[completed.results.length - 1];
      assert.equal(r.outcome, "re_review_incomplete",
        `未链式应降 re_review_incomplete，实得 ${r.outcome} / msg=${r.message}`);
      assert.ok(r.message.includes("chain→needs_heavy blocked"), `应标注被预算阻断：${r.message}`);
    } finally {
      volumeReadinessService.volumeReadinessService.assess = realAssess;
    }
  });
});

test("executor refuses execute when wall already exhausted (no silent re-budget_skip)", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    const {
      updateVolumeReadinessRun,
      getVolumeReadinessRun,
    } = require("../dist/services/novel/volume/volumeReadinessRunStore.js");

    let repairCalls = 0;
    const services = getSharedNovelServices();
    services.reviewChapter = async () => {
      throw new Error("should not review when wall exhausted");
    };
    services.createRepairStream = async () => {
      repairCalls += 1;
      return makeAdoptStream();
    };

    const run = createVolumeReadinessRun({
      novelId: "novel-wall-exh",
      volumeOrder: 1,
      fromOrder: 1,
      toOrder: 2,
      dryRun: false,
      actionFilter: ["needs_heavy"],
      budget: {
        maxChapters: 10,
        maxHeavyRewrites: 3,
        maxLlmCalls: 100,
        maxWallMinutes: 180,
      },
      plan: [
        {
          chapterId: "c1",
          chapterOrder: 1,
          title: "一",
          verdict: "needs_heavy",
          reasons: ["hard debt"],
          signals: { chapterId: "c1", chapterOrder: 1 },
        },
        {
          chapterId: "c2",
          chapterOrder: 2,
          title: "二",
          verdict: "needs_heavy",
          reasons: ["hard debt"],
          signals: { chapterId: "c2", chapterOrder: 2 },
        },
      ],
      planSummary: {
        total: 2, publishReady: 0, needsReReview: 0,
        needsPatch: 0, needsPolish: 0, needsHeavy: 2, needsManual: 0, publishReadyRatio: 0,
      },
    });
    // 模拟上次真跑 wall 耗尽后 hydrate 降为 planned
    updateVolumeReadinessRun(run.runId, {
      wallMsUsed: 185 * 60 * 1000,
    });

    const finished = await volumeReadinessExecutor.execute(run.runId);
    assert.equal(finished.status, "failed");
    assert.match(finished.error || "", /wall already exhausted/i);
    assert.equal(repairCalls, 0, "不得触发任何 repair");
    // 不得写入新的 budget_skipped 结果（空转）
    const live = getVolumeReadinessRun(run.runId);
    assert.equal(
      (live.results || []).filter((r) => r.outcome === "budget_skipped").length,
      0,
      "refuse 路径不得再写 budget_skipped",
    );
  });
});

test("second concurrent execute of same runId does not mark failed (flight race)", () => {
  return withEnv({
    VOLUME_READINESS_RUN_PERSIST: "0",
    VOLUME_READINESS_RUN_DIR: STORE_DIR,
  }, async () => {
    resetVolumeReadinessRunStoreForTests();
    _resetSharedNovelServicesForTest();

    const {
      tryClaimNovelRunFlight,
      releaseNovelRunFlight,
      getVolumeReadinessRun,
      updateVolumeReadinessRun,
    } = require("../dist/services/novel/volume/volumeReadinessRunStore.js");

    const run = makeBaseRun();
    // 模拟第一路 execute 已 claim 且 running
    assert.equal(tryClaimNovelRunFlight(run.novelId, run.runId), true);
    updateVolumeReadinessRun(run.runId, { status: "running" });

    // 第二路 execute（auto-resume 或重复 HTTP）应返回 live，不标 failed
    const second = await volumeReadinessExecutor.execute(run.runId);
    assert.equal(second.runId, run.runId);
    assert.equal(second.status, "running");
    assert.notEqual(second.status, "failed");
    assert.equal(second.error, null);

    releaseNovelRunFlight(run.novelId, run.runId);
    // 清理：标 completed 以免污染
    updateVolumeReadinessRun(run.runId, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    assert.equal(getVolumeReadinessRun(run.runId)?.status, "completed");
  });
});
