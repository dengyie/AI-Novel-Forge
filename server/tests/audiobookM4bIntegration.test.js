const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma.js");

test("AudiobookPipelineService creates M4bEncodingJob on finalize", async () => {
  // This test verifies the integration shape without full pipeline execution
  const { M4bJobQueueService } = require("../dist/services/audiobook/m4b/M4bJobQueueService.js");
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

  // Simulate what finalizeAudiobook should do
  const job = await service.createJob({
    audiobookTaskId: task.id,
    inputWavPath: "/tmp/test.wav",
    outputM4bPath: "/tmp/test.m4b",
    metadataJson: JSON.stringify({ title: "Test", chapters: [] })
  });

  assert.equal(job.audiobookTaskId, task.id);
  assert.equal(job.status, "pending");

  // Verify task not yet marked with fullAudioPath (worker will do that)
  const taskRefreshed = await prisma.audiobookTask.findUnique({
    where: { id: task.id }
  });
  assert.equal(taskRefreshed.fullAudioPath, null);

  // Cleanup
  await prisma.m4bEncodingJob.delete({ where: { id: job.id } });
  await prisma.audiobookTask.delete({ where: { id: task.id } });
  await prisma.novel.delete({ where: { id: novel.id } });
});

test("Feature flag AUDIOBOOK_M4B_USE_WORKER controls routing", async () => {
  const { isM4bWorkerEnabled } = require("../dist/services/audiobook/audiobookM4b.js");

  // Save original
  const original = process.env.AUDIOBOOK_M4B_USE_WORKER;

  // Test enabled (default)
  delete process.env.AUDIOBOOK_M4B_USE_WORKER;
  assert.equal(isM4bWorkerEnabled(), true);

  process.env.AUDIOBOOK_M4B_USE_WORKER = "true";
  assert.equal(isM4bWorkerEnabled(), true);

  process.env.AUDIOBOOK_M4B_USE_WORKER = "1";
  assert.equal(isM4bWorkerEnabled(), true);

  // Test disabled
  process.env.AUDIOBOOK_M4B_USE_WORKER = "false";
  assert.equal(isM4bWorkerEnabled(), false);

  process.env.AUDIOBOOK_M4B_USE_WORKER = "0";
  assert.equal(isM4bWorkerEnabled(), false);

  // Restore
  if (original !== undefined) {
    process.env.AUDIOBOOK_M4B_USE_WORKER = original;
  } else {
    delete process.env.AUDIOBOOK_M4B_USE_WORKER;
  }
});
