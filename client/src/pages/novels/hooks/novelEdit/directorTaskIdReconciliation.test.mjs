import test from "node:test";
import assert from "node:assert/strict";

import { resolveCanonicalDirectorTask } from "../../automation/directorTaskSelection.ts";
import { reconcileDirectorTaskId } from "./directorTaskIdReconciliation.ts";

test("controller preserves an explicitly pinned cancelled task after detail loads", () => {
  const writes = [];
  const cancelledTask = { id: "task-cancelled", status: "cancelled", meta: {} };

  reconcileDirectorTaskId({
    novelId: "novel-1",
    activeTaskQuerySucceeded: true,
    activeTaskId: "",
    directorTaskId: "task-cancelled",
    requestedTask: cancelledTask,
    requestedTaskFetched: true,
    taskPanelOpen: false,
    setDirectorTaskId: (taskId) => writes.push(taskId),
  });

  const selection = resolveCanonicalDirectorTask({
    directorTaskId: "task-cancelled",
    requestedTask: cancelledTask,
    activeTask: null,
    projection: null,
  });

  assert.deepEqual(writes, []);
  assert.equal(selection.requestedTaskId, "task-cancelled");
  assert.equal(selection.visibleTask?.id, "task-cancelled");
});
