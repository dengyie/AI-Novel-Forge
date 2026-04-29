const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { DirectorExecutionService } = require("../dist/services/novel/director/DirectorExecutionService.js");
const { NovelDirectorService } = require("../dist/services/novel/director/NovelDirectorService.js");
const { NovelWorkflowService } = require("../dist/services/novel/workflow/NovelWorkflowService.js");

function resumeCommand() {
  return {
    id: "command-resume",
    taskId: "task-1",
    novelId: "novel-1",
    commandType: "resume_from_checkpoint",
    status: "running",
    payloadJson: "{\"forceResume\":true}",
  };
}

test("director execution replays takeover request when recovery task lacks director input", async () => {
  const calls = [];
  const takeoverRequest = {
    novelId: "novel-1",
    entryStep: "structured",
    strategy: "continue_existing",
    runMode: "auto_to_execution",
  };
  const originals = {
    startTakeover: NovelDirectorService.prototype.startTakeover,
    executeContinueTask: NovelDirectorService.prototype.executeContinueTask,
    getTaskByIdWithoutHealing: NovelWorkflowService.prototype.getTaskByIdWithoutHealing,
    commandFindFirst: prisma.directorRunCommand.findFirst,
  };

  NovelWorkflowService.prototype.getTaskByIdWithoutHealing = async () => ({
    id: "task-1",
    lane: "auto_director",
    seedPayloadJson: JSON.stringify({
      takeover: {
        entryStep: "structured",
      },
    }),
  });
  prisma.directorRunCommand.findFirst = async () => ({
    id: "command-takeover",
    taskId: "task-1",
    commandType: "takeover",
    payloadJson: JSON.stringify({ takeoverRequest }),
  });
  NovelDirectorService.prototype.startTakeover = async (request, options) => {
    calls.push(["takeover", request, options]);
  };
  NovelDirectorService.prototype.executeContinueTask = async () => {
    calls.push(["continue"]);
  };

  try {
    const service = new DirectorExecutionService();
    await service.executeCommand(resumeCommand());

    assert.deepEqual(calls, [[
      "takeover",
      takeoverRequest,
      { workflowTaskId: "task-1" },
    ]]);
  } finally {
    NovelDirectorService.prototype.startTakeover = originals.startTakeover;
    NovelDirectorService.prototype.executeContinueTask = originals.executeContinueTask;
    NovelWorkflowService.prototype.getTaskByIdWithoutHealing = originals.getTaskByIdWithoutHealing;
    prisma.directorRunCommand.findFirst = originals.commandFindFirst;
  }
});

test("director execution keeps normal recovery path when director input is already persisted", async () => {
  const calls = [];
  const originals = {
    startTakeover: NovelDirectorService.prototype.startTakeover,
    executeContinueTask: NovelDirectorService.prototype.executeContinueTask,
    getTaskByIdWithoutHealing: NovelWorkflowService.prototype.getTaskByIdWithoutHealing,
    commandFindFirst: prisma.directorRunCommand.findFirst,
  };

  NovelWorkflowService.prototype.getTaskByIdWithoutHealing = async () => ({
    id: "task-1",
    lane: "auto_director",
    seedPayloadJson: JSON.stringify({
      directorInput: {
        candidate: {
          workingTitle: "Demo",
        },
        runMode: "auto_to_ready",
      },
    }),
  });
  prisma.directorRunCommand.findFirst = async () => {
    throw new Error("takeover replay should not be queried");
  };
  NovelDirectorService.prototype.startTakeover = async () => {
    calls.push(["takeover"]);
  };
  NovelDirectorService.prototype.executeContinueTask = async (taskId, input) => {
    calls.push(["continue", taskId, input.forceResume]);
  };

  try {
    const service = new DirectorExecutionService();
    await service.executeCommand(resumeCommand());

    assert.deepEqual(calls, [["continue", "task-1", true]]);
  } finally {
    NovelDirectorService.prototype.startTakeover = originals.startTakeover;
    NovelDirectorService.prototype.executeContinueTask = originals.executeContinueTask;
    NovelWorkflowService.prototype.getTaskByIdWithoutHealing = originals.getTaskByIdWithoutHealing;
    prisma.directorRunCommand.findFirst = originals.commandFindFirst;
  }
});
