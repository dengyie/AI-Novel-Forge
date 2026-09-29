const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/db/prisma.js');
const { ChapterArtifactSyncService } = require('../dist/services/novel/runtime/ChapterArtifactSyncService.js');
const { ragMain } = require('../dist/services/rag/mainProcessProxy.js');

async function fixture(expected, skipLegacy, run, supersedeAfterSummary = false) {
  const original = { transaction: prisma.$transaction, chapter: prisma.chapter.findFirst,
    characters: prisma.character.findMany, timelines: prisma.characterTimeline.findMany,
    facts: prisma.consistencyFact.findMany, enqueue: ragMain.jobs.enqueueUpsert };
  const events = [];
  prisma.chapter.findFirst = async () => ({ order: 1, title: '第一章', contentRevision: 8 });
  prisma.character.findMany = async () => [{ id: 'person', name: '张三' }];
  prisma.characterTimeline.findMany = prisma.consistencyFact.findMany = async () => [];
  ragMain.jobs.enqueueUpsert = async () => {};
  prisma.$transaction = async callback => callback({
    $executeRaw: async () => { events.push('revision-lock'); return expected === 8 && !(supersedeAfterSummary && events.includes('summary')) ? 1 : 0; },
    chapterSummary: { findUnique: async () => null, upsert: async () => events.push('summary') },
    consistencyFact: { deleteMany: async () => events.push('delete-facts'), createMany: async () => events.push('facts') },
    characterTimeline: { deleteMany: async () => events.push('delete-timeline'), createMany: async () => events.push('timeline') },
  });
  try { await run(() => new ChapterArtifactSyncService().syncChapterArtifacts('n','c','张三正在完成这一章的重要任务。', {
    expectedContentRevision: expected, skipLegacySummaryAndFacts: skipLegacy, scheduleBackgroundSync: false,
  }), events); } finally {
    prisma.$transaction = original.transaction; prisma.chapter.findFirst = original.chapter;
    prisma.character.findMany = original.characters; prisma.characterTimeline.findMany = original.timelines;
    prisma.consistencyFact.findMany = original.facts; ragMain.jobs.enqueueUpsert = original.enqueue;
  }
}
for (const skipLegacy of [true, false]) {
  test(`old revision cannot replace direct artifacts (skipLegacy=${skipLegacy})`, async () => {
    await fixture(7, skipLegacy, async (sync, events) => {
      await assert.rejects(sync, { name: 'ChapterProjectionSupersededError' });
      assert.deepEqual(events, ['revision-lock']);
    });
  });
}
test('current revision locks each transaction before replacing direct artifacts', async () => {
  await fixture(8, false, async (sync, events) => {
    await sync();
    assert.equal(events[0], 'revision-lock');
    assert.ok(events.indexOf('delete-timeline') > events.lastIndexOf('revision-lock'));
    assert.equal(events.filter(x=>x==='revision-lock').length, 2);
    assert.ok(events.includes('summary'));
    assert.ok(events.includes('timeline'));
  });
});

test('a newer save between summary and timeline prevents the second transaction', async () => {
  await fixture(8, false, async (sync, events) => {
    await assert.rejects(sync, { name: 'ChapterProjectionSupersededError' });
    assert.ok(events.includes('summary'));
    assert.ok(!events.includes('delete-timeline'));
  }, true);
});
