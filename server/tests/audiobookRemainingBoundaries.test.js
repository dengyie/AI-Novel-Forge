const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ResourceGate } = require("../dist/workers/DirectorTaskQueue.js");
const { prisma } = require("../dist/db/prisma.js");
const { AudiobookTaskService } = require("../dist/services/audiobook/AudiobookTaskService.js");

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
  prisma.audiobookTask.findUnique = async () => ({ resultJson: "{}" });
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
  prisma.audiobookTask.findUnique = async () => ({ resultJson: "{}" });
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
