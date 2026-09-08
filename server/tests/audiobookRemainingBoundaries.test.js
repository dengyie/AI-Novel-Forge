const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ResourceGate } = require("../dist/workers/DirectorTaskQueue.js");
const { prisma } = require("../dist/db/prisma.js");
const { AudiobookTaskService } = require("../dist/services/audiobook/AudiobookTaskService.js");
const {
  resolveM4bFfmpegThreads,
} = require("../dist/services/audiobook/audiobookM4b.js");
const {
  resolveM4bGlobalConcurrency,
} = require("../dist/services/audiobook/infrastructure/m4b/M4bPermitPool.js");
const {
  resolveM4bStallTimeoutMs,
} = require("../dist/services/audiobook/infrastructure/m4b/FfmpegProcessRunner.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeFakeWav(filePath) {
  const dataBytes = 100;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

test("m4b resource overrides reject fractions and cap hostile values", () => {
  assert.equal(resolveM4bGlobalConcurrency("2"), 2);
  assert.equal(resolveM4bGlobalConcurrency("1.5"), 1);
  assert.equal(resolveM4bGlobalConcurrency("1000000"), 4);

  assert.equal(resolveM4bFfmpegThreads("3"), 3);
  assert.equal(resolveM4bFfmpegThreads("1.5"), 2);
  assert.equal(resolveM4bFfmpegThreads("1000000"), 4);
  assert.equal(resolveM4bFfmpegThreads("0"), 2, "zero must fall back to the bounded default");

  assert.equal(resolveM4bStallTimeoutMs("Infinity"), 5 * 60_000);
  assert.equal(resolveM4bStallTimeoutMs("1000"), 30_000);
  assert.equal(resolveM4bStallTimeoutMs("999999999999"), 2_147_483_647);
});

test("全局资源 permit waiter abort 后应移出队列，并唤醒下一个 waiter", async () => {
  const gate = new ResourceGate(1);
  await gate.acquire();

  const controller = new AbortController();
  const aborted = gate.acquire(controller.signal);
  const next = gate.acquire();
  controller.abort();

  await assert.rejects(
    Promise.race([
      aborted,
      delay(100).then(() => { throw new Error("permit waiter timeout"); }),
    ]),
    /abort/i,
  );
  gate.release();
  await next;
  gate.release();
});

test("全局资源 permit 被 release 唤醒后若 signal abort，应拒绝且归还 permit", async () => {
  const gate = new ResourceGate(1);
  await gate.acquire();

  const controller = new AbortController();
  const waiter = gate.acquire(controller.signal);
  gate.release();
  controller.abort();

  await assert.rejects(waiter, /abort/i);
  const next = gate.acquire();
  await next;
  gate.release();
});

test("m4b 后台封装前置 WAV 缺失时应收口 marker，而不是永久停在封装中", async () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-marker-missing-wav-"));
  const service = new AudiobookTaskService();
  const updates = [];
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  prisma.audiobookTask.findUnique = async () => ({
    resultJson: "{}",
    status: "succeeded",
    m4bGenerationToken: "test-generation",
  });
  prisma.audiobookTask.updateMany = async (args) => {
    updates.push(args);
    return { count: 1 };
  };

  try {
    service.scheduleBackgroundM4bEncode({
      parentTaskId: "parent-missing-wav",
      novelId: "novel-1",
      parentTitle: "缺 WAV 书",
      taskDir,
      chapterIds: ["chapter-1"],
      generationToken: "test-generation",
    });
    await delay(20);
    assert.equal(updates.length, 1, "缺 WAV 时必须写入 m4b 终态，不能只 return");
    assert.match(updates[0].data.currentItemLabel, /m4b 失败/);
    assert.match(updates[0].data.resultJson, /"status":"failed"/);
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
  }
});

test("m4b 后台封装章节 WAV 缺失时应收口 marker", async () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-marker-missing-chapter-wav-"));
  writeFakeWav(path.join(taskDir, "full-book.wav"));
  const service = new AudiobookTaskService();
  const updates = [];
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  prisma.audiobookTask.findUnique = async () => ({
    resultJson: "{}",
    status: "succeeded",
    m4bGenerationToken: "test-generation",
  });
  prisma.audiobookTask.updateMany = async (args) => {
    updates.push(args);
    return { count: 1 };
  };

  try {
    service.scheduleBackgroundM4bEncode({
      parentTaskId: "parent-missing-chapter-wav",
      novelId: "novel-1",
      parentTitle: "缺章节 WAV 书",
      taskDir,
      chapterIds: ["chapter-1"],
      generationToken: "test-generation",
    });
    await delay(20);
    assert.equal(updates.length, 1, "缺章节 WAV 时必须写入 m4b 终态");
    assert.match(updates[0].data.currentItemLabel, /m4b 失败/);
    assert.match(updates[0].data.resultJson, /章节 WAV 缺失/);
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
  }
});

test("m4b 已就绪但终态 DB 写瞬时失败时仍重试落 ready", { concurrency: false }, async () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-settle-retry-"));
  writeFakeWav(path.join(taskDir, "full-book.wav"));
  writeFakeWav(path.join(taskDir, "chapters", "chapter-1", "chapter.wav"));
  fs.writeFileSync(path.join(taskDir, "full-book.m4b"), Buffer.alloc(128, 1));
  const service = new AudiobookTaskService();
  const terminalStates = [];
  let terminalAttempts = 0;
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  prisma.audiobookTask.findUnique = async () => ({
    resultJson: JSON.stringify({ m4b: { status: "encoding" } }),
    status: "succeeded",
    cancelRequestedAt: null,
    m4bGenerationToken: "settle-generation",
  });
  prisma.audiobookTask.updateMany = async (args) => {
    const nextState = JSON.parse(args.data.resultJson).m4b.status;
    if (nextState === "encoding") return { count: 1 };
    terminalAttempts += 1;
    if (terminalAttempts <= 2) throw new Error("synthetic transient database failure");
    terminalStates.push(nextState);
    return { count: 1 };
  };

  try {
    service.scheduleBackgroundM4bEncode({
      parentTaskId: "parent-settle-retry",
      novelId: "novel-1",
      parentTitle: "终态重试书",
      taskDir,
      chapterIds: ["chapter-1"],
      generationToken: "settle-generation",
    });
    const deadline = Date.now() + 1_500;
    while (terminalStates.length === 0 && Date.now() < deadline) {
      await delay(20);
    }
    assert.deepEqual(terminalStates, ["ready"], "DB 恢复后不得把已生成产物误记为 failed");
    assert.equal(terminalAttempts, 3, "连续失败必须沿退避链继续重试，而不是只重试一次");
  } finally {
    service.stopWatchdog();
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});
