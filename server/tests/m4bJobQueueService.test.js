const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma.js");
const { M4bJobQueueService } = require("../dist/services/audiobook/m4b/M4bJobQueueService.js");

test("M4bJobQueueService.claimNextJob claims and marks processing", async () => {
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

test("M4bJobQueueService.createJob creates pending job", async () => {
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
