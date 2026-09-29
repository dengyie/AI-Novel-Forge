const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prisma } = require('../dist/db/prisma');
const { M4bJobQueueService } = require('../dist/services/audiobook/m4b/M4bJobQueueService');
const { withQueueLock } = require('./helpers/m4bQueueTestLock');
async function fixture(run) {
  await withQueueLock(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4b-projection-'));
    const novel = await prisma.novel.create({ data: { title: 'projection fixture' } });
    try {
      const task = await prisma.audiobookTask.create({ data: { novelId: novel.id, title: 'test', scopeMode: 'full', narratorVoice: 'test', narratorStyle: 'test', status: 'succeeded', m4bGenerationToken: 'g1', resultJson: JSON.stringify({ retained: true, m4b: { status: 'skipped' } }) } });
      const queue = new M4bJobQueueService();
      await queue.createJob({ audiobookTaskId: task.id, generationToken: 'g1', inputWavPath: path.join(dir, 'full.wav'), outputM4bPath: path.join(dir, 'full.m4b'), metadataJson: JSON.stringify({ title: 'test', chapters: [] }) });
      const job = await queue.claimNextJob('projection-test-worker');
      assert.equal(job.audiobookTaskId, task.id);
      const part = path.join(dir, 'owned.part'); fs.writeFileSync(part, Buffer.alloc(128));
      await run({ task, job, queue, part, dir });
    } finally { await prisma.novel.delete({ where: { id: novel.id } }); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
for (const fail of [false, true]) test(`worker ${fail ? 'failure' : 'success'} updates the visible task`, async () => {
  await fixture(async ({ task, job, queue, part }) => {
    if (fail) await queue.markFailed(job, 'encoder failed'); else await queue.publish(job, part);
    const row = await prisma.audiobookTask.findUniqueOrThrow({ where: { id: task.id } });
    const result = JSON.parse(row.resultJson);
    assert.equal(result.m4b.status, fail ? 'failed' : 'ready');
    assert.equal(result.retained, true);
    const { AudiobookTaskService } = require('../dist/services/audiobook/AudiobookTaskService');
    assert.equal((await new AudiobookTaskService().getTask(task.id)).m4bStatus, fail ? 'failed' : 'ready');
    if (fail) assert.equal(result.m4b.reason, 'encoder failed');
    else assert.equal(result.m4b.bytes, 128);
  });
});

const { finalizeAudiobookTask } = require('../dist/services/audiobook/application/finalization');
function pipelineResult(dir) {
  return { outputDir: dir, annotations: [], chapterAudioPaths: [], completedChapterCount: 1,
    completedChunks: 4, qualityWarnings: ['retained warning'], fullAudioPath: 'full-book.wav',
    m4b: { status: 'skipped', relativePath: 'full-book.m4b', path: null, reason: 'queued' } };
}
for (const phase of ['before', 'after']) for (const failure of [false, true]) {
  test(`worker ${failure ? 'failure' : 'success'} ${phase} production finalization keeps its projection`, async () => {
    await fixture(async ({ task, job, queue, part, dir }) => {
      await prisma.audiobookTask.update({ where: { id: task.id }, data: { status: 'running' } });
      const settle = () => failure ? queue.markFailed(job, 'encoder stopped') : queue.publish(job, part);
      if (phase === 'before') await settle();
      await finalizeAudiobookTask({ taskId: task.id, generationToken: 'g1', isContinueChild: false, result: pipelineResult(dir) });
      if (phase === 'after') {
        const pending = await prisma.audiobookTask.findUniqueOrThrow({ where: { id: task.id } });
        assert.equal(JSON.parse(pending.resultJson).m4b.status, 'encoding');
        const { AudiobookTaskService } = require('../dist/services/audiobook/AudiobookTaskService');
        assert.equal((await new AudiobookTaskService().getTask(task.id)).m4bStatus, 'encoding');
        await settle();
      }
      const row = await prisma.audiobookTask.findUniqueOrThrow({ where: { id: task.id } });
      assert.equal(row.status, 'succeeded');
      const json = JSON.parse(row.resultJson);
      assert.equal(json.m4b.status, failure ? 'failed' : 'ready');
      assert.deepEqual(json.qualityWarnings, ['retained warning']);
      assert.equal(json.completedChunks, 4);
      assert.equal(json.m4b.chapterCount, 1);
      assert.doesNotMatch(row.summary, /未生成|queued/);
    });
  });
}
for (const action of ['publish', 'failure', 'finalize']) test(`old generation ${action} cannot change new task projection`, async () => {
  await fixture(async ({ task, job, queue, part, dir }) => {
    const newer = JSON.stringify({ m4b: { status: 'encoding' }, newest: true });
    await prisma.audiobookTask.update({ where: { id: task.id }, data: { status: 'running', m4bGenerationToken: 'g2', resultJson: newer } });
    if (action === 'publish') await assert.rejects(queue.publish(job, part), /no longer current/);
    else if (action === 'failure') await queue.markFailed(job, 'late failure');
    else await finalizeAudiobookTask({ taskId: task.id, generationToken: 'g1', isContinueChild: false, result: pipelineResult(dir) });
    const row = await prisma.audiobookTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(row.resultJson, newer);
    assert.equal(row.status, 'running');
  });
});
test('recovery retry exhaustion projects visible packaging failure', async () => {
  await fixture(async ({ task, job, queue }) => {
    const retried = await prisma.m4bEncodingJob.update({ where: { id: job.id }, data: { retryCount: 1 } });
    await queue.resetJob(retried);
    const row = await prisma.audiobookTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(JSON.parse(row.resultJson).m4b.status, 'failed');
  });
});


test('simultaneous worker publication and production finalization serialize on task ownership', async () => {
  await fixture(async ({ task, job, queue, part, dir }) => {
    await prisma.audiobookTask.update({ where: { id: task.id }, data: { status: 'running' } });
    await Promise.all([
      queue.publish(job, part),
      finalizeAudiobookTask({ taskId: task.id, generationToken: 'g1', isContinueChild: false, result: pipelineResult(dir) }),
    ]);
    const row = await prisma.audiobookTask.findUniqueOrThrow({ where: { id: task.id } });
    const value = JSON.parse(row.resultJson);
    assert.equal(row.status, 'succeeded'); assert.equal(value.m4b.status, 'ready');
    assert.equal(value.completedChunks, 4); assert.equal(value.m4b.chapterCount, 1);
  });
});

test('stale production finalization never prunes the current generation chunks', async () => {
  await fixture(async ({ task, dir }) => {
    const { resolveChunkAudioPath } = require('../dist/services/audiobook/audiobookPaths');
    const chunk = resolveChunkAudioPath(dir, 'chapter-1', 0);
    fs.mkdirSync(path.dirname(chunk), { recursive: true }); fs.writeFileSync(chunk, 'new-generation-audio');
    await prisma.audiobookTask.update({ where: { id: task.id }, data: { status: 'running', m4bGenerationToken: 'g2' } });
    const result = { ...pipelineResult(dir), chapterAudioPaths: [{ chapterId: 'chapter-1', path: path.join(dir, 'chapter.wav'), bytes: 10 }] };
    await finalizeAudiobookTask({ taskId: task.id, generationToken: 'g1', isContinueChild: false, result });
    assert.equal(fs.readFileSync(chunk, 'utf8'), 'new-generation-audio');
  });
});
