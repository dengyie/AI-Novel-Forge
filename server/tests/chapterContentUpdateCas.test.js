const test = require("node:test");
const assert = require("node:assert/strict");

const { NovelCoreCrudService } = require("../dist/services/novel/novelCoreCrudService.js");
const { CHAPTER_CONTENT_CONFLICT_CODE } = require("../dist/services/novel/chapterContentCas.js");
const { AppError } = require("../dist/middleware/errorHandler.js");
const { prisma } = require("../dist/db/prisma.js");

function baseChapter(overrides = {}) {
  return {
    id: "ch_1",
    novelId: "novel_1",
    title: "第一章",
    order: 1,
    content: "旧正文",
    contentRevision: 2,
    expectation: null,
    chapterStatus: "pending_review",
    targetWordCount: null,
    conflictLevel: null,
    revealLevel: null,
    mustAvoid: null,
    taskSheet: null,
    sceneCards: null,
    repairHistory: null,
    qualityScore: null,
    continuityScore: null,
    characterScore: null,
    pacingScore: null,
    riskFlags: null,
    generationState: "drafted",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("updateChapter content CAS: matching expectedContentRevision succeeds and bumps", async () => {
  const service = new NovelCoreCrudService();
  const originals = {
    findFirst: prisma.chapter.findFirst,
    findFirstOrThrow: prisma.chapter.findFirstOrThrow,
    updateMany: prisma.chapter.updateMany,
    update: prisma.chapter.update,
    findMany: prisma.chapter.findMany,
    transaction: prisma.$transaction,
  };
  const mirror = service.volumeService.mirrorChapterIntoWorkspace.bind(service.volumeService);
  service.volumeService.mirrorChapterIntoWorkspace = async () => null;

  let updateManyCalls = 0;
  try {
    prisma.chapter.findFirst = async ({ select }) => {
      if (select?.contentRevision) {
        return { id: "ch_1", contentRevision: 2 };
      }
      return baseChapter({ contentRevision: 3, content: "新正文" });
    };
    prisma.chapter.findFirstOrThrow = async () => baseChapter({ contentRevision: 3, content: "新正文" });
    prisma.chapter.updateMany = async ({ where, data }) => {
      updateManyCalls += 1;
      assert.equal(where.contentRevision, 2);
      assert.equal(data.content, "新正文");
      assert.equal(data.contentRevision, 3);
      return { count: 1 };
    };
    prisma.chapter.update = async () => {
      throw new Error("CAS path must not call chapter.update");
    };
    prisma.chapter.findMany = async () => [];
    // 跳过 syncChapterArtifacts 真实写库（FK 依赖 novel/chapter 行）
    // product: novelChapterArtifacts 先 findUnique 再 update/create，不能只 stub upsert
    prisma.$transaction = async (fn) => {
      if (typeof fn === "function") {
        const tx = {
          chapterSummary: {
            findUnique: async () => null,
            update: async () => null,
            create: async () => null,
            upsert: async () => null,
          },
          consistencyFact: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
        };
        return fn(tx);
      }
      return fn;
    };

    const result = await service.updateChapter("novel_1", "ch_1", {
      content: "新正文",
      expectedContentRevision: 2,
    });
    assert.equal(updateManyCalls, 1);
    assert.equal(result.contentRevision, 3);
    assert.equal(result.content, "新正文");
  } finally {
    prisma.chapter.findFirst = originals.findFirst;
    prisma.chapter.findFirstOrThrow = originals.findFirstOrThrow;
    prisma.chapter.updateMany = originals.updateMany;
    prisma.chapter.update = originals.update;
    prisma.chapter.findMany = originals.findMany;
    prisma.$transaction = originals.transaction;
    service.volumeService.mirrorChapterIntoWorkspace = mirror;
  }
});

test("updateChapter content CAS: stale expectedContentRevision throws 409", async () => {
  const service = new NovelCoreCrudService();
  const originals = {
    findFirst: prisma.chapter.findFirst,
    updateMany: prisma.chapter.updateMany,
    update: prisma.chapter.update,
    findMany: prisma.chapter.findMany,
  };
  const mirror = service.volumeService.mirrorChapterIntoWorkspace.bind(service.volumeService);
  service.volumeService.mirrorChapterIntoWorkspace = async () => null;

  try {
    let findFirstCalls = 0;
    prisma.chapter.findFirst = async () => {
      findFirstCalls += 1;
      // first existence check + re-read after failed claim
      return { id: "ch_1", contentRevision: 5 };
    };
    prisma.chapter.updateMany = async () => ({ count: 0 });
    prisma.chapter.update = async () => {
      throw new Error("conflict path must not call chapter.update");
    };
    prisma.chapter.findMany = async () => [];

    await assert.rejects(
      () => service.updateChapter("novel_1", "ch_1", {
        content: "冲突正文",
        expectedContentRevision: 2,
      }),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.details.code, CHAPTER_CONTENT_CONFLICT_CODE);
        assert.equal(error.details.currentContentRevision, 5);
        assert.equal(error.details.expectedContentRevision, 2);
        return true;
      },
    );
    assert.ok(findFirstCalls >= 2);
  } finally {
    prisma.chapter.findFirst = originals.findFirst;
    prisma.chapter.updateMany = originals.updateMany;
    prisma.chapter.update = originals.update;
    prisma.chapter.findMany = originals.findMany;
    service.volumeService.mirrorChapterIntoWorkspace = mirror;
  }
});

test("updateChapter without expectedContentRevision is last-write-wins and still bumps", async () => {
  const service = new NovelCoreCrudService();
  const originals = {
    findFirst: prisma.chapter.findFirst,
    updateMany: prisma.chapter.updateMany,
    update: prisma.chapter.update,
    findMany: prisma.chapter.findMany,
    transaction: prisma.$transaction,
  };
  const mirror = service.volumeService.mirrorChapterIntoWorkspace.bind(service.volumeService);
  service.volumeService.mirrorChapterIntoWorkspace = async () => null;

  try {
    prisma.chapter.findFirst = async () => ({ id: "ch_1", contentRevision: 2 });
    prisma.chapter.updateMany = async () => {
      throw new Error("compat path must not call updateMany");
    };
    prisma.chapter.update = async ({ data }) => {
      assert.equal(data.content, "兼容正文");
      assert.deepEqual(data.contentRevision, { increment: 1 });
      return baseChapter({ content: "兼容正文", contentRevision: 3 });
    };
    prisma.chapter.findMany = async () => [];
    prisma.$transaction = async (fn) => {
      if (typeof fn === "function") {
        const tx = {
          chapterSummary: {
            findUnique: async () => null,
            update: async () => null,
            create: async () => null,
            upsert: async () => null,
          },
          consistencyFact: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
        };
        return fn(tx);
      }
      return fn;
    };

    const result = await service.updateChapter("novel_1", "ch_1", {
      content: "兼容正文",
    });
    assert.equal(result.contentRevision, 3);
  } finally {
    prisma.chapter.findFirst = originals.findFirst;
    prisma.chapter.updateMany = originals.updateMany;
    prisma.chapter.update = originals.update;
    prisma.chapter.findMany = originals.findMany;
    prisma.$transaction = originals.transaction;
    service.volumeService.mirrorChapterIntoWorkspace = mirror;
  }
});

test("updateChapter rejects non-integer expectedContentRevision with 400", async () => {
  const service = new NovelCoreCrudService();
  const originals = {
    findFirst: prisma.chapter.findFirst,
    updateMany: prisma.chapter.updateMany,
    update: prisma.chapter.update,
  };
  try {
    prisma.chapter.findFirst = async () => ({ id: "ch_1" });
    prisma.chapter.updateMany = async () => {
      throw new Error("invalid expected must not call updateMany");
    };
    prisma.chapter.update = async () => {
      throw new Error("invalid expected must not call update");
    };
    await assert.rejects(
      () => service.updateChapter("novel_1", "ch_1", {
        content: "x",
        expectedContentRevision: 1.5,
      }),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 400);
        return true;
      },
    );
  } finally {
    prisma.chapter.findFirst = originals.findFirst;
    prisma.chapter.updateMany = originals.updateMany;
    prisma.chapter.update = originals.update;
  }
});

test("updateChapter metadata-only does not bump contentRevision", async () => {
  const service = new NovelCoreCrudService();
  const originals = {
    findFirst: prisma.chapter.findFirst,
    updateMany: prisma.chapter.updateMany,
    update: prisma.chapter.update,
    findMany: prisma.chapter.findMany,
  };
  const mirror = service.volumeService.mirrorChapterIntoWorkspace.bind(service.volumeService);
  service.volumeService.mirrorChapterIntoWorkspace = async () => null;

  try {
    prisma.chapter.findFirst = async () => ({ id: "ch_1", contentRevision: 2 });
    prisma.chapter.updateMany = async () => {
      throw new Error("metadata path must not call updateMany");
    };
    prisma.chapter.update = async ({ data }) => {
      assert.equal(data.title, "新标题");
      assert.equal(data.content, undefined);
      assert.equal(data.contentRevision, undefined);
      return baseChapter({ title: "新标题", contentRevision: 2 });
    };
    prisma.chapter.findMany = async () => [];

    const result = await service.updateChapter("novel_1", "ch_1", {
      title: "新标题",
    });
    assert.equal(result.contentRevision, 2);
    assert.equal(result.title, "新标题");
  } finally {
    prisma.chapter.findFirst = originals.findFirst;
    prisma.chapter.updateMany = originals.updateMany;
    prisma.chapter.update = originals.update;
    prisma.chapter.findMany = originals.findMany;
    service.volumeService.mirrorChapterIntoWorkspace = mirror;
  }
});
