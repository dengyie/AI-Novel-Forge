const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createApp } = require("../dist/app.js");
const { ragMain } = require("../dist/services/rag/mainProcessProxy.js");
const { enqueueReindexOwners } = require("../dist/services/rag/indexing/index.js");
const { prisma } = require("../dist/db/prisma.js");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("POST /api/rag/reindex all still queues worlds when there are no novels", async () => {
  const originalEnqueueOwnerJob = ragMain.jobs.enqueueOwnerJob;
  const originalQueries = {
    novel: prisma.novel.findMany,
    chapter: prisma.chapter.findMany,
    chapterSummary: prisma.chapterSummary.findMany,
    consistencyFact: prisma.consistencyFact.findMany,
    character: prisma.character.findMany,
    characterTimeline: prisma.characterTimeline.findMany,
    world: prisma.world.findMany,
    worldPropertyLibrary: prisma.worldPropertyLibrary.findMany,
    knowledgeDocument: prisma.knowledgeDocument.findMany,
  };
  const queuedOwners = [];
  let knowledgeDocumentQuery;

  ragMain.jobs.enqueueOwnerJob = async (_jobType, ownerType, ownerId) => {
    queuedOwners.push({ ownerType, ownerId });
    return { id: `rag-job-${queuedOwners.length}` };
  };
  prisma.novel.findMany = async () => [];
  prisma.chapter.findMany = async () => [];
  prisma.chapterSummary.findMany = async () => [];
  prisma.consistencyFact.findMany = async () => [];
  prisma.character.findMany = async () => [];
  prisma.characterTimeline.findMany = async () => [];
  prisma.world.findMany = async () => [{ id: "world-fixture" }];
  prisma.worldPropertyLibrary.findMany = async () => [{ id: "library-fixture" }];
  prisma.knowledgeDocument.findMany = async (args) => {
    knowledgeDocumentQuery = args;
    return [{ id: "knowledge-fixture" }];
  };

  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rag/reindex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "all" }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.count, 3);
    assert.deepEqual(knowledgeDocumentQuery.where, { status: { not: "archived" } });
    assert.deepEqual(queuedOwners, [
      { ownerType: "world", ownerId: "world-fixture" },
      { ownerType: "world_library_item", ownerId: "library-fixture" },
      { ownerType: "knowledge_document", ownerId: "knowledge-fixture" },
    ]);
  } finally {
    ragMain.jobs.enqueueOwnerJob = originalEnqueueOwnerJob;
    prisma.novel.findMany = originalQueries.novel;
    prisma.chapter.findMany = originalQueries.chapter;
    prisma.chapterSummary.findMany = originalQueries.chapterSummary;
    prisma.consistencyFact.findMany = originalQueries.consistencyFact;
    prisma.character.findMany = originalQueries.character;
    prisma.characterTimeline.findMany = originalQueries.characterTimeline;
    prisma.world.findMany = originalQueries.world;
    prisma.worldPropertyLibrary.findMany = originalQueries.worldPropertyLibrary;
    prisma.knowledgeDocument.findMany = originalQueries.knowledgeDocument;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("enqueueReindexOwners keeps owner writes within its concurrency bound", async () => {
  const owners = Array.from({ length: 10 }, (_, index) => ({
    ownerType: "world",
    ownerId: `world-${index}`,
  }));
  let active = 0;
  let maxActive = 0;

  const jobs = await enqueueReindexOwners(owners, async (owner) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { id: owner.ownerId };
  });

  assert.equal(maxActive, 4);
  assert.deepEqual(jobs, owners.map((owner) => ({ id: owner.ownerId })));
});
