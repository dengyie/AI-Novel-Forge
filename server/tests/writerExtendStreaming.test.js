const test = require("node:test");
const assert = require("node:assert/strict");

const { ChapterWritingGraph } = require("../dist/services/novel/chapterWritingGraph.js");
const promptRunner = require("../dist/prompting/core/promptRunner.js");

// 生产 P2 回归：writer_extend 曾走非流式 runTextPrompt——establish 无 transport retry、
// 无 live 进度，652s 墙钟超时只留一行 err.log。修复后必须与 writer_draft 同构走
// streamTextPrompt，超时 reject 直接冒泡为章节失败（不落半截续写）。

function buildContextPackageWithTarget(targetWordCount, chapterBoundary = null) {
  return {
    chapter: { title: "第20章", targetWordCount, sceneCards: null, expectation: "推进。" },
    chapterWriteContext: {
      bookContract: {
        title: "源世界", genre: "玄幻", targetAudience: "读者", sellingPoint: "卖点",
        first30ChapterPromise: "承诺", narrativePov: "第三人称", pacePreference: "中",
        emotionIntensity: "中", toneGuardrails: [], hardConstraints: [],
      },
      macroConstraints: null,
      volumeWindow: null,
      chapterMission: {
        chapterId: "chapter-20", chapterOrder: 20, title: "第20章",
        objective: "推进。", expectation: "推进。", targetWordCount,
        mustAdvance: [], mustPreserve: [], hookTarget: "", taskSheet: "", riskNotes: [],
      },
      nextAction: "write_chapter",
      chapterStateGoal: null,
      protectedSecrets: [], payoffDirectives: [],
      obligationContract: {
        mustHitNow: [], mustPreserve: [], requiredPayoffTouches: [],
        requiredCharacterAppearances: [], requiredGoalChanges: [], canDefer: [], forbiddenCrossings: [],
      },
      chapterBoundary, lengthBudget: null, scenePlan: null,
      participants: [], characterHardFacts: [], characterBehaviorGuides: [],
      activeRelationStages: [], pendingCandidateGuards: [],
      localStateSummary: "无", openConflictSummaries: [],
      ledgerPendingItems: [], ledgerUrgentItems: [], ledgerOverdueItems: [], ledgerSummary: null,
      timelineContext: null, characterResourceContext: null,
      recentChapterSummaries: [], previousChapterTail: null,
      openingAntiRepeatHint: "none", styleContract: null, styleConstraints: [],
      continuationConstraints: [], ragFacts: [], completedMilestones: [], recentScenePatterns: [],
    },
    ragContext: "",
    continuation: { enabled: false, sourceType: null, sourceId: null, sourceTitle: "", systemRule: "", humanBlock: "", antiCopyCorpus: [] },
  };
}

function buildGraph(overrides = {}) {
  return new ChapterWritingGraph({
    enforceOpeningDiversity: async (_n, _o, _t, content) => ({ content, rewritten: false, maxSimilarity: 0 }),
    saveDraftAndArtifacts: async (novelId, chapterId, content) => ({ novelId, chapterId, content, contentRevision: 1 }),
    logInfo: () => {},
    logWarn: () => {},
    ...overrides,
  });
}

// 短 draft（远低于 min）触发 enforceTargetLength → writer_extend 路径。
const SHORT_DRAFT = "夜色渐沉，林风立于废墟之上，望着天际最后一抹残光。";

test("writer_extend uses streamTextPrompt and appends continuation output", async () => {
  const originalStream = promptRunner.streamTextPrompt;
  const streamCalls = [];
  // 长正文续写段：足够长让 merged 越过 minWordCount（7000*0.85=5950）
  const continuationText = "续写正文。".repeat(1500);

  promptRunner.streamTextPrompt = async (input) => {
    streamCalls.push(input);
    const isDraft = input.promptInput.mode === "draft";
    return {
      stream: (async function* () { yield { content: "chunk" }; })(),
      complete: Promise.resolve({ output: isDraft ? SHORT_DRAFT : continuationText }),
    };
  };

  try {
    const graph = buildGraph();
    const result = await graph.createChapterStream({
      novelId: "novel-1",
      novelTitle: "源世界",
      chapter: { id: "chapter-20", title: "第20章", order: 20, targetWordCount: 7000 },
      contextPackage: buildContextPackageWithTarget(7000),
      options: {},
    });
    const done = await result.onDone(SHORT_DRAFT);

    assert.equal(streamCalls.length >= 2, true, "draft + at least one extend call");
    const extendCall = streamCalls.find((c) => c.promptInput.mode === "continue");
    assert.ok(extendCall, "writer_extend must go through streamTextPrompt (mode=continue)");
    assert.equal(extendCall.options.stage, "writer_extend");
    assert.equal(typeof extendCall.options.timeoutMs, "number");
    assert.ok(extendCall.options.timeoutMs >= 480_000, "extend timeout must respect writer floor");
    assert.match(done.finalContent, /续写正文/, "continuation must be merged into final content");
  } finally {
    promptRunner.streamTextPrompt = originalStream;
  }
});

test("writer_extend does not cross a concrete chapter boundary to repay length debt", async () => {
  const originalStream = promptRunner.streamTextPrompt;
  const streamCalls = [];
  const continuationText = "不应越过边界的续写。".repeat(1500);

  promptRunner.streamTextPrompt = async (input) => {
    streamCalls.push(input);
    const isDraft = input.promptInput.mode === "draft";
    return {
      stream: (async function* () { yield { content: "chunk" }; })(),
      complete: Promise.resolve({ output: isDraft ? SHORT_DRAFT : continuationText }),
    };
  };

  try {
    const graph = buildGraph();
    const result = await graph.createChapterStream({
      novelId: "novel-1",
      novelTitle: "源世界",
      chapter: { id: "chapter-20", title: "第20章", order: 20, targetWordCount: 7000 },
      contextPackage: buildContextPackageWithTarget(7000, {
        endingState: "手电光已经扫到巷口，追兵即将进入视野",
        doNotCross: ["不得进入巷口后的正面交锋"],
      }),
      options: {},
    });
    const done = await result.onDone(SHORT_DRAFT);

    assert.equal(streamCalls.filter((call) => call.promptInput.mode === "continue").length, 0);
    assert.equal(done.finalContent, SHORT_DRAFT);
  } finally {
    promptRunner.streamTextPrompt = originalStream;
  }
});

test("writer_extend stream timeout rejects chapter generation (no partial append)", async () => {
  const originalStream = promptRunner.streamTextPrompt;

  promptRunner.streamTextPrompt = async (input) => {
    const isDraft = input.promptInput.mode === "draft";
    if (isDraft) {
      return {
        stream: (async function* () { yield { content: "chunk" }; })(),
        complete: Promise.resolve({ output: SHORT_DRAFT }),
      };
    }
    // writer_extend：模拟墙钟超时——complete reject TimeoutError（P0a 修复后进程不崩）。
    const timeoutError = new Error("[novel.chapter.writer@v5] Request timed out after 652000ms.");
    timeoutError.name = "TimeoutError";
    return {
      stream: (async function* () { yield { content: "partial-extend" }; })(),
      complete: Promise.reject(timeoutError),
    };
  };

  try {
    const graph = buildGraph();
    const result = await graph.createChapterStream({
      novelId: "novel-1",
      novelTitle: "源世界",
      chapter: { id: "chapter-20", title: "第20章", order: 20, targetWordCount: 7000 },
      contextPackage: buildContextPackageWithTarget(7000),
      options: {},
    });
    await assert.rejects(
      () => result.onDone(SHORT_DRAFT),
      (error) => {
        assert.equal(error.name, "TimeoutError");
        assert.match(error.message, /timed out/);
        return true;
      },
      "extend timeout must reject the whole generation instead of silently appending partial text",
    );
  } finally {
    promptRunner.streamTextPrompt = originalStream;
  }
});
