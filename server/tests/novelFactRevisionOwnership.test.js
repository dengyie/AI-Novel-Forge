const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { NovelFactService } = require("../dist/services/novel/fact/NovelFactService.js");

test("new chapter revision supersedes older automatic facts and preserves manual facts", async () => {
  const originalTransaction = prisma.$transaction;
  const calls = [];
  let currentContentRevision = 9;
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async (query) => {
      calls.push(["revisionLock", query]);
      return query.values.includes(currentContentRevision) ? 1 : 0;
    },
    novelFactEntry: {
      deleteMany: async (input) => {
        calls.push(["deleteMany", input]);
        return { count: 2 };
      },
      upsert: async (input) => {
        calls.push(["upsert", input]);
        return input.create;
      },
    },
  });

  try {
    await new NovelFactService().writeChapterFacts({
      novelId: "novel-1",
      chapterId: "chapter-3",
      chapterOrder: 3,
      contentRevision: 9,
      items: [
        { text: " 主角 已取得 钥匙 ", category: "completed" },
        { text: "主角 已取得 钥匙", category: "completed" },
      ],
    });

    assert.equal(calls[0][0], "revisionLock");
    assert.deepEqual(calls[1][1].where, {
      novelId: "novel-1",
      source: "auto",
      OR: [
        { chapterId: "chapter-3", contentRevision: { lt: 9 } },
        { chapterId: null, chapterOrder: 3 },
      ],
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[2][0], "upsert");
    assert.deepEqual(calls[2][1].update, {});
    assert.equal(calls[2][1].create.chapterId, "chapter-3");
    assert.equal(calls[2][1].create.contentRevision, 9);
    assert.match(calls[2][1].create.idempotencyKey, /^[a-f0-9]{64}$/);

    const firstIdempotencyKey = calls[2][1].create.idempotencyKey;
    await new NovelFactService().writeChapterFacts({
      novelId: "novel-1",
      chapterId: "chapter-3",
      chapterOrder: 3,
      contentRevision: 9,
      items: [{ text: "主角 已取得 钥匙", category: "completed" }],
    });
    assert.equal(calls[5][0], "upsert");
    assert.equal(calls[5][1].where.idempotencyKey, firstIdempotencyKey);

    currentContentRevision = 10;
    await assert.rejects(
      new NovelFactService().writeChapterFacts({
        novelId: "novel-1",
        chapterId: "chapter-3",
        chapterOrder: 3,
        contentRevision: 9,
        items: [{ text: "旧 revision 事实", category: "completed" }],
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.equal(calls.length, 7);
    assert.equal(calls[6][0], "revisionLock");
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test("fact reads exclude automatic rows owned by stale chapter revisions", async () => {
  const originalFactFindMany = prisma.novelFactEntry.findMany;
  const originalChapterFindMany = prisma.chapter.findMany;
  let factCall = 0;
  prisma.novelFactEntry.findMany = async () => {
    factCall += 1;
    if (factCall === 1) {
      return [
        { id: "stale", novelId: "novel-1", chapterId: "chapter-2", contentRevision: 4, chapterOrder: 2, text: "旧事实", category: "completed", source: "auto", idempotencyKey: "stale", createdAt: new Date() },
        { id: "current", novelId: "novel-1", chapterId: "chapter-2", contentRevision: 5, chapterOrder: 2, text: "新事实", category: "completed", source: "auto", idempotencyKey: "current", createdAt: new Date() },
        { id: "manual", novelId: "novel-1", chapterId: null, contentRevision: null, chapterOrder: 2, text: "人工事实", category: "completed", source: "manual", idempotencyKey: null, createdAt: new Date() },
      ];
    }
    return [];
  };
  prisma.chapter.findMany = async () => [{ id: "chapter-2", contentRevision: 5 }];

  try {
    const rows = await new NovelFactService().listForChapter({
      novelId: "novel-1",
      beforeChapterOrder: 3,
    });
    assert.deepEqual(rows.map((row) => row.text), ["新事实", "人工事实"]);
  } finally {
    prisma.novelFactEntry.findMany = originalFactFindMany;
    prisma.chapter.findMany = originalChapterFindMany;
  }
});
