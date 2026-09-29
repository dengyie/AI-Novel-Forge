const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { PrismaClient } = require('@prisma/client');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

test('knowledge source and index job share a real SQLite commit boundary', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovel-queue-transaction-'));
  const databasePath = path.join(directory, 'fixture.db');
  const setup = new Database(databasePath);
  const migrations = path.join(__dirname, '../src/prisma/migrations.sqlite');
  const initial = fs.readFileSync(path.join(migrations, '20260313170000_init/migration.sql'), 'utf8');
  // Use canonical DDL for the tested aggregate and its read-side count relation.
  for (const table of ['KnowledgeDocument', 'KnowledgeDocumentVersion', 'RagIndexJob', 'BookAnalysis']) {
    const ddl = initial.match(new RegExp(`CREATE TABLE "${table}" \\([\\s\\S]*?\\n\\);`));
    assert.ok(ddl, `missing canonical DDL: ${table}`);
    setup.exec(ddl[0]);
  }
  const publishMigration = fs.readFileSync(path.join(migrations, '20260626123000_knowledge_document_publish_kind/migration.sql'), 'utf8');
  for (const statement of publishMigration.split(';')) {
    if (statement.trim().startsWith('ALTER TABLE "KnowledgeDocument"')) setup.exec(statement);
  }
  setup.close();
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }), log: [] });
  // The application receives an actual isolated Prisma client, never a transaction mock.
  const prismaModule = require.resolve('../dist/db/prisma');
  const previousModule = require.cache[prismaModule];
  require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: { prisma } };
  const { KnowledgeService } = require('../dist/services/knowledge/KnowledgeService');
  const { ragMain } = require('../dist/services/rag/mainProcessProxy');
  const previousKick = ragMain.kickWorker;
  const observer = new Database(databasePath, { readonly: true });
  let wakeCount = 0;
  ragMain.kickWorker = () => {
    // A second connection must see the source, version and job when wake happens.
    const document = observer.prepare('SELECT * FROM KnowledgeDocument').get();
    const version = observer.prepare('SELECT * FROM KnowledgeDocumentVersion WHERE id = ?').get(document.activeVersionId);
    const job = observer.prepare('SELECT * FROM RagIndexJob WHERE ownerId = ?').get(document.id);
    assert.ok(version); assert.ok(job);
    assert.equal(JSON.parse(job.payloadJson).sourceVersionId, version.id);
    wakeCount++;
  };
  t.after(async () => {
    ragMain.kickWorker = previousKick;
    if (previousModule) require.cache[prismaModule] = previousModule;
    else delete require.cache[prismaModule];
    observer.close();
    await prisma.$disconnect();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const service = new KnowledgeService();
  const failQueue = () => prisma.$executeRawUnsafe(`CREATE TRIGGER reject_index_job BEFORE INSERT ON RagIndexJob BEGIN SELECT RAISE(ABORT, 'fixture queue failure'); END`);
  const allowQueue = () => prisma.$executeRawUnsafe('DROP TRIGGER reject_index_job');
  const isQueueInsertFailure = error => {
    // The SQLite adapter maps RAISE(ABORT) to Prisma P2003, discarding trigger text.
    assert.equal(error.code, 'P2003');
    assert.match(error.message, /ragIndexJob\.create/);
    return true;
  };

  await t.test('queue insert failure leaves no newly created source or version', async () => {
    await failQueue();
    await assert.rejects(service.createDocument({ fileName: 'new.txt', content: 'fixture content' }), isQueueInsertFailure);
    assert.equal(await prisma.knowledgeDocument.count(), 0);
    assert.equal(await prisma.knowledgeDocumentVersion.count(), 0);
    assert.equal(await prisma.ragIndexJob.count(), 0);
    assert.equal(wakeCount, 0);
    await allowQueue();
  });

  let document;
  await t.test('successful creation makes source version and job visible in the same commit', async () => {
    document = await service.createDocument({ fileName: 'new.txt', content: 'fixture content', indexPayload: { preChunks: ['fixture chunk'] } });
    assert.equal(document.latestIndexStatus, 'queued');
    assert.equal(await prisma.knowledgeDocument.count(), 1);
    assert.equal(await prisma.knowledgeDocumentVersion.count(), 1);
    const jobs = await prisma.ragIndexJob.findMany();
    assert.equal(jobs.length, 1);
    assert.deepEqual(JSON.parse(jobs[0].payloadJson).preChunks, ['fixture chunk']);
    assert.equal(wakeCount, 1);
  });

  await t.test('restoration queue failure leaves the document archived', async () => {
    await prisma.knowledgeDocument.update({ where: { id: document.id }, data: { status: 'archived', latestIndexStatus: 'idle' } });
    // Preserve the existing completed history; force restoration to insert a new job.
    await prisma.ragIndexJob.updateMany({ data: { status: 'succeeded' } });
    await failQueue();
    await assert.rejects(service.updateDocumentStatus(document.id, 'enabled'), isQueueInsertFailure);
    const after = await prisma.knowledgeDocument.findUnique({ where: { id: document.id } });
    assert.equal(after.status, 'archived');
    assert.equal(after.latestIndexStatus, 'idle');
    assert.equal(await prisma.ragIndexJob.count(), 1);
    assert.equal(wakeCount, 1);
    await allowQueue();
  });
});
