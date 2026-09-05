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
    startVolumeRecovery: () => { calls.push("volume"); },
    startDirectorWorker: () => { calls.push("director"); },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["core:start"]);

  releaseCore();
  assert.deepEqual(await sequence, { failedDomains: [] });
  assert.deepEqual(calls, ["core:start", "core:end", "services", "volume", "director"]);
});

test("startup stop skips late high-memory workers after core recovery settles", async () => {
  const calls = [];
  const result = await runStartupRecoverySequence({
    recoverCore: async () => ({ failedDomains: ["novel_pipeline"] }),
    startDeferredServices: () => { calls.push("services"); },
    startVolumeRecovery: () => { calls.push("volume"); },
    startDirectorWorker: () => { calls.push("director"); },
    shouldStop: () => true,
  });

  assert.deepEqual(result, { failedDomains: ["novel_pipeline"] });
  assert.deepEqual(calls, []);
});
