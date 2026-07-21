const test = require("node:test");
const assert = require("node:assert/strict");
const { LlmLiveBroker } = require("../dist/llm/live/LlmLiveBroker.js");

test("LlmLiveBroker filters snapshots by taskId and novelId", () => {
  const broker = new LlmLiveBroker();
  const a = broker.begin({
    label: "a",
    mode: "text",
    taskId: "task-a",
    novelId: "novel-1",
  });
  broker.begin({
    label: "b",
    mode: "structured",
    taskId: "task-b",
    novelId: "novel-2",
  });
  const byTask = broker.getSnapshots({ taskId: "task-a" });
  assert.equal(byTask.length, 1);
  assert.equal(byTask[0].context.taskId, "task-a");
  const byNovel = broker.getSnapshots({ novelId: "novel-2" });
  assert.equal(byNovel.length, 1);
  assert.equal(byNovel[0].context.novelId, "novel-2");
  a.complete();
});

test("LlmLiveBroker subscribe respects novelId filter", () => {
  const broker = new LlmLiveBroker();
  const seen = [];
  const unsub = broker.subscribe({ novelId: "novel-keep" }, (event) => {
    seen.push(event);
  });
  broker.begin({ label: "keep", mode: "text", novelId: "novel-keep" });
  broker.begin({ label: "drop", mode: "text", novelId: "novel-other" });
  assert.equal(seen.filter((e) => e.type === "session_started").length, 1);
  assert.equal(seen[0].context.novelId, "novel-keep");
  unsub();
});
