const test = require("node:test");
const assert = require("node:assert/strict");

const { NovelExportService } = require("../dist/modules/export/novelExport.service.js");
const { prisma } = require("../dist/db/prisma.js");

test("buildExportContent uses novel title plus timestamp as export filename", async () => {
  const originalFindUnique = prisma.novel.findUnique;

  prisma.novel.findUnique = async () => ({
    title: "霓虹档案 / Neon Archive",
    description: "都市异能悬疑",
    chapters: [
      {
        order: 1,
        title: "误入局中",
        content: "第一章正文",
      },
    ],
  });

  try {
    const service = new NovelExportService();
    const result = await service.buildExportContent("novel_export_demo", "txt");

    assert.match(result.fileName, /^霓虹档案 _ Neon Archive-\d{8}-\d{6}\.txt$/);
    assert.equal(result.contentType, "text/plain; charset=utf-8");
    assert.match(result.content, /第一章正文/);
  } finally {
    prisma.novel.findUnique = originalFindUnique;
  }
});


async function withMixedReadinessChapters(run) {
  const originalFindUnique = prisma.novel.findUnique;
  const originalChapterFindMany = prisma.chapter.findMany;
  const originalChapterAggregate = prisma.chapter.aggregate;

  prisma.novel.findUnique = async (args) => {
    if (args?.select?.chapters) {
      return {
        title: "门测试",
        description: null,
        chapters: [
          { order: 1, title: "一", content: "第一章" },
          { order: 21, title: "廿一", content: "卷二章" },
        ],
      };
    }
    return { id: "novel_gate" };
  };
  prisma.chapter.aggregate = async () => ({ _max: { order: 21 } });
  prisma.chapter.findMany = async () => ([
    {
      id: "c1",
      order: 1,
      title: "一",
      content: "x".repeat(300),
      chapterStatus: "completed",
      generationState: "approved",
      riskFlags: JSON.stringify({
        qualityLoop: {
          evaluatedAt: new Date().toISOString(),
          signals: [
            { artifactType: "literary_score", status: "valid" },
            { artifactType: "style_residual", status: "valid" },
            { artifactType: "prose_quality", status: "valid" },
          ],
        },
      }),
      contentRevision: 1,
    },
    {
      id: "c21",
      order: 21,
      title: "廿一",
      content: "y".repeat(300),
      chapterStatus: "pending_review",
      generationState: "approved",
      riskFlags: null,
      contentRevision: 1,
    },
  ]);

  try {
    return await run();
  } finally {
    prisma.novel.findUnique = originalFindUnique;
    prisma.chapter.findMany = originalChapterFindMany;
    prisma.chapter.aggregate = originalChapterAggregate;
  }
}

test("requirePublishReady gates full book for txt even if volumeOrder passed", async () => {
  await withMixedReadinessChapters(async () => {
    const service = new NovelExportService();
    let threw = null;
    try {
      await service.buildExportContent("novel_gate", "txt", "full", {
        requirePublishReady: true,
        volumeOrder: 1, // should be IGNORED — full-book gate for all formats
      });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, "expected publish gate to block");
    assert.equal(threw.statusCode ?? threw.status, 409);
    assert.match(String(threw.message), /全书|publish_ready/);
  });
});

test("requirePublishReady gates full book for markdown even if volumeOrder passed", async () => {
  await withMixedReadinessChapters(async () => {
    const service = new NovelExportService();
    let threw = null;
    try {
      // markdown 内容是全书 section；门必须全书，不能因 volumeOrder=1 放行
      await service.buildExportContent("novel_gate", "markdown", "full", {
        requirePublishReady: true,
        volumeOrder: 1,
      });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, "expected publish gate to block markdown");
    assert.equal(threw.statusCode ?? threw.status, 409);
    assert.match(String(threw.message), /全书|publish_ready/);
  });
});
