import test from "node:test";
import assert from "node:assert/strict";

import { resolveCanonicalDirectorTask } from "./directorTaskSelection.ts";

function buildTask(id, status = "running") {
  return {
    id,
    status,
    meta: {},
  };
}

for (const status of ["failed", "blocked", "waiting_recovery"]) {
  test(`${status} book projection remains visible without a director task in the URL`, () => {
    const requestedTask = buildTask(`task-${status}`, status === "waiting_recovery" ? "queued" : "failed");
    const result = resolveCanonicalDirectorTask({
      directorTaskId: "",
      requestedTask,
      activeTask: null,
      projection: {
        status,
        latestTask: { id: requestedTask.id, status: requestedTask.status },
      },
    });

    assert.equal(result.requestedTaskId, requestedTask.id);
    assert.equal(result.visibleTask?.id, requestedTask.id);
    assert.equal(result.visibleTask?.displayStatus, status);
  });
}

test("an explicit URL director task wins over the latest active and projected tasks", () => {
  const result = resolveCanonicalDirectorTask({
    directorTaskId: "task-pinned",
    requestedTask: buildTask("task-pinned", "failed"),
    activeTask: buildTask("task-active"),
    projection: {
      status: "running",
      latestTask: { id: "task-projected", status: "running" },
    },
  });

  assert.equal(result.requestedTaskId, "task-pinned");
  assert.equal(result.visibleTask?.id, "task-pinned");
});

test("a cancelled task is suppressed when it is not explicitly pinned", () => {
  const result = resolveCanonicalDirectorTask({
    directorTaskId: "",
    requestedTask: buildTask("task-cancelled", "cancelled"),
    activeTask: buildTask("task-cancelled", "cancelled"),
    projection: {
      status: "cancelled",
      latestTask: { id: "task-cancelled", status: "cancelled" },
    },
  });

  assert.equal(result.requestedTaskId, "");
  assert.equal(result.visibleTask, null);
});

test("a cancelled task remains inspectable when explicitly pinned", () => {
  const result = resolveCanonicalDirectorTask({
    directorTaskId: "task-cancelled",
    requestedTask: buildTask("task-cancelled", "cancelled"),
    activeTask: null,
    projection: null,
  });

  assert.equal(result.requestedTaskId, "task-cancelled");
  assert.equal(result.visibleTask?.id, "task-cancelled");
});

test("an actionable projection supplies the query target before task detail is loaded", () => {
  const result = resolveCanonicalDirectorTask({
    directorTaskId: "",
    requestedTask: null,
    activeTask: null,
    projection: {
      status: "waiting_recovery",
      latestTask: { id: "task-projected", status: "failed" },
    },
  });

  assert.equal(result.requestedTaskId, "task-projected");
  assert.equal(result.visibleTask, null);
});
