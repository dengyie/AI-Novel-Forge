const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { RagClient } = require("../dist/runtime/RagClient.js");

function createWorker(sendImpl) {
  const worker = new EventEmitter();
  worker.send = sendImpl;
  worker.off = worker.removeListener.bind(worker);
  return worker;
}

test("RagClient uses Node child-process IPC and resolves the response", async () => {
  const worker = createWorker((message, callback) => {
    callback?.();
    setImmediate(() => worker.emit("message", {
      id: message.id,
      ok: true,
      result: "retrieved context",
    }));
    return true;
  });
  const client = new RagClient({
    getWorker: () => worker,
    ensureWorker: () => {},
  });

  assert.equal(await client.buildContextBlock("query", {}), "retrieved context");
  assert.equal(client.inflightCount, 0);
});

test("RagClient degrades only the failed IPC request", async () => {
  const worker = createWorker((_message, callback) => {
    callback?.(new Error("channel closed"));
    return false;
  });
  const client = new RagClient({
    getWorker: () => worker,
    ensureWorker: () => {},
  });

  assert.equal(await client.buildContextBlock("query", {}), "");
  assert.equal(client.inflightCount, 0);
});

test("RagClient waits for a cold worker acquisition before sending the RPC", async () => {
  let worker = null;
  const coldWorker = createWorker((message, callback) => {
    callback?.();
    setImmediate(() => coldWorker.emit("message", {
      id: message.id,
      ok: true,
      result: "cold-start context",
    }));
    return true;
  });
  const client = new RagClient({
    getWorker: () => worker,
    ensureWorker: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      worker = coldWorker;
    },
  });

  assert.equal(await client.buildContextBlock("query", {}), "cold-start context");
  assert.equal(client.inflightCount, 0);
});
