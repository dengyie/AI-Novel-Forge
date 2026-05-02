const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma");
const {
  loadPersistentDirectorRuntimeProjection,
} = require("../dist/services/novel/director/novelDirectorRuntimeProjection.js");
const {
  directorUsageTelemetryQueryService,
} = require("../dist/services/novel/director/runtime/DirectorUsageTelemetryQueryService.js");

function buildRun() {
  return {
    id: "task-1",
    novelId: null,
    entrypoint: "candidate_generation",
    policyJson: JSON.stringify({
      mode: "run_until_gate",
      mayOverwriteUserContent: false,
      maxAutoRepairAttempts: 1,
      allowExpensiveReview: false,
      modelTier: "balanced",
      updatedAt: "2026-05-02T00:00:00.000Z",
    }),
    lastWorkspaceAnalysisJson: null,
    updatedAt: new Date("2026-05-02T15:18:33.000Z"),
    steps: [{
      idempotencyKey: "task-1:candidate_generation:global:global",
      nodeKey: "candidate_generation",
      label: "生成书级候选",
      status: "succeeded",
      targetType: "global",
      targetId: "global",
      startedAt: new Date("2026-05-02T15:17:33.000Z"),
      finishedAt: new Date("2026-05-02T15:18:33.000Z"),
      error: null,
      policyDecisionJson: null,
    }],
    events: [{
      id: "event-1",
      type: "node_completed",
      taskId: "task-1",
      novelId: null,
      nodeKey: "candidate_generation",
      artifactId: null,
      artifactType: null,
      summary: "生成书级候选完成。",
      affectedScope: null,
      severity: null,
      occurredAt: new Date("2026-05-02T15:18:33.000Z"),
      metadataJson: null,
    }],
  };
}

function mockProjectionData(command) {
  const originals = {
    runFindUnique: prisma.directorRun.findUnique,
    commandFindFirst: prisma.directorRunCommand.findFirst,
    getTaskUsage: directorUsageTelemetryQueryService.getTaskUsage,
  };
  prisma.directorRun.findUnique = async ({ where }) => {
    assert.equal(where.taskId, "task-1");
    return buildRun();
  };
  prisma.directorRunCommand.findFirst = async ({ where }) => {
    assert.equal(where.taskId, "task-1");
    assert.deepEqual(where.status.in, ["queued", "leased", "running"]);
    return command;
  };
  directorUsageTelemetryQueryService.getTaskUsage = async (taskId) => {
    assert.equal(taskId, "task-1");
    return {
      summary: null,
      recentUsage: [],
      stepUsage: [],
      promptUsage: [],
    };
  };
  return () => {
    prisma.directorRun.findUnique = originals.runFindUnique;
    prisma.directorRunCommand.findFirst = originals.commandFindFirst;
    directorUsageTelemetryQueryService.getTaskUsage = originals.getTaskUsage;
  };
}

test("runtime projection shows queued candidate confirmation after direction selection", async () => {
  const restore = mockProjectionData({
    id: "command-1",
    commandType: "confirm_candidate",
    status: "queued",
    updatedAt: new Date("2026-05-02T15:18:39.000Z"),
  });
  try {
    const projection = await loadPersistentDirectorRuntimeProjection("task-1");

    assert.equal(projection.status, "running");
    assert.equal(projection.requiresUserAction, false);
    assert.equal(projection.headline, "AI 正在处理书级方向");
    assert.equal(projection.currentLabel, "书级方向提交完成，等待 AI 创建小说项目。");
    assert.equal(projection.detail, "后台执行器接手后，会创建小说并继续后续流程。");
  } finally {
    restore();
  }
});

