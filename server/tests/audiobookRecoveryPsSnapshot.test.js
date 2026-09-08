const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const { prisma } = require("../dist/db/prisma.js");
const { AudiobookTaskService } = require("../dist/services/audiobook/AudiobookTaskService.js");

function task(taskId, taskDir) {
  return {
    id: taskId,
    novelId: "novel-1",
    title: taskId,
    outputDir: taskDir,
    progress: 100,
    status: "succeeded",
    chapterIdsJson: JSON.stringify(["chapter-1"]),
    progressJson: null,
    resultJson: JSON.stringify({ m4b: { status: "encoding" } }),
    currentStage: "finalizing",
    cancelRequestedAt: null,
    m4bGenerationToken: `generation-${taskId}`,
  };
}

test("startup recovery takes one process snapshot for all m4b rows in a pass", { concurrency: false }, async () => {
  const dirs = [
    fs.mkdtempSync(path.join(os.tmpdir(), "ab-recovery-ps-a-")),
    fs.mkdtempSync(path.join(os.tmpdir(), "ab-recovery-ps-b-")),
  ];
  const service = new AudiobookTaskService();
  const originals = {
    findMany: prisma.audiobookTask.findMany,
    updateMany: prisma.audiobookTask.updateMany,
    schedule: service.scheduleBackgroundM4bEncode,
    execFile: childProcess.execFile,
  };
  let psCalls = 0;
  childProcess.execFile = ((file, args, options, callback) => {
    if (file === "ps") {
      psCalls += 1;
      callback(null, "", "");
      return;
    }
    return originals.execFile(file, args, options, callback);
  });
  prisma.audiobookTask.findMany = async (query) => {
    if (!query.select?.resultJson) return [];
    return [task("m4b-a", dirs[0]), task("m4b-b", dirs[1])];
  };
  prisma.audiobookTask.updateMany = async () => ({ count: 1 });
  service.scheduleBackgroundM4bEncode = () => undefined;

  try {
    await service.resumePendingTasks();
    assert.equal(psCalls, 1, "a recovery pass must not spawn one ps process per task row");
  } finally {
    prisma.audiobookTask.findMany = originals.findMany;
    prisma.audiobookTask.updateMany = originals.updateMany;
    service.scheduleBackgroundM4bEncode = originals.schedule;
    childProcess.execFile = originals.execFile;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});
