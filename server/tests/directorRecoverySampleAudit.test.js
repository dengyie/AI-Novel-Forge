const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  buildDirectorRecoverySampleAudit,
} = require("../dist/services/novel/director/directorRecoverySampleAudit.js");

function hash(value) {
  return crypto.createHash("sha256").update(value.trim()).digest("hex");
}

test("director recovery sample audit classifies real-data recovery fixtures", () => {
  const audit = buildDirectorRecoverySampleAudit({
    tasks: [
      {
        id: "task-takeover-recovery",
        novelId: "novel-1",
        status: "running",
        pendingManualRecovery: true,
        currentStage: "AI 自动导演",
        currentItemKey: "takeover",
        currentItemLabel: "自动导演接管任务已提交",
        seedPayloadJson: "{}",
        resumeTargetJson: JSON.stringify({ stage: "basic" }),
        lastError: "missing context",
        updatedAt: "2026-04-29T00:00:00.000Z",
      },
      {
        id: "task-front10",
        novelId: "novel-2",
        status: "waiting_approval",
        pendingManualRecovery: false,
        checkpointType: "front10_ready",
        currentStage: "chapter_execution",
        currentItemKey: "chapter_execution",
        currentItemLabel: "waiting",
        seedPayloadJson: JSON.stringify({
          directorInput: { runMode: "auto_to_execution" },
          directorSession: { phase: "front10_ready" },
          autoExecution: { mode: "front10", nextChapterOrder: 1 },
        }),
        resumeTargetJson: JSON.stringify({ stage: "chapter" }),
        updatedAt: "2026-04-29T00:01:00.000Z",
      },
    ],
    commands: [
      {
        id: "cmd-1",
        taskId: "task-takeover-recovery",
        novelId: "novel-1",
        commandType: "takeover",
        status: "failed",
        payloadJson: JSON.stringify({
          takeoverRequest: {
            novelId: "novel-1",
            entryStep: "structured",
          },
        }),
        updatedAt: "2026-04-29T00:02:00.000Z",
      },
    ],
    jobs: [
      {
        id: "job-1",
        novelId: "novel-2",
        status: "failed",
        currentStage: "generating_chapters",
        currentItemLabel: "chapter 1",
        startOrder: 1,
        endOrder: 10,
        completedCount: 7,
        totalCount: 10,
        updatedAt: "2026-04-29T00:03:00.000Z",
      },
    ],
    artifacts: [
      {
        id: "chapter_draft:chapter:chapter-1:Chapter:chapter-1",
        novelId: "novel-2",
        artifactType: "chapter_draft",
        targetType: "chapter",
        targetId: "chapter-1",
        version: 1,
        status: "active",
        source: "user_edited",
        contentTable: "Chapter",
        contentId: "chapter-1",
        contentHash: hash("old chapter content"),
        protectedUserContent: true,
        updatedAt: "2026-04-29T00:04:00.000Z",
      },
    ],
    chapters: [
      {
        id: "chapter-1",
        novelId: "novel-2",
        order: 1,
        title: "Chapter 1",
        content: "new chapter content",
        updatedAt: "2026-04-29T00:05:00.000Z",
      },
    ],
    draftChapters: [
      {
        id: "chapter-1",
        novelId: "novel-2",
        order: 1,
        title: "Chapter 1",
        content: "new chapter content",
        updatedAt: "2026-04-29T00:05:00.000Z",
      },
      {
        id: "chapter-2",
        novelId: "novel-2",
        order: 2,
        title: "Chapter 2",
        content: "draft without ledger baseline",
        updatedAt: "2026-04-29T00:06:00.000Z",
      },
    ],
  });

  assert.equal(audit.counts.autoDirectorTasks, 2);
  assert.equal(audit.counts.takeoverCommands, 1);
  assert.equal(audit.counts.recoveryTasks, 1);
  assert.equal(audit.counts.chapterBatchTasks, 1);
  assert.equal(audit.counts.waitingTasks, 1);
  assert.equal(audit.counts.contextlessTakeoverRecoveryTasks, 1);
  assert.equal(audit.counts.manualEditCandidates, 1);
  assert.equal(audit.counts.manualEditHashChanged, 1);
  assert.equal(audit.counts.draftBaselineArtifacts, 1);
  assert.equal(audit.counts.untrackedDraftChapters, 1);
  assert.equal(audit.samples.recoveryTasks[0].id, "task-takeover-recovery");
  assert.equal(audit.samples.contextlessTakeoverRecoveryTasks[0].id, "task-takeover-recovery");
  assert.equal(audit.samples.chapterBatchTasks[0].runMode, "auto_to_execution");
  assert.equal(audit.samples.manualEditCandidates[0].hashChanged, true);
  assert.equal(audit.samples.untrackedDraftChapters[0].chapterId, "chapter-2");
});

test("director recovery sample audit checks draft baselines separately from protected artifacts", () => {
  const audit = buildDirectorRecoverySampleAudit({
    tasks: [],
    commands: [],
    jobs: [],
    artifacts: [],
    chapters: [],
    draftBaselineArtifacts: [
      {
        id: "chapter_draft:chapter:chapter-1:Chapter:chapter-1",
        novelId: "novel-2",
        artifactType: "chapter_draft",
        targetType: "chapter",
        targetId: "chapter-1",
        version: 1,
        status: "active",
        source: "inventory_backfill",
        contentTable: "Chapter",
        contentId: "chapter-1",
        contentHash: hash("chapter with ordinary ledger baseline"),
        protectedUserContent: false,
        updatedAt: "2026-04-29T00:04:00.000Z",
      },
    ],
    draftChapters: [
      {
        id: "chapter-1",
        novelId: "novel-2",
        order: 1,
        title: "Chapter 1",
        content: "chapter with ordinary ledger baseline",
        updatedAt: "2026-04-29T00:05:00.000Z",
      },
      {
        id: "chapter-2",
        novelId: "novel-2",
        order: 2,
        title: "Chapter 2",
        content: "draft without ledger baseline",
        updatedAt: "2026-04-29T00:06:00.000Z",
      },
    ],
  });

  assert.equal(audit.counts.protectedOrStaleArtifacts, 0);
  assert.equal(audit.counts.draftBaselineArtifacts, 1);
  assert.equal(audit.counts.untrackedDraftChapters, 1);
  assert.equal(audit.samples.untrackedDraftChapters[0].chapterId, "chapter-2");
});
