import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readClientFile = (relativePath) => readFileSync(join(clientRoot, relativePath), "utf8");

const utils = readClientFile("src/pages/tasks/taskCenterUtils.ts");
const page = readClientFile("src/pages/tasks/TaskCenterPage.tsx");
const panel = readClientFile("src/pages/tasks/components/TaskCenterListPanel.tsx");
const summary = readClientFile("src/pages/tasks/components/TaskCenterSummaryCards.tsx");

test("task center completed group is labeled 完成任务 and collapsed by default", () => {
  assert.match(utils, /completed:\s*"完成任务"/);
  assert.match(utils, /completed:\s*true/);
  assert.match(utils, /BULK_ARCHIVE_STATUSES/);
});

test("task list priority ranks failed before cancelled and waiting before running", () => {
  assert.match(utils, /status === "failed"/);
  assert.match(utils, /status === "cancelled"/);
  assert.match(utils, /status === "waiting_approval"/);
  assert.match(utils, /status === "running"/);
  assert.match(utils, /status === "queued"/);

  const failedIdx = utils.indexOf('if (status === "failed")');
  const cancelledIdx = utils.indexOf('if (status === "cancelled")');
  const waitingIdx = utils.indexOf('if (status === "waiting_approval")');
  const runningIdx = utils.indexOf('if (status === "running")');
  const queuedIdx = utils.indexOf('if (status === "queued")');
  assert.ok(failedIdx > 0 && cancelledIdx > failedIdx);
  assert.ok(waitingIdx > cancelledIdx && runningIdx > waitingIdx && queuedIdx > runningIdx);
});

test("task center page wires overview counts, attention sync, and bulk archive scope", () => {
  assert.match(page, /getTaskOverview/);
  assert.match(page, /queryKeys\.tasks\.overview/);
  assert.match(page, /waitingApprovalCount/);
  assert.match(page, /bulkArchiveSucceededMutation/);
  assert.match(page, /一键归档本页完成任务/);
  assert.match(page, /最多 80/);
  assert.match(page, /attention"\) === "1"/);
  assert.match(page, /next\.set\("attention", "1"\)/);
  assert.match(page, /next\.delete\("attention"\)/);
  assert.match(summary, /等待审批/);
  assert.doesNotMatch(summary, /排队中/);
});

test("list panel highlights failed / waiting / stale heartbeat with updatedAt fallback", () => {
  assert.match(panel, /border-l-destructive/);
  assert.match(panel, /border-l-amber-500/);
  assert.match(panel, /心跳超时/);
  assert.match(panel, /失败/);
  assert.match(panel, /isStaleHeartbeat\(task\.heartbeatAt, Date\.now\(\), undefined, task\.updatedAt\)/);
  assert.match(utils, /Missing both timestamps/);
  assert.match(utils, /return true;/);
});
