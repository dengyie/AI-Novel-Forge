const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CHAPTER_CONTENT_CONFLICT_CODE,
  contentRevisionBumpData,
  createChapterContentConflictError,
  createChapterNotFoundError,
  initialContentRevisionForCreate,
} = require("../dist/services/novel/chapterContentCas.js");
const { AppError } = require("../dist/middleware/errorHandler.js");

test("initialContentRevisionForCreate: empty stays 0, non-empty starts at 1", () => {
  assert.equal(initialContentRevisionForCreate(""), 0);
  assert.equal(initialContentRevisionForCreate(null), 0);
  assert.equal(initialContentRevisionForCreate(undefined), 0);
  assert.equal(initialContentRevisionForCreate("正文"), 1);
});

test("contentRevisionBumpData uses prisma increment", () => {
  assert.deepEqual(contentRevisionBumpData(), {
    contentRevision: { increment: 1 },
  });
});

test("createChapterContentConflictError is AppError 409 with structured details", () => {
  const error = createChapterContentConflictError({
    currentContentRevision: 3,
    expectedContentRevision: 1,
  });
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 409);
  assert.match(error.message, /正文已变更/);
  assert.equal(error.details.code, CHAPTER_CONTENT_CONFLICT_CODE);
  assert.equal(error.details.currentContentRevision, 3);
  assert.equal(error.details.expectedContentRevision, 1);
});

test("createChapterNotFoundError is AppError 404", () => {
  const error = createChapterNotFoundError();
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 404);
  assert.match(error.message, /章节不存在/);
});
