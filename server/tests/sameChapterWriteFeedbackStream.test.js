const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ChapterStreamGenerationOrchestrator,
} = require("../dist/services/novel/runtime/ChapterStreamGenerationOrchestrator.js");
const {
  ChapterChineseProseGateError,
} = require("../dist/services/novel/runtime/chapterChineseProseGateError.js");
const {
  ChapterEmptyContentError,
} = require("../dist/services/novel/runtime/chapterEmptyContentError.js");

/**
 * Stream retry path: resolveWriterResultWithEmptyRetry must inject same-chapter
 * feedback into the second generateDraftFromWriter call.
 * (TS private is compile-time only; dist still exposes the method.)
 */
test("stream empty/chinese retry injects same-chapter feedback into generateDraftFromWriter", async () => {
  const writerAssembledFeedback = [];
  let writerCalls = 0;

  const orchestrator = new ChapterStreamGenerationOrchestrator({
    assembler: {
      async assemble() {
        throw new Error("assemble should not run in this unit test");
      },
    },
    chapterWritingGraph: {
      async createChapterStream() {
        throw new Error("createChapterStream should not run; generateDraftFromWriter is stubbed");
      },
    },
    readinessService: {
      async assertReady() {},
    },
    contentFinalizationService: {
      async finalizeChapterContent() {
        throw new Error("finalize should not run");
      },
      async markChapterStatus() {},
    },
    agentRuntime: {
      async createChapterGenRun() {
        return "run-test";
      },
    },
    validateRequest(input) {
      return input;
    },
    async ensureNovelCharacters() {},
  });

  // Stub generateDraftFromWriter used by the retry gun.
  orchestrator.generateDraftFromWriter = async (input) => {
    writerCalls += 1;
    const prior = input?.assembled?.contextPackage?.priorQualityFeedback ?? [];
    writerAssembledFeedback.push(Array.isArray(prior) ? [...prior] : []);
    return {
      content: "中文正文重试通过。",
      lengthControl: undefined,
      artifactsAlreadySynced: false,
      backgroundSyncDeferred: false,
    };
  };

  const assembled = {
    novel: { id: "novel-1", title: "测试" },
    chapter: {
      id: "chapter-1",
      title: "第十二章",
      order: 12,
      content: null,
      expectation: null,
    },
    contextPackage: {
      priorQualityFeedback: ["上章债：示例"],
      chapterWriteContext: {
        priorQualityFeedback: ["上章债：示例"],
      },
    },
  };

  const result = await orchestrator.resolveWriterResultWithEmptyRetry({
    novelId: "novel-1",
    chapterId: "chapter-1",
    request: { provider: "test", model: "test" },
    assembled,
    writerDone: async () => {
      throw new ChapterChineseProseGateError({
        novelId: "novel-1",
        chapterId: "chapter-1",
        chapterOrder: 12,
        source: "stream_test",
        reason: "english_meta",
        metaMarker: "We need to write",
        cjkCount: 5,
        latinCount: 400,
        rawLength: 500,
      });
    },
    fallbackContent: "We need to write a plan",
  });

  assert.equal(result.finalContent, "中文正文重试通过。");
  assert.equal(writerCalls, 1);
  assert.equal(writerAssembledFeedback.length, 1);
  assert.ok(
    writerAssembledFeedback[0].some((line) => String(line).includes("本章上枪")),
    `expected same-chapter feedback on stream retry, got ${JSON.stringify(writerAssembledFeedback[0])}`,
  );
  assert.ok(
    writerAssembledFeedback[0].some((line) => String(line).includes("We need")),
    "stream retry feedback should include meta evidence",
  );
  assert.ok(
    writerAssembledFeedback[0].includes("上章债：示例"),
    "prior chapter feedback should remain",
  );
  // Original assembled must not be mutated.
  assert.deepEqual(assembled.contextPackage.priorQualityFeedback, ["上章债：示例"]);
});

test("stream empty content retry also injects same-chapter feedback", async () => {
  const writerAssembledFeedback = [];
  const orchestrator = new ChapterStreamGenerationOrchestrator({
    assembler: { async assemble() {} },
    chapterWritingGraph: { async createChapterStream() {} },
    readinessService: { async assertReady() {} },
    contentFinalizationService: {
      async finalizeChapterContent() {},
      async markChapterStatus() {},
    },
    agentRuntime: { async createChapterGenRun() { return "r"; } },
    validateRequest(input) { return input; },
    async ensureNovelCharacters() {},
  });

  orchestrator.generateDraftFromWriter = async (input) => {
    const prior = input?.assembled?.contextPackage?.priorQualityFeedback ?? [];
    writerAssembledFeedback.push(Array.isArray(prior) ? [...prior] : []);
    return { content: "非空正文" };
  };

  await orchestrator.resolveWriterResultWithEmptyRetry({
    novelId: "n",
    chapterId: "c",
    request: {},
    assembled: {
      novel: { id: "n", title: "t" },
      chapter: { id: "c", title: "t", order: 1, content: null, expectation: null },
      contextPackage: { priorQualityFeedback: [] },
    },
    writerDone: async () => {
      throw new ChapterEmptyContentError({
        novelId: "n",
        chapterId: "c",
        chapterOrder: 1,
        source: "stream_test",
        rawLength: 0,
        trimmedLength: 0,
      });
    },
    fallbackContent: "   ",
  });

  assert.ok(
    writerAssembledFeedback[0].some((line) => String(line).includes("空正文") || String(line).includes("本章上枪")),
  );
});
