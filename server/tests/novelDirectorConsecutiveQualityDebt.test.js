const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NovelDirectorAutoExecutionRuntime,
} = require(
  "../dist/services/novel/director/automation/novelDirectorAutoExecutionRuntime.js"
);
const { prisma } = require("../dist/db/prisma.js");
const {
  advanceAutoExecutionProgressGuard,
  didAutoExecutionAdvance,
} = require(
  "../dist/services/novel/director/automation/domain/AutoExecutionProgressPolicy.js"
);

function buildRequest() {
  return {
    idea: "一个普通人被卷入命运迷局",
    candidate: {
      id: "candidate-1",
      workingTitle: "命运谜局",
      titleOptions: [],
      logline: "一个普通人误入更大的秘密链条。",
      positioning: "都市悬疑成长",
      sellingPoint: "强钩子与高压追更感",
      coreConflict: "主角必须在真相与自保之间抉择",
      protagonistPath: "从被动卷入到主动破局",
      endingDirection: "主角以代价换来新秩序",
      hookStrategy: "用反常事件做开局钩子",
      progressionLoop: "调查推进、反噬升级、关系重组",
      whyItFits: "适合自动导演快速启动",
      toneKeywords: ["悬疑", "压迫感"],
      targetChapterCount: 7,
    },
    runMode: "full_book_autopilot",
  };
}

function sceneCards(order) {
  return JSON.stringify({
    targetWordCount: 2800,
    lengthBudget: {
      targetWordCount: 2800,
      softMinWordCount: 2380,
      softMaxWordCount: 3220,
      hardMaxWordCount: 3500,
    },
    scenes: [{
      key: `chapter-${order}-scene-1`,
      title: "推进",
      purpose: "推进本章目标",
      mustAdvance: ["主线"],
      mustPreserve: ["人物动机"],
      entryState: "进入冲突",
      exitState: "压力升级",
      forbiddenExpansion: [],
      targetWordCount: 2800,
    }],
  });
}

function chapter(order, patch = {}) {
  return {
    id: `chapter-${order}`,
    order,
    title: `第${order}章`,
    purpose: `第${order}章目标`,
    exclusiveEvent: `第${order}章独占事件`,
    endingState: `第${order}章结尾状态`,
    nextChapterEntryState: `第${order + 1}章入场状态`,
    conflictLevel: 5,
    revealLevel: 3,
    targetWordCount: 2800,
    mustAvoid: "不要展开无关支线",
    taskSheet: `第${order}章任务单`,
    sceneCards: sceneCards(order),
    content: "",
    generationState: "planned",
    chapterStatus: "unplanned",
    riskFlags: null,
    ...patch,
  };
}

test("six advancing defer-and-continue chapters do not fail the full-book run", async () => {
  const calls = [];
  const deferFlags = JSON.stringify({
    qualityLoop: {
      overallStatus: "invalid",
      recommendedAction: "patch_repair",
      rootCauseCode: "draft_obligation_unmet",
      terminalAction: "defer_and_continue",
      signals: [{
        artifactType: "prose_quality",
        status: "invalid",
        issueCodes: ["prose_system_hud"],
      }],
    },
  });
  let finalChapterCompleted = false;
  let currentOrder = 1;
  let exposeCurrentDebt = false;
  const workflowUpdatedAt = new Date("2026-08-10T00:00:00.000Z");
  const workflowOwnershipRow = (taskId = "task-quality-debt") => ({
    id: taskId,
    attemptCount: 0,
    updatedAt: workflowUpdatedAt,
  });
  const originalUsageFindMany = prisma.directorLlmUsageRecord.findMany;
  prisma.directorLlmUsageRecord.findMany = async () => [];

  const runtime = new NovelDirectorAutoExecutionRuntime({
    novelContextService: {
      async listChapters() {
        return Array.from({ length: 7 }, (_, index) => {
          const order = index + 1;
          if (order === 7 && finalChapterCompleted) {
            return chapter(order, {
              content: "第7章正文",
              generationState: "approved",
              chapterStatus: "completed",
            });
          }
          if (order < currentOrder || (order === currentOrder && exposeCurrentDebt)) {
            return chapter(order, {
              content: `第${order}章可用正文`,
              generationState: "reviewed",
              chapterStatus: "pending_review",
              riskFlags: deferFlags,
            });
          }
          return chapter(order);
        });
      },
    },
    novelService: {
      async startPipelineJob(_novelId, options) {
        calls.push(["startPipelineJob", options.startOrder, options.endOrder]);
        if (options.startOrder <= 6) {
          currentOrder = options.startOrder;
          exposeCurrentDebt = true;
          throw new Error("指定区间内没有可生成的章节。当前可用章节范围为第 1 章到第 7 章。");
        }
        return { id: "job-7", status: "queued" };
      },
      async findActivePipelineJobForRange() {
        return null;
      },
      async getPipelineJobById(jobId) {
        finalChapterCompleted = true;
        calls.push(["getPipelineJobById", jobId]);
        return {
          id: jobId,
          status: "succeeded",
          progress: 1,
          currentStage: null,
          currentItemLabel: null,
          noticeSummary: null,
          error: null,
        };
      },
      async resumePipelineJob() {},
      async cancelPipelineJob() {},
    },
    workflowService: {
      async bootstrapTask(input) {
        const nextOrder = input.seedPayload.autoExecution?.nextChapterOrder ?? null;
        if (typeof nextOrder === "number" && nextOrder > currentOrder) {
          currentOrder = nextOrder;
          exposeCurrentDebt = false;
        }
        calls.push([
          "bootstrapTask",
          nextOrder,
          input.seedPayload.autoExecution?.skippedChapterOrders ?? [],
        ]);
        return workflowOwnershipRow(input.workflowTaskId);
      },
      async getTaskByIdWithoutHealing() {
        return { status: "running", ...workflowOwnershipRow() };
      },
      async markTaskRunning(taskId) {
        return workflowOwnershipRow(taskId);
      },
      async recordCheckpoint(_taskId, input) {
        calls.push(["recordCheckpoint", input.checkpointType]);
        return workflowOwnershipRow(_taskId);
      },
      async markTaskFailed(_taskId, message) {
        calls.push(["markTaskFailed", message]);
        return workflowOwnershipRow(_taskId);
      },
    },
    buildDirectorSeedPayload(_request, _novelId, extra) {
      return extra ?? {};
    },
  });

  try {
    await runtime.runFromReady({
      taskId: "task-quality-debt",
      novelId: "novel-1",
      request: buildRequest(),
      existingState: {
        enabled: true,
        mode: "chapter_range",
        autoReview: true,
        autoRepair: true,
        firstChapterId: "chapter-1",
        startOrder: 1,
        endOrder: 7,
        totalChapterCount: 7,
        nextChapterId: "chapter-1",
        nextChapterOrder: 1,
        remainingChapterCount: 7,
        pipelineJobId: null,
        pipelineStatus: null,
      },
    });
  } finally {
    prisma.directorLlmUsageRecord.findMany = originalUsageFindMany;
  }

  assert.equal(calls.some((call) => call[0] === "markTaskFailed"), false);
  assert.deepEqual(
    calls.filter((call) => call[0] === "startPipelineJob").map((call) => call.slice(1)),
    [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]],
  );
  assert.ok(calls.some((call) => call[0] === "recordCheckpoint" && call[1] === "workflow_completed"));
  const latestSkipped = calls
    .filter((call) => call[0] === "bootstrapTask")
    .map((call) => call[2])
    .findLast((orders) => Array.isArray(orders) && orders.length >= 6);
  assert.deepEqual(latestSkipped, [1, 2, 3, 4, 5, 6]);
});

test("unchanged auto-execution cursor triggers the no-progress safety guard", () => {
  const cursor = {
    nextChapterId: "chapter-3",
    nextChapterOrder: 3,
    remainingChapterCount: 5,
  };
  assert.equal(didAutoExecutionAdvance(cursor, cursor), false);

  let guard = { consecutiveNoProgress: 0, shouldStop: false };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    guard = advanceAutoExecutionProgressGuard({
      previous: guard,
      before: cursor,
      after: { ...cursor },
      maxConsecutiveNoProgress: 3,
    });
  }
  assert.deepEqual(guard, {
    consecutiveNoProgress: 3,
    shouldStop: true,
  });

  assert.equal(didAutoExecutionAdvance(cursor, {
    nextChapterId: "chapter-4",
    nextChapterOrder: 4,
    remainingChapterCount: 4,
  }), true);
});
