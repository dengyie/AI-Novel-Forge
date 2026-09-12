const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma.js");

test("M4bEncodingJob.create with required fields", async () => {
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

  const job = await prisma.m4bEncodingJob.create({
    data: {
      audiobookTaskId: task.id,
      status: "pending",
      inputWavPath: "/tmp/test.wav",
      outputM4bPath: "/tmp/test.m4b",
      metadataJson: JSON.stringify({ title: "Test", chapters: [] })
    }
  });

  assert.equal(job.status, "pending");
  assert.equal(job.progressPercent, 0);
  assert.equal(job.retryCount, 0);

  // Cleanup
  await prisma.m4bEncodingJob.delete({ where: { id: job.id } });
  await prisma.audiobookTask.delete({ where: { id: task.id } });
  await prisma.novel.delete({ where: { id: novel.id } });
});
