const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ChapterChineseProseGateError,
  isChapterChineseProseGateError,
  buildChapterChineseProseGateError,
} = require("../dist/services/novel/runtime/chapterChineseProseGateError.js");
const { assessChineseProse } = require("../dist/utils/chineseProseGate.js");

test("buildChapterChineseProseGateError carries gate details and typed code", () => {
  const text = "We need to write a chapter plan. Paragraph 1. However the story continues.";
  const gate = assessChineseProse(text);
  assert.equal(gate.ok, false);
  const error = buildChapterChineseProseGateError(text, gate, {
    novelId: "n1",
    chapterId: "c1",
    chapterOrder: 18,
    source: "chapter_writer",
  });
  assert.equal(error.code, "CHAPTER_CHINESE_PROSE_GATE");
  assert.equal(error.details.source, "chapter_writer");
  assert.equal(error.details.chapterOrder, 18);
  assert.ok(error.details.rawLength > 0);
  assert.equal(isChapterChineseProseGateError(error), true);
  assert.equal(isChapterChineseProseGateError(new Error("plain")), false);
  assert.equal(
    isChapterChineseProseGateError({ code: "CHAPTER_CHINESE_PROSE_GATE" }),
    true,
  );
});

test("ChapterChineseProseGateError is instanceof Error", () => {
  const error = new ChapterChineseProseGateError({
    source: "test",
    cjkCount: 0,
    latinCount: 10,
    rawLength: 20,
    reason: "english_heavy",
  });
  assert.ok(error instanceof Error);
  assert.ok(error.message.includes("中文硬门"));
});
