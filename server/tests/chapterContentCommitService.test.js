const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ChapterContentCommitService,
} = require("../dist/services/novel/runtime/content/ChapterContentCommitService.js");
const {
  CHAPTER_CONTENT_CONFLICT_CODE,
} = require("../dist/services/novel/chapterContentCas.js");
const { AppError } = require("../dist/middleware/errorHandler.js");

test("chapter content commit uses revision CAS and returns the committed snapshot", async () => {
  let updateManyInput = null;
  let reloadCalls = 0;
  const db = {
    chapter: {
      updateMany: async (input) => {
        updateManyInput = input;
        return { count: 1 };
      },
      findFirst: async () => {
        reloadCalls += 1;
        return {
          novelId: "novel-1",
          id: "chapter-1",
          content: "紧随其后的人工编辑",
          contentRevision: 9,
        };
      },
      update: async () => {
        throw new Error("content commit must not use unconditional chapter.update");
      },
    },
  };

  const service = new ChapterContentCommitService(db);
  const result = await service.commit({
    novelId: "novel-1",
    chapterId: "chapter-1",
    content: "提交后的正文",
    expectedContentRevision: 7,
    statePatch: { generationState: "ready" },
    source: "style_rewrite",
  });

  assert.deepEqual(updateManyInput, {
    where: {
      id: "chapter-1",
      novelId: "novel-1",
      contentRevision: 7,
    },
    data: {
      content: "提交后的正文",
      generationState: "ready",
      contentRevision: { increment: 1 },
    },
  });
  assert.deepEqual(result, {
    novelId: "novel-1",
    chapterId: "chapter-1",
    content: "提交后的正文",
    contentRevision: 8,
  });
  assert.equal(
    reloadCalls,
    0,
    "successful CAS must return its own deterministic snapshot instead of reloading a newer writer",
  );
});

test("chapter content commit reports the current revision after a CAS conflict", async () => {
  const db = {
    chapter: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => ({ contentRevision: 11 }),
      update: async () => {
        throw new Error("conflict path must not use chapter.update");
      },
    },
  };
  const service = new ChapterContentCommitService(db);

  await assert.rejects(
    () => service.commit({
      novelId: "novel-1",
      chapterId: "chapter-1",
      content: "过期候选",
      expectedContentRevision: 7,
      source: "repair_adopt",
    }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.details.code, CHAPTER_CONTENT_CONFLICT_CODE);
      assert.equal(error.details.currentContentRevision, 11);
      assert.equal(error.details.expectedContentRevision, 7);
      return true;
    },
  );
});

test("chapter content commit reports not found when the CAS target disappeared", async () => {
  const db = {
    chapter: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      update: async () => {
        throw new Error("not-found path must not use chapter.update");
      },
    },
  };
  const service = new ChapterContentCommitService(db);

  await assert.rejects(
    () => service.commit({
      novelId: "novel-1",
      chapterId: "chapter-1",
      content: "候选正文",
      expectedContentRevision: 2,
      source: "style_rewrite",
    }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});
