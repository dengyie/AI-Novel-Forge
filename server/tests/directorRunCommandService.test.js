const test = require("node:test");
const assert = require("node:assert/strict");

const { DirectorCommandService } = require("../dist/services/novel/director/commands/DirectorCommandService.js");
const { DirectorCommandLeaseService } = require("../dist/services/novel/director/commands/leases/DirectorCommandLeaseService.js");
const { prisma } = require("../dist/db/prisma.js");
const { taskDispatcher } = require("../dist/workers/TaskDispatcher.js");

function createTask(overrides = {}) {
  return {
    id: "task-1",
    novelId: "novel-1",
    lane: "auto_director",
    status: "waiting_approval",
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    heartbeatAt: null,
    currentItemKey: null,
    checkpointType: null,
    attemptCount: 0,
    seedPayloadJson: JSON.stringify({
      provider: "openai",
      model: "gpt-5",
      temperature: 0.7,
      directorInput: {
        provider: "openai",
        model: "gpt-5",
        temperature: 0.7,
      },
    }),
    updatedAt: new Date("2026-04-29T12:00:00.000Z"),
    ...overrides,
  };
}

function createConfirmRequest(overrides = {}) {
  return {
    idea: "A college girl accidentally enters a supernatural organization.",
    title: "Neon Archive",
    narrativePov: "third_person",
    pacePreference: "balanced",
    emotionIntensity: "medium",
    aiFreedom: "medium",
    projectMode: "ai_led",
    writingMode: "original",
    estimatedChapterCount: 30,
    runMode: "auto_to_execution",
    workflowTaskId: "task-1",
    candidate: {
      id: "candidate-1",
      workingTitle: "Neon Archive",
      logline: "A college girl enters a hidden power network.",
      positioning: "Urban supernatural growth thriller.",
      sellingPoint: "An ordinary girl levels up inside a dangerous secret organization.",
      coreConflict: "The organization pushes back as she gets closer to the truth.",
      protagonistPath: "She grows from cautious student into an active operator.",
      endingDirection: "Hopeful victory with a meaningful cost.",
      hookStrategy: "Each arc reveals a deeper layer of the conspiracy.",
      progressionLoop: "Find clue, face pressure, pay cost, gain leverage.",
      whyItFits: "It keeps the urban premise clear and easy to continue.",
      toneKeywords: ["urban", "thriller"],
      targetChapterCount: 30,
    },
    ...overrides,
  };
}

function createCandidatesRequest(overrides = {}) {
  return {
    idea: "A college girl accidentally enters a supernatural organization.",
    title: "Neon Archive",
    narrativePov: "third_person",
    pacePreference: "balanced",
    emotionIntensity: "medium",
    aiFreedom: "medium",
    projectMode: "ai_led",
    writingMode: "original",
    estimatedChapterCount: 30,
    runMode: "auto_to_execution",
    ...overrides,
  };
}

function createHarness(task = createTask()) {
  const commands = [];
  const bootstraps = [];
  const requeued = [];
  const stepUpdates = [];
  const jobUpdates = [];
  const directorEvents = [];
  const taskUpdates = [];
  const originalTransaction = prisma.$transaction;
  const originalDirectorRunCommand = {
    findFirst: prisma.directorRunCommand.findFirst,
    create: prisma.directorRunCommand.create,
    findUnique: prisma.directorRunCommand.findUnique,
    updateMany: prisma.directorRunCommand.updateMany,
    findMany: prisma.directorRunCommand.findMany,
  };
  const originalNovelWorkflowTask = {
    findUnique: prisma.novelWorkflowTask.findUnique,
    updateMany: prisma.novelWorkflowTask.updateMany,
  };
  const originalDirectorStepRun = {
    updateMany: prisma.directorStepRun.updateMany,
  };
  const originalGenerationJob = {
    updateMany: prisma.generationJob.updateMany,
  };
  const originalDirectorRun = {
    findUnique: prisma.directorRun.findUnique,
  };
  const originalDirectorEvent = {
    create: prisma.directorEvent.create,
  };
  const workflowService = {
    async getTaskById(taskId) {
      return taskId === task.id ? task : null;
    },
    async getTaskByIdWithoutHealing(taskId) {
      return taskId === task.id ? task : null;
    },
    async retryTask() {
      task.status = "queued";
      task.updatedAt = new Date(task.updatedAt.getTime() + 1);
      return task;
    },
    async applyAutoDirectorLlmOverride() {},
    async cancelTask() {
      task.status = "cancelled";
      task.cancelRequestedAt = new Date();
      task.updatedAt = new Date(task.updatedAt.getTime() + 1);
      return task;
    },
    async requeueTaskForRecovery(taskId, message) {
      requeued.push({ taskId, message });
      task.status = "queued";
      task.pendingManualRecovery = true;
      task.lastError = message;
      task.heartbeatAt = null;
      task.updatedAt = new Date(task.updatedAt.getTime() + 1);
      return task;
    },
    async bootstrapTask(input) {
      bootstraps.push(input);
      task.id = input.workflowTaskId?.trim() || (input.novelId ? `takeover-task-${commands.length + 1}` : task.id);
      task.novelId = input.novelId ?? null;
      task.lane = input.lane;
      task.status = "queued";
      task.updatedAt = new Date(task.updatedAt.getTime() + 1);
      return task;
    },
  };

  prisma.directorRunCommand.findFirst = async ({ where }) => {
    let rows = commands;
    if (where?.novelId) {
      rows = rows.filter((row) => row.novelId === where.novelId);
    }
    if (where?.taskId) {
      rows = rows.filter((row) => row.taskId === where.taskId);
    }
    if (where?.commandType) {
      if (typeof where.commandType === "string") {
        rows = rows.filter((row) => row.commandType === where.commandType);
      } else if (Array.isArray(where.commandType.in)) {
        rows = rows.filter((row) => where.commandType.in.includes(row.commandType));
      }
    }
    if (where?.idempotencyKey) {
      rows = rows.filter((row) => row.idempotencyKey === where.idempotencyKey);
    }
    if (where?.status) {
      if (typeof where.status === "string") {
        rows = rows.filter((row) => row.status === where.status);
      } else if (Array.isArray(where.status.in)) {
        rows = rows.filter((row) => where.status.in.includes(row.status));
      }
    }
    if (where?.runAfter?.lte) {
      rows = rows.filter((row) => row.runAfter <= where.runAfter.lte);
    }
    return rows[0] ?? null;
  };
  prisma.directorRunCommand.create = async ({ data }) => {
    const row = {
      id: `command-${commands.length + 1}`,
      novelId: data.novelId ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
      attempt: 0,
      runAfter: new Date(),
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
      novelId: data.novelId ?? null,
    };
    commands.push(row);
    return row;
  };
  prisma.directorRunCommand.findUnique = async ({ where }) => (
    commands.find((row) => row.id === where.id) ?? null
  );
  prisma.directorRunCommand.findMany = async ({ where }) => {
    let rows = commands;
    if (where?.taskId) {
      rows = rows.filter((row) => row.taskId === where.taskId);
    }
    if (where?.status?.in) {
      rows = rows.filter((row) => where.status.in.includes(row.status));
    }
    if (where?.leaseExpiresAt?.lt) {
      rows = rows.filter((row) => row.leaseExpiresAt && row.leaseExpiresAt < where.leaseExpiresAt.lt);
    }
    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      commandType: row.commandType,
      status: row.status,
      leaseOwner: row.leaseOwner,
      leaseExpiresAt: row.leaseExpiresAt,
      attempt: row.attempt,
      payloadJson: row.payloadJson,
    }));
  };
  prisma.directorRunCommand.updateMany = async ({ where, data }) => {
    let count = 0;
    for (const row of commands) {
      if (where?.id) {
        if (typeof where.id === "string" && row.id !== where.id) {
          continue;
        }
        if (Array.isArray(where.id.in) && !where.id.in.includes(row.id)) {
          continue;
        }
      }
      if (where?.taskId && row.taskId !== where.taskId) {
        continue;
      }
      if (where?.commandType) {
        if (typeof where.commandType === "string" && row.commandType !== where.commandType) {
          continue;
        }
        if (Array.isArray(where.commandType.in) && !where.commandType.in.includes(row.commandType)) {
          continue;
        }
      }
      if (Object.prototype.hasOwnProperty.call(where ?? {}, "leaseOwner")) {
        if ((row.leaseOwner ?? null) !== where.leaseOwner) {
          continue;
        }
      }
      if (Object.prototype.hasOwnProperty.call(where ?? {}, "leaseExpiresAt")) {
        const expected = where.leaseExpiresAt;
        const actual = row.leaseExpiresAt ?? null;
        if (expected?.lt instanceof Date) {
          if (!(actual instanceof Date) || actual >= expected.lt) {
            continue;
          }
        } else if (expected?.gt instanceof Date) {
          if (!(actual instanceof Date) || actual <= expected.gt) {
            continue;
          }
        } else if (expected === null ? actual !== null : expected?.getTime?.() !== actual?.getTime?.()) {
          continue;
        }
      }
      if (Object.prototype.hasOwnProperty.call(where ?? {}, "attempt") && row.attempt !== where.attempt) {
        continue;
      }
      if (where?.status) {
        if (typeof where.status === "string" && row.status !== where.status) {
          continue;
        }
        if (Array.isArray(where.status.in) && !where.status.in.includes(row.status)) {
          continue;
        }
      }
      if (data?.attempt?.increment) {
        row.attempt += data.attempt.increment;
      }
      for (const [key, value] of Object.entries(data ?? {})) {
        if (key !== "attempt") {
          row[key] = value;
        }
      }
      row.updatedAt = new Date();
      count += 1;
    }
    return { count };
  };
  prisma.novelWorkflowTask.updateMany = async (args) => {
    taskUpdates.push(args);
    if (args?.where?.id) {
      if (typeof args.where.id === "string" && args.where.id !== task.id) {
        return { count: 0 };
      }
      if (Array.isArray(args.where.id.in) && !args.where.id.in.includes(task.id)) {
        return { count: 0 };
      }
    }
    if (args?.where?.lane && args.where.lane !== task.lane) {
      return { count: 0 };
    }
    if (args?.where?.status) {
      if (typeof args.where.status === "string" && args.where.status !== task.status) {
        return { count: 0 };
      }
      if (Array.isArray(args.where.status.in) && !args.where.status.in.includes(task.status)) {
        return { count: 0 };
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(args?.where ?? {}, "pendingManualRecovery")
      && task.pendingManualRecovery !== args.where.pendingManualRecovery
    ) {
      return { count: 0 };
    }
    if (
      Object.prototype.hasOwnProperty.call(args?.where ?? {}, "attemptCount")
      && task.attemptCount !== args.where.attemptCount
    ) {
      return { count: 0 };
    }
    if (Object.prototype.hasOwnProperty.call(args?.where ?? {}, "cancelRequestedAt")) {
      const expected = args.where.cancelRequestedAt;
      const actual = task.cancelRequestedAt ?? null;
      if (expected === null ? actual !== null : expected?.getTime?.() !== actual?.getTime?.()) {
        return { count: 0 };
      }
    }
    for (const field of ["updatedAt", "heartbeatAt"]) {
      if (!Object.prototype.hasOwnProperty.call(args?.where ?? {}, field)) continue;
      const expected = args.where[field];
      const actual = task[field] ?? null;
      if (expected === null ? actual !== null : expected?.getTime?.() !== actual?.getTime?.()) {
        return { count: 0 };
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(args?.where ?? {}, "currentItemKey")
      && (task.currentItemKey ?? null) !== args.where.currentItemKey
    ) {
      return { count: 0 };
    }
    Object.assign(task, args?.data ?? {});
    if (!Object.prototype.hasOwnProperty.call(args?.data ?? {}, "updatedAt")) {
      task.updatedAt = new Date(task.updatedAt.getTime() + 1);
    }
    return { count: 1 };
  };
  prisma.novelWorkflowTask.findUnique = async ({ where }) => (
    where?.id === task.id ? task : null
  );
  prisma.directorStepRun.updateMany = async (args) => {
    stepUpdates.push(args);
    return { count: 1 };
  };
  prisma.generationJob.updateMany = async (args) => {
    jobUpdates.push(args);
    return { count: 1 };
  };
  prisma.directorRun.findUnique = async ({ where }) => (
    where.taskId === task.id
      ? { id: "run-1", novelId: task.novelId }
      : null
  );
  prisma.directorEvent.create = async ({ data }) => {
    directorEvents.push(data);
    return data;
  };
  prisma.$transaction = async (callback) => {
    const commandSnapshot = commands.map((row) => ({ ...row }));
    const taskSnapshot = { ...task };
    try {
      return await callback(prisma);
    } catch (error) {
      commands.splice(0, commands.length, ...commandSnapshot);
      for (const key of Object.keys(task)) {
        delete task[key];
      }
      Object.assign(task, taskSnapshot);
      throw error;
    }
  };

  const leaseService = new DirectorCommandLeaseService();

  return {
    commands,
    bootstraps,
    requeued,
    task,
    stepUpdates,
    jobUpdates,
    directorEvents,
    taskUpdates,
    workflowService,
    leaseService,
    service: new DirectorCommandService(workflowService, leaseService),
    restore() {
      prisma.$transaction = originalTransaction;
      Object.assign(prisma.directorRunCommand, originalDirectorRunCommand);
      Object.assign(prisma.novelWorkflowTask, originalNovelWorkflowTask);
      Object.assign(prisma.directorStepRun, originalDirectorStepRun);
      Object.assign(prisma.generationJob, originalGenerationJob);
      Object.assign(prisma.directorRun, originalDirectorRun);
      Object.assign(prisma.directorEvent, originalDirectorEvent);
    },
  };
}

test("director command service reuses active continue commands", async () => {
  const harness = createHarness();
  try {
    const first = await harness.service.enqueueContinueCommand("task-1", {
      continuationMode: "auto_execute_range",
    });
    const second = await harness.service.enqueueContinueCommand("task-1", {
      continuationMode: "auto_execute_range",
    });
    assert.equal(first.commandId, second.commandId);
    assert.equal(harness.commands.length, 1);
    assert.equal(first.status, "queued");
  } finally {
    harness.restore();
  }
});

test("director command service internal enqueue uses raw task lookup without triggering healing", async () => {
  const harness = createHarness();
  let rawReads = 0;
  harness.workflowService.getTaskById = async () => {
    throw new Error("healing read must not be used by command enqueue");
  };
  harness.workflowService.getTaskByIdWithoutHealing = async (taskId) => {
    rawReads += 1;
    return taskId === harness.task.id ? harness.task : null;
  };

  try {
    const accepted = await harness.service.enqueueContinueCommand("task-1", {
      continuationMode: "resume",
      forceResume: true,
    });

    assert.equal(accepted.status, "queued");
    assert.equal(rawReads, 1);
    assert.equal(harness.commands.length, 1);
  } finally {
    harness.restore();
  }
});

test("director command service reprojects a reused active command as the sole accepted task state", async () => {
  const harness = createHarness(createTask({
    status: "running",
    pendingManualRecovery: false,
    lastError: "stale runtime error",
  }));

  try {
    await harness.service.enqueueContinueCommand("task-1", { forceResume: true });
    harness.task.status = "running";
    harness.task.lastError = "stale runtime error";
    harness.taskUpdates.length = 0;

    const accepted = await harness.service.enqueueContinueCommand("task-1", { forceResume: true });

    assert.equal(accepted.commandId, "command-1");
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.taskUpdates.length, 1);
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.lastError, null);
  } finally {
    harness.restore();
  }
});

test("director command service does not project accepted state when command creation fails", async () => {
  const harness = createHarness(createTask({
    status: "running",
    lastError: "keep this diagnostic",
  }));
  prisma.directorRunCommand.create = async () => {
    throw new Error("command create failed");
  };

  try {
    await assert.rejects(
      () => harness.service.enqueueContinueCommand("task-1", { forceResume: true }),
      /command create failed/,
    );
    assert.equal(harness.taskUpdates.length, 0);
    assert.equal(harness.task.status, "running");
    assert.equal(harness.task.lastError, "keep this diagnostic");
  } finally {
    harness.restore();
  }
});

test("director command service projects durable acceptance before best-effort dispatcher wake-up", async () => {
  const harness = createHarness(createTask({
    status: "running",
    lastError: "keep this diagnostic",
  }));
  const observedStatuses = [];
  const unsubscribe = taskDispatcher.onTaskAvailable(() => {
    observedStatuses.push(harness.task.status);
    throw new Error("dispatcher rejected wake-up");
  });

  try {
    const accepted = await harness.service.enqueueContinueCommand("task-1", { forceResume: true });

    assert.equal(accepted.status, "queued");
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.taskUpdates.length, 1);
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.lastError, null);
    assert.deepEqual(observedStatuses, ["queued"], "worker wake-up must observe the accepted task projection");
  } finally {
    unsubscribe();
    harness.restore();
  }
});

test("director command service surfaces task projection failure instead of claiming accepted state", async () => {
  const harness = createHarness(createTask({
    status: "running",
    lastError: "keep this diagnostic",
  }));
  prisma.novelWorkflowTask.updateMany = async () => {
    throw new Error("task projection failed");
  };

  try {
    await assert.rejects(
      () => harness.service.enqueueContinueCommand("task-1", { forceResume: true }),
      /task projection failed/,
    );
    assert.equal(
      harness.commands.some((command) => ["queued", "leased", "running"].includes(command.status)),
      false,
      "projection failure must not leave a leaseable command",
    );
    assert.equal(harness.task.status, "running");
    assert.equal(harness.task.lastError, "keep this diagnostic");
  } finally {
    harness.restore();
  }
});

test("director command service does not regress a reused running command back to queued", async () => {
  const harness = createHarness(createTask({
    status: "running",
    lastError: null,
  }));

  try {
    await harness.service.enqueueContinueCommand("task-1", { forceResume: true });
    harness.commands[0].status = "running";
    harness.task.status = "running";
    harness.taskUpdates.length = 0;

    const accepted = await harness.service.enqueueContinueCommand("task-1", { forceResume: true });

    assert.equal(accepted.commandId, "command-1");
    assert.equal(accepted.status, "running");
    assert.equal(harness.task.status, "running");
    assert.equal(harness.taskUpdates.length, 0);
  } finally {
    harness.restore();
  }
});

test("director command service cancels the durable command when task cancellation wins the acceptance CAS", async () => {
  const harness = createHarness(createTask({
    status: "cancelled",
    cancelRequestedAt: new Date("2026-04-29T12:00:01.000Z"),
    pendingManualRecovery: true,
  }));
  prisma.novelWorkflowTask.updateMany = async () => ({ count: 0 });

  try {
    await assert.rejects(
      () => harness.service.enqueueContinueCommand("task-1", { forceResume: true }),
      (error) => error?.statusCode === 409,
    );
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.commands[0].status, "cancelled");
    assert.match(harness.commands[0].errorMessage, /未被接受/);
    assert.equal(harness.task.status, "cancelled");
    assert.ok(harness.task.cancelRequestedAt instanceof Date);
  } finally {
    harness.restore();
  }
});

test("director command service rejects stale recovery without creating a command when the observed task heartbeat has advanced", async () => {
  const observedAt = new Date("2026-04-29T12:00:00.000Z");
  const harness = createHarness(createTask({
    status: "running",
    currentItemKey: "beat_sheet",
    heartbeatAt: observedAt,
    updatedAt: observedAt,
    cancelRequestedAt: null,
  }));
  harness.task.heartbeatAt = new Date("2026-04-29T12:00:05.000Z");
  harness.task.updatedAt = new Date("2026-04-29T12:00:05.000Z");

  try {
    await assert.rejects(
      () => harness.service.enqueueContinueCommand("task-1", {
        continuationMode: "resume",
        forceResume: true,
      }, {
        expectedTaskState: {
          status: "running",
          updatedAt: observedAt,
          heartbeatAt: observedAt,
          currentItemKey: "beat_sheet",
        },
      }),
      (error) => error?.statusCode === 409,
    );

    assert.equal(harness.commands.length, 0);
    assert.equal(harness.task.status, "running");
    assert.equal(harness.task.updatedAt.toISOString(), "2026-04-29T12:00:05.000Z");
  } finally {
    harness.restore();
  }
});

test("director command service repairs a historical orphan queued command only when the stale snapshot still matches", async () => {
  const harness = createHarness(createTask({
    status: "running",
    currentItemKey: "beat_sheet",
    heartbeatAt: new Date("2026-04-29T12:00:00.000Z"),
    updatedAt: new Date("2026-04-29T12:00:00.000Z"),
    cancelRequestedAt: null,
  }));

  try {
    await harness.service.enqueueContinueCommand("task-1", { forceResume: true });
    const staleSnapshot = {
      status: "running",
      currentItemKey: "beat_sheet",
      heartbeatAt: new Date("2026-04-29T12:01:00.000Z"),
      updatedAt: new Date("2026-04-29T12:01:00.000Z"),
    };
    Object.assign(harness.task, staleSnapshot, { lastError: "historical orphan command" });
    harness.taskUpdates.length = 0;

    const accepted = await harness.service.enqueueContinueCommand("task-1", {
      continuationMode: "resume",
      forceResume: true,
    }, {
      expectedTaskState: staleSnapshot,
    });

    assert.equal(accepted.commandId, "command-1");
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.commands[0].status, "queued");
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.lastError, null);
    assert.equal(harness.taskUpdates.length, 1);
  } finally {
    harness.restore();
  }
});

test("director command service queues candidate confirmation as a serialized command", async () => {
  const harness = createHarness(createTask({
    novelId: null,
    status: "waiting_approval",
  }));
  try {
    const accepted = await harness.service.enqueueConfirmCandidateCommand(createConfirmRequest());

    assert.equal(accepted.status, "queued");
    assert.equal(accepted.commandType, "confirm_candidate");
    assert.equal(accepted.taskId, "task-1");
    assert.equal(accepted.novelId, null);
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.bootstraps.length, 1);
    assert.equal(harness.bootstraps[0].lane, "auto_director");
    assert.equal(harness.bootstraps[0].initialState.itemKey, "candidate_confirm");
    const payload = JSON.parse(harness.commands[0].payloadJson);
    assert.equal(payload.confirmRequest.workflowTaskId, "task-1");
    assert.equal(payload.confirmRequest.runMode, "auto_to_execution");
    assert.equal(payload.confirmRequest.candidate.workingTitle, "Neon Archive");
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.currentItemKey, "candidate_confirm");
    assert.equal(harness.task.currentItemLabel, "书级方向提交完成，等待 AI 创建小说项目");
    assert.equal(harness.task.pendingManualRecovery, false);
  } finally {
    harness.restore();
  }
});

test("director command service queues candidate generation as a serialized command", async () => {
  const harness = createHarness(createTask({
    novelId: null,
    status: "queued",
  }));
  try {
    const accepted = await harness.service.enqueueGenerateCandidatesCommand(createCandidatesRequest());

    assert.equal(accepted.status, "queued");
    assert.equal(accepted.commandType, "generate_candidates");
    assert.equal(accepted.taskId, "task-1");
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.bootstraps.length, 1);
    assert.equal(harness.bootstraps[0].initialState.itemKey, "candidate_direction_batch");
    const payload = JSON.parse(harness.commands[0].payloadJson);
    assert.equal(payload.candidatesRequest.workflowTaskId, "task-1");
    assert.equal(payload.candidatesRequest.idea, "A college girl accidentally enters a supernatural organization.");
    assert.equal(harness.task.currentItemLabel, "AI 正在生成书级方向候选");
  } finally {
    harness.restore();
  }
});

test("director command service reuses active candidate generation commands", async () => {
  const harness = createHarness(createTask({
    novelId: null,
    status: "queued",
  }));
  try {
    const first = await harness.service.enqueueGenerateCandidatesCommand(createCandidatesRequest());
    const second = await harness.service.enqueueGenerateCandidatesCommand(createCandidatesRequest());

    assert.equal(first.commandId, second.commandId);
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.commands[0].commandType, "generate_candidates");
  } finally {
    harness.restore();
  }
});

test("director command service queues approve gate as a one-shot command", async () => {
  const harness = createHarness();
  try {
    const accepted = await harness.service.enqueueApproveGateCommand("task-1");

    assert.equal(accepted.status, "queued");
    assert.equal(accepted.commandType, "approve_gate");
    assert.equal(harness.commands.length, 1);
    const payload = JSON.parse(harness.commands[0].payloadJson);
    assert.equal(payload.continuationMode, "resume");
    assert.equal(payload.forceResume, true);
    assert.equal(harness.task.currentItemKey, "approve_gate");
  } finally {
    harness.restore();
  }
});

test("director command service queues policy updates without directly mutating runtime policy", async () => {
  const harness = createHarness();
  try {
    const accepted = await harness.service.enqueuePolicyUpdateCommand("task-1", {
      mode: "run_next_step",
      autoApproveActions: ["chapter_execution_continue"],
    });

    assert.equal(accepted.status, "queued");
    assert.equal(accepted.commandType, "policy_update");
    assert.equal(harness.commands.length, 1);
    const payload = JSON.parse(harness.commands[0].payloadJson);
    assert.equal(payload.policyUpdateRequest.mode, "run_next_step");
    assert.deepEqual(payload.policyUpdateRequest.autoApproveActions, ["chapter_execution_continue"]);
    assert.equal(harness.task.currentItemKey, "policy_update");
    assert.equal(harness.task.currentItemLabel, "已提交运行策略调整，等待 AI 按新策略推进");
  } finally {
    harness.restore();
  }
});

test("director command service applies the full-book autopilot contract before queueing confirmation", async () => {
  const harness = createHarness(createTask({
    novelId: null,
    status: "waiting_approval",
  }));
  try {
    await harness.service.enqueueConfirmCandidateCommand(createConfirmRequest({
      runMode: "full_book_autopilot",
      autoExecutionPlan: {
        mode: "chapter_range",
        endOrder: 10,
        autoReview: false,
        autoRepair: false,
      },
      autoApproval: {
        enabled: false,
        approvalPointCodes: ["candidate_direction_confirmed"],
      },
    }));

    const payload = JSON.parse(harness.commands[0].payloadJson);
    assert.equal(payload.confirmRequest.runMode, "full_book_autopilot");
    assert.deepEqual(payload.confirmRequest.autoExecutionPlan, {
      mode: "book",
      autoReview: true,
      autoRepair: true,
    });
    assert.equal(payload.confirmRequest.autoApproval.enabled, true);
    assert.ok(payload.confirmRequest.autoApproval.approvalPointCodes.includes("chapter_execution_continue"));
    assert.ok(payload.confirmRequest.autoApproval.approvalPointCodes.includes("replan_continue"));
    assert.deepEqual(harness.bootstraps[0].seedPayload.autoExecutionPlan, {
      mode: "book",
      autoReview: true,
      autoRepair: true,
    });
    assert.equal(harness.bootstraps[0].seedPayload.autoApproval.enabled, true);
  } finally {
    harness.restore();
  }
});

test("director command service clears manual recovery state when a stale running task is continued", async () => {
  const harness = createHarness(createTask({
    status: "running",
    pendingManualRecovery: true,
    lastError: "Director Worker 已中断，任务已暂停，等待手动恢复。",
  }));
  try {
    const accepted = await harness.service.enqueueContinueCommand("task-1", {
      forceResume: true,
    });

    assert.equal(accepted.status, "queued");
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.pendingManualRecovery, false);
    assert.equal(harness.task.lastError, null);
    assert.equal(harness.task.finishedAt, null);
    assert.equal(harness.task.cancelRequestedAt, null);
    assert.deepEqual(harness.taskUpdates[0].where.status, {
      in: ["queued", "running", "waiting_approval", "failed"],
    });
    assert.equal(harness.taskUpdates[0].where.cancelRequestedAt, null);
  } finally {
    harness.restore();
  }
});

test("director command service reuses active takeover command by novel", async () => {
  const harness = createHarness();
  try {
    const first = await harness.service.enqueueTakeoverCommand({
      novelId: "novel-1",
      entryStep: "structured",
      strategy: "continue_existing",
    });
    const second = await harness.service.enqueueTakeoverCommand({
      novelId: "novel-1",
      entryStep: "structured",
      strategy: "continue_existing",
    });
    assert.equal(first.commandId, second.commandId);
    assert.equal(first.commandType, "takeover");
    assert.equal(harness.commands.length, 1);
  } finally {
    harness.restore();
  }
});

test("director command service queues chapter title repair without clearing the warning", async () => {
  const harness = createHarness(createTask({
    status: "failed",
    lastError: "章节标题过于相似，需要修复。",
  }));
  try {
    const accepted = await harness.service.enqueueChapterTitleRepairCommand("task-1", {
      volumeId: " volume-1 ",
    });

    assert.equal(accepted.status, "queued");
    assert.equal(accepted.commandType, "repair_chapter_titles");
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.commands[0].payloadJson, "{\"volumeId\":\"volume-1\"}");
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.lastError, "章节标题过于相似，需要修复。");
    assert.equal("lastError" in harness.taskUpdates[0].data, false);
  } finally {
    harness.restore();
  }
});

test("director command service queues chapter title repair with a null volume filter", async () => {
  const harness = createHarness(createTask({ status: "failed" }));
  try {
    const accepted = await harness.service.enqueueChapterTitleRepairCommand("task-1", {
      volumeId: "   ",
    });

    assert.equal(accepted.commandType, "repair_chapter_titles");
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.commands[0].payloadJson, "{\"volumeId\":null}");
    assert.equal("lastError" in harness.taskUpdates[0].data, false);
  } finally {
    harness.restore();
  }
});

test("director command service accepts retry command, attempt, cancellation reset, and model override atomically", async () => {
  const cancelledAt = new Date("2026-04-29T12:00:00.000Z");
  const harness = createHarness(createTask({
    status: "cancelled",
    cancelRequestedAt: cancelledAt,
    attemptCount: 2,
    lastError: "用户已取消",
  }));
  try {
    const accepted = await harness.service.enqueueRetryCommand({
      taskId: "task-1",
      llmOverride: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        temperature: 0.4,
      },
      batchAlreadyStartedCount: 6,
    });

    assert.equal(accepted.status, "queued");
    assert.equal(accepted.commandType, "retry");
    assert.equal(harness.commands.length, 1);
    assert.deepEqual(JSON.parse(harness.commands[0].payloadJson), {
      batchAlreadyStartedCount: 6,
      forceResume: true,
    });
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.attemptCount, 3);
    assert.equal(harness.task.cancelRequestedAt, null);
    assert.equal(harness.task.lastError, null);
    const seedPayload = JSON.parse(harness.task.seedPayloadJson);
    assert.equal(seedPayload.provider, "anthropic");
    assert.equal(seedPayload.model, "claude-sonnet-4-5");
    assert.equal(seedPayload.temperature, 0.4);
    assert.equal(seedPayload.directorInput.provider, "anthropic");
    assert.equal(seedPayload.directorInput.model, "claude-sonnet-4-5");
  } finally {
    harness.restore();
  }
});

test("director command service rolls back retry task and model override when command creation fails", async () => {
  const harness = createHarness(createTask({
    status: "failed",
    attemptCount: 2,
    lastError: "provider unavailable",
  }));
  const before = {
    status: harness.task.status,
    attemptCount: harness.task.attemptCount,
    cancelRequestedAt: harness.task.cancelRequestedAt,
    seedPayloadJson: harness.task.seedPayloadJson,
    lastError: harness.task.lastError,
  };
  prisma.directorRunCommand.create = async () => {
    throw new Error("command create failed");
  };

  try {
    await assert.rejects(
      () => harness.service.enqueueRetryCommand({
        taskId: "task-1",
        llmOverride: {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          temperature: 0.4,
        },
      }),
      /command create failed/,
    );
    assert.deepEqual({
      status: harness.task.status,
      attemptCount: harness.task.attemptCount,
      cancelRequestedAt: harness.task.cancelRequestedAt,
      seedPayloadJson: harness.task.seedPayloadJson,
      lastError: harness.task.lastError,
    }, before);
    assert.equal(harness.commands.length, 0);
  } finally {
    harness.restore();
  }
});

test("director command service retry CAS does not overwrite a task that became active after lookup", async () => {
  const harness = createHarness(createTask({
    status: "failed",
    attemptCount: 2,
    lastError: "stale failure",
  }));
  const transaction = prisma.$transaction;
  let injected = false;
  prisma.$transaction = async (callback) => {
    if (!injected) {
      injected = true;
      harness.task.status = "running";
      harness.task.lastError = null;
      harness.task.updatedAt = new Date(harness.task.updatedAt.getTime() + 10);
    }
    return transaction(callback);
  };

  try {
    await assert.rejects(
      () => harness.service.enqueueRetryCommand({ taskId: "task-1" }),
      /already being retried|no longer accepts|retryable/i,
    );
    assert.equal(harness.task.status, "running");
    assert.equal(harness.task.attemptCount, 2);
    assert.equal(harness.task.lastError, null);
    assert.equal(harness.commands.length, 0);
  } finally {
    harness.restore();
  }
});

test("director command service explicit retry atomically supersedes an expired old command instead of requeueing it", async () => {
  const harness = createHarness(createTask({
    status: "failed",
    attemptCount: 2,
    lastError: "旧模型执行失败",
  }));
  harness.commands.push({
    id: "command-1",
    taskId: "task-1",
    novelId: "novel-1",
    commandType: "continue",
    idempotencyKey: "continue:old",
    status: "running",
    leaseOwner: "worker-old",
    leaseExpiresAt: new Date("2026-04-29T11:59:00.000Z"),
    attempt: 1,
    runAfter: new Date("2026-04-29T11:00:00.000Z"),
    payloadJson: JSON.stringify({ forceResume: true }),
    errorMessage: null,
    startedAt: new Date("2026-04-29T11:30:00.000Z"),
    finishedAt: null,
    createdAt: new Date("2026-04-29T11:00:00.000Z"),
    updatedAt: new Date("2026-04-29T11:30:00.000Z"),
  });

  try {
    const accepted = await harness.service.enqueueRetryCommand({
      taskId: "task-1",
      llmOverride: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        temperature: 0.4,
      },
    });

    assert.equal(accepted.commandId, "command-2");
    assert.equal(harness.commands[0].status, "stale");
    assert.match(harness.commands[0].errorMessage, /显式重试/);
    assert.equal(harness.commands[1].status, "queued");
    assert.equal(harness.commands[1].commandType, "retry");
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.attemptCount, 3);
    assert.equal(JSON.parse(harness.task.seedPayloadJson).model, "claude-sonnet-4-5");
  } finally {
    harness.restore();
  }
});

test("director command service leases a queued command once", async () => {
  const harness = createHarness();
  try {
    await harness.service.enqueueContinueCommand("task-1");
    const leased = await harness.service.leaseNextCommand({
      workerId: "worker-a",
      leaseMs: 30_000,
    });
    assert.equal(leased.id, "command-1");
    assert.equal(leased.status, "leased");
    assert.equal(leased.leaseOwner, "worker-a");
    assert.equal(leased.attempt, 1);
    const next = await harness.service.leaseNextCommand({
      workerId: "worker-b",
      leaseMs: 30_000,
    });
    assert.equal(next, null);
  } finally {
    harness.restore();
  }
});

test("director command service marks a leased command cancelled and closes running children", async () => {
  const harness = createHarness();
  try {
    await harness.service.enqueueContinueCommand("task-1");
    const leased = await harness.service.leaseNextCommand({
      workerId: "worker-a",
      leaseMs: 30_000,
    });

    await harness.service.markCommandCancelled(leased.id, "worker-a");

    assert.equal(harness.commands[0].status, "cancelled");
    assert.equal(harness.commands[0].leaseExpiresAt, null);
    assert.equal(harness.commands[0].errorMessage, "自动导演任务已取消。");
    assert.equal(harness.stepUpdates.length, 1);
    assert.equal(harness.stepUpdates[0].where.taskId, "task-1");
    assert.equal(harness.stepUpdates[0].where.status, "running");
    assert.equal(harness.stepUpdates[0].data.status, "failed");
    assert.equal(harness.stepUpdates[0].data.error, "自动导演任务已取消。");
    assert.equal(harness.jobUpdates.length, 1);
    assert.deepEqual(harness.jobUpdates[0].where.status, { in: ["queued", "running"] });
    assert.deepEqual(harness.jobUpdates[0].where.payload, { contains: "task-1" });
    assert.equal(harness.jobUpdates[0].data.status, "cancelled");
    assert.equal(harness.directorEvents.length, 1);
    assert.equal(harness.directorEvents[0].type, "run_cancelled");
    assert.equal(harness.directorEvents[0].summary, "自动导演已停止，后台运行状态已收束。");
  } finally {
    harness.restore();
  }
});

test("director lease cancellation rolls back task and command state when runtime cleanup fails", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.task.status = "running";
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].leaseExpiresAt = new Date(Date.now() + 30_000);
    const snapshot = { ...harness.task };

    prisma.directorEvent.create = async () => {
      throw new Error("cancel audit write failed");
    };

    await assert.rejects(
      () => harness.leaseService.cancelTaskAndCommands(snapshot),
      /cancel audit write failed/,
    );

    assert.equal(harness.task.status, "running");
    assert.equal(harness.task.cancelRequestedAt, null);
    assert.equal(harness.commands[0].status, "running");
    assert.equal(harness.commands[0].leaseOwner, "worker-a");
    assert.ok(harness.commands[0].leaseExpiresAt instanceof Date);
    assert.equal(harness.commands.some((command) => command.commandType === "cancel"), false);
  } finally {
    harness.restore();
  }
});

test("director lease cancellation is idempotent and clears active ownership exactly once", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.task.status = "running";
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].leaseExpiresAt = new Date(Date.now() + 30_000);

    const first = await harness.leaseService.cancelTaskAndCommands({ ...harness.task });
    const second = await harness.leaseService.cancelTaskAndCommands({ ...harness.task });

    assert.equal(first.taskChanged, true);
    assert.equal(second.taskChanged, false);
    assert.equal(first.command.id, second.command.id);
    assert.equal(harness.task.status, "cancelled");
    assert.ok(harness.task.cancelRequestedAt instanceof Date);
    assert.equal(harness.commands[0].status, "cancelled");
    assert.equal(harness.commands[0].leaseOwner, null);
    assert.equal(harness.commands[0].leaseExpiresAt, null);
    assert.equal(harness.commands.filter((command) => command.commandType === "cancel").length, 1);
    assert.equal(harness.directorEvents.length, 1);
  } finally {
    harness.restore();
  }
});

test("director lease cancellation rejects a stale cancelled snapshot after retry has claimed the task", async () => {
  const cancelledAt = new Date("2026-04-29T12:00:00.000Z");
  const staleCancelledSnapshot = createTask({
    status: "cancelled",
    cancelRequestedAt: cancelledAt,
    attemptCount: 1,
    updatedAt: new Date("2026-04-29T12:00:01.000Z"),
  });
  const harness = createHarness(createTask({
    status: "queued",
    cancelRequestedAt: null,
    attemptCount: 2,
    updatedAt: new Date("2026-04-29T12:00:02.000Z"),
  }));
  try {
    await harness.service.enqueueContinueCommand("task-1");
    const retryCommand = harness.commands[0];

    await assert.rejects(
      () => harness.leaseService.cancelTaskAndCommands(staleCancelledSnapshot),
      /Task state changed before cancellation was accepted/,
    );

    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.cancelRequestedAt, null);
    assert.equal(retryCommand.status, "queued");
    assert.equal(harness.commands.some((command) => command.commandType === "cancel"), false);
    assert.equal(harness.stepUpdates.length, 0);
    assert.equal(harness.jobUpdates.length, 0);
    assert.equal(harness.directorEvents.length, 0);
  } finally {
    harness.restore();
  }
});

test("director lease cancellation requires the full cancelled task snapshot before repairing a missing audit", async () => {
  const cancelledAt = new Date("2026-04-29T12:00:00.000Z");
  const staleCancelledSnapshot = createTask({
    status: "cancelled",
    cancelRequestedAt: cancelledAt,
    attemptCount: 1,
    updatedAt: new Date("2026-04-29T12:00:01.000Z"),
  });
  const harness = createHarness(createTask({
    status: "cancelled",
    cancelRequestedAt: cancelledAt,
    attemptCount: 2,
    updatedAt: new Date("2026-04-29T12:00:02.000Z"),
  }));
  try {
    await assert.rejects(
      () => harness.leaseService.cancelTaskAndCommands(staleCancelledSnapshot),
      /Task state changed before cancellation was accepted/,
    );

    assert.equal(harness.task.status, "cancelled");
    assert.equal(harness.task.cancelRequestedAt, cancelledAt);
    assert.equal(harness.task.attemptCount, 2);
    assert.equal(harness.commands.length, 0);
    assert.equal(harness.stepUpdates.length, 0);
    assert.equal(harness.jobUpdates.length, 0);
    assert.equal(harness.directorEvents.length, 0);
  } finally {
    harness.restore();
  }
});

test("director lease cancellation never reuses an unrelated cancel command after a unique conflict", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  try {
    await prisma.directorRunCommand.create({
      data: {
        taskId: "task-1",
        novelId: "novel-1",
        commandType: "cancel",
        idempotencyKey: "cancel:1",
        status: "succeeded",
        payloadJson: "{}",
        finishedAt: new Date("2026-04-29T11:00:00.000Z"),
      },
    });
    const uniqueError = new Error("different unique constraint failed");
    uniqueError.code = "P2002";
    prisma.directorRunCommand.create = async () => {
      throw uniqueError;
    };

    await assert.rejects(
      () => harness.leaseService.cancelTaskAndCommands({ ...harness.task }),
      (error) => error === uniqueError,
    );

    assert.equal(harness.task.status, "running");
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.commands[0].idempotencyKey, "cancel:1");
  } finally {
    harness.restore();
  }
});

test("director lease cancellation preserves completion that wins the task CAS", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  const transactionalUpdate = prisma.novelWorkflowTask.updateMany;
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.task.status = "running";
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].leaseExpiresAt = new Date(Date.now() + 30_000);
    const snapshot = { ...harness.task };

    prisma.$transaction = async (callback) => callback(prisma);
    let completionInjected = false;
    prisma.novelWorkflowTask.updateMany = async (args) => {
      if (!completionInjected && args?.data?.status === "cancelled") {
        completionInjected = true;
        harness.task.status = "succeeded";
        harness.task.finishedAt = new Date();
        harness.task.updatedAt = new Date(harness.task.updatedAt.getTime() + 1);
        harness.commands[0].status = "succeeded";
        harness.commands[0].leaseOwner = null;
        harness.commands[0].leaseExpiresAt = null;
        harness.commands[0].finishedAt = new Date();
      }
      return transactionalUpdate(args);
    };

    await assert.rejects(
      () => harness.leaseService.cancelTaskAndCommands(snapshot),
      /Task state changed before cancellation was accepted/,
    );

    assert.equal(harness.task.status, "succeeded");
    assert.equal(harness.task.cancelRequestedAt, null);
    assert.equal(harness.commands[0].status, "succeeded");
    assert.equal(harness.commands.some((command) => command.commandType === "cancel"), false);
    assert.equal(harness.stepUpdates.length, 0);
    assert.equal(harness.jobUpdates.length, 0);
    assert.equal(harness.directorEvents.length, 0);
  } finally {
    harness.restore();
  }
});

test("director cancellation does not rewrite succeeded commands and a later retry stays queued", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.task.status = "running";
    harness.commands[0].status = "succeeded";
    harness.commands[0].leaseOwner = null;
    harness.commands[0].leaseExpiresAt = null;
    harness.commands[0].finishedAt = new Date();

    await harness.service.enqueueCancelCommand("task-1");

    assert.equal(harness.commands[0].status, "succeeded");
    assert.equal(harness.task.status, "cancelled");
    const retry = await harness.service.enqueueRetryCommand({ taskId: "task-1" });
    const retryCommand = harness.commands.find((command) => command.id === retry.commandId);

    assert.equal(retryCommand.commandType, "retry");
    assert.equal(retryCommand.status, "queued");
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.cancelRequestedAt, null);
    assert.equal(harness.commands[0].status, "succeeded");
  } finally {
    harness.restore();
  }
});

test("director command service rejects every terminal or renewal CAS after lease expiry", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].leaseExpiresAt = new Date(Date.now() - 1_000);
    const originalStartedAt = harness.commands[0].startedAt;
    const originalStatus = harness.commands[0].status;

    assert.equal(await harness.service.markCommandRunning("command-1", "worker-a", 30_000), false);
    assert.equal(await harness.service.renewLease("command-1", "worker-a", 30_000), false);
    assert.equal(await harness.service.markCommandSucceeded("command-1", "worker-a"), false);
    assert.equal(await harness.service.markCommandCancelled("command-1", "worker-a"), false);
    assert.equal(await harness.service.markCommandFailed("command-1", "worker-a", new Error("late failure")), false);

    assert.equal(harness.commands[0].status, originalStatus);
    assert.equal(harness.commands[0].startedAt, originalStartedAt);
    assert.equal(harness.requeued.length, 0, "an expired owner must not requeue the task");
    assert.equal(harness.stepUpdates.length, 0, "an expired owner must not project a step failure");
  } finally {
    harness.restore();
  }
});

test("director command service auto requeues first stale continue lease", async () => {
  const harness = createHarness(createTask({
    status: "running",
    pendingManualRecovery: false,
    lastError: null,
  }));
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].attempt = 1;
    harness.commands[0].leaseExpiresAt = new Date("2026-04-29T12:00:00.000Z");
    const count = await harness.service.recoverStaleLeases(new Date("2026-04-29T12:01:00.000Z"));
    assert.equal(count, 1);
    assert.equal(harness.commands[0].status, "queued");
    assert.equal(harness.commands[0].leaseOwner, null);
    assert.equal(harness.commands[0].leaseExpiresAt, null);
    assert.equal(harness.commands[0].startedAt, null);
    assert.equal(harness.commands[0].finishedAt, null);
    assert.equal(harness.commands[0].errorMessage, "\u540e\u53f0\u6267\u884c\u4e2d\u65ad\uff0c\u7cfb\u7edf\u5df2\u81ea\u52a8\u4ece\u6700\u8fd1\u8fdb\u5ea6\u7ee7\u7eed\u3002");
    assert.equal(harness.requeued.length, 0);
    assert.equal(harness.stepUpdates.length, 0);
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.pendingManualRecovery, false);
    assert.equal(harness.task.lastError, null);
  } finally {
    harness.restore();
  }
});

test("director command service marks exhausted expired leases stale and requeues task recovery", async () => {
  const harness = createHarness();
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].attempt = 2;
    harness.commands[0].leaseExpiresAt = new Date("2026-04-29T12:00:00.000Z");
    const count = await harness.service.recoverStaleLeases(new Date("2026-04-29T12:01:00.000Z"));
    assert.equal(count, 1);
    assert.equal(harness.commands[0].status, "stale");
    assert.equal(harness.requeued.length, 0, "manual stale recovery must not use the cancellation-clearing workflow facade");
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.pendingManualRecovery, true);
    assert.match(harness.task.lastError, /\u70b9\u51fb\u6062\u590d/);
    assert.equal(harness.taskUpdates.at(-1).where.cancelRequestedAt, null);
    assert.deepEqual(harness.taskUpdates.at(-1).where.status, {
      in: ["queued", "running", "waiting_approval", "failed"],
    });
    assert.equal(harness.stepUpdates.length, 1);
    assert.equal(harness.stepUpdates[0].where.taskId, "task-1");
    assert.equal(harness.stepUpdates[0].where.status, "running");
    assert.equal(harness.stepUpdates[0].data.status, "failed");
    assert.match(harness.stepUpdates[0].data.error, /\u79df\u7ea6\u8fc7\u671f/);
  } finally {
    harness.restore();
  }
});

test("director command service does not recover a stale lease that was renewed after the scan", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].attempt = 1;
    harness.commands[0].leaseExpiresAt = new Date("2026-04-29T12:00:00.000Z");
    harness.task.status = "running";
    harness.taskUpdates.length = 0;

    const updateMany = prisma.directorRunCommand.updateMany;
    let renewed = false;
    prisma.directorRunCommand.updateMany = async (args) => {
      if (!renewed && args?.data?.status === "queued") {
        renewed = true;
        harness.commands[0].leaseExpiresAt = new Date("2026-04-29T12:05:00.000Z");
      }
      return updateMany(args);
    };

    const count = await harness.service.recoverStaleLeases(new Date("2026-04-29T12:01:00.000Z"));

    assert.equal(count, 0);
    assert.equal(harness.commands[0].status, "running");
    assert.equal(harness.commands[0].leaseOwner, "worker-a");
    assert.equal(harness.commands[0].leaseExpiresAt.toISOString(), "2026-04-29T12:05:00.000Z");
    assert.equal(harness.task.status, "running");
    assert.equal(harness.taskUpdates.length, 0, "CAS miss must never project the workflow task");
  } finally {
    harness.restore();
  }
});

test("director command service does not recover a stale lease that completed after the scan", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].attempt = 1;
    harness.commands[0].leaseExpiresAt = new Date("2026-04-29T12:00:00.000Z");
    harness.task.status = "running";
    harness.taskUpdates.length = 0;

    const updateMany = prisma.directorRunCommand.updateMany;
    let completed = false;
    prisma.directorRunCommand.updateMany = async (args) => {
      if (!completed && args?.data?.status === "queued") {
        completed = true;
        harness.commands[0].status = "succeeded";
        harness.commands[0].finishedAt = new Date("2026-04-29T12:00:30.000Z");
      }
      return updateMany(args);
    };

    const count = await harness.service.recoverStaleLeases(new Date("2026-04-29T12:01:00.000Z"));

    assert.equal(count, 0);
    assert.equal(harness.commands[0].status, "succeeded");
    assert.equal(harness.task.status, "running");
    assert.equal(harness.taskUpdates.length, 0);
  } finally {
    harness.restore();
  }
});

test("director command service preserves cancellation that wins before stale task projection", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].attempt = 1;
    harness.commands[0].leaseExpiresAt = new Date("2026-04-29T12:00:00.000Z");
    harness.task.status = "running";
    harness.taskUpdates.length = 0;

    const updateMany = prisma.novelWorkflowTask.updateMany;
    const cancelledAt = new Date("2026-04-29T12:00:30.000Z");
    let cancelled = false;
    prisma.novelWorkflowTask.updateMany = async (args) => {
      if (!cancelled) {
        cancelled = true;
        harness.task.status = "cancelled";
        harness.task.cancelRequestedAt = cancelledAt;
      }
      return updateMany(args);
    };

    await harness.service.recoverStaleLeases(new Date("2026-04-29T12:01:00.000Z"));

    assert.equal(harness.task.status, "cancelled");
    assert.equal(harness.task.cancelRequestedAt, cancelledAt);
    assert.ok(!["queued", "leased", "running"].includes(harness.commands[0].status));
  } finally {
    harness.restore();
  }
});

test("director command service auto requeues full-book autopilot stale leases before manual recovery", async () => {
  const harness = createHarness(createTask({
    status: "running",
    pendingManualRecovery: false,
    lastError: null,
  }));
  try {
    await harness.service.enqueueConfirmCandidateCommand(createConfirmRequest({
      runMode: "full_book_autopilot",
    }));
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].attempt = 2;
    harness.commands[0].leaseExpiresAt = new Date("2026-04-29T12:00:00.000Z");

    const count = await harness.service.recoverStaleLeases(new Date("2026-04-29T12:01:00.000Z"));

    assert.equal(count, 1);
    assert.equal(harness.commands[0].status, "queued");
    assert.equal(harness.commands[0].leaseOwner, null);
    assert.equal(harness.commands[0].leaseExpiresAt, null);
    assert.equal(harness.requeued.length, 0);
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.pendingManualRecovery, false);
  } finally {
    harness.restore();
  }
});

test("director command service clears exhausted stale command before accepting a new continue", async () => {
  const harness = createHarness(createTask({
    status: "running",
    pendingManualRecovery: true,
    lastError: "服务重启后任务已暂停，等待手动恢复。",
  }));
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].attempt = 2;
    harness.commands[0].leaseExpiresAt = new Date("2026-04-29T12:00:00.000Z");
    harness.task.status = "running";
    harness.task.pendingManualRecovery = true;
    harness.task.lastError = "服务重启后任务已暂停，等待手动恢复。";

    const accepted = await harness.service.enqueueContinueCommand("task-1");

    assert.equal(harness.commands[0].status, "stale");
    assert.equal(harness.commands.length, 2);
    assert.notEqual(harness.commands[0].idempotencyKey, harness.commands[1].idempotencyKey);
    assert.equal(accepted.commandId, "command-2");
    assert.equal(accepted.status, "queued");
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.pendingManualRecovery, false);
    assert.equal(harness.task.lastError, null);
  } finally {
    harness.restore();
  }
});

test("director command service requeues task recovery when worker execution fails", async () => {
  const harness = createHarness();
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].leaseExpiresAt = new Date(Date.now() + 30_000);

    await harness.service.markCommandFailed("command-1", "worker-a", new Error("worker boom"));

    assert.equal(harness.commands[0].status, "failed");
    assert.equal(harness.commands[0].leaseExpiresAt, null);
    assert.equal(harness.commands[0].errorMessage, "worker boom");
    assert.equal(harness.requeued.length, 0, "failure recovery must use the task CAS transaction, not the healing facade");
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.pendingManualRecovery, true);
    assert.equal(harness.stepUpdates.length, 1);
    assert.equal(harness.stepUpdates[0].where.taskId, "task-1");
    assert.equal(harness.stepUpdates[0].where.status, "running");
    assert.equal(harness.stepUpdates[0].data.status, "failed");
    assert.equal(harness.stepUpdates[0].data.error, "worker boom");
  } finally {
    harness.restore();
  }
});

test("director command service does not resurrect a task when cancellation wins after command failure CAS", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  const originalFindUnique = prisma.novelWorkflowTask.findUnique;
  let injected = false;
  prisma.novelWorkflowTask.findUnique = async ({ where }) => {
    if (where?.id !== harness.task.id) return null;
    const snapshot = { ...harness.task };
    if (!injected) {
      injected = true;
      harness.task.status = "cancelled";
      harness.task.cancelRequestedAt = new Date();
      harness.task.updatedAt = new Date(harness.task.updatedAt.getTime() + 1);
    }
    return snapshot;
  };
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].leaseExpiresAt = new Date(Date.now() + 30_000);

    assert.equal(await harness.service.markCommandFailed("command-1", "worker-a", new Error("worker boom")), true);
    assert.equal(harness.commands[0].status, "failed");
    assert.equal(harness.task.status, "cancelled");
    assert.ok(harness.task.cancelRequestedAt instanceof Date);
    assert.equal(harness.requeued.length, 0);
    assert.equal(harness.stepUpdates.length, 0);
  } finally {
    prisma.novelWorkflowTask.findUnique = originalFindUnique;
    harness.restore();
  }
});

test("director command service does not overwrite a retry task when failure cleanup races with retry", async () => {
  const harness = createHarness(createTask({ status: "running" }));
  const originalFindUnique = prisma.novelWorkflowTask.findUnique;
  let injected = false;
  prisma.novelWorkflowTask.findUnique = async ({ where }) => {
    if (where?.id !== harness.task.id) return null;
    const snapshot = { ...harness.task };
    if (!injected) {
      injected = true;
      harness.task.status = "queued";
      harness.task.attemptCount += 1;
      harness.task.updatedAt = new Date(harness.task.updatedAt.getTime() + 1);
    }
    return snapshot;
  };
  try {
    await harness.service.enqueueContinueCommand("task-1");
    harness.commands[0].status = "running";
    harness.commands[0].leaseOwner = "worker-a";
    harness.commands[0].leaseExpiresAt = new Date(Date.now() + 30_000);

    assert.equal(await harness.service.markCommandFailed("command-1", "worker-a", new Error("worker boom")), true);
    assert.equal(harness.commands[0].status, "failed");
    assert.equal(harness.task.status, "queued");
    assert.equal(harness.task.attemptCount, 1);
    assert.equal(harness.requeued.length, 0);
    assert.equal(harness.stepUpdates.length, 0);
  } finally {
    prisma.novelWorkflowTask.findUnique = originalFindUnique;
    harness.restore();
  }
});
