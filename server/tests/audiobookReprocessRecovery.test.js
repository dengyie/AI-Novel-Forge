const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { prisma } = require("../dist/db/prisma.js");
const { AudiobookTaskService } = require("../dist/services/audiobook/AudiobookTaskService.js");
const {
  audiobookPrecheckService,
} = require("../dist/services/audiobook/AudiobookPrecheckService.js");
const {
  resolveChapterAudioPath,
  resolveChapterAnnotationPath,
  resolveFullBookAudioPath,
  ensureChapterAudioDir,
} = require("../dist/services/audiobook/audiobookPaths.js");

function makeTaskDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ab-reprocess-recovery-"));
}

function makeTask(taskDir) {
  const now = new Date();
  return {
    id: "reprocess-task-1",
    novelId: "novel-1",
    title: "重处理测试书",
    scopeMode: "full",
    chapterIdsJson: JSON.stringify(["chapter-1"]),
    chapterCount: 1,
    completedChapterCount: 1,
    narratorVoice: "voice",
    narratorStyle: "style",
    provider: null,
    model: null,
    temperature: null,
    status: "succeeded",
    progress: 100,
    retryCount: 0,
    maxRetries: 3,
    pendingManualRecovery: false,
    heartbeatAt: now,
    currentStage: "finalizing",
    currentItemKey: null,
    currentItemLabel: "有声书生成完成",
    cancelRequestedAt: null,
    error: null,
    summary: null,
    annotationsJson: JSON.stringify([{ chapterId: "chapter-1", segments: [] }]),
    progressJson: null,
    resultJson: JSON.stringify({ m4b: { status: "ready" } }),
    m4bGenerationToken: "generation-old",
    outputDir: taskDir,
    fullAudioPath: "full-book.wav",
    startedAt: now,
    finishedAt: now,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    llmCallCount: 0,
    lastTokenRecordedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function installArtifacts(taskDir) {
  ensureChapterAudioDir(taskDir, "chapter-1");
  fs.writeFileSync(resolveChapterAudioPath(taskDir, "chapter-1"), Buffer.alloc(64));
  fs.writeFileSync(resolveFullBookAudioPath(taskDir), Buffer.alloc(64));
}

function installValidArtifacts(taskDir) {
  const { buildWavBuffer } = require("../dist/services/audiobook/audiobookWav.js");
  ensureChapterAudioDir(taskDir, "chapter-1");
  const wav = buildWavBuffer(
    Buffer.alloc(800),
    { numChannels: 1, sampleRate: 16000, bitsPerSample: 16 },
  );
  fs.writeFileSync(resolveChapterAudioPath(taskDir, "chapter-1"), wav);
  fs.writeFileSync(resolveFullBookAudioPath(taskDir), wav);
}

function installAnnotationArtifact(taskDir) {
  const annotationPath = resolveChapterAnnotationPath(taskDir, "chapter-1");
  fs.mkdirSync(path.dirname(annotationPath), { recursive: true });
  fs.writeFileSync(annotationPath, JSON.stringify({ chapterId: "chapter-1" }));
  fs.writeFileSync(`${annotationPath}.part`, "partial");
  return annotationPath;
}

test("continue child creation failure restores the parent result while keeping the new generation fence", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  const service = new AudiobookTaskService();
  const originals = {
    taskFindUnique: prisma.audiobookTask.findUnique,
    taskUpdateMany: prisma.audiobookTask.updateMany,
    taskCreate: prisma.audiobookTask.create,
    precheck: audiobookPrecheckService.precheck,
  };
  const originalResultJson = JSON.stringify({
    chapterIds: ["chapter-1"],
    qualityWarnings: ["保留诊断"],
    qualityFlags: [{ code: "voice_overlap" }],
    m4b: { status: "ready", path: "full-book.m4b" },
  });
  const parent = {
    ...makeTask(taskDir),
    resultJson: originalResultJson,
    m4bGenerationToken: "parent-generation-old",
  };
  const writes = [];

  audiobookPrecheckService.precheck = async () => ({
    ok: true,
    novelId: parent.novelId,
    scopeMode: "chapter",
    chapterIds: ["chapter-1"],
    chapterCount: 1,
  });
  prisma.audiobookTask.findUnique = async () => ({ ...parent });
  prisma.audiobookTask.updateMany = async ({ data }) => {
    writes.push({ ...data });
    Object.assign(parent, data);
    return { count: 1 };
  };
  prisma.audiobookTask.create = async () => {
    throw new Error("synthetic child create failure");
  };

  try {
    await assert.rejects(
      service.continueParentTask({
        parentTaskId: parent.id,
        chapterIds: ["chapter-1"],
        mode: "resynthesize",
      }),
      /synthetic child create failure/,
    );
    const claimProjection = JSON.parse(writes[0].resultJson);
    assert.deepEqual(claimProjection.qualityWarnings, ["保留诊断"]);
    assert.deepEqual(claimProjection.qualityFlags, [{ code: "voice_overlap" }]);
    assert.equal("m4b" in claimProjection, false, "continuation must invalidate only the m4b projection");
    assert.equal(parent.resultJson, originalResultJson, "no-wipe child-create failure must restore the exact parent result");
    assert.notEqual(
      parent.m4bGenerationToken,
      "parent-generation-old",
      "rollback must retain the rotated generation so an old worker cannot publish",
    );
  } finally {
    prisma.audiobookTask.findUnique = originals.taskFindUnique;
    prisma.audiobookTask.updateMany = originals.taskUpdateMany;
    prisma.audiobookTask.create = originals.taskCreate;
    audiobookPrecheckService.precheck = originals.precheck;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("reprocess persists one recoverable queued intent before deleting artifacts", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  installArtifacts(taskDir);
  const service = new AudiobookTaskService();
  const originalFindUnique = prisma.audiobookTask.findUnique;
  const originalUpdateMany = prisma.audiobookTask.updateMany;
  const originalEnqueue = service.enqueueTask;
  const row = makeTask(taskDir);
  let updateCount = 0;

  prisma.audiobookTask.findUnique = async () => ({ ...row });
  prisma.audiobookTask.updateMany = async ({ data }) => {
    updateCount += 1;
    if (updateCount === 1) {
      Object.assign(row, data);
      return { count: 1 };
    }
    throw new Error("synthetic final reprocess write failure");
  };
  const enqueued = [];
  service.enqueueTask = (taskId) => { enqueued.push(taskId); };

  try {
    await service.reprocessChapter({
      taskId: row.id,
      chapterId: "chapter-1",
      mode: "resynthesize",
    });
    assert.equal(updateCount, 1, "there must be no fallible post-wipe state transition");
    assert.equal(row.status, "queued", "the durable pre-wipe state must be runnable");
    assert.equal(row.currentStage, "queued");
    assert.equal(row.currentItemKey, "chapter-1");
    assert.equal(row.fullAudioPath, null);
    const intent = JSON.parse(row.progressJson);
    assert.deepEqual(intent.reprocess, {
      chapterId: "chapter-1",
      mode: "resynthesize",
    });
    assert.deepEqual(enqueued, [row.id]);
    assert.equal(fs.existsSync(resolveChapterAudioPath(taskDir, "chapter-1")), false);
    assert.equal(fs.existsSync(resolveFullBookAudioPath(taskDir)), false);
  } finally {
    prisma.audiobookTask.findUnique = originalFindUnique;
    prisma.audiobookTask.updateMany = originalUpdateMany;
    service.enqueueTask = originalEnqueue;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("a cleanup error cannot strand the already-claimed reprocess task outside the queue", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  const chapterDir = path.dirname(resolveChapterAudioPath(taskDir, "chapter-1"));
  fs.mkdirSync(path.dirname(chapterDir), { recursive: true });
  fs.writeFileSync(chapterDir, "not a directory");
  const service = new AudiobookTaskService();
  const originalFindUnique = prisma.audiobookTask.findUnique;
  const originalUpdateMany = prisma.audiobookTask.updateMany;
  const originalEnqueue = service.enqueueTask;
  const row = makeTask(taskDir);
  const enqueued = [];

  prisma.audiobookTask.findUnique = async () => ({ ...row });
  prisma.audiobookTask.updateMany = async ({ data }) => {
    Object.assign(row, data);
    return { count: 1 };
  };
  service.enqueueTask = (taskId) => { enqueued.push(taskId); };

  try {
    await assert.rejects(
      service.reprocessChapter({
        taskId: row.id,
        chapterId: "chapter-1",
        mode: "resynthesize",
      }),
      /ENOTDIR/,
    );
    assert.equal(row.status, "queued");
    assert.deepEqual(JSON.parse(row.progressJson).reprocess, {
      chapterId: "chapter-1",
      mode: "resynthesize",
    });
    assert.deepEqual(enqueued, [row.id], "the worker must retry without requiring a restart");
  } finally {
    prisma.audiobookTask.findUnique = originalFindUnique;
    prisma.audiobookTask.updateMany = originalUpdateMany;
    service.enqueueTask = originalEnqueue;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("reprocess surfaces a chapter artifact unlink failure after persisting and enqueueing the intent", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  installArtifacts(taskDir);
  const service = new AudiobookTaskService();
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
    enqueue: service.enqueueTask,
    unlinkSync: fs.unlinkSync,
  };
  const row = makeTask(taskDir);
  const enqueued = [];
  const chapterAudioPath = resolveChapterAudioPath(taskDir, "chapter-1");

  prisma.audiobookTask.findUnique = async () => ({ ...row });
  prisma.audiobookTask.updateMany = async ({ data }) => {
    Object.assign(row, data);
    return { count: 1 };
  };
  service.enqueueTask = (taskId) => { enqueued.push(taskId); };
  fs.unlinkSync = (target) => {
    if (target === chapterAudioPath) {
      const error = new Error("synthetic permission denied");
      error.code = "EPERM";
      throw error;
    }
    return originals.unlinkSync(target);
  };

  try {
    await assert.rejects(
      service.reprocessChapter({
        taskId: row.id,
        chapterId: "chapter-1",
        mode: "resynthesize",
      }),
      (error) => error?.code === "EPERM",
    );
    assert.equal(row.status, "queued");
    assert.deepEqual(JSON.parse(row.progressJson).reprocess, {
      chapterId: "chapter-1",
      mode: "resynthesize",
    });
    assert.deepEqual(enqueued, [row.id]);
    assert.equal(fs.existsSync(chapterAudioPath), true, "the undeleted stale artifact remains observable");
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
    service.enqueueTask = originals.enqueue;
    fs.unlinkSync = originals.unlinkSync;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("reannotate removes the persisted annotation and both annotation artifacts in the durable claim", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  installArtifacts(taskDir);
  const annotationPath = installAnnotationArtifact(taskDir);
  const service = new AudiobookTaskService();
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
    enqueue: service.enqueueTask,
  };
  const row = makeTask(taskDir);
  row.chapterIdsJson = JSON.stringify(["chapter-1", "chapter-2"]);
  row.annotationsJson = JSON.stringify([
    { chapterId: "chapter-1", segments: [] },
    { chapterId: "chapter-2", segments: [] },
  ]);

  prisma.audiobookTask.findUnique = async () => ({ ...row });
  prisma.audiobookTask.updateMany = async ({ data }) => {
    Object.assign(row, data);
    return { count: 1 };
  };
  service.enqueueTask = () => {};

  try {
    await service.reprocessChapter({
      taskId: row.id,
      chapterId: "chapter-1",
      mode: "reannotate",
    });
    assert.deepEqual(JSON.parse(row.annotationsJson), [
      { chapterId: "chapter-2", segments: [] },
    ]);
    assert.equal(fs.existsSync(annotationPath), false);
    assert.equal(fs.existsSync(`${annotationPath}.part`), false);
    assert.deepEqual(JSON.parse(row.progressJson).reprocess, {
      chapterId: "chapter-1",
      mode: "reannotate",
    });
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
    service.enqueueTask = originals.enqueue;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("startup recovery preserves a durable reprocess intent while requeueing the task", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  const service = new AudiobookTaskService();
  const originals = {
    findMany: prisma.audiobookTask.findMany,
    updateMany: prisma.audiobookTask.updateMany,
    enqueue: service.enqueueTask,
  };
  const intentJson = JSON.stringify({
    reprocess: { chapterId: "chapter-1", mode: "resynthesize" },
  });
  const row = {
    ...makeTask(taskDir),
    status: "queued",
    currentStage: "queued",
    progressJson: intentJson,
  };
  const enqueued = [];

  prisma.audiobookTask.findMany = async (query) => (
    query.select?.resultJson ? [] : [{ ...row }]
  );
  prisma.audiobookTask.updateMany = async ({ data }) => {
    Object.assign(row, data);
    return { count: 1 };
  };
  service.enqueueTask = (taskId) => { enqueued.push(taskId); };

  try {
    await service.resumePendingTasks();
    assert.equal(row.progressJson, intentJson, "recovery must not erase the pre-wipe intent");
    assert.equal(row.status, "queued");
    assert.notEqual(row.m4bGenerationToken, "generation-old");
    assert.deepEqual(enqueued, [row.id]);
  } finally {
    prisma.audiobookTask.findMany = originals.findMany;
    prisma.audiobookTask.updateMany = originals.updateMany;
    service.enqueueTask = originals.enqueue;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("executeTask replays a reannotate wipe before reading novel data", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  installArtifacts(taskDir);
  const annotationPath = installAnnotationArtifact(taskDir);
  const service = new AudiobookTaskService();
  const originals = {
    taskFindUnique: prisma.audiobookTask.findUnique,
    taskUpdateMany: prisma.audiobookTask.updateMany,
    novelFindUnique: prisma.novel.findUnique,
  };
  const row = {
    ...makeTask(taskDir),
    status: "queued",
    currentStage: "queued",
    progress: 0,
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    progressJson: JSON.stringify({
      reprocess: { chapterId: "chapter-1", mode: "reannotate" },
    }),
    annotationsJson: null,
  };
  let novelReadAfterWipe = false;

  prisma.audiobookTask.findUnique = async ({ select }) => {
    if (!select) return { ...row };
    const projected = {};
    for (const key of Object.keys(select)) projected[key] = row[key] ?? null;
    return projected;
  };
  prisma.audiobookTask.updateMany = async ({ data }) => {
    Object.assign(row, data);
    return { count: 1 };
  };
  prisma.novel.findUnique = async () => {
    novelReadAfterWipe = true;
    assert.equal(fs.existsSync(resolveChapterAudioPath(taskDir, "chapter-1")), false);
    assert.equal(fs.existsSync(resolveFullBookAudioPath(taskDir)), false);
    assert.equal(fs.existsSync(annotationPath), false);
    assert.equal(fs.existsSync(`${annotationPath}.part`), false);
    return null;
  };

  try {
    await service.executeTask(row.id);
    assert.equal(novelReadAfterWipe, true);
    assert.equal(row.status, "failed", "the test exits through the existing missing-novel failure path");
  } finally {
    prisma.audiobookTask.findUnique = originals.taskFindUnique;
    prisma.audiobookTask.updateMany = originals.taskUpdateMany;
    prisma.novel.findUnique = originals.novelFindUnique;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("executeTask replays a durable continue resynthesize wipe before reading novel data", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  installArtifacts(taskDir);
  const service = new AudiobookTaskService();
  const originals = {
    taskFindUnique: prisma.audiobookTask.findUnique,
    taskUpdateMany: prisma.audiobookTask.updateMany,
    novelFindUnique: prisma.novel.findUnique,
  };
  const row = {
    ...makeTask(taskDir),
    id: "continue-child-1",
    status: "queued",
    currentStage: "queued",
    progress: 0,
    completedChapterCount: 0,
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    progressJson: JSON.stringify({
      hidden: true,
      parentTaskId: "continue-parent-1",
      parentGenerationToken: "continue-parent-generation-1",
      mode: "resynthesize",
    }),
    resultJson: null,
    fullAudioPath: null,
  };
  const parent = {
    ...makeTask(taskDir),
    id: "continue-parent-1",
    status: "running",
    currentStage: "continuing",
    progress: 2,
    progressJson: JSON.stringify({ deliveryStyleMode: "off" }),
    resultJson: null,
    fullAudioPath: null,
    m4bGenerationToken: "continue-parent-generation-1",
    finishedAt: null,
  };
  let novelReadAfterWipe = false;

  prisma.audiobookTask.findUnique = async ({ where, select }) => {
    const found = where.id === row.id ? row : where.id === parent.id ? parent : null;
    if (!found) return null;
    if (!select) return { ...found };
    const projected = {};
    for (const key of Object.keys(select)) projected[key] = found[key] ?? null;
    return projected;
  };
  prisma.audiobookTask.updateMany = async ({ where, data }) => {
    if (where.id === row.id) Object.assign(row, data);
    if (where.id === parent.id) Object.assign(parent, data);
    return { count: 1 };
  };
  prisma.novel.findUnique = async () => {
    novelReadAfterWipe = true;
    assert.equal(fs.existsSync(resolveChapterAudioPath(taskDir, "chapter-1")), false);
    assert.equal(fs.existsSync(resolveFullBookAudioPath(taskDir)), false);
    return null;
  };

  try {
    await service.executeTask(row.id);
    assert.equal(novelReadAfterWipe, true);
    assert.equal(
      fs.existsSync(resolveChapterAudioPath(taskDir, "chapter-1")),
      false,
      "continue child must not reach pipeline-capable reads with stale chapter audio",
    );
    assert.equal(fs.existsSync(resolveFullBookAudioPath(taskDir)), false);
  } finally {
    prisma.audiobookTask.findUnique = originals.taskFindUnique;
    prisma.audiobookTask.updateMany = originals.taskUpdateMany;
    prisma.novel.findUnique = originals.novelFindUnique;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("executeTask invalidates stale full-book artifacts for a durable missing-chapter continuation", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  installValidArtifacts(taskDir);
  const service = new AudiobookTaskService();
  const originals = {
    taskFindUnique: prisma.audiobookTask.findUnique,
    taskUpdateMany: prisma.audiobookTask.updateMany,
    novelFindUnique: prisma.novel.findUnique,
  };
  const child = {
    ...makeTask(taskDir),
    id: "continue-child-missing",
    chapterIdsJson: JSON.stringify(["chapter-2"]),
    status: "queued",
    currentStage: "queued",
    progress: 0,
    completedChapterCount: 0,
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    progressJson: JSON.stringify({
      hidden: true,
      parentTaskId: "continue-parent-missing",
      parentGenerationToken: "continue-parent-generation-missing",
      mode: null,
    }),
    resultJson: null,
    fullAudioPath: null,
  };
  const parent = {
    ...makeTask(taskDir),
    id: "continue-parent-missing",
    chapterIdsJson: JSON.stringify(["chapter-1", "chapter-2"]),
    chapterCount: 2,
    status: "running",
    currentStage: "continuing",
    progress: 2,
    progressJson: JSON.stringify({ deliveryStyleMode: "off" }),
    resultJson: null,
    fullAudioPath: null,
    m4bGenerationToken: "continue-parent-generation-missing",
    finishedAt: null,
  };
  let novelReadAfterInvalidation = false;

  function project(row, select) {
    if (!select) return { ...row };
    const projected = {};
    for (const key of Object.keys(select)) projected[key] = row[key] ?? null;
    return projected;
  }
  prisma.audiobookTask.findUnique = async ({ where, select }) => {
    if (where.id === child.id) return project(child, select);
    if (where.id === parent.id) return project(parent, select);
    return null;
  };
  prisma.audiobookTask.updateMany = async ({ where, data }) => {
    const row = where.id === child.id ? child : where.id === parent.id ? parent : null;
    if (row) Object.assign(row, data);
    return { count: row ? 1 : 0 };
  };
  prisma.novel.findUnique = async () => {
    novelReadAfterInvalidation = true;
    assert.equal(fs.existsSync(resolveFullBookAudioPath(taskDir)), false);
    assert.equal(
      fs.existsSync(resolveChapterAudioPath(taskDir, "chapter-1")),
      true,
      "missing-chapter continuation must preserve already-ready chapter audio",
    );
    return null;
  };

  try {
    await service.executeTask(child.id);
    assert.equal(novelReadAfterInvalidation, true);
    assert.equal(fs.existsSync(resolveFullBookAudioPath(taskDir)), false);
    assert.equal(fs.existsSync(resolveChapterAudioPath(taskDir, "chapter-1")), true);
  } finally {
    prisma.audiobookTask.findUnique = originals.taskFindUnique;
    prisma.audiobookTask.updateMany = originals.taskUpdateMany;
    prisma.novel.findUnique = originals.novelFindUnique;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("a denied continue resynthesize wipe fails the child and parent without accepting stale disk artifacts", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  installValidArtifacts(taskDir);
  const service = new AudiobookTaskService();
  const originals = {
    taskFindUnique: prisma.audiobookTask.findUnique,
    taskUpdateMany: prisma.audiobookTask.updateMany,
    novelFindUnique: prisma.novel.findUnique,
    unlinkSync: fs.unlinkSync,
  };
  const child = {
    ...makeTask(taskDir),
    id: "continue-child-denied",
    status: "queued",
    currentStage: "queued",
    progress: 0,
    completedChapterCount: 0,
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    progressJson: JSON.stringify({
      hidden: true,
      parentTaskId: "continue-parent-denied",
      parentGenerationToken: "parent-generation",
      mode: "resynthesize",
    }),
    resultJson: null,
    fullAudioPath: null,
  };
  const parent = {
    ...makeTask(taskDir),
    id: "continue-parent-denied",
    status: "running",
    currentStage: "continuing",
    currentItemLabel: "续生成 1 章",
    progress: 2,
    completedChapterCount: 0,
    progressJson: JSON.stringify({ deliveryStyleMode: "off" }),
    resultJson: null,
    fullAudioPath: null,
    m4bGenerationToken: "parent-generation",
    finishedAt: null,
  };
  let novelReadCount = 0;
  const chapterAudioPath = resolveChapterAudioPath(taskDir, "chapter-1");

  function project(row, select) {
    if (!select) return { ...row };
    const projected = {};
    for (const key of Object.keys(select)) projected[key] = row[key] ?? null;
    return projected;
  }
  prisma.audiobookTask.findUnique = async ({ where, select }) => {
    if (where.id === child.id) return project(child, select);
    if (where.id === parent.id) return project(parent, select);
    return null;
  };
  prisma.audiobookTask.updateMany = async ({ where, data }) => {
    const row = where.id === child.id ? child : where.id === parent.id ? parent : null;
    if (!row) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  };
  prisma.novel.findUnique = async () => {
    novelReadCount += 1;
    return null;
  };
  fs.unlinkSync = (target) => {
    if (target === chapterAudioPath) {
      const error = new Error("synthetic continue permission denied");
      error.code = "EPERM";
      throw error;
    }
    return originals.unlinkSync(target);
  };

  try {
    await service.executeTask(child.id);
    assert.equal(novelReadCount, 0, "pipeline-capable reads must not run after cleanup failed");
    assert.equal(child.status, "failed");
    assert.equal(parent.status, "failed", "the parent must expose the failed continuation");
    assert.equal(parent.currentStage, "failed");
    assert.equal(parent.fullAudioPath, null);
    assert.deepEqual(
      JSON.parse(parent.progressJson).failedContinueChapters,
      ["chapter-1"],
      "old chapter.wav cannot prove the requested generation succeeded",
    );
    assert.equal(fs.existsSync(chapterAudioPath), true, "the denied stale artifact remains observable");
  } finally {
    prisma.audiobookTask.findUnique = originals.taskFindUnique;
    prisma.audiobookTask.updateMany = originals.taskUpdateMany;
    prisma.novel.findUnique = originals.novelFindUnique;
    fs.unlinkSync = originals.unlinkSync;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("a stale continue generation cannot wipe artifacts owned by the current parent generation", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  installValidArtifacts(taskDir);
  const service = new AudiobookTaskService();
  const originals = {
    taskFindUnique: prisma.audiobookTask.findUnique,
    taskUpdateMany: prisma.audiobookTask.updateMany,
    novelFindUnique: prisma.novel.findUnique,
  };
  const child = {
    ...makeTask(taskDir),
    id: "continue-child-stale",
    status: "queued",
    currentStage: "queued",
    progress: 0,
    completedChapterCount: 0,
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    progressJson: JSON.stringify({
      hidden: true,
      parentTaskId: "continue-parent-current",
      parentGenerationToken: "parent-generation-old",
      mode: "resynthesize",
    }),
    resultJson: null,
    fullAudioPath: null,
  };
  const parent = {
    ...makeTask(taskDir),
    id: "continue-parent-current",
    status: "running",
    currentStage: "continuing",
    progress: 2,
    progressJson: JSON.stringify({ deliveryStyleMode: "off" }),
    resultJson: null,
    fullAudioPath: null,
    m4bGenerationToken: "parent-generation-current",
    finishedAt: null,
  };
  let novelReadCount = 0;

  function project(row, select) {
    if (!select) return { ...row };
    const projected = {};
    for (const key of Object.keys(select)) projected[key] = row[key] ?? null;
    return projected;
  }
  prisma.audiobookTask.findUnique = async ({ where, select }) => {
    if (where.id === child.id) return project(child, select);
    if (where.id === parent.id) return project(parent, select);
    return null;
  };
  prisma.audiobookTask.updateMany = async ({ where, data }) => {
    const row = where.id === child.id ? child : where.id === parent.id ? parent : null;
    if (!row) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  };
  prisma.novel.findUnique = async () => {
    novelReadCount += 1;
    return null;
  };

  try {
    await service.executeTask(child.id);
    assert.equal(novelReadCount, 0);
    assert.equal(child.status, "cancelled", "stale hidden work must settle without touching the parent");
    assert.equal(parent.status, "running");
    assert.equal(parent.m4bGenerationToken, "parent-generation-current");
    assert.equal(fs.existsSync(resolveChapterAudioPath(taskDir, "chapter-1")), true);
    assert.equal(fs.existsSync(resolveFullBookAudioPath(taskDir)), true);
  } finally {
    prisma.audiobookTask.findUnique = originals.taskFindUnique;
    prisma.audiobookTask.updateMany = originals.taskUpdateMany;
    prisma.novel.findUnique = originals.novelFindUnique;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("executeTask fails the durable reprocess intent before pipeline reads when unlink is denied", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  installArtifacts(taskDir);
  const service = new AudiobookTaskService();
  const originals = {
    taskFindUnique: prisma.audiobookTask.findUnique,
    taskUpdateMany: prisma.audiobookTask.updateMany,
    novelFindUnique: prisma.novel.findUnique,
    unlinkSync: fs.unlinkSync,
  };
  const row = {
    ...makeTask(taskDir),
    status: "queued",
    currentStage: "queued",
    progress: 0,
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    progressJson: JSON.stringify({
      reprocess: { chapterId: "chapter-1", mode: "resynthesize" },
    }),
  };
  const chapterAudioPath = resolveChapterAudioPath(taskDir, "chapter-1");
  let novelReads = 0;

  prisma.audiobookTask.findUnique = async ({ select }) => {
    if (!select) return { ...row };
    const projected = {};
    for (const key of Object.keys(select)) projected[key] = row[key] ?? null;
    return projected;
  };
  prisma.audiobookTask.updateMany = async ({ data }) => {
    Object.assign(row, data);
    return { count: 1 };
  };
  prisma.novel.findUnique = async () => {
    novelReads += 1;
    return null;
  };
  fs.unlinkSync = (target) => {
    if (target === chapterAudioPath) {
      const error = new Error("synthetic permission denied");
      error.code = "EPERM";
      throw error;
    }
    return originals.unlinkSync(target);
  };

  try {
    await service.executeTask(row.id);
    assert.equal(novelReads, 0, "the synthesis pipeline must not observe stale artifacts");
    assert.equal(row.status, "failed");
    assert.match(row.error, /synthetic permission denied/);
  } finally {
    prisma.audiobookTask.findUnique = originals.taskFindUnique;
    prisma.audiobookTask.updateMany = originals.taskUpdateMany;
    prisma.novel.findUnique = originals.novelFindUnique;
    fs.unlinkSync = originals.unlinkSync;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("an old executeTask generation cannot wipe artifacts after its token is superseded", { concurrency: false }, async () => {
  const taskDir = makeTaskDir();
  installArtifacts(taskDir);
  const annotationPath = installAnnotationArtifact(taskDir);
  const service = new AudiobookTaskService();
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  const row = {
    ...makeTask(taskDir),
    status: "queued",
    currentStage: "queued",
    progress: 0,
    pendingManualRecovery: false,
    cancelRequestedAt: null,
    progressJson: JSON.stringify({
      reprocess: { chapterId: "chapter-1", mode: "reannotate" },
    }),
  };
  let initialRead = true;

  prisma.audiobookTask.findUnique = async ({ select }) => {
    if (!select && initialRead) {
      initialRead = false;
      return { ...row };
    }
    const projected = {};
    for (const key of Object.keys(select ?? {})) projected[key] = row[key] ?? null;
    return select ? projected : { ...row };
  };
  prisma.audiobookTask.updateMany = async ({ data }) => {
    Object.assign(row, data);
    // Model a newer recovery/reprocess generation winning immediately after
    // the old queued→running claim and before the old worker enters cleanup.
    row.m4bGenerationToken = "generation-new";
    return { count: 1 };
  };

  try {
    await service.executeTask(row.id);
    assert.equal(fs.existsSync(resolveChapterAudioPath(taskDir, "chapter-1")), true);
    assert.equal(fs.existsSync(resolveFullBookAudioPath(taskDir)), true);
    assert.equal(fs.existsSync(annotationPath), true);
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});
