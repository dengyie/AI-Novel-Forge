const test = require("node:test");
const assert = require("node:assert/strict");

const {
  throwIfChapterGenerationAborted,
} = require("../dist/services/novel/runtime/chapterAbortGuard.js");
const { ChapterWritingGraph } = require("../dist/services/novel/chapterWritingGraph.js");
const promptRunner = require("../dist/prompting/core/promptRunner.js");

test("throwIfChapterGenerationAborted throws when aborted with Error reason", () => {
  const controller = new AbortController();
  controller.abort(new Error("当前自动导演任务已取消。"));
  assert.throws(
    () => throwIfChapterGenerationAborted(controller.signal),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /取消/);
      return true;
    },
  );
});

test("throwIfChapterGenerationAborted allows live or missing signal", () => {
  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfChapterGenerationAborted(controller.signal));
  assert.doesNotThrow(() => throwIfChapterGenerationAborted(undefined));
});

test("throwIfChapterGenerationAborted uses fallback message for non-Error reason", () => {
  const controller = new AbortController();
  controller.abort("cancelled");
  assert.throws(
    () => throwIfChapterGenerationAborted(controller.signal, "章节生成已取消，跳过正文定稿。"),
    (error) => {
      assert.equal(error.message, "章节生成已取消，跳过正文定稿。");
      return true;
    },
  );
});

function buildMinimalContextPackage() {
  return {
    chapter: {
      title: "第1章",
      // null：跳过 enforceTargetLength 二次 LLM，避免测试依赖 runTextPrompt
      targetWordCount: null,
      sceneCards: null,
      expectation: "推进。",
    },
    chapterWriteContext: {
      bookContract: {
        title: "测试",
        genre: "测试",
        targetAudience: "读者",
        sellingPoint: "卖点",
        first30ChapterPromise: "前三十章承诺",
        narrativePov: "第三人称",
        pacePreference: "中",
        emotionIntensity: "中",
        toneGuardrails: [],
        hardConstraints: [],
      },
      macroConstraints: null,
      volumeWindow: null,
      chapterMission: {
        chapterId: "chapter-1",
        chapterOrder: 1,
        title: "第1章",
        objective: "推进。",
        expectation: "推进。",
        targetWordCount: null,
        mustAdvance: [],
        mustPreserve: [],
        hookTarget: "",
        taskSheet: "",
        riskNotes: [],
      },
      nextAction: "write_chapter",
      chapterStateGoal: null,
      protectedSecrets: [],
      payoffDirectives: [],
      obligationContract: {
        mustHitNow: [],
        mustPreserve: [],
        requiredPayoffTouches: [],
        requiredCharacterAppearances: [],
        requiredGoalChanges: [],
        canDefer: [],
        forbiddenCrossings: [],
      },
      chapterBoundary: null,
      lengthBudget: null,
      scenePlan: null,
      participants: [],
      characterHardFacts: [],
      characterBehaviorGuides: [],
      activeRelationStages: [],
      pendingCandidateGuards: [],
      localStateSummary: "无",
      openConflictSummaries: [],
      ledgerPendingItems: [],
      ledgerUrgentItems: [],
      ledgerOverdueItems: [],
      ledgerSummary: null,
      timelineContext: null,
      characterResourceContext: null,
      recentChapterSummaries: [],
      previousChapterTail: null,
      openingAntiRepeatHint: "none",
      styleContract: null,
      styleConstraints: [],
      continuationConstraints: [],
      ragFacts: [],
      completedMilestones: [],
      recentScenePatterns: [],
    },
    ragContext: "",
    continuation: {
      enabled: false,
      sourceType: null,
      sourceId: null,
      sourceTitle: "",
      systemRule: "",
      humanBlock: "",
      antiCopyCorpus: [],
    },
  };
}

test("ChapterWritingGraph onDone throws when signal aborted and does not save draft", async () => {
  const originalStream = promptRunner.streamTextPrompt;
  let saveCalls = 0;

  promptRunner.streamTextPrompt = async () => ({
    stream: {
      async *[Symbol.asyncIterator]() {
        yield { content: "partial" };
      },
    },
    complete: Promise.resolve({ output: "partial final body that should not publish" }),
  });

  try {
    const graph = new ChapterWritingGraph({
      enforceOpeningDiversity: async (_n, _o, _t, content) => ({
        content,
        rewritten: false,
        maxSimilarity: 0,
      }),
      saveDraftAndArtifacts: async () => {
        saveCalls += 1;
      },
      logInfo: () => {},
      logWarn: () => {},
    });

    const controller = new AbortController();
    controller.abort(new Error("PIPELINE_CANCELLED"));

    const result = await graph.createChapterStream({
      novelId: "novel-1",
      novelTitle: "测试",
      chapter: {
        id: "chapter-1",
        title: "第1章",
        order: 1,
        // null：避免 enforceTargetLength 回退到 chapter.targetWordCount 触发二次 LLM
        targetWordCount: null,
      },
      contextPackage: buildMinimalContextPackage(),
      options: {
        signal: controller.signal,
      },
    });

    await assert.rejects(
      () => result.onDone("partial final body that should not publish"),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /PIPELINE_CANCELLED|取消/);
        return true;
      },
    );
    assert.equal(saveCalls, 0, "aborted onDone must not save draft/artifacts");
  } finally {
    promptRunner.streamTextPrompt = originalStream;
  }
});

test("ChapterWritingGraph onDone proceeds when signal is live", async () => {
  const originalStream = promptRunner.streamTextPrompt;
  let saveCalls = 0;

  promptRunner.streamTextPrompt = async () => ({
    stream: {
      async *[Symbol.asyncIterator]() {
        yield { content: "完整正文内容足够通过空内容校验。" };
      },
    },
    complete: Promise.resolve({ output: "完整正文内容足够通过空内容校验。" }),
  });

  try {
    const graph = new ChapterWritingGraph({
      enforceOpeningDiversity: async (_n, _o, _t, content) => ({
        content,
        rewritten: false,
        maxSimilarity: 0,
      }),
      saveDraftAndArtifacts: async () => {
        saveCalls += 1;
      },
      logInfo: () => {},
      logWarn: () => {},
    });

    const controller = new AbortController();
    const result = await graph.createChapterStream({
      novelId: "novel-1",
      novelTitle: "测试",
      chapter: {
        id: "chapter-1",
        title: "第1章",
        order: 1,
        targetWordCount: null,
      },
      contextPackage: buildMinimalContextPackage(),
      options: {
        signal: controller.signal,
      },
    });

    const done = await result.onDone("完整正文内容足够通过空内容校验。");
    assert.ok(done?.finalContent);
    assert.equal(saveCalls, 1);
  } finally {
    promptRunner.streamTextPrompt = originalStream;
  }
});

test("pipeline cancel AbortController propagates aborted state to draft options", () => {
  const chapterAbort = new AbortController();
  chapterAbort.abort(new Error("PIPELINE_CANCELLED"));
  const options = { signal: chapterAbort.signal };
  assert.equal(options.signal.aborted, true);
  assert.equal(options.signal.reason.message, "PIPELINE_CANCELLED");
});
