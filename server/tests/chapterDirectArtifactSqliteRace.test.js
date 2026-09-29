const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chapter-artifact-race-'));
const file = path.join(directory, 'fixture.db');
process.env.DATABASE_URL = `file:${file}`;
const connection = new Database(file);
connection.exec(`
  CREATE TABLE Chapter (id TEXT PRIMARY KEY, novelId TEXT, "order" INTEGER, title TEXT, content TEXT, contentRevision INTEGER, riskFlags TEXT);
  CREATE TABLE Character (id TEXT PRIMARY KEY, novelId TEXT, name TEXT);
  CREATE TABLE CharacterTimeline (id TEXT PRIMARY KEY, novelId TEXT, characterId TEXT, chapterId TEXT, chapterOrder INTEGER, title TEXT, content TEXT, source TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE ChapterSummary (id TEXT PRIMARY KEY, novelId TEXT, chapterId TEXT UNIQUE, summary TEXT, keyEvents TEXT, characterStates TEXT, hook TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE ConsistencyFact (id TEXT PRIMARY KEY, novelId TEXT, chapterId TEXT, category TEXT, content TEXT, source TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP);
`);
const { prisma } = require('../dist/db/prisma.js');
const { ChapterArtifactSyncService } = require('../dist/services/novel/runtime/ChapterArtifactSyncService.js');
const { ragMain } = require('../dist/services/rag/mainProcessProxy.js');
const originalEnqueue = ragMain.jobs.enqueueUpsert;
ragMain.jobs.enqueueUpsert = async () => {};
test.after(async () => {
  ragMain.jobs.enqueueUpsert = originalEnqueue;
  await prisma.$disconnect(); connection.close(); fs.rmSync(directory, { recursive:true });
});

for (const pausedTransaction of [1, 2]) {
  test(`SQLite newer save wins when old artifact transaction ${pausedTransaction} resumes late`, async () => {
    const chapterId = `chapter-${pausedTransaction}`;
    connection.prepare('INSERT INTO Chapter VALUES (?, ?, 1, ?, ?, 7, NULL)').run(chapterId, 'novel', '第一章', '张三仍在追查旧目标，沿着街道继续调查。');
    connection.prepare('INSERT OR IGNORE INTO Character VALUES (?, ?, ?)').run('character', 'novel', '张三');
    const originalTransaction = prisma.$transaction.bind(prisma);
    let transactionNumber = 0, paused;
    const reachedPause = new Promise(resolve => paused=resolve);
    let release;
    const gate = new Promise(resolve=>release=resolve);
    prisma.$transaction = async (...args) => {
      transactionNumber++;
      if (transactionNumber === pausedTransaction) { paused(); await gate; }
      return originalTransaction(...args);
    };
    const service = new ChapterArtifactSyncService();
    const stale = service.syncChapterArtifacts('novel', chapterId, '张三仍在追查旧目标，沿着街道继续调查。', {
      expectedContentRevision:7, scheduleBackgroundSync:false,
    });
    // Attach rejection observation before releasing the delayed transaction.
    const rejected = assert.rejects(stale, { name:'ChapterProjectionSupersededError' });
    try {
      await reachedPause;
      const latest = '张三已经完成新的目标，带着证据离开城市。';
      connection.prepare('UPDATE Chapter SET content=?, contentRevision=8 WHERE id=? AND contentRevision=7').run(latest, chapterId);
      await service.syncChapterArtifacts('novel', chapterId, latest, { expectedContentRevision:8, scheduleBackgroundSync:false });
      const snapshot = () => ({
        timeline:connection.prepare('SELECT content FROM CharacterTimeline WHERE chapterId=? ORDER BY id').all(chapterId),
        facts:connection.prepare('SELECT content FROM ConsistencyFact WHERE chapterId=? ORDER BY id').all(chapterId),
        summary:connection.prepare('SELECT keyEvents, characterStates FROM ChapterSummary WHERE chapterId=?').get(chapterId),
      });
      const afterNewSave = snapshot();
      assert.ok(afterNewSave.timeline.length > 0);
      release(); await rejected;
      assert.deepEqual(snapshot(), afterNewSave);
      assert.equal(connection.prepare('SELECT contentRevision FROM Chapter WHERE id=?').get(chapterId).contentRevision,8);
    } finally { release(); prisma.$transaction = originalTransaction; }
  });
}
