const test = require("node:test");
const assert = require("node:assert/strict");
const promptRunner = require("../dist/prompting/core/promptRunner.js");

const {
  runPipelineChapterWithRuntime,
} = require("../dist/services/novel/runtime/chapterRuntimePipeline.js");

function createRuntimePackage(overallScore) {
  return {
    novelId: "novel-1",
    chapterId: "chapter-1",
    audit: {
      score: {
        coherence: overallScore,
        pacing: overallScore,
        repetition: 10,
        engagement: overallScore,
        voice: overallScore,
        overall: overallScore,
      },
      openIssues: [{
        auditType: "continuity",
        severity: "medium",
        evidence: "存在承接问题。",
        fixSuggestion: "补足承接。",
        code: "CONTINUITY_GAP",
      }],
      reports: [],
    },
    context: {
      chapterRepairContext: null,
      bookContract: null,
      macroConstraints: null,
      volumeWindow: null,
    },
  };
}

test("runPipelineChapterWithRuntime skips review and repair when autoReview is disabled", async () => {
  const stages = [];
  const generationStates = [];
  const savedDrafts = [];
  const finalSyncs = [];
  let finalizeCalled = false;

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "测试小说" },
          chapter: {
            id: "chapter-1",
            title: "第一章",
            order: 1,
            content: null,
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        return { content: "生成后的正文" };
      },
      async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
        savedDrafts.push({ content, generationState });
      },
      async syncFinalChapterArtifacts(_novelId, _chapterId, content) {
        finalSyncs.push(content);
      },
      async finalizeChapterContent() {
        finalizeCalled = true;
        throw new Error("should not finalize");
      },
        async markChapterGenerationState(_chapterId, generationState) {
          generationStates.push(generationState);
        },
        async markChapterNeedsRepair() {},
      },
    "novel-1",
    "chapter-1",
    {
      autoReview: false,
      autoRepair: true,
    },
    {
      async onStageChange(stage) {
        stages.push(stage);
      },
    },
  );

  assert.equal(finalizeCalled, false);
  assert.deepEqual(stages, ["generating_chapters"]);
  assert.deepEqual(savedDrafts, [{
    content: "生成后的正文",
    generationState: "drafted",
  }]);
  assert.equal(finalSyncs.length, 1);
  assert.deepEqual(generationStates, ["approved"]);
  assert.equal(result.reviewExecuted, false);
  assert.equal(result.pass, true);
  assert.equal(result.retryCountUsed, 0);
  assert.deepEqual(result.issues, []);
  assert.equal(result.runtimePackage, null);
  assert.deepEqual(result.score, {
    coherence: 100,
    pacing: 100,
    repetition: 0,
    engagement: 100,
    voice: 100,
    overall: 100,
  });
});

test("runPipelineChapterWithRuntime records recoverable patch failures without failing the batch chapter", async () => {
  const originalRunStructuredPrompt = promptRunner.runStructuredPrompt;
  const stages = [];
  const savedDrafts = [];
  const finalSyncs = [];
  let needsRepairMarked = false;
  let reviewCount = 0;

  promptRunner.runStructuredPrompt = async () => ({
    output: {
      strategy: "patch_first",
      summary: "补足承接。",
      patches: [{
        id: "patch-missing",
        targetExcerpt: "模型认为存在但正文里没有的片段。",
        replacement: "替换后的片段。",
        reason: "目标片段不存在。",
        issueIds: [],
      }],
      requiresFullRewrite: false,
      escalationReason: null,
    },
  });

  try {
    const result = await runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "测试小说" },
            chapter: {
              id: "chapter-1",
              title: "第一章",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: {},
          };
        },
        async generateDraftFromWriter() {
          return { content: "生成后的正文需要承接。" };
        },
        async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
          savedDrafts.push({ content, generationState });
        },
        async syncFinalChapterArtifacts(_novelId, _chapterId, content) {
          finalSyncs.push(content);
        },
        async finalizeChapterContent({ content }) {
          reviewCount += 1;
          return {
            finalContent: content,
            runtimePackage: createRuntimePackage(72),
          };
        },
        async markChapterGenerationState() {},
        async markChapterNeedsRepair() {
          needsRepairMarked = true;
        },
      },
      "novel-1",
      "chapter-1",
      {
        autoReview: true,
        autoRepair: true,
      },
      {
        async onStageChange(stage) {
          stages.push(stage);
        },
      },
    );

    assert.deepEqual(stages, ["generating_chapters", "reviewing", "repairing"]);
    assert.equal(reviewCount, 1);
    assert.equal(result.pass, false);
    assert.equal(result.retryCountUsed, 0);
    assert.equal(result.recoverableRepairFailure.message, "patch-missing: 目标片段不存在，不能安全应用局部补丁。");
    assert.deepEqual(result.recoverableRepairFailure.failureTypes, ["missing_target"]);
    assert.equal(needsRepairMarked, true);
    assert.equal(finalSyncs.length, 1);
    assert.deepEqual(savedDrafts, [{
      content: "生成后的正文需要承接。",
      generationState: "drafted",
    }]);
  } finally {
    promptRunner.runStructuredPrompt = originalRunStructuredPrompt;
  }
});

test("runPipelineChapterWithRuntime does not save a generated draft twice when writer already synced artifacts", async () => {
  const savedDrafts = [];
  const finalSyncs = [];

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest(input) {
        return input;
      },
      async ensureNovelCharacters() {},
      async assemble() {
        return {
          novel: { id: "novel-1", title: "test novel" },
          chapter: {
            id: "chapter-1",
            title: "chapter one",
            order: 1,
            content: null,
            expectation: null,
          },
          contextPackage: {},
        };
      },
      async generateDraftFromWriter() {
        return { content: "generated draft", artifactsAlreadySynced: true };
      },
      async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
        savedDrafts.push({ content, generationState });
      },
      async syncFinalChapterArtifacts(_novelId, _chapterId, content) {
        finalSyncs.push(content);
      },
      async finalizeChapterContent({ content }) {
        return {
          finalContent: content,
          runtimePackage: createRuntimePackage(90),
        };
      },
      async markChapterGenerationState() {},
      async markChapterNeedsRepair() {},
    },
    "novel-1",
    "chapter-1",
    {
      autoReview: true,
      autoRepair: true,
    },
  );

  assert.deepEqual(savedDrafts, []);
  assert.deepEqual(finalSyncs, ["generated draft"]);
  assert.equal(result.pass, true);
  assert.equal(result.reviewExecuted, true);
});

test("runPipelineChapterWithRuntime defaults to a single repair pass before stopping", async () => {
  const originalRunStructuredPrompt = promptRunner.runStructuredPrompt;
  const stages = [];
  const finalizeInputs = [];
  const savedDrafts = [];
  const finalSyncs = [];
  const generationStates = [];
  let reviewCount = 0;

  promptRunner.runStructuredPrompt = async () => ({
    output: {
      strategy: "patch_first",
      summary: "补足承接。",
      patches: [{
        id: "patch-1",
        targetExcerpt: "初审正文需要承接。",
        replacement: "修后正文补足承接。",
        reason: "补足承接。",
        issueIds: [],
      }],
      requiresFullRewrite: false,
      escalationReason: null,
    },
  });

  try {
    const result = await runPipelineChapterWithRuntime(
      {
        validateRequest(input) {
          return input;
        },
        async ensureNovelCharacters() {},
        async assemble() {
          return {
            novel: { id: "novel-1", title: "测试小说" },
            chapter: {
              id: "chapter-1",
              title: "第一章",
              order: 1,
              content: null,
              expectation: null,
            },
            contextPackage: {},
          };
        },
        async generateDraftFromWriter() {
          return { content: "生成后的正文" };
        },
        async saveDraftAndArtifacts(_novelId, _chapterId, content, generationState) {
          savedDrafts.push({ content, generationState });
        },
        async syncFinalChapterArtifacts(_novelId, _chapterId, content) {
          finalSyncs.push(content);
        },
        async finalizeChapterContent({ content }) {
          reviewCount += 1;
          finalizeInputs.push(content);
          return {
            finalContent: reviewCount === 1 ? "初审正文需要承接。" : "修后复审正文",
            runtimePackage: createRuntimePackage(reviewCount === 1 ? 72 : 73),
          };
        },
      async markChapterGenerationState(_chapterId, generationState) {
        generationStates.push(generationState);
      },
      async markChapterNeedsRepair() {},
    },
      "novel-1",
      "chapter-1",
      {
        autoReview: true,
        autoRepair: true,
      },
      {
        async onStageChange(stage) {
          stages.push(stage);
        },
      },
    );

    assert.deepEqual(stages, ["generating_chapters", "reviewing", "repairing", "reviewing"]);
    assert.deepEqual(finalizeInputs, ["生成后的正文", "修后正文补足承接。"]);
    assert.equal(reviewCount, 2);
    assert.equal(result.retryCountUsed, 1);
    assert.equal(result.pass, false);
    assert.deepEqual(generationStates, ["reviewed", "reviewed"]);
    assert.deepEqual(savedDrafts, [
      {
        content: "生成后的正文",
        generationState: "drafted",
      },
      {
        content: "修后正文补足承接。",
        generationState: "repaired",
      },
    ]);
    assert.equal(finalSyncs.length, 1);
  } finally {
    promptRunner.runStructuredPrompt = originalRunStructuredPrompt;
  }
});
