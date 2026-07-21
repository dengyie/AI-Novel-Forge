const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertChapterBlankDeletable,
} = require("../dist/services/novel/chapterBlankDeleteGate.js");

function expectCode(fn, code) {
  try {
    fn();
    assert.fail("expected AppError");
  } catch (error) {
    const details = error && typeof error === "object" ? error.details : null;
    const actual = details && typeof details === "object" ? details.code : undefined;
    assert.equal(actual, code, error instanceof Error ? error.message : String(error));
  }
}

test("assertChapterBlankDeletable allows blank unplanned with confirm", () => {
  assert.doesNotThrow(() => assertChapterBlankDeletable({
    content: "",
    chapterStatus: "unplanned",
    sceneCards: null,
    taskSheet: null,
    hasBusyJob: false,
    confirmBlank: true,
  }));
});

test("assertChapterBlankDeletable rejects content / busy / scene / no confirm", () => {
  expectCode(() => assertChapterBlankDeletable({
    content: "有正文",
    chapterStatus: "unplanned",
    confirmBlank: true,
  }), "CHAPTER_NOT_BLANK");

  expectCode(() => assertChapterBlankDeletable({
    content: "",
    chapterStatus: "approved",
    confirmBlank: true,
  }), "CHAPTER_NOT_BLANK");

  expectCode(() => assertChapterBlankDeletable({
    content: "",
    chapterStatus: "unplanned",
    hasBusyJob: true,
    confirmBlank: true,
  }), "CHAPTER_BUSY");

  expectCode(() => assertChapterBlankDeletable({
    content: "",
    chapterStatus: "unplanned",
    sceneCards: JSON.stringify({ scenes: [{ key: "s1" }] }),
    confirmBlank: true,
  }), "CHAPTER_NOT_BLANK");

  expectCode(() => assertChapterBlankDeletable({
    content: "",
    chapterStatus: "unplanned",
    confirmBlank: false,
  }), "CHAPTER_CONFIRM_REQUIRED");
});
