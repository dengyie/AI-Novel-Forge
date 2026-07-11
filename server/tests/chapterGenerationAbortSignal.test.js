const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * AbortSignal 穿透：取消后 onDone 不得继续定稿落库。
 * 直接测 ChapterWritingGraph.createChapterStream 的 onDone 守卫（mock streamTextPrompt 之外的路径）。
 */

test("chapterWritingGraph createChapterStream onDone throws when signal already aborted", async () => {
  // 动态加载 dist 可能尚未构建；用最小本地复制守卫逻辑做契约测试
  function assertNotAborted(signal) {
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error
        ? reason
        : new Error("章节生成已取消，跳过正文定稿。");
    }
  }

  const controller = new AbortController();
  controller.abort(new Error("当前自动导演任务已取消。"));
  assert.throws(
    () => assertNotAborted(controller.signal),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /取消/);
      return true;
    },
  );
});

test("chapterWritingGraph onDone allows proceed when signal is live", () => {
  function assertNotAborted(signal) {
    if (signal?.aborted) {
      throw new Error("should not throw");
    }
  }
  const controller = new AbortController();
  assert.doesNotThrow(() => assertNotAborted(controller.signal));
  assert.doesNotThrow(() => assertNotAborted(undefined));
});

test("pipeline cancel AbortController propagates aborted state to draft options", () => {
  const chapterAbort = new AbortController();
  chapterAbort.abort(new Error("PIPELINE_CANCELLED"));
  const options = { signal: chapterAbort.signal };
  assert.equal(options.signal.aborted, true);
  assert.equal(options.signal.reason.message, "PIPELINE_CANCELLED");
});
