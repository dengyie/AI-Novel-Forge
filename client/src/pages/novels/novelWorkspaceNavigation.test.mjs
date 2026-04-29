import test from "node:test";
import assert from "node:assert/strict";

import { tabFromDirectorProgress } from "./novelWorkspaceNavigation.ts";

test("running chapter execution uses the active item over a stale front10 checkpoint", () => {
  assert.equal(tabFromDirectorProgress({
    status: "running",
    currentStage: "章节执行",
    currentItemKey: "chapter_execution",
    checkpointType: "front10_ready",
  }), "chapter");
});

test("waiting front10 checkpoint stays on structured outline before execution starts", () => {
  assert.equal(tabFromDirectorProgress({
    status: "waiting_approval",
    currentStage: "章节执行",
    currentItemKey: "chapter_execution",
    checkpointType: "front10_ready",
  }), "structured");
});
