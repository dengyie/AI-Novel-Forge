const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runStartupRecoverySequence,
} = require("../dist/app/startup/StartupRecoveryCoordinator.js");

test("director and volume recovery cannot start before core recovery scanning settles", async () => {
  const calls = [];
  let releaseCore;
  const coreGate = new Promise((resolve) => { releaseCore = resolve; });

  const sequence = runStartupRecoverySequence({
    recoverCore: async () => {
      calls.push("core:start");
      await coreGate;
      calls.push("core:end");
      return { failedDomains: [] };
    },
    startDeferredServices: () => { calls.push("services"); },
    startVolumeRecovery: async () => { calls.push("volume"); },
    startDirectorWorker: () => { calls.push("director"); },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["core:start"]);

  releaseCore();
  const result = await sequence;
  assert.deepEqual(result.recoveryResult, { failedDomains: [] });
  await result.backgroundRecovery;
  assert.deepEqual(calls, ["core:start", "core:end", "services", "volume", "director"]);
});

test("startup stop skips late high-memory workers after core recovery settles", async () => {
  const calls = [];
  const result = await runStartupRecoverySequence({
    recoverCore: async () => ({ failedDomains: ["novel_pipeline"] }),
    startDeferredServices: () => { calls.push("services"); },
    startVolumeRecovery: async () => { calls.push("volume"); },
    startDirectorWorker: () => { calls.push("director"); },
    shouldStop: () => true,
  });

  assert.deepEqual(result.recoveryResult, { failedDomains: ["novel_pipeline"] });
  await result.backgroundRecovery;
  assert.deepEqual(calls, []);
});

test("startup director waits for volume execution without blocking HTTP readiness", async () => {
  const calls = [];
  let releaseVolume;
  const volumeGate = new Promise((resolve) => { releaseVolume = resolve; });
  try {
    const result = await runStartupRecoverySequence({
      recoverCore: async () => ({ failedDomains: [] }),
      startDeferredServices: () => {},
      startVolumeRecovery: async () => {
        calls.push("volume:start");
        await volumeGate;
        calls.push("volume:end");
      },
      startDirectorWorker: () => { calls.push("director"); },
    });
    // The core scan can report readiness while volume work remains pending.
    assert.deepEqual(calls, ["volume:start"]);
    releaseVolume();
    await result.backgroundRecovery;
    assert.deepEqual(calls, ["volume:start", "volume:end", "director"]);
  } finally {
    releaseVolume();
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("shutdown during volume recovery prevents a late director start", async () => {
  let releaseVolume;
  const volumeGate = new Promise((resolve) => { releaseVolume = resolve; });
  let stopped = false;
  let directorStarts = 0;
  const result = await runStartupRecoverySequence({
    recoverCore: async () => ({ failedDomains: [] }),
    startDeferredServices: () => {},
    startVolumeRecovery: async () => { await volumeGate; },
    startDirectorWorker: () => { directorStarts += 1; },
    shouldStop: () => stopped,
  });
  stopped = true;
  releaseVolume();
  await result.backgroundRecovery;
  assert.equal(directorStarts, 0);
});

test("volume recovery failure is observable and does not starve director commands", async () => {
  for (const synchronous of [true, false]) {
    const failure = new Error("volume hydration failed");
    let directorStarts = 0;
    const result = await runStartupRecoverySequence({
      recoverCore: async () => ({ failedDomains: [] }),
      startDeferredServices: () => {},
      startVolumeRecovery: () => {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      },
      startDirectorWorker: () => { directorStarts += 1; },
    });
    await assert.rejects(result.backgroundRecovery, (error) => error === failure);
    assert.equal(directorStarts, 1);
  }
});

test("core recovery failure cannot start any deferred work", async () => {
  const calls = [];
  const failure = new Error("core failed");
  await assert.rejects(runStartupRecoverySequence({
    recoverCore: async () => { throw failure; },
    startDeferredServices: () => { calls.push("services"); },
    startVolumeRecovery: async () => { calls.push("volume"); },
    startDirectorWorker: () => { calls.push("director"); },
  }), (error) => error === failure);
  assert.deepEqual(calls, []);
});
