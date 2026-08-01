const test = require("node:test");
const assert = require("node:assert/strict");

const { TaskCenterService } = require("../dist/services/task/TaskCenterService.js");
const {
  compareTaskSummary,
  isAfterCursor,
  parseCursor,
  toCursor,
} = require("../dist/services/task/taskCenter.shared.js");
const { AgentRunTaskAdapter } = require("../dist/services/task/adapters/AgentRunTaskAdapter.js");
const { prisma } = require("../dist/db/prisma.js");

function summary(kind, id, status = "succeeded") {
  return {
    id,
    kind,
    title: `${kind}-${id}`,
    status,
    progress: status === "succeeded" ? 1 : 0.5,
    currentStage: null,
    currentItemLabel: null,
    attemptCount: 0,
    maxAttempts: 0,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: null,
    ownerId: id,
    ownerLabel: id,
    sourceRoute: "/tasks",
    sourceResource: { type: "task", id, label: id, route: "/tasks" },
    targetResources: [],
  };
}

function fakeAdapter(items) {
  const ordered = [...items].sort(compareTaskSummary);
  return {
    async list(input) {
      let visible = ordered;
      if (input.status) {
        visible = visible.filter((item) => item.status === input.status);
      }
      if (input.cursor) {
        visible = visible.filter((item) => isAfterCursor(item, input.cursor));
      }
      const page = visible.slice(0, input.take);
      return {
        items: page,
        hasMore: visible.length > page.length,
        exhausted: visible.length <= page.length,
      };
    },
  };
}

function installEmptyAdapters(service) {
  const empty = fakeAdapter([]);
  service.pipelineAdapter = empty;
  service.knowledgeAdapter = empty;
  service.imageAdapter = empty;
  service.agentAdapter = empty;
  service.workflowAdapter = empty;
  service.styleExtractionAdapter = empty;
  service.audiobookAdapter = empty;
}

test("TaskCenter pagination traverses a source beyond the legacy fixed window", async () => {
  const service = new TaskCenterService();
  const tasks = Array.from({ length: 130 }, (_, index) =>
    summary("book_analysis", `book-${String(index + 1).padStart(3, "0")}`));
  service.bookAdapter = fakeAdapter(tasks);
  installEmptyAdapters(service);

  const seen = new Set();
  let cursor;
  let pageCount = 0;
  do {
    const page = await service.listTasks({ kind: "book_analysis", limit: 10, cursor });
    pageCount += 1;
    for (const item of page.items) {
      assert.equal(seen.has(item.id), false, `duplicate task ${item.id}`);
      seen.add(item.id);
    }
    cursor = page.nextCursor || undefined;
  } while (cursor);

  assert.equal(pageCount, 13);
  assert.equal(seen.size, tasks.length);
});

test("TaskCenter keeps the public cursor moving when a linked pipeline row is hidden", async () => {
  const service = new TaskCenterService();
  const workflow = summary("novel_workflow", "workflow-1", "running");
  workflow.targetResources = [{ type: "generation_job", id: "pipeline-1" }];
  service.workflowAdapter = fakeAdapter([workflow]);
  service.pipelineAdapter = fakeAdapter([
    summary("novel_pipeline", "pipeline-1", "running"),
    summary("novel_pipeline", "pipeline-2", "running"),
  ]);
  service.bookAdapter = fakeAdapter([]);
  service.knowledgeAdapter = fakeAdapter([]);
  service.imageAdapter = fakeAdapter([]);
  service.agentAdapter = fakeAdapter([]);
  service.styleExtractionAdapter = fakeAdapter([]);
  service.audiobookAdapter = fakeAdapter([]);

  const first = await service.listTasks({ limit: 1 });
  assert.deepEqual(first.items.map((item) => item.id), ["workflow-1"]);
  assert.ok(first.nextCursor);

  const second = await service.listTasks({ limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.id), ["pipeline-2"]);
});

test("agent adapter paginates mixed statuses in canonical order without dropping lower-rank tasks", async () => {
  const originalFindMany = prisma.agentRun.findMany;
  const originalArchiveFindMany = prisma.taskCenterArchive.findMany;
  let activeCursor;
  const rows = [
    {
      id: "agent-succeeded",
      novelId: null,
      chapterId: null,
      goal: "succeeded",
      status: "succeeded",
      currentStep: null,
      error: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:04:00.000Z"),
      steps: [],
    },
    {
      id: "agent-cancelled",
      novelId: null,
      chapterId: null,
      goal: "cancelled",
      status: "cancelled",
      currentStep: null,
      error: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:03:00.000Z"),
      steps: [],
    },
    {
      id: "agent-queued",
      novelId: null,
      chapterId: null,
      goal: "queued",
      status: "queued",
      currentStep: null,
      error: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:02:00.000Z"),
      steps: [],
    },
    {
      id: "agent-running",
      novelId: null,
      chapterId: null,
      goal: "running",
      status: "running",
      currentStep: null,
      error: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
      steps: [],
    },
  ];
  const rowSummary = (row) => ({
    ...summary("agent_run", row.id, row.status),
    updatedAt: row.updatedAt.toISOString(),
  });

  prisma.taskCenterArchive.findMany = async () => [];
  prisma.agentRun.findMany = async ({ where, take }) => {
    const visible = rows
      .filter((row) => !where.status || row.status === where.status)
      .filter((row) => !activeCursor || isAfterCursor(rowSummary(row), activeCursor))
      .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
    return visible.slice(0, take);
  };

  try {
    const adapter = new AgentRunTaskAdapter();
    const first = await adapter.list({ take: 2 });
    assert.deepEqual(first.items.map((item) => item.id), ["agent-running", "agent-queued"]);
    assert.equal(first.hasMore, true);

    activeCursor = parseCursor(toCursor(first.items.at(-1)));
    const second = await adapter.list({ take: 2, cursor: activeCursor });
    assert.deepEqual(second.items.map((item) => item.id), ["agent-cancelled", "agent-succeeded"]);
    assert.equal(second.hasMore, false);
  } finally {
    prisma.agentRun.findMany = originalFindMany;
    prisma.taskCenterArchive.findMany = originalArchiveFindMany;
  }
});

test("TaskCenter rejects malformed cursors instead of silently returning page one", async () => {
  const service = new TaskCenterService();
  await assert.rejects(
    () => service.listTasks({ cursor: "not-base64-json" }),
    (error) => error?.statusCode === 400,
  );

  const valid = parseCursor(toCursor(summary("book_analysis", "book-1")));
  assert.equal(valid?.id, "book-1");
});
