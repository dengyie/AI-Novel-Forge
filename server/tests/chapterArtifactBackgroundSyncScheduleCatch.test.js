const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * scheduleChapterSync 必须 .catch fire-and-forget rejection：
 * void promise 在 Node 会变成 unhandledRejection 杀进程。
 * runChapterSyncNow 仍 rethrow 给 await 调用方。
 */
test("scheduleChapterSync swallows runChapterSyncNow rejection", async () => {
  const mod = require("../dist/services/novel/runtime/ChapterArtifactBackgroundSyncService.js");
  const service = mod.chapterArtifactBackgroundSyncService;
  assert.ok(service, "service export");

  const original = service.runChapterSyncNow.bind(service);
  let called = false;
  service.runChapterSyncNow = async () => {
    called = true;
    throw new Error("synthetic transport_error for schedule catch test");
  };

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };

  let unhandled = null;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    service.scheduleChapterSync("n1", "c1", "body text for hash");
    // allow microtask / promise chain to settle
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, true, "runChapterSyncNow should be invoked");
    assert.equal(unhandled, null, "must not emit unhandledRejection");
    assert.ok(
      warnings.some((w) => w.includes("scheduleChapterSync swallowed")),
      `expected swallow warn, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    console.warn = origWarn;
    service.runChapterSyncNow = original;
  }
});
