const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { prisma } = require("../dist/db/prisma.js");
const { M4bJobQueueService } = require("../dist/services/audiobook/m4b/M4bJobQueueService.js");

// m4b 队列测试共享全局 M4bEncodingJob 表，与 m4bWorker/m4bWorkerManager 测试
// 并发时互相领走对方 job。用 O_EXCL 文件锁串行化跨文件的 m4b 队列访问。
const LOCK_PATH = path.join(os.tmpdir(), "m4b-queue-test.lock");

async function withQueueLock(fn) {
  let fd = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(LOCK_PATH, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // 锁文件可能是崩溃残留：超过 3 分钟无 mtime 更新则强占
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 180000) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {
        // 锁文件刚好被释放，继续重试
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (fd === null) throw new Error("m4b queue test lock timeout");
  try {
    fs.utimesSync(LOCK_PATH, new Date(), new Date());
    return await fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      // 已被强占方删除
    }
  }
}

test("M4bJobQueueService.claimNextJob claims and marks processing", { timeout: 150000 }, async () => {
  await withQueueLock(async () => {
    const service = new M4bJobQueueService();
    const novel = await prisma.novel.create({
      data: { title: "Test Novel" }
    });
    const task = await prisma.audiobookTask.create({
      data: {
        novelId: novel.id,
        title: "Test Task",
        scopeMode: "full",
        narratorVoice: "test-voice",
        narratorStyle: "neutral"
      }
    });

    const created = await service.createJob({
      audiobookTaskId: task.id,
      inputWavPath: "/tmp/test.wav",
      outputM4bPath: "/tmp/test.m4b",
      metadataJson: JSON.stringify({ title: "Test", chapters: [] })
    });

    const claimed = await service.claimNextJob("worker-123");

    assert.equal(claimed.id, created.id);
    assert.equal(claimed.status, "processing");
    assert.equal(claimed.workerId, "worker-123");
    assert.ok(claimed.workerStartedAt);

    // Cleanup
    await prisma.m4bEncodingJob.delete({ where: { id: created.id } });
    await prisma.audiobookTask.delete({ where: { id: task.id } });
    await prisma.novel.delete({ where: { id: novel.id } });
  });
});

test("M4bJobQueueService.createJob creates pending job", { timeout: 150000 }, async () => {
  await withQueueLock(async () => {
    const service = new M4bJobQueueService();
    const novel = await prisma.novel.create({
      data: { title: "Test Novel" }
    });
    const task = await prisma.audiobookTask.create({
      data: {
        novelId: novel.id,
        title: "Test Task",
        scopeMode: "full",
        narratorVoice: "test-voice",
        narratorStyle: "neutral"
      }
    });

    const job = await service.createJob({
      audiobookTaskId: task.id,
      inputWavPath: "/tmp/test.wav",
      outputM4bPath: "/tmp/test.m4b",
      metadataJson: JSON.stringify({ title: "Test", chapters: [] })
    });

    assert.equal(job.status, "pending");
    assert.equal(job.audiobookTaskId, task.id);

    // Cleanup
    await prisma.m4bEncodingJob.delete({ where: { id: job.id } });
    await prisma.audiobookTask.delete({ where: { id: task.id } });
    await prisma.novel.delete({ where: { id: novel.id } });
  });
});
