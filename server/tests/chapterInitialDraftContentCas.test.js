const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  CHAPTER_CONTENT_CONFLICT_CODE,
} = require("../dist/services/novel/chapterContentCas.js");
const {
  ChapterArtifactSyncService,
} = require("../dist/services/novel/runtime/ChapterArtifactSyncService.js");
const {
  ChapterContentCommitService,
} = require("../dist/services/novel/runtime/content/ChapterContentCommitService.js");

test("initial writer draft cannot overwrite a manual edit saved after generation started", async () => {
  const originalUpdate = prisma.chapter.update;
  const row = {
    novelId: "novel-1",
    id: "chapter-1",
    content: "生成开始时的旧正文",
    contentRevision: 7,
    generationState: "pending",
    chapterStatus: "pending_generation",
  };

  const db = {
    chapter: {
      async updateMany(input) {
        const matches = input.where.id === row.id
          && input.where.novelId === row.novelId
          && input.where.contentRevision === row.contentRevision;
        if (!matches) {
          return { count: 0 };
        }
        row.content = input.data.content;
        row.contentRevision += input.data.contentRevision.increment;
        row.generationState = input.data.generationState;
        row.chapterStatus = input.data.chapterStatus;
        return { count: 1 };
      },
      async findFirst(input) {
        if (input.where.id !== row.id || input.where.novelId !== row.novelId) {
          return null;
        }
        return { contentRevision: row.contentRevision };
      },
    },
  };

  try {
    // 模拟 writer 以 revision 7 开始生成后，用户先保存了 revision 8。
    row.content = "人工保存的新正文";
    row.contentRevision = 8;

    // RED 兼容：旧实现仍走无条件 update，会真实覆盖内存行；修复后必须只走上述 CAS updateMany。
    prisma.chapter.update = async (input) => {
      row.content = input.data.content;
      row.contentRevision += input.data.contentRevision.increment;
      row.generationState = input.data.generationState;
      row.chapterStatus = input.data.chapterStatus;
      return { ...row };
    };

    const contentCommitService = new ChapterContentCommitService(db);
    const service = new ChapterArtifactSyncService(contentCommitService);

    await assert.rejects(
      () => service.saveDraftAndArtifacts(
        "novel-1",
        "chapter-1",
        "后台生成的草稿",
        "drafted",
        {
          expectedContentRevision: 7,
          syncArtifacts: false,
        },
      ),
      (error) => {
        assert.equal(error.details.code, CHAPTER_CONTENT_CONFLICT_CODE);
        return true;
      },
    );

    assert.equal(row.content, "人工保存的新正文");
    assert.equal(row.contentRevision, 8);
  } finally {
    prisma.chapter.update = originalUpdate;
  }
});
