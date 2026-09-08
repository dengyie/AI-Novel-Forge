const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { AudiobookTaskService } = require("../dist/services/audiobook/AudiobookTaskService.js");

test("startup audiobook recovery reads tasks in bounded pages", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originalFindMany = prisma.audiobookTask.findMany;
  const queries = [];
  prisma.audiobookTask.findMany = async (query) => {
    queries.push(query);
    return [];
  };
  try {
    await service.resumePendingTasks();
  } finally {
    prisma.audiobookTask.findMany = originalFindMany;
  }

  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.equal(query.take, 100, "recovery must cap each database page");
    assert.deepEqual(query.orderBy, { id: "asc" }, "pagination must use a stable unique order");
    assert.equal(query.cursor, undefined);
  }
  assert.equal(queries[0].select.resultJson, undefined, "active scan must not load historical resultJson");
  assert.equal(queries[1].select.resultJson, true, "succeeded scan must inspect the m4b marker");
  assert.deepEqual(
    queries[1].where.resultJson,
    { contains: "encoding" },
    "succeeded scan must let the database discard rows without an encoding marker",
  );
});

test("startup audiobook recovery advances with the last task cursor", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originalFindMany = prisma.audiobookTask.findMany;
  const queries = [];
  prisma.audiobookTask.findMany = async (query) => {
    queries.push(query);
    if (query.cursor || query.where.status.in) return [];
    return Array.from({ length: 100 }, (_, index) => ({
      id: `task-${String(index).padStart(3, "0")}`,
      novelId: "novel-1",
      title: "历史任务",
      chapterIdsJson: "[]",
      status: "succeeded",
      resultJson: null,
      outputDir: null,
      progress: 100,
      progressJson: null,
      currentStage: "done",
      cancelRequestedAt: null,
      m4bGenerationToken: "generation-1",
    }));
  };
  try {
    await service.resumePendingTasks();
  } finally {
    prisma.audiobookTask.findMany = originalFindMany;
  }

  assert.equal(queries.length, 3);
  assert.deepEqual(queries[2].cursor, { id: "task-099" });
  assert.equal(queries[2].skip, 1);
  assert.equal(queries[2].take, 100);
});

test("continuing-parent recovery checks live children beyond the first page", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originalFindMany = prisma.audiobookTask.findMany;
  const queries = [];
  prisma.audiobookTask.findMany = async (query) => {
    queries.push(query);
    if (query.cursor) {
      return [{ id: "child-late", progressJson: JSON.stringify({ parentTaskId: "parent-1" }) }];
    }
    return Array.from({ length: 2000 }, (_, index) => ({
      id: `task-${String(index).padStart(4, "0")}`,
      progressJson: null,
    }));
  };
  try {
    assert.equal(await service.countLiveContinueChildren("parent-1"), 1);
  } finally {
    prisma.audiobookTask.findMany = originalFindMany;
  }

  assert.equal(queries.length, 2);
  assert.deepEqual(queries[1].cursor, { id: "task-1999" });
  assert.equal(queries[1].skip, 1);
});
