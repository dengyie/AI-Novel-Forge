/**
 * m4b generation token 回归测试。
 *
 * 复现：generation A 启动后，continue/reprocess 使当前代际切到 B；A 的 ffmpeg
 * 晚完成时不得把自己的 part rename 成规范名，也不得被视为可提交的产物。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  encodeFullBookM4b,
  withAudiobookTaskDirArtifactLock,
} = require("../dist/services/audiobook/audiobookM4b.js");
const { resolveFullBookM4bPath } = require("../dist/services/audiobook/audiobookPaths.js");
const { prisma } = require("../dist/db/prisma.js");
const { AudiobookTaskService } = require("../dist/services/audiobook/AudiobookTaskService.js");

function makeTaskDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ab-m4b-generation-${label}-`));
}

function installFakeFfmpeg(sleepSeconds = 0.25) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-generation-ffmpeg-"));
  const started = path.join(dir, "started");
  const script = path.join(dir, "fake-ffmpeg.sh");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `touch "${started}"`,
      'prev=""',
      'src=""',
      'last=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-i" ] && [ -z "$src" ]; then src="$a"; fi',
      '  last="$a"',
      '  prev="$a"',
      "done",
      'cp "$src" "$last"',
      `sleep ${sleepSeconds}`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { script, started };
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(filePath), true, `expected ${filePath} to appear`);
}

function writeFakeWav(filePath) {
  const dataBytes = 1_000;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16_000, 24);
  buf.writeUInt32LE(32_000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  fs.writeFileSync(filePath, buf);
}

test("stale generation A cannot rename over generation B after continue/reprocess rotates token", { concurrency: false }, async () => {
  const taskDir = makeTaskDir("stale");
  const source = path.join(taskDir, "full-book.wav");
  fs.writeFileSync(source, Buffer.alloc(4096, "A"));
  const fake = installFakeFfmpeg();
  const previousFfmpeg = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake.script;

  let currentGenerationToken = "generation-A";
  try {
    const generationA = encodeFullBookM4b({
      taskDir,
      bookTitle: "测试书",
      chapters: [],
      generationToken: "generation-A",
      isGenerationCurrent: (token) => token === currentGenerationToken,
    });
    await waitForFile(fake.started);

    // continue/reprocess 已持久化并切到 generation B；A 仍在 ffmpeg 中。
    currentGenerationToken = "generation-B";
    const staleResult = await generationA;

    assert.notEqual(staleResult.status, "ready", "generation A 失效后不得报告 ready");
    assert.equal(
      fs.existsSync(resolveFullBookM4bPath(taskDir)),
      false,
      "generation A 完成不得 rename canonical full-book.m4b",
    );

    const generationB = await encodeFullBookM4b({
      taskDir,
      bookTitle: "测试书",
      chapters: [],
      generationToken: "generation-B",
      isGenerationCurrent: (token) => token === currentGenerationToken,
    });
    assert.equal(generationB.status, "ready", generationB.reason);
    assert.equal(fs.existsSync(resolveFullBookM4bPath(taskDir)), true);
  } finally {
    if (previousFfmpeg === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = previousFfmpeg;
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(fake.script), { recursive: true, force: true });
  }
});

test("artifact rotation can abort an encoder without waiting for the full encode lock", { concurrency: false }, async () => {
  const taskDir = makeTaskDir("rotation-abort");
  const source = path.join(taskDir, "full-book.wav");
  fs.writeFileSync(source, Buffer.alloc(4096, "R"));
  const fake = installFakeFfmpeg(5);
  const previousFfmpeg = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake.script;
  const controller = new AbortController();
  let encoding;
  try {
    encoding = encodeFullBookM4b({
      taskDir,
      bookTitle: "轮换中止旧编码",
      chapters: [],
      signal: controller.signal,
    });
    await waitForFile(fake.started);

    await Promise.race([
      withAudiobookTaskDirArtifactLock(taskDir, () => controller.abort()),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("artifact rotation waited for the full ffmpeg run")),
        500,
      )),
    ]);
    const result = await encoding;
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /取消/);
  } finally {
    controller.abort();
    if (encoding) await Promise.allSettled([encoding]);
    if (previousFfmpeg === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = previousFfmpeg;
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(fake.script), { recursive: true, force: true });
  }
});

test("aborted queued generation does not acquire the task-directory lock", { concurrency: false }, async () => {
  const taskDir = makeTaskDir("queued-abort");
  const source = path.join(taskDir, "full-book.wav");
  fs.writeFileSync(source, Buffer.alloc(4096, "Q"));
  const fake = installFakeFfmpeg();
  const previousFfmpeg = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake.script;
  const queuedController = new AbortController();
  try {
    const first = encodeFullBookM4b({
      taskDir,
      bookTitle: "队列第一轮",
      chapters: [],
    });
    await waitForFile(fake.started);
    const queued = encodeFullBookM4b({
      taskDir,
      bookTitle: "队列旧轮",
      chapters: [],
      signal: queuedController.signal,
    });
    queuedController.abort();

    const queuedResult = await queued;
    const firstResult = await first;
    assert.equal(queuedResult.status, "failed");
    assert.equal(queuedResult.reason, "m4b 封装已取消。");
    assert.equal(firstResult.status, "ready", firstResult.reason);
    assert.equal(fs.existsSync(resolveFullBookM4bPath(taskDir)), true);
  } finally {
    if (previousFfmpeg === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = previousFfmpeg;
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(fake.script), { recursive: true, force: true });
  }
});

test("generation rotation cannot interleave between publish check and canonical rename", { concurrency: false }, async () => {
  const taskDir = makeTaskDir("publish-window");
  const source = path.join(taskDir, "full-book.wav");
  fs.writeFileSync(source, Buffer.alloc(4096, "P"));
  const fake = installFakeFfmpeg();
  const previousFfmpeg = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = fake.script;
  let releasePublishCheck;
  const publishCheckBlocked = new Promise((resolve) => { releasePublishCheck = resolve; });
  let publishCheckEntered;
  const publishCheckEnteredPromise = new Promise((resolve) => { publishCheckEntered = resolve; });
  let rotationRan = false;
  try {
    const generationA = encodeFullBookM4b({
      taskDir,
      bookTitle: "发布窗口 A",
      chapters: [],
      generationToken: "generation-A",
      isGenerationCurrent: async () => {
        publishCheckEntered();
        await publishCheckBlocked;
        return true;
      },
    });
    await waitForFile(fake.started);
    await publishCheckEnteredPromise;

    const rotation = withAudiobookTaskDirArtifactLock(taskDir, async () => {
      rotationRan = true;
      fs.rmSync(resolveFullBookM4bPath(taskDir), { force: true });
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rotationRan, false, "rotation must wait for the publish lock");

    releasePublishCheck();
    await Promise.all([generationA, rotation]);
    assert.equal(fs.existsSync(resolveFullBookM4bPath(taskDir)), false, "new-generation wipe must win after publish");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = previousFfmpeg;
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(fake.script), { recursive: true, force: true });
  }
});

test("same generation token settles the m4b projection, while stale/cancelled workers cannot", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originalFindUnique = prisma.audiobookTask.findUnique;
  const originalUpdateMany = prisma.audiobookTask.updateMany;
  const updates = [];
  prisma.audiobookTask.findUnique = async () => ({
    resultJson: JSON.stringify({ chapterIds: ["c1"], qualityWarnings: ["保留此字段"] }),
    m4bGenerationToken: "generation-B",
    status: "succeeded",
  });
  prisma.audiobookTask.updateMany = async (args) => {
    updates.push(args);
    return { count: 1 };
  };
  try {
    await service.settleBackgroundM4b(
      "task-1",
      "有声书生成完成（含 m4b）",
      { status: "ready", path: "full-book.m4b", bytes: 128 },
      { force: true, generationToken: "generation-B" },
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0].where.m4bGenerationToken, "generation-B");
    assert.deepEqual(JSON.parse(updates[0].data.resultJson).m4b, {
      status: "ready",
      path: "full-book.m4b",
      reason: null,
      bytes: 128,
      chapterCount: null,
    });
    assert.deepEqual(JSON.parse(updates[0].data.resultJson).qualityWarnings, ["保留此字段"]);

    updates.length = 0;
    await service.settleBackgroundM4b(
      "task-1",
      "有声书生成完成（含 m4b）",
      { status: "ready", path: "full-book.m4b", bytes: 256 },
      { force: true, generationToken: "generation-A" },
    );
    assert.equal(updates.length, 0, "旧 token 在 settle 前必须被拒绝");

    // 即便 token 仍相同，任务已取消时 updateMany 的 status CAS 也必须落空，
    // 不得把取消后的投影恢复成 ready。
    prisma.audiobookTask.findUnique = async () => ({
      resultJson: "{}",
      m4bGenerationToken: "generation-B",
      status: "cancelled",
    });
    prisma.audiobookTask.updateMany = async (args) => {
      updates.push(args);
      return { count: 0 };
    };
    await service.settleBackgroundM4b(
      "task-1",
      "有声书生成完成（含 m4b）",
      { status: "ready", path: "full-book.m4b", bytes: 128 },
      { force: true, generationToken: "generation-B" },
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0].where.status, "succeeded");
  } finally {
    prisma.audiobookTask.findUnique = originalFindUnique;
    prisma.audiobookTask.updateMany = originalUpdateMany;
  }
});

test("same-generation encoding CAS miss is retryable instead of silently abandoning the terminal projection", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  let reads = 0;
  prisma.audiobookTask.findUnique = async () => {
    reads += 1;
    return {
      resultJson: reads === 1
        ? JSON.stringify({ qualityWarnings: [] , m4b: { status: "encoding" } })
        : JSON.stringify({ qualityWarnings: ["concurrent update"], m4b: { status: "encoding" } }),
      m4bGenerationToken: "generation-current",
      status: "succeeded",
      currentItemLabel: "有声书生成完成（m4b 后台封装中）",
    };
  };
  prisma.audiobookTask.updateMany = async () => ({ count: 0 });

  try {
    await assert.rejects(
      service.settleBackgroundM4b(
        "task-cas-race",
        "有声书生成完成（含 m4b）",
        { status: "ready", path: "full-book.m4b", bytes: 128 },
        { force: false, generationToken: "generation-current" },
      ),
      /m4b settle CAS/i,
    );
    assert.equal(reads, 2, "CAS miss must re-read authority before deciding whether to retry");
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
  }
});

test("same-generation terminal settle is not coupled to the mutable progress label", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  const encodingResult = JSON.stringify({ m4b: { status: "encoding" } });
  const updates = [];
  prisma.audiobookTask.findUnique = async () => ({
    resultJson: encodingResult,
    m4bGenerationToken: "generation-current",
    status: "succeeded",
    currentItemLabel: "同代并发更新后的进度文案",
  });
  prisma.audiobookTask.updateMany = async (args) => {
    updates.push(args);
    return { count: Object.hasOwn(args.where, "currentItemLabel") ? 0 : 1 };
  };

  try {
    await service.settleBackgroundM4b(
      "task-label-race",
      "有声书生成完成（含 m4b）",
      { status: "ready", path: "full-book.m4b", bytes: 128 },
      { force: false, generationToken: "generation-current" },
    );
    assert.equal(updates.length, 1);
    assert.equal(
      Object.hasOwn(updates[0].where, "currentItemLabel"),
      false,
      "generation ownership and resultJson snapshot are the CAS authority",
    );
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
  }
});

test("same-generation projection removal after a CAS miss remains retryable", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  let reads = 0;
  prisma.audiobookTask.findUnique = async () => {
    reads += 1;
    return {
      resultJson: reads === 1
        ? JSON.stringify({ m4b: { status: "encoding" } })
        : JSON.stringify({ qualityWarnings: ["concurrent projection rewrite"] }),
      m4bGenerationToken: "generation-current",
      status: "succeeded",
      currentItemLabel: "同代并发更新后的进度文案",
    };
  };
  prisma.audiobookTask.updateMany = async () => ({ count: 0 });

  try {
    await assert.rejects(
      service.settleBackgroundM4b(
        "task-projection-removed",
        "有声书生成完成（含 m4b）",
        { status: "ready", path: "full-book.m4b", bytes: 128 },
        { force: false, generationToken: "generation-current" },
      ),
      /m4b settle CAS/i,
    );
    assert.equal(reads, 2);
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
  }
});

test("same-generation settle treats an existing terminal projection as idempotent", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  let updates = 0;
  prisma.audiobookTask.findUnique = async () => ({
    resultJson: JSON.stringify({
      qualityWarnings: ["preserve"],
      m4b: { status: "ready", path: "full-book.m4b", bytes: 128 },
    }),
    m4bGenerationToken: "generation-current",
    status: "succeeded",
    currentItemLabel: "有声书生成完成（m4b 后台封装中）",
  });
  prisma.audiobookTask.updateMany = async () => {
    updates += 1;
    return { count: 1 };
  };

  try {
    await service.settleBackgroundM4b(
      "task-already-terminal",
      "有声书生成完成；m4b 失败（late duplicate）",
      { status: "failed", reason: "late duplicate" },
      { force: false, generationToken: "generation-current" },
    );
    assert.equal(updates, 0, "a delayed same-generation callback must not replace a durable terminal state");
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
  }
});

test("restart recovery rotates the persisted token before re-queueing a stale worker", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originalFindMany = prisma.audiobookTask.findMany;
  const originalUpdateMany = prisma.audiobookTask.updateMany;
  const originalEnqueue = service.enqueueTask;
  const updates = [];
  const enqueued = [];
  prisma.audiobookTask.findMany = async (query) => {
    if (!query.where?.status?.in) return [];
    return [
      {
        id: "task-restart",
        novelId: "novel-1",
        outputDir: makeTaskDir("restart"),
        progress: 42,
        progressJson: null,
        currentStage: "synthesizing",
        status: "running",
        cancelRequestedAt: null,
        m4bGenerationToken: "generation-A",
      },
      {
        id: "task-legacy-null",
        novelId: "novel-1",
        outputDir: makeTaskDir("legacy-null"),
        progress: 42,
        progressJson: null,
        currentStage: "synthesizing",
        status: "queued",
        cancelRequestedAt: null,
        m4bGenerationToken: null,
      },
    ];
  };
  prisma.audiobookTask.updateMany = async (args) => {
    updates.push(args);
    return { count: 1 };
  };
  service.enqueueTask = (taskId) => enqueued.push(taskId);
  try {
    await service.resumePendingTasks();
    assert.equal(updates.length, 2);
    assert.equal(updates[0].where.m4bGenerationToken, "generation-A");
    assert.notEqual(updates[0].data.m4bGenerationToken, "generation-A");
    assert.equal(updates[1].where.m4bGenerationToken, null, "legacy NULL token must remain a NULL CAS predicate");
    assert.ok(updates[1].data.m4bGenerationToken, "legacy row must receive a fresh token");
    assert.deepEqual(enqueued, ["task-restart", "task-legacy-null"]);
  } finally {
    service.enqueueTask = originalEnqueue;
    prisma.audiobookTask.findMany = originalFindMany;
    prisma.audiobookTask.updateMany = originalUpdateMany;
  }
});

test("superseding a background generation aborts its in-process ffmpeg worker", { concurrency: false }, async () => {
  const taskDir = makeTaskDir("abort");
  writeFakeWav(path.join(taskDir, "full-book.wav"));
  const ffmpegDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-generation-abort-ffmpeg-"));
  const started = path.join(ffmpegDir, "started");
  const script = path.join(ffmpegDir, "fake-ffmpeg.sh");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    `touch "${started}"`,
    'prev=""; src=""; last=""',
    'for a in "$@"; do [ "$prev" = "-i" ] && [ -z "$src" ] && src="$a"; last="$a"; prev="$a"; done',
    'cp "$src" "$last"',
    "sleep 5",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const previousFfmpeg = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = script;
  const service = new AudiobookTaskService();
  const originalFindUnique = prisma.audiobookTask.findUnique;
  const originalUpdateMany = prisma.audiobookTask.updateMany;
  const originalChapterFindMany = prisma.chapter.findMany;
  const originalNovelFindUnique = prisma.novel.findUnique;
  prisma.audiobookTask.findUnique = async () => ({
    resultJson: "{}",
    m4bGenerationToken: "generation-B",
    status: "succeeded",
    cancelRequestedAt: null,
  });
  prisma.audiobookTask.updateMany = async (args) => ({
    // The worker must win the persisted marker CAS before ffmpeg starts.
    count: args?.data?.currentItemLabel === "有声书生成完成（m4b 后台封装中）" ? 1 : 0,
  });
  prisma.chapter.findMany = async () => [];
  prisma.novel.findUnique = async () => null;
  fs.mkdirSync(path.join(taskDir, "chapters", "c1"), { recursive: true });
  writeFakeWav(path.join(taskDir, "chapters", "c1", "chapter.wav"));
  try {
    service.scheduleBackgroundM4bEncode({
      parentTaskId: "task-abort",
      novelId: "novel-1",
      parentTitle: "测试书",
      taskDir,
      chapterIds: ["c1"],
      generationToken: "generation-B",
      force: true,
    });
    await waitForFile(started);
    service.abortBackgroundM4b("task-abort");
    const deadline = Date.now() + 2_000;
    while (service.activeM4bControllers.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(service.activeM4bControllers.size, 0, "superseded worker must be removed after abort");
    assert.equal(fs.existsSync(resolveFullBookM4bPath(taskDir)), false);
    // schedule 的 catch/settle 是 fire-and-forget；等待它完成后再恢复共享 prisma stub。
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    if (previousFfmpeg === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = previousFfmpeg;
    prisma.audiobookTask.findUnique = originalFindUnique;
    prisma.audiobookTask.updateMany = originalUpdateMany;
    prisma.chapter.findMany = originalChapterFindMany;
    prisma.novel.findUnique = originalNovelFindUnique;
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.rmSync(ffmpegDir, { recursive: true, force: true });
  }
});
