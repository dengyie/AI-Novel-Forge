const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EventBus,
  getEventBusHandlerFailureMetrics,
  resetEventBusHandlerFailureMetrics,
} = require("../dist/events/EventBus.js");

test("EventBus emit continues after handler failure and counts metrics (P2-4)", async () => {
  resetEventBusHandlerFailureMetrics();
  const bus = new EventBus();
  const seen = [];

  bus.on("pipeline:completed", async () => {
    throw new Error("handler boom");
  });
  bus.on("pipeline:completed", async (event) => {
    seen.push(event.payload?.jobId ?? "ok");
  }, 10);

  await bus.emit({
    type: "pipeline:completed",
    payload: { novelId: "n1", jobId: "job-1", status: "succeeded" },
  });

  assert.deepEqual(seen, ["job-1"], "later handler must still run after earlier failure");
  const metrics = getEventBusHandlerFailureMetrics();
  assert.equal(metrics.total, 1);
  assert.equal(metrics.lastEventType, "pipeline:completed");
  assert.match(metrics.lastError ?? "", /handler boom/);
  assert.ok(metrics.lastAt);

  resetEventBusHandlerFailureMetrics();
  assert.equal(getEventBusHandlerFailureMetrics().total, 0);
});

test("EventBus emit with no handlers is a no-op", async () => {
  resetEventBusHandlerFailureMetrics();
  const bus = new EventBus();
  await bus.emit({
    type: "pipeline:completed",
    payload: { novelId: "n1", jobId: "job-2", status: "failed" },
  });
  assert.equal(getEventBusHandlerFailureMetrics().total, 0);
});
