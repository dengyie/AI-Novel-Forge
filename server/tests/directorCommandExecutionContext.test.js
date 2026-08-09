const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NovelDirectorService,
} = require("../dist/services/novel/director/NovelDirectorService.js");
const {
  DirectorCommandExecutor,
} = require("../dist/services/novel/director/commands/DirectorCommandExecutor.js");

function buildExecutor(directorService) {
  return new DirectorCommandExecutor({
    directorService,
    workflowService: {
      async getTaskByIdWithoutHealing() {
        return { status: "running" };
      },
    },
    commandService: {
      async getCommandById() {
        return { id: "command-1" };
      },
      parseCommandPayload() {
        return { confirmRequest: { candidate: { workingTitle: "测试书名" } } };
      },
    },
    interpreter: {
      interpret() {
        return {
          id: "command-1",
          taskId: "task-command",
          novelId: null,
          intent: "confirm_candidate",
          payload: { confirmRequest: { candidate: { workingTitle: "测试书名" } } },
        };
      },
    },
    stateStore: {
      async readTaskState() {
        return { task: { novelId: null }, runtime: null };
      },
      async recordPipelineDispatch() {},
    },
  });
}

test("DirectorCommandExecutor awaits the real scheduled runner before completing", async () => {
  const service = new NovelDirectorService();
  let releaseRunner;
  let runnerStarted = false;
  let settled = false;
  service.buildDirectorUsageContext = async () => ({
    workflowTaskId: "task-command",
    directorTelemetry: true,
  });
  service.confirmCandidate = async () => service.scheduleBackgroundRun("task-command", async () => {
    runnerStarted = true;
    await new Promise((resolve) => {
      releaseRunner = resolve;
    });
  });
  const execution = buildExecutor(service).execute("command-1").then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runnerStarted, true);
  assert.equal(settled, false, "command completion must retain the scheduled runner");

  releaseRunner();
  await execution;
  assert.equal(settled, true);
});

test("DirectorCommandExecutor propagates runner errors after normal task failure projection", async () => {
  const service = new NovelDirectorService();
  const failure = new Error("real runner failed");
  const taskFailures = [];
  service.buildDirectorUsageContext = async () => ({
    workflowTaskId: "task-command",
    directorTelemetry: true,
  });
  service.workflowService.markTaskFailed = async (_taskId, message) => {
    taskFailures.push(message);
  };
  service.confirmCandidate = async () => service.scheduleBackgroundRun("task-command", async () => {
    throw failure;
  });

  await assert.rejects(
    buildExecutor(service).execute("command-1"),
    failure,
  );
  assert.deepEqual(taskFailures, ["real runner failed"]);
});

test("DirectorCommandExecutor propagates abort without overwriting task state as failed", async () => {
  const service = new NovelDirectorService();
  const controller = new AbortController();
  const failure = new Error("command lease lost");
  const taskFailures = [];
  service.buildDirectorUsageContext = async () => ({
    workflowTaskId: "task-command",
    directorTelemetry: true,
  });
  service.workflowService.markTaskFailed = async (_taskId, message) => {
    taskFailures.push(message);
  };
  service.confirmCandidate = async () => service.scheduleBackgroundRun("task-command", async () => {
    controller.abort(failure);
    throw failure;
  });

  await assert.rejects(
    buildExecutor(service).execute("command-1", { signal: controller.signal }),
    failure,
  );
  assert.deepEqual(taskFailures, []);
});

test("DirectorCommandExecutor does not start the runner after abort during usage context loading", async () => {
  const service = new NovelDirectorService();
  const controller = new AbortController();
  const failure = new Error("command lease lost");
  let runnerStarted = false;
  service.buildDirectorUsageContext = async () => {
    controller.abort(failure);
    return {
      workflowTaskId: "task-command",
      directorTelemetry: true,
    };
  };
  service.confirmCandidate = async () => service.scheduleBackgroundRun("task-command", async () => {
    runnerStarted = true;
  });

  await assert.rejects(
    buildExecutor(service).execute("command-1", { signal: controller.signal }),
    failure,
  );
  assert.equal(runnerStarted, false);
});
