const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NovelDirectorAutoExecutionRuntime,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionRuntime.js");

function buildSceneCards(order) {
  return JSON.stringify({
    targetWordCount: 2800,
    lengthBudget: {
      targetWordCount: 2800,
      softMinWordCount: 2380,
      softMaxWordCount: 3220,
      hardMaxWordCount: 3500,
    },
    scenes: [
      {
        key: `chapter-${order}-scene-1`,
        title: "起势",
        purpose: "推进本章核心目标",
        mustAdvance: ["主线"],
        mustPreserve: ["人物动机"],
        entryState: "进入冲突",
        exitState: "压力升级",
        forbiddenExpansion: [],
        targetWordCount: 900,
      },
      {
        key: `chapter-${order}-scene-2`,
        title: "交锋",
        purpose: "制造选择压力",
        mustAdvance: ["冲突"],
        mustPreserve: ["设定边界"],
        entryState: "压力升级",
        exitState: "代价显形",
        forbiddenExpansion: [],
        targetWordCount: 900,
      },
      {
        key: `chapter-${order}-scene-3`,
        title: "落点",
        purpose: "形成章末推进",
        mustAdvance: ["章末钩子"],
        mustPreserve: ["后续入口"],
        entryState: "代价显形",
        exitState: "进入下一章",
        forbiddenExpansion: [],
        targetWordCount: 1000,
      },
    ],
  });
}

function withExecutionDetail(chapter) {
  const order = chapter.order;
  return {
    purpose: `第${order}章目标`,
    exclusiveEvent: `第${order}章独占事件`,
    endingState: `第${order}章结尾状态`,
    nextChapterEntryState: `第${order + 1}章入场状态`,
    conflictLevel: 5,
    revealLevel: 3,
    targetWordCount: 2800,
    mustAvoid: "不要展开无关支线",
    taskSheet: `第${order}章任务单`,
    sceneCards: buildSceneCards(order),
    ...chapter,
  };
}

test("runFromReady expands to next prepared window when batch roll is enabled", async () => {
  const calls = [];
  const completed = new Set();
  const runtime = new NovelDirectorAutoExecutionRuntime({
    novelContextService: {
      async listChapters() {
        return [1, 2].map((order) => (
          completed.has(order)
            ? withExecutionDetail({
              id: `chapter-${order}`,
              order,
              generationState: "approved",
              chapterStatus: "completed",
              content: `正文${order}`,
            })
            : withExecutionDetail({
              id: `chapter-${order}`,
              order,
              generationState: "planned",
              chapterStatus: "unplanned",
              content: "",
            })
        ));
      },
    },
    novelService: {
      async startPipelineJob(_novelId, options) {
        calls.push(["startPipelineJob", options.startOrder, options.endOrder]);
        return { id: `job-${options.startOrder}`, status: "queued" };
      },
      async findActivePipelineJobForRange() {
        return null;
      },
      async getPipelineJobById(jobId) {
        const order = Number(String(jobId).replace("job-", ""));
        completed.add(order);
        return {
          id: jobId,
          status: "succeeded",
          progress: 1,
          startOrder: order,
          endOrder: order,
          noticeSummary: null,
          error: null,
        };
      },
      async cancelPipelineJob() {},
      async resumePipelineJob() {},
    },
    workflowService: {
      async bootstrapTask() {},
      async getTaskById() {
        return { status: "running" };
      },
      async markTaskRunning() {
        calls.push(["markTaskRunning"]);
      },
      async recordCheckpoint(_taskId, input) {
        calls.push(["recordCheckpoint", input.checkpointType, input.seedPayload?.autoExecution?.startOrder, input.seedPayload?.autoExecution?.endOrder]);
      },
      async markTaskFailed(_taskId, message) {
        calls.push(["markTaskFailed", message]);
      },
    },
    buildDirectorSeedPayload(_request, _novelId, extra) {
      return extra ?? {};
    },
    enableBatchRoll: true,
    resolveBatchRoll: async ({ range, consecutiveBatchRolls }) => {
      calls.push(["resolveBatchRoll", range.startOrder, range.endOrder, consecutiveBatchRolls]);
      if (range.endOrder < 2) {
        return {
          kind: "expand_range",
          reason: "next window ready",
          nextRange: { startOrder: 2, endOrder: 2 },
        };
      }
      return { kind: "completed_scope", reason: "done" };
    },
  });

  await runtime.runFromReady({
    taskId: "task-batch-roll",
    novelId: "novel-1",
    request: {
      idea: "x",
      candidate: {
        id: "c1",
        workingTitle: "t",
        titleOptions: [],
        logline: "l",
        positioning: "p",
        sellingPoint: "s",
        coreConflict: "c",
        protagonistPath: "p",
        endingDirection: "e",
        hookStrategy: "h",
        progressionLoop: "p",
        whyItFits: "w",
        toneKeywords: [],
        targetChapterCount: 10,
      },
      runMode: "auto_to_execution",
    },
    existingState: {
      enabled: true,
      mode: "chapter_range",
      firstChapterId: "chapter-1",
      startOrder: 1,
      endOrder: 1,
      totalChapterCount: 1,
      pipelineJobId: null,
      pipelineStatus: null,
      autoReview: true,
      autoRepair: true,
    },
  });

  const starts = calls.filter((c) => c[0] === "startPipelineJob").map((c) => c.slice(1));
  assert.deepEqual(starts, [[1, 1], [2, 2]]);
  assert.ok(calls.some((c) => c[0] === "resolveBatchRoll" && c[1] === 1 && c[2] === 1));
  assert.ok(calls.some((c) => c[0] === "recordCheckpoint" && c[1] === "workflow_completed"));
  assert.equal(calls.some((c) => c[0] === "markTaskFailed"), false);
});

test("runFromReady without resolveBatchRoll keeps legacy workflow_completed on empty remaining", async () => {
  const calls = [];
  const runtime = new NovelDirectorAutoExecutionRuntime({
    novelContextService: {
      async listChapters() {
        return [withExecutionDetail({
          id: "chapter-1",
          order: 1,
          generationState: "approved",
          chapterStatus: "completed",
          content: "done",
        })];
      },
    },
    novelService: {
      async startPipelineJob() {
        calls.push(["startPipelineJob"]);
        return { id: "job", status: "queued" };
      },
      async findActivePipelineJobForRange() { return null; },
      async getPipelineJobById() { return null; },
      async cancelPipelineJob() {},
      async resumePipelineJob() {},
    },
    workflowService: {
      async bootstrapTask() {},
      async getTaskById() { return { status: "running" }; },
      async markTaskRunning() {},
      async recordCheckpoint(_id, input) {
        calls.push(["recordCheckpoint", input.checkpointType]);
      },
      async markTaskFailed() {
        calls.push(["markTaskFailed"]);
      },
    },
    buildDirectorSeedPayload(_r, _n, extra) { return extra ?? {}; },
  });

  await runtime.runFromReady({
    taskId: "task-legacy",
    novelId: "novel-1",
    request: {
      idea: "x",
      candidate: {
        id: "c1", workingTitle: "t", titleOptions: [], logline: "l", positioning: "p",
        sellingPoint: "s", coreConflict: "c", protagonistPath: "p", endingDirection: "e",
        hookStrategy: "h", progressionLoop: "p", whyItFits: "w", toneKeywords: [], targetChapterCount: 10,
      },
      runMode: "auto_to_execution",
    },
    existingState: {
      enabled: true,
      mode: "chapter_range",
      startOrder: 1,
      endOrder: 1,
      totalChapterCount: 1,
      firstChapterId: "chapter-1",
      autoReview: true,
      autoRepair: true,
    },
  });

  assert.equal(calls.some((c) => c[0] === "startPipelineJob"), false);
  assert.ok(calls.some((c) => c[0] === "recordCheckpoint" && c[1] === "workflow_completed"));
});

function buildMinimalRequest(overrides = {}) {
  return {
    idea: "x",
    candidate: {
      id: "c1",
      workingTitle: "t",
      titleOptions: [],
      logline: "l",
      positioning: "p",
      sellingPoint: "s",
      coreConflict: "c",
      protagonistPath: "p",
      endingDirection: "e",
      hookStrategy: "h",
      progressionLoop: "p",
      whyItFits: "w",
      toneKeywords: [],
      targetChapterCount: 10,
    },
    runMode: "auto_to_execution",
    ...overrides,
  };
}

test("runFromReady reenter prepares next window then continues loop", async () => {
  const calls = [];
  const completed = new Set([1]);
  const runtime = new NovelDirectorAutoExecutionRuntime({
    novelContextService: {
      async listChapters() {
        return [1, 2].map((order) => (
          completed.has(order)
            ? withExecutionDetail({
              id: `chapter-${order}`,
              order,
              generationState: "approved",
              chapterStatus: "completed",
              content: `正文${order}`,
            })
            : withExecutionDetail({
              id: `chapter-${order}`,
              order,
              generationState: "planned",
              chapterStatus: "unplanned",
              content: "",
            })
        ));
      },
    },
    novelService: {
      async startPipelineJob(_novelId, options) {
        calls.push(["startPipelineJob", options.startOrder, options.endOrder]);
        return { id: `job-${options.startOrder}`, status: "queued" };
      },
      async findActivePipelineJobForRange() {
        return null;
      },
      async getPipelineJobById(jobId) {
        const order = Number(String(jobId).replace("job-", ""));
        completed.add(order);
        return {
          id: jobId,
          status: "succeeded",
          progress: 1,
          startOrder: order,
          endOrder: order,
          noticeSummary: null,
          error: null,
        };
      },
      async cancelPipelineJob() {},
      async resumePipelineJob() {},
    },
    workflowService: {
      async bootstrapTask() {},
      async getTaskById() {
        return { status: "running" };
      },
      async markTaskRunning() {
        calls.push(["markTaskRunning"]);
      },
      async recordCheckpoint(_taskId, input) {
        calls.push([
          "recordCheckpoint",
          input.checkpointType,
          input.seedPayload?.autoExecution?.startOrder,
          input.seedPayload?.autoExecution?.endOrder,
        ]);
      },
      async markTaskFailed(_taskId, message) {
        calls.push(["markTaskFailed", message]);
      },
    },
    buildDirectorSeedPayload(_request, _novelId, extra) {
      return extra ?? {};
    },
    enableBatchRoll: true,
    canPrepareNextBatch: true,
    resolveBatchRoll: async ({ range, consecutiveBatchRolls }) => {
      calls.push(["resolveBatchRoll", range.startOrder, range.endOrder, consecutiveBatchRolls]);
      if (range.endOrder < 2) {
        return {
          kind: "reenter_structured_outline",
          reason: "next window needs prepare",
          nextRange: { startOrder: 2, endOrder: 2 },
        };
      }
      return { kind: "completed_scope", reason: "done" };
    },
    prepareNextAutoExecutionBatch: async (input) => {
      calls.push([
        "prepareNextAutoExecutionBatch",
        input.decision.kind,
        input.decision.nextRange?.startOrder,
        input.decision.nextRange?.endOrder,
        input.request?.runMode ?? null,
        input.previousState?.startOrder ?? null,
      ]);
      assert.equal(input.decision.kind, "reenter_structured_outline");
      assert.equal(input.request?.runMode, "auto_to_execution");
      return {
        range: {
          startOrder: 2,
          endOrder: 2,
          totalChapterCount: 1,
          firstChapterId: "chapter-2",
        },
        autoExecution: {
          enabled: true,
          mode: "chapter_range",
          firstChapterId: "chapter-2",
          startOrder: 2,
          endOrder: 2,
          totalChapterCount: 1,
          pipelineJobId: null,
          pipelineStatus: "queued",
          autoReview: true,
          autoRepair: true,
          skippedChapterIds: input.previousState?.skippedChapterIds ?? [],
          skippedChapterOrders: input.previousState?.skippedChapterOrders ?? [],
        },
      };
    },
  });

  await runtime.runFromReady({
    taskId: "task-reenter-prepare",
    novelId: "novel-1",
    request: buildMinimalRequest(),
    existingState: {
      enabled: true,
      mode: "chapter_range",
      firstChapterId: "chapter-1",
      startOrder: 1,
      endOrder: 1,
      totalChapterCount: 1,
      pipelineJobId: null,
      pipelineStatus: null,
      autoReview: true,
      autoRepair: true,
      skippedChapterIds: ["chapter-skip"],
      skippedChapterOrders: [99],
    },
  });

  assert.ok(calls.some((c) => (
    c[0] === "prepareNextAutoExecutionBatch"
    && c[1] === "reenter_structured_outline"
    && c[2] === 2
    && c[3] === 2
    && c[4] === "auto_to_execution"
  )));
  const starts = calls.filter((c) => c[0] === "startPipelineJob").map((c) => c.slice(1));
  assert.deepEqual(starts, [[2, 2]]);
  assert.ok(calls.some((c) => c[0] === "recordCheckpoint" && c[1] === "workflow_completed"));
  assert.equal(calls.some((c) => c[0] === "markTaskFailed"), false);
});

test("runFromReady reenter without prepare port fails and does not expand", async () => {
  const calls = [];
  const runtime = new NovelDirectorAutoExecutionRuntime({
    novelContextService: {
      async listChapters() {
        return [withExecutionDetail({
          id: "chapter-1",
          order: 1,
          generationState: "approved",
          chapterStatus: "completed",
          content: "done",
        })];
      },
    },
    novelService: {
      async startPipelineJob() {
        calls.push(["startPipelineJob"]);
        return { id: "job", status: "queued" };
      },
      async findActivePipelineJobForRange() { return null; },
      async getPipelineJobById() { return null; },
      async cancelPipelineJob() {},
      async resumePipelineJob() {},
    },
    workflowService: {
      async bootstrapTask() {},
      async getTaskById() { return { status: "running" }; },
      async markTaskRunning() {},
      async recordCheckpoint(_id, input) {
        calls.push(["recordCheckpoint", input.checkpointType]);
      },
      async markTaskFailed(_taskId, message) {
        calls.push(["markTaskFailed", String(message)]);
      },
    },
    buildDirectorSeedPayload(_r, _n, extra) { return extra ?? {}; },
    enableBatchRoll: true,
    canPrepareNextBatch: true,
    resolveBatchRoll: async () => ({
      kind: "reenter_structured_outline",
      reason: "need prepare but port missing",
      nextRange: { startOrder: 2, endOrder: 2 },
    }),
    // intentionally omit prepareNextAutoExecutionBatch
  });

  await runtime.runFromReady({
    taskId: "task-reenter-no-prepare",
    novelId: "novel-1",
    request: buildMinimalRequest(),
    existingState: {
      enabled: true,
      mode: "chapter_range",
      startOrder: 1,
      endOrder: 1,
      totalChapterCount: 1,
      firstChapterId: "chapter-1",
      autoReview: true,
      autoRepair: true,
    },
  });

  assert.equal(calls.some((c) => c[0] === "startPipelineJob"), false);
  assert.ok(calls.some((c) => c[0] === "markTaskFailed" && /prepareNextAutoExecutionBatch/.test(c[1])));
  assert.equal(calls.some((c) => c[0] === "recordCheckpoint" && c[1] === "workflow_completed"), false);
});
