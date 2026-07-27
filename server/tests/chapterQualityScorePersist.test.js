const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const {
  mapQualityScoreToChapterColumns,
  persistChapterQualityScores,
} = require("../dist/services/novel/quality/chapterQualityScorePersist.js");
const { prisma } = require("../dist/db/prisma.js");

test("mapQualityScoreToChapterColumns flattens overall/coherence/voice/pacing", () => {
  const columns = mapQualityScoreToChapterColumns({
    coherence: 88,
    repetition: 91,
    pacing: 76,
    voice: 82,
    engagement: 85,
    overall: 84,
  });
  assert.deepEqual(columns, {
    qualityScore: 84,
    continuityScore: 88,
    characterScore: 82,
    pacingScore: 76,
  });
});

test("mapQualityScoreToChapterColumns clamps out-of-range and non-finite", () => {
  const columns = mapQualityScoreToChapterColumns({
    coherence: 150,
    repetition: -10,
    pacing: Number.NaN,
    voice: 50.6,
    engagement: 100,
    overall: -3,
  });
  assert.equal(columns.qualityScore, 0);
  assert.equal(columns.continuityScore, 100);
  assert.equal(columns.characterScore, 51);
  assert.equal(columns.pacingScore, 0);
});

test("quality projection owns column-only persist; pipeline/manual/stream owns QualityReport write", () => {
  // 所有权契约：直接检查拆分后的真实投影模块，避免 facade 与 createQualityReport 双写报告行。
  const qualityProjectionSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/runtime/finalization/ChapterQualityProjectionService.ts"),
    "utf8",
  );
  const reviewSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/novelCoreReviewService.ts"),
    "utf8",
  );
  const streamSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/runtime/ChapterStreamGenerationOrchestrator.ts"),
    "utf8",
  );
  assert.match(qualityProjectionSrc, /writeReport:\s*false/);
  assert.doesNotMatch(qualityProjectionSrc, /writeReport:\s*true/);
  assert.match(reviewSrc, /writeReport:\s*true/);
  assert.match(reviewSrc, /createQualityReport/);
  assert.match(streamSrc, /writeReport:\s*true/);
  assert.match(streamSrc, /persistChapterQualityScores/);
});

test("revision-scoped quality projection does not attach stale scores or reports to newer content", async () => {
  const originalTransaction = prisma.$transaction;
  const calls = [];
  prisma.$transaction = async (callback) => callback({
    chapter: {
      updateMany: async (input) => {
        calls.push(["chapter.updateMany", input]);
        return { count: 0 };
      },
      findFirst: async () => ({ contentRevision: 12 }),
    },
    qualityReport: {
      create: async (input) => {
        calls.push(["qualityReport.create", input]);
        return {};
      },
    },
  });

  try {
    await assert.rejects(
      () => persistChapterQualityScores({
        novelId: "novel-1",
        chapterId: "chapter-1",
        expectedContentRevision: 11,
        score: {
          coherence: 90,
          repetition: 90,
          pacing: 90,
          voice: 90,
          engagement: 90,
          overall: 90,
        },
        writeReport: true,
      }),
      (error) => error?.details?.code === "CHAPTER_CONTENT_CONFLICT",
    );
    assert.deepEqual(calls[0][1].where, {
      id: "chapter-1",
      novelId: "novel-1",
      contentRevision: 11,
    });
    assert.equal(calls.some(([name]) => name === "qualityReport.create"), false);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});
