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

test("pending recovery bootstrap settles degraded when one domain fails", async () => {
  const calls = [];
  const service = new RecoveryTaskService({}, {}, {}, {}, {
    resumePendingBookAnalyses: async () => { calls.push("book"); },
    resumePendingImageTasks: async () => { calls.push("image"); },
    resumePendingAutoDirectorTasks: async () => { calls.push("director"); },
    resumePendingPipelineJobs: async () => { calls.push("pipeline"); throw new Error("database lock"); },
    resumePendingStyleTasks: async () => { calls.push("style"); },
    resumePendingAudiobookTasks: async () => { calls.push("audiobook"); },
  });

  const outcome = await service.initializePendingRecoveries();

  assert.deepEqual(calls.sort(), ["audiobook", "book", "director", "image", "pipeline", "style"]);
  assert.deepEqual(outcome.failedDomains, ["novel_pipeline"]);
  await service.waitUntilReady();
});

test("degraded recovery can be retried without duplicating concurrent retry scans", async () => {
  let failPipeline = true;
  const service = new RecoveryTaskService({}, {}, {}, {}, {
    resumePendingBookAnalyses: async () => {},
    resumePendingImageTasks: async () => {},
    resumePendingAutoDirectorTasks: async () => {},
    resumePendingPipelineJobs: async () => {
      if (failPipeline) throw new Error("temporary database lock");
    },
    resumePendingStyleTasks: async () => {},
    resumePendingAudiobookTasks: async () => {},
  });

  assert.deepEqual((await service.initializePendingRecoveries()).failedDomains, ["novel_pipeline"]);
  failPipeline = false;
  const [first, second] = await Promise.all([
    service.retryPendingRecoveries(),
    service.retryPendingRecoveries(),
  ]);
  assert.deepEqual(first.failedDomains, []);
  assert.strictEqual(first, second);
});

test("degraded recovery retries only the domains that failed", async () => {
  let failPipeline = true;
  const calls = [];
  const service = new RecoveryTaskService({}, {}, {}, {}, {
    resumePendingBookAnalyses: async () => { calls.push("book"); },
    resumePendingImageTasks: async () => { calls.push("image"); },
    resumePendingAutoDirectorTasks: async () => { calls.push("director"); },
    resumePendingPipelineJobs: async () => {
      calls.push("pipeline");
      if (failPipeline) throw new Error("temporary database lock");
    },
    resumePendingStyleTasks: async () => { calls.push("style"); },
    resumePendingAudiobookTasks: async () => { calls.push("audiobook"); },
  });

  assert.deepEqual((await service.initializePendingRecoveries()).failedDomains, ["novel_pipeline"]);
  failPipeline = false;
  assert.deepEqual((await service.retryPendingRecoveries()).failedDomains, []);
  assert.deepEqual(calls.sort(), [
    "audiobook",
    "book",
    "director",
    "image",
    "pipeline",
    "pipeline",
    "style",
  ]);
});
