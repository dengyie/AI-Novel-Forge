const test = require("node:test");
const assert = require("node:assert/strict");

const { RecoveryTaskService } = require("../dist/services/task/RecoveryTaskService.js");

test("pending recovery bootstrap is shared by concurrent callers and each resume runs once", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new RecoveryTaskService({}, {}, {}, {}, {
    resumePendingBookAnalyses: async () => { calls.push("book"); await gate; },
    resumePendingImageTasks: async () => { calls.push("image"); await gate; },
    resumePendingAutoDirectorTasks: async () => { calls.push("director"); await gate; },
    resumePendingPipelineJobs: async () => { calls.push("pipeline"); await gate; },
    resumePendingStyleTasks: async () => { calls.push("style"); await gate; },
    resumePendingAudiobookTasks: async () => { calls.push("audiobook"); await gate; },
  });

  const first = service.initializePendingRecoveries();
  const second = service.initializePendingRecoveries();
  assert.strictEqual(first, second, "concurrent bootstrap callers must attach to one promise");
  assert.deepEqual(calls.sort(), ["audiobook", "book", "director", "image", "pipeline", "style"]);

  release();
  await Promise.all([first, second]);
  await service.waitUntilReady();
  assert.equal(calls.length, 6, "the initialization fan-out must not be duplicated");
});
