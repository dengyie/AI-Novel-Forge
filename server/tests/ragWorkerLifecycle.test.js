const test = require("node:test");
const assert = require("node:assert/strict");
const { RagWorker } = require("../dist/services/rag/RagWorker.js");
const { ragConfig } = require("../dist/config/rag.js");

function createJob() {
  return {
    id: "job-1",
    tenantId: "default",
    jobType: "upsert",
    ownerType: "knowledge_document",
    ownerId: "doc-1",
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    runAfter: new Date(),
    lastError: null,
    payloadJson: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

test("RagWorker waits for interrupted-job recovery before its first tick", async () => {
  const originalEnabled = ragConfig.enabled;
  ragConfig.enabled = true;
  let releaseRecovery;
  let listCalls = 0;
  const recovery = new Promise((resolve) => {
    releaseRecovery = resolve;
  });
  const service = {
    async listJobs() {
      listCalls += 1;
      await recovery;
      return [];
    },
    async getNextRunnableJob() {
      throw new Error("first tick ran before startup recovery finished");
    },
  };
  const worker = new RagWorker(service, {
    async cancelStaleActiveJobs() {
      return { cancelledQueued: 0, cancelledRunning: 0 };
    },
  });

  try {
    worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(listCalls, 1);
    const stopPromise = worker.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    releaseRecovery();
    await stopPromise;
    assert.equal(stopped, true);
  } finally {
    ragConfig.enabled = originalEnabled;
    await worker.stop();
  }
});

test("RagWorker.stop waits for an active processJob before resolving", async () => {
  const originalEnabled = ragConfig.enabled;
  ragConfig.enabled = true;
  let releaseProcess;
  const processGate = new Promise((resolve) => {
    releaseProcess = resolve;
  });
  let processStarted = false;
  const job = createJob();
  const service = {
    async listJobs() {
      return [];
    },
    async getNextRunnableJob() {
      return processStarted ? null : job;
    },
    async updateJobStatus() {},
    async processJob() {
      processStarted = true;
      await processGate;
      return { chunks: 1 };
    },
  };
  const worker = new RagWorker(service, {
    async cancelStaleActiveJobs() {
      return { cancelledQueued: 0, cancelledRunning: 0 };
    },
  });

  try {
    worker.start();
    for (let i = 0; i < 10 && !processStarted; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(processStarted, true);
    const stopPromise = worker.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    releaseProcess();
    await stopPromise;
    assert.equal(stopped, true);
  } finally {
    ragConfig.enabled = originalEnabled;
    releaseProcess?.();
    await worker.stop();
  }
});
