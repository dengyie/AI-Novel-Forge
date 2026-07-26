const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createVolumeReadinessRun,
  registerVolumeReadinessRunCancelHook,
  requestVolumeReadinessRunCancel,
  releaseNovelRunFlight,
  resetVolumeReadinessRunStoreForTests,
} = require("../dist/services/novel/volume/volumeReadinessRunStore.js");

function makeRun(novelId) {
  return createVolumeReadinessRun({
    novelId,
    volumeOrder: 1,
    fromOrder: 1,
    toOrder: 2,
    dryRun: false,
    actionFilter: ["needs_heavy"],
    budget: {
      maxChapters: 5,
      maxHeavyRewrites: 2,
      maxLlmCalls: 30,
      maxWallMinutes: 60,
    },
    plan: [{
      chapterId: "c1",
      chapterOrder: 1,
      title: "一",
      verdict: "needs_heavy",
      reasons: ["heavy"],
    }],
  });
}

// I6：cancel 此前只置 flag，executor 只在循环顶端读 → 章内 heavy 最长 45 分钟才生效。
// 现在 cancel 立刻触发已注册的章级 abort 钩子。

test("requestVolumeReadinessRunCancel 立即触发章级 abort 钩子（I6）", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();

  const run = makeRun("n-cancel-1");
  let aborted = 0;
  registerVolumeReadinessRunCancelHook(run.runId, () => {
    aborted += 1;
  });

  requestVolumeReadinessRunCancel(run.runId);
  assert.equal(aborted, 1, "cancel 应同步触发 abort 钩子");
});

test("注销后的钩子不再被触发（I6 章间不误 abort）", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();

  const run = makeRun("n-cancel-2");
  let aborted = 0;
  const unregister = registerVolumeReadinessRunCancelHook(run.runId, () => {
    aborted += 1;
  });
  unregister();

  requestVolumeReadinessRunCancel(run.runId);
  assert.equal(aborted, 0);
});

test("后注册的钩子覆盖前者（executor 串行换章）", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();

  const run = makeRun("n-cancel-3");
  const fired = [];
  registerVolumeReadinessRunCancelHook(run.runId, () => fired.push("ch1"));
  registerVolumeReadinessRunCancelHook(run.runId, () => fired.push("ch2"));

  requestVolumeReadinessRunCancel(run.runId);
  assert.deepEqual(fired, ["ch2"]);
});

test("钩子抛错不打挂 cancel 路径（I6 fail-safe）", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();

  const run = makeRun("n-cancel-4");
  registerVolumeReadinessRunCancelHook(run.runId, () => {
    throw new Error("abort listener exploded");
  });

  const cancelled = requestVolumeReadinessRunCancel(run.runId);
  assert.ok(cancelled);
  assert.equal(cancelled.cancelRequested, true);
});

test("releaseNovelRunFlight 清理钩子表（I6 防累积）", () => {
  process.env.VOLUME_READINESS_RUN_PERSIST = "0";
  resetVolumeReadinessRunStoreForTests();

  const run = makeRun("n-cancel-5");
  let aborted = 0;
  registerVolumeReadinessRunCancelHook(run.runId, () => {
    aborted += 1;
  });
  releaseNovelRunFlight("n-cancel-5", run.runId);

  requestVolumeReadinessRunCancel(run.runId);
  assert.equal(aborted, 0);
});
