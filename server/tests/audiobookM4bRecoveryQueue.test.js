const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { prisma } = require("../dist/db/prisma.js");
const {
  AudiobookTaskService,
  readBackgroundM4bState,
  selectOrphanM4bPids,
} = require("../dist/services/audiobook/AudiobookTaskService.js");
const { encodeFullBookM4b } = require("../dist/services/audiobook/audiobookM4b.js");

function makeTaskDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ab-m4b-recovery-${label}-`));
}

function installOverlapFfmpeg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-overlap-"));
  const script = path.join(dir, "fake-ffmpeg.sh");
  const overlap = path.join(dir, "overlap");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    'last=""; prev=""; src=""',
    'for a in "$@"; do if [ "$prev" = "-i" ] && [ -z "$src" ]; then src="$a"; fi; last="$a"; prev="$a"; done',
    `if ! mkdir "${dir}/active" 2>/dev/null; then echo overlap > "${overlap}"; fi`,
    'sleep 0.15',
    'cp "$src" "$last"',
    `rmdir "${dir}/active" 2>/dev/null || true`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  return { script, overlap };
}

test("recovery scans succeeded m4b-encoding task after restart", async () => {
  assert.equal(
    readBackgroundM4bState(JSON.stringify({ m4b: { status: "encoding" } })),
    "encoding",
  );
  const service = new AudiobookTaskService();
  const scheduled = [];
  service.scheduleBackgroundM4bEncode = (input) => { scheduled.push(input); };
  const originalFindMany = prisma.audiobookTask.findMany;
  const originalUpdateMany = prisma.audiobookTask.updateMany;
  prisma.audiobookTask.findMany = async () => ([{
    id: "task-m4b-1",
    novelId: "novel-1",
    outputDir: "/tmp/audiobook/task-m4b-1",
    progress: 100,
    status: "succeeded",
    title: "测试书",
    chapterIdsJson: JSON.stringify(["c1"]),
    progressJson: null,
    resultJson: JSON.stringify({ m4b: { status: "encoding" } }),
    currentStage: "finalizing",
    cancelRequestedAt: null,
  }]);
  prisma.audiobookTask.updateMany = async () => ({ count: 1 });
  try {
    await service.resumePendingTasks();
    assert.equal(scheduled.length, 1, "restart recovery must requeue the durable m4b job");
    assert.equal(scheduled[0].parentTaskId, "task-m4b-1");
  } finally {
    prisma.audiobookTask.findMany = originalFindMany;
    prisma.audiobookTask.updateMany = originalUpdateMany;
  }
});

test("startup m4b recovery only schedules work and does not wait for long ffmpeg", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  let release;
  const encodeStarted = new Promise((resolve) => { release = resolve; });
  const originals = {
    findMany: prisma.audiobookTask.findMany,
    updateMany: prisma.audiobookTask.updateMany,
    schedule: service.scheduleBackgroundM4bEncode,
  };
  const taskDir = makeTaskDir("startup-nonblocking");
  prisma.audiobookTask.findMany = async () => ([{
    id: "task-m4b-long",
    novelId: "novel-1",
    outputDir: taskDir,
    progress: 100,
    status: "succeeded",
    title: "长书",
    chapterIdsJson: JSON.stringify(["c1"]),
    progressJson: null,
    resultJson: JSON.stringify({ m4b: { status: "encoding" } }),
    currentStage: "finalizing",
    cancelRequestedAt: null,
    m4bGenerationToken: "generation-A",
  }]);
  prisma.audiobookTask.updateMany = async () => ({ count: 1 });
  service.scheduleBackgroundM4bEncode = async () => encodeStarted;
  try {
    const recovery = service.resumePendingTasks();
    const returned = await Promise.race([
      recovery.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    assert.equal(returned, true, "startup recovery must not wait for the full ffmpeg encode");
    release();
    await recovery;
  } finally {
    prisma.audiobookTask.findMany = originals.findMany;
    prisma.audiobookTask.updateMany = originals.updateMany;
    service.scheduleBackgroundM4bEncode = originals.schedule;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("a detached startup schedule rejection settles the claimed generation as failed", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originals = {
    findMany: prisma.audiobookTask.findMany,
    updateMany: prisma.audiobookTask.updateMany,
    schedule: service.scheduleBackgroundM4bEncode,
    settle: service.settleBackgroundM4b,
  };
  const taskDir = makeTaskDir("detached-reject");
  let recoveryToken = null;
  const settled = [];
  prisma.audiobookTask.findMany = async (query) => {
    if (!query.select?.resultJson) return [];
    return [{
      id: "task-m4b-detached-reject",
      novelId: "novel-1",
      outputDir: taskDir,
      progress: 100,
      status: "succeeded",
      title: "调度拒绝",
      chapterIdsJson: JSON.stringify(["c1"]),
      progressJson: null,
      resultJson: JSON.stringify({ m4b: { status: "encoding" } }),
      currentStage: "finalizing",
      cancelRequestedAt: null,
      m4bGenerationToken: "generation-before-recovery",
    }];
  };
  prisma.audiobookTask.updateMany = async ({ data }) => {
    recoveryToken = data.m4bGenerationToken;
    return { count: 1 };
  };
  service.scheduleBackgroundM4bEncode = async () => {
    throw new Error("synthetic detached schedule rejection");
  };
  service.settleBackgroundM4b = async (...args) => { settled.push(args); };

  try {
    await service.resumePendingTasks();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled.length, 1, "the durable encoding marker must reach a terminal state");
    assert.equal(settled[0][0], "task-m4b-detached-reject");
    assert.match(settled[0][1], /m4b 失败/);
    assert.deepEqual(settled[0][2], {
      status: "failed",
      reason: "synthetic detached schedule rejection",
    });
    assert.equal(settled[0][3].generationToken, recoveryToken);
  } finally {
    prisma.audiobookTask.findMany = originals.findMany;
    prisma.audiobookTask.updateMany = originals.updateMany;
    service.scheduleBackgroundM4bEncode = originals.schedule;
    service.settleBackgroundM4b = originals.settle;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("startup recovery closes a legacy encoding marker with an empty chapter list", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originalFindMany = prisma.audiobookTask.findMany;
  const originalUpdateMany = prisma.audiobookTask.updateMany;
  const settled = [];
  const taskDir = makeTaskDir("empty-chapters");
  service.settleBackgroundM4b = async (...args) => { settled.push(args); };
  prisma.audiobookTask.findMany = async (query) => {
    if (query.select?.resultJson) {
      return [{
        id: "task-m4b-empty",
        novelId: "novel-1",
        outputDir: taskDir,
        progress: 100,
        status: "succeeded",
        title: "坏数据任务",
        chapterIdsJson: "[]",
        progressJson: null,
        // Pretty-printed legacy JSON must still be discovered by the broad DB prefilter.
        resultJson: JSON.stringify({ m4b: { status: "encoding" } }, null, 2),
        currentStage: "finalizing",
        cancelRequestedAt: null,
        m4bGenerationToken: "generation-legacy",
      }];
    }
    return [];
  };
  prisma.audiobookTask.updateMany = async () => ({ count: 1 });
  try {
    await service.resumePendingTasks();
    assert.equal(settled.length, 1, "malformed marker must be settled instead of retried forever");
    assert.equal(settled[0][0], "task-m4b-empty");
    assert.match(settled[0][1], /m4b 失败/);
    assert.deepEqual(settled[0][2], { status: "failed", reason: "任务章节列表为空" });
  } finally {
    prisma.audiobookTask.findMany = originalFindMany;
    prisma.audiobookTask.updateMany = originalUpdateMany;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("startup recovery reports a failed m4b claim after continuing the page", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originalFindMany = prisma.audiobookTask.findMany;
  const originalUpdateMany = prisma.audiobookTask.updateMany;
  const scheduled = [];
  const taskDirs = [makeTaskDir("claim-broken"), makeTaskDir("claim-healthy")];
  let findManyCalls = 0;
  service.scheduleBackgroundM4bEncode = (input) => { scheduled.push(input); };
  prisma.audiobookTask.findMany = async (query) => {
    findManyCalls += 1;
    if (!query.select?.resultJson) return [];
    return [
      {
        id: "task-m4b-broken",
        novelId: "novel-1",
        outputDir: taskDirs[0],
        progress: 100,
        status: "succeeded",
        title: "认领失败",
        chapterIdsJson: JSON.stringify(["c1"]),
        progressJson: null,
        resultJson: JSON.stringify({ m4b: { status: "encoding" } }),
        currentStage: "finalizing",
        cancelRequestedAt: null,
        m4bGenerationToken: "generation-broken",
      },
      {
        id: "task-m4b-healthy",
        novelId: "novel-1",
        outputDir: taskDirs[1],
        progress: 100,
        status: "succeeded",
        title: "认领成功",
        chapterIdsJson: JSON.stringify(["c2"]),
        progressJson: null,
        resultJson: JSON.stringify({ m4b: { status: "encoding" } }),
        currentStage: "finalizing",
        cancelRequestedAt: null,
        m4bGenerationToken: "generation-healthy",
      },
    ];
  };
  prisma.audiobookTask.updateMany = async (query) => {
    if (query.where.id === "task-m4b-broken") throw new Error("database unavailable");
    return { count: 1 };
  };
  try {
    await assert.rejects(
      service.resumePendingTasks(),
      (error) => error instanceof AggregateError
        && error.errors.some((item) => item instanceof Error && item.message === "database unavailable"),
      "the recovery domain must be degraded when any row cannot be claimed",
    );
    assert.equal(findManyCalls, 2, "both recovery domains should still be scanned");
    assert.deepEqual(
      scheduled.map((item) => item.parentTaskId),
      ["task-m4b-healthy"],
      "a failed row must not prevent healthy rows in the same page from recovering",
    );
  } finally {
    prisma.audiobookTask.findMany = originalFindMany;
    prisma.audiobookTask.updateMany = originalUpdateMany;
    for (const taskDir of taskDirs) fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("startup recovery does not requeue a task when orphan cleanup is unconfirmed", { concurrency: false }, async () => {
  const service = new AudiobookTaskService();
  const originalFindMany = prisma.audiobookTask.findMany;
  const originalUpdateMany = prisma.audiobookTask.updateMany;
  const originalPath = process.env.PATH;
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-recovery-ps-fail-"));
  const fakePs = path.join(fakeBin, "ps");
  fs.writeFileSync(fakePs, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const taskDir = makeTaskDir("cleanup-unconfirmed");
  let updateCalls = 0;
  process.env.PATH = fakeBin;
  prisma.audiobookTask.findMany = async (query) => {
    if (query.select?.resultJson) return [];
    return [{
      id: "task-m4b-cleanup-blocked",
      novelId: "novel-1",
      outputDir: taskDir,
      progress: 100,
      status: "running",
      title: "清理未确认",
      chapterIdsJson: JSON.stringify(["c1"]),
      progressJson: null,
      resultJson: null,
      currentStage: "finalizing",
      cancelRequestedAt: null,
      m4bGenerationToken: "generation-cleanup-blocked",
    }];
  };
  prisma.audiobookTask.updateMany = async () => {
    updateCalls += 1;
    return { count: 1 };
  };
  try {
    await assert.rejects(
      service.resumePendingTasks(),
      (error) => error instanceof AggregateError,
      "unconfirmed orphan cleanup must keep the audiobook recovery domain degraded",
    );
    assert.equal(updateCalls, 0, "recovery must not claim or requeue while cleanup is unconfirmed");
  } finally {
    prisma.audiobookTask.findMany = originalFindMany;
    prisma.audiobookTask.updateMany = originalUpdateMany;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("m4b encoding is globally bounded across different task directories", async () => {
  const { script, overlap } = installOverlapFfmpeg();
  const oldPath = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = script;
  const dirA = makeTaskDir("a");
  const dirB = makeTaskDir("b");
  const srcA = path.join(dirA, "src.wav");
  const srcB = path.join(dirB, "src.wav");
  fs.writeFileSync(srcA, "A".repeat(128));
  fs.writeFileSync(srcB, "B".repeat(128));
  try {
    const [a, b] = await Promise.all([
      encodeFullBookM4b({ taskDir: dirA, bookTitle: "A", sourceWavPath: srcA, chapters: [] }),
      encodeFullBookM4b({ taskDir: dirB, bookTitle: "B", sourceWavPath: srcB, chapters: [] }),
    ]);
    assert.equal(a.status, "ready", a.reason);
    assert.equal(b.status, "ready", b.reason);
    assert.equal(fs.existsSync(overlap), false, "different taskDir jobs must not spawn ffmpeg concurrently");
  } finally {
    if (oldPath === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = oldPath;
  }
});

test("queued m4b encoding abort removes its waiter without consuming a permit", async () => {
  const dir = makeTaskDir("abort");
  const src = path.join(dir, "src.wav");
  fs.writeFileSync(src, "A".repeat(128));
  const activeDir = makeTaskDir("abort-active");
  const activeSrc = path.join(activeDir, "src.wav");
  fs.writeFileSync(activeSrc, "B".repeat(128));
  const controller = new AbortController();
  const blocker = installOverlapFfmpeg();
  const oldPath = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = blocker.script;
  const active = encodeFullBookM4b({ taskDir: activeDir, bookTitle: "active", sourceWavPath: activeSrc, chapters: [] });
  const queued = encodeFullBookM4b({ taskDir: dir, bookTitle: "queued", sourceWavPath: src, chapters: [], signal: controller.signal });
  controller.abort();
  try {
    const queuedResult = await queued;
    assert.equal(queuedResult.status, "failed");
    assert.match(queuedResult.reason ?? "", /取消/);
    const activeResult = await active;
    assert.equal(activeResult.status, "ready", activeResult.reason);
  } finally {
    if (oldPath === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = oldPath;
  }
});

test("failed m4b encoding releases the global permit for the next task", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-release-"));
  const script = path.join(dir, "fake-ffmpeg.sh");
  const calls = path.join(dir, "calls");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    `n=$(wc -l < "${calls}" 2>/dev/null || echo 0)`,
    `echo call >> "${calls}"`,
    'last=""; prev=""; src=""',
    'for a in "$@"; do if [ "$prev" = "-i" ] && [ -z "$src" ]; then src="$a"; fi; last="$a"; prev="$a"; done',
    'if [ "$n" -eq 0 ]; then exit 1; fi',
    'cp "$src" "$last"',
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const oldPath = process.env.AUDIOBOOK_FFMPEG_PATH;
  process.env.AUDIOBOOK_FFMPEG_PATH = script;
  const first = makeTaskDir("release-first");
  const second = makeTaskDir("release-second");
  fs.writeFileSync(path.join(first, "src.wav"), "F".repeat(128));
  fs.writeFileSync(path.join(second, "src.wav"), "S".repeat(128));
  try {
    const [failed, recovered] = await Promise.all([
      encodeFullBookM4b({ taskDir: first, bookTitle: "first", sourceWavPath: path.join(first, "src.wav"), chapters: [] }),
      encodeFullBookM4b({ taskDir: second, bookTitle: "second", sourceWavPath: path.join(second, "src.wav"), chapters: [] }),
    ]);
    assert.equal(failed.status, "failed");
    assert.equal(recovered.status, "ready", recovered.reason);
  } finally {
    if (oldPath === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = oldPath;
  }
});

test("orphan cleanup selects only orphan ffmpeg writing the requested m4b part", () => {
  const taskDir = "/data/audiobook/task-1";
  const ps = [
    ` 101 1 /usr/bin/ffmpeg /usr/bin/ffmpeg -i src.wav ${taskDir}/full-book.m4b.run.part`,
    ` 105 1 /usr/bin/ffmpeg /usr/bin/ffmpeg -i src.wav /data/audiobook/task-10/full-book.m4b.run.part`,
    ` 102 1 /usr/bin/not-ffmpeg /usr/bin/not-ffmpeg -i src.wav ${taskDir}/full-book.m4b.run.part`,
    ` 103 1 /usr/bin/ffmpeg /usr/bin/ffmpeg -i src.wav /data/audiobook/task-2/full-book.m4b.run.part`,
    ` 104 9 /usr/bin/ffmpeg /usr/bin/ffmpeg -i src.wav ${taskDir}/full-book.m4b.run.part`,
  ].join("\n");
  assert.deepEqual(selectOrphanM4bPids(ps, taskDir, 999), [101]);
});

test("orphan cleanup recognizes a configured ffmpeg wrapper process-group root", () => {
  const taskDir = "/data/audiobook/task-wrapper";
  const wrapper = "/opt/ai-novel/bin/ffmpeg-wrapper.sh";
  const ps = [
    ` 201 1 /bin/sh ${wrapper} -i src.wav ${taskDir}/full-book.m4b.run.part`,
    ` 202 1 /bin/sh /opt/other/wrapper.sh -i src.wav ${taskDir}/full-book.m4b.run.part`,
  ].join("\n");
  assert.deepEqual(selectOrphanM4bPids(ps, taskDir, 999, wrapper), [201]);
});
