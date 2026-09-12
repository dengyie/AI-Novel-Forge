const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { prisma } = require("../dist/db/prisma.js");
const { M4bJobQueueService } = require("../dist/services/audiobook/m4b/M4bJobQueueService.js");
const { withQueueLock } = require("./helpers/m4bQueueTestLock.js");

test("m4b-worker processes job and exits", { timeout: 300000 }, async () => {
  // worker 子进程共享 DB 队列：入队→spawn→退出全程持锁，防止其 claim
  // 与其他测试文件的 job 互抢。
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

    // Create minimal test WAV (44-byte header + silent data)
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "m4b-test-"));
    const wavPath = path.join(testDir, "test.wav");
    const m4bPath = path.join(testDir, "test.m4b");

    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(36 + 8000, 4); // file size - 8
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16); // fmt chunk size
    wavHeader.writeUInt16LE(1, 20); // PCM
    wavHeader.writeUInt16LE(1, 22); // mono
    wavHeader.writeUInt32LE(16000, 24); // sample rate
    wavHeader.writeUInt32LE(32000, 28); // byte rate
    wavHeader.writeUInt16LE(2, 32); // block align
    wavHeader.writeUInt16LE(16, 34); // bits per sample
    wavHeader.write("data", 36);
    wavHeader.writeUInt32LE(8000, 40); // data size

    fs.writeFileSync(wavPath, Buffer.concat([wavHeader, Buffer.alloc(8000)]));

    const job = await service.createJob({
      audiobookTaskId: task.id,
      inputWavPath: wavPath,
      outputM4bPath: m4bPath,
      metadataJson: JSON.stringify({
        title: "Test",
        chapters: [{ title: "Chapter 1", startMs: 0, endMs: 500 }]
      })
    });

    // Spawn worker with short idle timeout for test
    const workerPath = path.join(__dirname, "../dist/workers/m4b-worker.js");
    const worker = spawn("node", [workerPath], {
      env: {
        ...process.env,
        M4B_WORKER_IDLE_TIMEOUT_MS: "5000",
        M4B_WORKER_LOG_PATH: path.join(testDir, "worker.log")
      },
      stdio: "ignore"
    });

    // Wait for worker to process or timeout
    const exitCode = await new Promise((resolve) => {
      worker.on("exit", (code) => resolve(code));
      setTimeout(() => {
        worker.kill();
        resolve(null);
      }, 25000);
    });

    // Verify job completed (or skipped if no ffmpeg)
    const result = await prisma.m4bEncodingJob.findUnique({
      where: { id: job.id }
    });

    assert.ok(result.status === "completed" || result.status === "failed");
    assert.equal(exitCode, 0);

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
    await prisma.m4bEncodingJob.delete({ where: { id: job.id } });
    await prisma.audiobookTask.delete({ where: { id: task.id } });
    await prisma.novel.delete({ where: { id: novel.id } });
  });
});
