const test = require("node:test");
const assert = require("node:assert/strict");

const {
  withBackgroundChapterLlmSlot,
  setBackgroundChapterLlmMaxInFlight,
  getBackgroundChapterLlmStats,
} = require("../dist/services/novel/runtime/backgroundLlmGate.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("withBackgroundChapterLlmSlot serializes when maxInFlight=1", async () => {
  setBackgroundChapterLlmMaxInFlight(1);
  const order = [];
  const first = withBackgroundChapterLlmSlot("a", async () => {
    order.push("a-start");
    await delay(40);
    order.push("a-end");
    return "a";
  });
  const second = withBackgroundChapterLlmSlot("b", async () => {
    order.push("b-start");
    await delay(10);
    order.push("b-end");
    return "b";
  });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  assert.equal(getBackgroundChapterLlmStats().inFlight, 0);
  assert.equal(getBackgroundChapterLlmStats().waiting, 0);
});

test("withBackgroundChapterLlmSlot releases slot on error", async () => {
  setBackgroundChapterLlmMaxInFlight(1);
  await assert.rejects(
    () => withBackgroundChapterLlmSlot("boom", async () => {
      throw new Error("nope");
    }),
    /nope/,
  );
  const value = await withBackgroundChapterLlmSlot("ok", async () => "ok");
  assert.equal(value, "ok");
  assert.equal(getBackgroundChapterLlmStats().inFlight, 0);
});

test("withBackgroundChapterLlmSlot wait timeout rejects waiter", async () => {
  setBackgroundChapterLlmMaxInFlight(1);
  const previous = process.env.BACKGROUND_CHAPTER_LLM_WAIT_TIMEOUT_MS;
  process.env.BACKGROUND_CHAPTER_LLM_WAIT_TIMEOUT_MS = "80";
  try {
    let releaseHolder;
    const holder = withBackgroundChapterLlmSlot("holder", async () => {
      await new Promise((resolve) => {
        releaseHolder = resolve;
      });
      return "held";
    });
    await delay(5);
    await assert.rejects(
      () => withBackgroundChapterLlmSlot("waiter", async () => "never"),
      /wait timeout/i,
    );
    releaseHolder();
    assert.equal(await holder, "held");
    assert.equal(getBackgroundChapterLlmStats().inFlight, 0);
    assert.equal(getBackgroundChapterLlmStats().waiting, 0);
  } finally {
    if (previous === undefined) {
      delete process.env.BACKGROUND_CHAPTER_LLM_WAIT_TIMEOUT_MS;
    } else {
      process.env.BACKGROUND_CHAPTER_LLM_WAIT_TIMEOUT_MS = previous;
    }
    setBackgroundChapterLlmMaxInFlight(1);
  }
});
