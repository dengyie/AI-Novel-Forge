const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const promptRunner = require("../dist/prompting/core/promptRunner.js");
const {
  ChapterArtifactDeltaService,
} = require("../dist/services/novel/runtime/ChapterArtifactDeltaService.js");
const {
  ChapterArtifactDeltaOrchestrator,
  ChapterCharacterProjection,
  ChapterPayoffProjection,
  ChapterSummaryFactProjection,
} = require("../dist/services/novel/runtime/artifacts/index.js");
const {
  ChapterProjectionSupersededError,
} = require("../dist/services/novel/runtime/projections/index.js");
const {
  stateService,
} = require("../dist/services/state/StateService.js");
const {
  openConflictService,
} = require("../dist/services/state/OpenConflictService.js");
const {
  novelFactService,
} = require("../dist/services/novel/fact/NovelFactService.js");
const {
  stateCommitService,
} = require("../dist/services/novel/state/StateCommitService.js");
const {
  characterResourceLedgerService,
} = require("../dist/services/novel/characterResource/CharacterResourceLedgerService.js");
const {
  characterResourceStaleScanService,
} = require("../dist/services/novel/characterResource/CharacterResourceStaleScanService.js");
const {
  ragServices,
} = require("../dist/services/rag/index.js");

function emptyArtifactOutput() {
  return {
    summary: "旧正文提取出的摘要",
    concreteFacts: [],
    stateDeltas: {
      summary: "旧正文状态",
      characterStates: [],
      relationStates: [],
      informationStates: [],
      foreshadowStates: [],
    },
    characterResourceDeltas: [],
    payoffDeltas: [],
    relationDynamics: [],
    factionUpdates: [],
    characterCandidates: [],
    characterKnowledgeStates: [],
    syncPlan: {
      stateSnapshot: "skip",
      characterResources: "skip",
      payoffLedger: "skip",
      characterDynamics: "skip",
      reason: "竞态测试",
    },
    confidence: 0.9,
    requiresFullReconcile: false,
  };
}

test("artifact extraction for revision N cannot project after chapter advances to N+1", async () => {
  const originals = {
    novelFindUnique: prisma.novel.findUnique,
    chapterFindFirst: prisma.chapter.findFirst,
    chapterFindMany: prisma.chapter.findMany,
    characterFindMany: prisma.character.findMany,
    payoffFindMany: prisma.payoffLedgerItem.findMany,
    transaction: prisma.$transaction,
    runStructuredPrompt: promptRunner.runStructuredPrompt,
    previousSnapshot: stateService.getLatestSnapshotBeforeChapter,
    writeFacts: novelFactService.writeChapterFacts,
    proposeAndCommit: stateCommitService.proposeAndCommit,
    listResources: characterResourceLedgerService.listResources,
    staleScan: characterResourceStaleScanService.scanAfterChapter,
    ragEnqueue: ragServices.ragIndexService.enqueueUpsert,
  };
  let contentRevision = 7;
  let releasePrompt;
  let signalPromptStarted;
  const promptStarted = new Promise((resolve) => {
    signalPromptStarted = resolve;
  });
  const promptReleased = new Promise((resolve) => {
    releasePrompt = resolve;
  });
  const writes = {
    summary: 0,
    facts: 0,
    stateCommit: 0,
    staleScan: 0,
    rag: 0,
  };

  prisma.novel.findUnique = async () => ({ title: "并发测试小说" });
  prisma.chapter.findFirst = async ({ where }) => {
    if (where.contentRevision !== undefined && where.contentRevision !== contentRevision) {
      return null;
    }
    return {
      id: "chapter-1",
      order: 1,
      title: "第一章",
      expectation: "推进冲突",
      taskSheet: null,
      contentRevision,
    };
  };
  prisma.chapter.findMany = async () => [{ id: "chapter-1", order: 1, title: "第一章" }];
  prisma.character.findMany = async () => [];
  prisma.payoffLedgerItem.findMany = async () => [];
  prisma.$transaction = async (callback) => {
    writes.summary += 1;
    return callback({
      chapter: { updateMany: async () => ({ count: 1 }) },
      chapterSummary: {
        findUnique: async () => null,
        upsert: async () => ({}),
      },
    });
  };
  stateService.getLatestSnapshotBeforeChapter = async () => null;
  characterResourceLedgerService.listResources = async () => [];
  novelFactService.writeChapterFacts = async () => {
    writes.facts += 1;
  };
  stateCommitService.proposeAndCommit = async () => {
    writes.stateCommit += 1;
    return { committed: [], pendingReview: [], rejected: [], versionRecord: null };
  };
  characterResourceStaleScanService.scanAfterChapter = async () => {
    writes.staleScan += 1;
    return 0;
  };
  ragServices.ragIndexService.enqueueUpsert = async () => {
    writes.rag += 1;
  };
  promptRunner.runStructuredPrompt = async () => {
    signalPromptStarted();
    await promptReleased;
    return { output: emptyArtifactOutput() };
  };

  try {
    const sync = new ChapterArtifactDeltaService().syncChapterArtifacts({
      novelId: "novel-1",
      chapterId: "chapter-1",
      content: "revision 7 的旧正文",
      contentRevision: 7,
    });
    await promptStarted;
    contentRevision = 8;
    releasePrompt();
    await assert.rejects(sync, (error) => error?.name === "ChapterProjectionSupersededError");
    assert.deepEqual(writes, {
      summary: 0,
      facts: 0,
      stateCommit: 0,
      staleScan: 0,
      rag: 0,
    });
  } finally {
    prisma.novel.findUnique = originals.novelFindUnique;
    prisma.chapter.findFirst = originals.chapterFindFirst;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.character.findMany = originals.characterFindMany;
    prisma.payoffLedgerItem.findMany = originals.payoffFindMany;
    prisma.$transaction = originals.transaction;
    promptRunner.runStructuredPrompt = originals.runStructuredPrompt;
    stateService.getLatestSnapshotBeforeChapter = originals.previousSnapshot;
    novelFactService.writeChapterFacts = originals.writeFacts;
    stateCommitService.proposeAndCommit = originals.proposeAndCommit;
    characterResourceLedgerService.listResources = originals.listResources;
    characterResourceStaleScanService.scanAfterChapter = originals.staleScan;
    ragServices.ragIndexService.enqueueUpsert = originals.ragEnqueue;
  }
});

test("artifact orchestrator stops later writers when one projection is superseded", async () => {
  const originals = {
    novelFindUnique: prisma.novel.findUnique,
    chapterFindFirst: prisma.chapter.findFirst,
    chapterFindMany: prisma.chapter.findMany,
    characterFindMany: prisma.character.findMany,
    payoffFindMany: prisma.payoffLedgerItem.findMany,
    transaction: prisma.$transaction,
    runStructuredPrompt: promptRunner.runStructuredPrompt,
    previousSnapshot: stateService.getLatestSnapshotBeforeChapter,
    writeFacts: novelFactService.writeChapterFacts,
    proposeAndCommit: stateCommitService.proposeAndCommit,
    listResources: characterResourceLedgerService.listResources,
    staleScan: characterResourceStaleScanService.scanAfterChapter,
    ragEnqueue: ragServices.ragIndexService.enqueueUpsert,
  };
  const output = emptyArtifactOutput();
  output.syncPlan.payoffLedger = "delta";
  output.syncPlan.characterDynamics = "delta";
  output.characterKnowledgeStates = [{
    characterName: "主角",
    knownFacts: ["已知事实"],
    hiddenFacts: ["隐藏事实"],
  }];
  const calls = { payoff: 0, dynamics: 0, knowledge: 0, rag: 0 };

  prisma.novel.findUnique = async () => ({ title: "并发测试小说" });
  prisma.chapter.findFirst = async () => ({
    id: "chapter-1",
    order: 1,
    title: "第一章",
    expectation: "推进冲突",
    taskSheet: null,
  });
  prisma.chapter.findMany = async () => [{ id: "chapter-1", order: 1, title: "第一章" }];
  prisma.character.findMany = async () => [{
    id: "character-1",
    name: "主角",
    role: "protagonist",
    castRole: null,
    currentGoal: null,
    currentState: null,
  }];
  prisma.payoffLedgerItem.findMany = async () => [];
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async () => 1,
    chapter: { updateMany: async () => ({ count: 1 }) },
    chapterSummary: {
      findUnique: async () => null,
      upsert: async () => ({}),
    },
  });
  promptRunner.runStructuredPrompt = async () => ({ output });
  stateService.getLatestSnapshotBeforeChapter = async () => null;
  novelFactService.writeChapterFacts = async () => {};
  stateCommitService.proposeAndCommit = async () => ({
    committed: [], pendingReview: [], rejected: [], versionRecord: null,
  });
  characterResourceLedgerService.listResources = async () => [];
  characterResourceStaleScanService.scanAfterChapter = async () => 0;
  ragServices.ragIndexService.enqueueUpsert = async () => {
    calls.rag += 1;
  };

  const orchestrator = new ChapterArtifactDeltaOrchestrator(
    new ChapterSummaryFactProjection(),
    { project: async () => null },
    {
      project: async () => {
        calls.payoff += 1;
        throw new ChapterProjectionSupersededError({
          novelId: "novel-1",
          chapterId: "chapter-1",
          expectedContentRevision: 7,
        });
      },
    },
    {
      projectDynamics: async () => {
        calls.dynamics += 1;
        return 0;
      },
      projectKnowledge: async () => {
        calls.knowledge += 1;
        return 0;
      },
    },
  );

  try {
    await assert.rejects(
      orchestrator.syncChapterArtifacts({
        novelId: "novel-1",
        chapterId: "chapter-1",
        content: "旧正文",
        contentRevision: 7,
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.deepEqual(calls, { payoff: 1, dynamics: 0, knowledge: 0, rag: 0 });
  } finally {
    prisma.novel.findUnique = originals.novelFindUnique;
    prisma.chapter.findFirst = originals.chapterFindFirst;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.character.findMany = originals.characterFindMany;
    prisma.payoffLedgerItem.findMany = originals.payoffFindMany;
    prisma.$transaction = originals.transaction;
    promptRunner.runStructuredPrompt = originals.runStructuredPrompt;
    stateService.getLatestSnapshotBeforeChapter = originals.previousSnapshot;
    novelFactService.writeChapterFacts = originals.writeFacts;
    stateCommitService.proposeAndCommit = originals.proposeAndCommit;
    characterResourceLedgerService.listResources = originals.listResources;
    characterResourceStaleScanService.scanAfterChapter = originals.staleScan;
    ragServices.ragIndexService.enqueueUpsert = originals.ragEnqueue;
  }
});

test("summary and fact projection acquires revision ownership before its first write", async () => {
  const originals = {
    transaction: prisma.$transaction,
    writeFacts: novelFactService.writeChapterFacts,
    ragEnqueue: ragServices.ragIndexService.enqueueUpsert,
  };
  const writes = { summary: 0, facts: 0, rag: 0 };
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async () => 0,
    chapter: {
      updateMany: async () => {
        writes.summary += 1;
        return { count: 1 };
      },
    },
    chapterSummary: {
      findUnique: async () => null,
      upsert: async () => {
        writes.summary += 1;
        return {};
      },
    },
  });
  novelFactService.writeChapterFacts = async () => {
    writes.facts += 1;
  };
  ragServices.ragIndexService.enqueueUpsert = async () => {
    writes.rag += 1;
  };

  try {
    await assert.rejects(
      new ChapterSummaryFactProjection().project({
        owner: {
          novelId: "novel-1",
          chapterId: "chapter-1",
          expectedContentRevision: 7,
        },
        chapterOrder: 1,
        content: "旧正文",
        output: emptyArtifactOutput(),
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.deepEqual(writes, { summary: 0, facts: 0, rag: 0 });
  } finally {
    prisma.$transaction = originals.transaction;
    novelFactService.writeChapterFacts = originals.writeFacts;
    ragServices.ragIndexService.enqueueUpsert = originals.ragEnqueue;
  }
});

test("state snapshot and state commit acquire revision ownership before writes", async () => {
  const originals = {
    chapterFindFirst: prisma.chapter.findFirst,
    chapterFindMany: prisma.chapter.findMany,
    characterFindMany: prisma.character.findMany,
    snapshotFindFirst: prisma.storyStateSnapshot.findFirst,
    transaction: prisma.$transaction,
    previousSnapshot: stateService.getLatestSnapshotBeforeChapter,
  };
  const writes = { snapshot: 0, proposal: 0, character: 0 };
  const staleTransaction = async (callback) => callback({
    $executeRaw: async () => 0,
    storyStateSnapshot: {
      create: async () => {
        writes.snapshot += 1;
        return { id: "snapshot-1" };
      },
    },
    stateChangeProposal: {
      create: async () => {
        writes.proposal += 1;
        return {};
      },
    },
    character: {
      update: async () => {
        writes.character += 1;
      },
    },
  });
  prisma.chapter.findFirst = async () => ({ id: "chapter-1", title: "第一章", order: 1 });
  prisma.chapter.findMany = async () => [{ id: "chapter-1", title: "第一章", order: 1 }];
  prisma.character.findMany = async () => [];
  prisma.storyStateSnapshot.findFirst = async () => null;
  prisma.$transaction = staleTransaction;
  stateService.getLatestSnapshotBeforeChapter = async () => null;

  try {
    await assert.rejects(
      stateService.persistExtractedChapterSnapshot({
        novelId: "novel-1",
        chapterId: "chapter-1",
        expectedContentRevision: 7,
        skipPayoffLedgerSync: true,
        extracted: {
          summary: "旧正文状态",
          characterStates: [],
          relationStates: [],
          informationStates: [],
          foreshadowStates: [],
        },
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.deepEqual(writes, { snapshot: 0, proposal: 0, character: 0 });

    await assert.rejects(
      stateCommitService.proposeAndCommit({
        novelId: "novel-1",
        chapterId: "chapter-1",
        chapterOrder: 1,
        content: "旧正文",
        skipFactExtraction: true,
        projectionOwner: {
          novelId: "novel-1",
          chapterId: "chapter-1",
          expectedContentRevision: 7,
        },
        proposals: [{
          novelId: "novel-1",
          chapterId: "chapter-1",
          sourceSnapshotId: null,
          sourceType: "chapter_background_sync",
          sourceStage: "chapter_execution",
          proposalType: "character_state_update",
          riskLevel: "low",
          status: "validated",
          summary: "旧 revision 的角色状态",
          payload: { characterId: "character-1", currentState: "旧状态" },
          evidence: ["旧正文证据"],
          validationNotes: [],
        }],
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.deepEqual(writes, { snapshot: 0, proposal: 0, character: 0 });
  } finally {
    prisma.chapter.findFirst = originals.chapterFindFirst;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.character.findMany = originals.characterFindMany;
    prisma.storyStateSnapshot.findFirst = originals.snapshotFindFirst;
    prisma.$transaction = originals.transaction;
    stateService.getLatestSnapshotBeforeChapter = originals.previousSnapshot;
  }
});

test("state snapshot propagates supersession from its conflict writer", async () => {
  const originals = {
    chapterFindFirst: prisma.chapter.findFirst,
    chapterFindMany: prisma.chapter.findMany,
    characterFindMany: prisma.character.findMany,
    snapshotFindFirst: prisma.storyStateSnapshot.findFirst,
    snapshotFindUnique: prisma.storyStateSnapshot.findUnique,
    transaction: prisma.$transaction,
    previousSnapshot: stateService.getLatestSnapshotBeforeChapter,
    syncConflicts: openConflictService.syncFromStateDiff,
  };
  prisma.chapter.findFirst = async () => ({ id: "chapter-1", title: "第一章", order: 1 });
  prisma.chapter.findMany = async () => [{ id: "chapter-1", title: "第一章", order: 1 }];
  prisma.character.findMany = async () => [];
  prisma.storyStateSnapshot.findFirst = async () => ({ id: "snapshot-1" });
  prisma.storyStateSnapshot.findUnique = async () => ({
    id: "snapshot-1",
    novelId: "novel-1",
    sourceChapterId: "chapter-1",
    characterStates: [],
    relationStates: [],
    informationStates: [],
    foreshadowStates: [],
  });
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async () => 1,
    storyStateSnapshot: {
      findUnique: async () => ({ id: "snapshot-1" }),
      update: async () => ({ id: "snapshot-1" }),
    },
    characterState: { deleteMany: async () => ({ count: 0 }) },
    relationState: { deleteMany: async () => ({ count: 0 }) },
    informationState: { deleteMany: async () => ({ count: 0 }) },
    foreshadowState: { deleteMany: async () => ({ count: 0 }) },
  });
  stateService.getLatestSnapshotBeforeChapter = async () => null;
  openConflictService.syncFromStateDiff = async () => {
    throw new ChapterProjectionSupersededError({
      novelId: "novel-1",
      chapterId: "chapter-1",
      expectedContentRevision: 7,
    });
  };

  try {
    await assert.rejects(
      stateService.persistExtractedChapterSnapshot({
        novelId: "novel-1",
        chapterId: "chapter-1",
        expectedContentRevision: 7,
        skipPayoffLedgerSync: true,
        extracted: {
          summary: "旧正文状态",
          characterStates: [],
          relationStates: [],
          informationStates: [],
          foreshadowStates: [],
        },
      }),
      { name: "ChapterProjectionSupersededError" },
    );
  } finally {
    prisma.chapter.findFirst = originals.chapterFindFirst;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.character.findMany = originals.characterFindMany;
    prisma.storyStateSnapshot.findFirst = originals.snapshotFindFirst;
    prisma.storyStateSnapshot.findUnique = originals.snapshotFindUnique;
    prisma.$transaction = originals.transaction;
    stateService.getLatestSnapshotBeforeChapter = originals.previousSnapshot;
    openConflictService.syncFromStateDiff = originals.syncConflicts;
  }
});

test("state snapshot resolves existing ownership after acquiring the revision lock", async () => {
  const originals = {
    chapterFindFirst: prisma.chapter.findFirst,
    chapterFindMany: prisma.chapter.findMany,
    characterFindMany: prisma.character.findMany,
    snapshotFindFirst: prisma.storyStateSnapshot.findFirst,
    snapshotFindUnique: prisma.storyStateSnapshot.findUnique,
    transaction: prisma.$transaction,
    previousSnapshot: stateService.getLatestSnapshotBeforeChapter,
    syncConflicts: openConflictService.syncFromStateDiff,
  };
  const writes = { create: 0, update: 0 };
  prisma.chapter.findFirst = async () => ({ id: "chapter-1", title: "第一章", order: 1 });
  prisma.chapter.findMany = async () => [{ id: "chapter-1", title: "第一章", order: 1 }];
  prisma.character.findMany = async () => [];
  prisma.storyStateSnapshot.findFirst = async () => null;
  prisma.storyStateSnapshot.findUnique = async () => ({
    id: "snapshot-1",
    novelId: "novel-1",
    sourceChapterId: "chapter-1",
    characterStates: [],
    relationStates: [],
    informationStates: [],
    foreshadowStates: [],
  });
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async () => 1,
    storyStateSnapshot: {
      findUnique: async () => ({ id: "snapshot-1" }),
      create: async () => {
        writes.create += 1;
        return { id: "snapshot-created" };
      },
      update: async () => {
        writes.update += 1;
        return { id: "snapshot-1" };
      },
    },
    characterState: { deleteMany: async () => ({ count: 0 }) },
    relationState: { deleteMany: async () => ({ count: 0 }) },
    informationState: { deleteMany: async () => ({ count: 0 }) },
    foreshadowState: { deleteMany: async () => ({ count: 0 }) },
  });
  stateService.getLatestSnapshotBeforeChapter = async () => null;
  openConflictService.syncFromStateDiff = async () => {};

  try {
    await stateService.persistExtractedChapterSnapshot({
      novelId: "novel-1",
      chapterId: "chapter-1",
      expectedContentRevision: 7,
      skipPayoffLedgerSync: true,
      extracted: {
        summary: "当前 revision 状态",
        characterStates: [],
        relationStates: [],
        informationStates: [],
        foreshadowStates: [],
      },
    });
    assert.deepEqual(writes, { create: 0, update: 1 });
  } finally {
    prisma.chapter.findFirst = originals.chapterFindFirst;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.character.findMany = originals.characterFindMany;
    prisma.storyStateSnapshot.findFirst = originals.snapshotFindFirst;
    prisma.storyStateSnapshot.findUnique = originals.snapshotFindUnique;
    prisma.$transaction = originals.transaction;
    stateService.getLatestSnapshotBeforeChapter = originals.previousSnapshot;
    openConflictService.syncFromStateDiff = originals.syncConflicts;
  }
});

test("payoff, character dynamics, and knowledge writers lock the chapter revision first", async () => {
  const originals = {
    payoffFindMany: prisma.payoffLedgerItem.findMany,
    volumeFindFirst: prisma.volumePlan.findFirst,
    relationFindMany: prisma.characterRelation.findMany,
    transaction: prisma.$transaction,
  };
  const writes = { payoff: 0, dynamics: 0, knowledge: 0 };
  prisma.payoffLedgerItem.findMany = async () => [];
  prisma.volumePlan.findFirst = async () => null;
  prisma.characterRelation.findMany = async () => [];
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async () => 0,
    payoffLedgerItem: {
      update: async () => { writes.payoff += 1; },
      upsert: async () => { writes.payoff += 1; },
    },
    characterCandidate: {
      deleteMany: async () => { writes.dynamics += 1; },
      create: async () => { writes.dynamics += 1; },
    },
    characterFactionTrack: {
      deleteMany: async () => { writes.dynamics += 1; },
      create: async () => { writes.dynamics += 1; },
    },
    characterRelationStage: {
      deleteMany: async () => { writes.dynamics += 1; },
      updateMany: async () => { writes.dynamics += 1; },
      create: async () => { writes.dynamics += 1; },
    },
    character: {
      findUnique: async () => {
        writes.knowledge += 1;
        return { currentState: null };
      },
      update: async () => { writes.knowledge += 1; },
    },
  });
  const owner = {
    novelId: "novel-1",
    chapterId: "chapter-1",
    expectedContentRevision: 7,
  };

  try {
    await assert.rejects(
      new ChapterPayoffProjection().project({
        owner,
        chapterOrder: 1,
        chapterTitle: "第一章",
        chapters: [{ id: "chapter-1", order: 1, title: "第一章" }],
        output: { payoffDeltas: [{}] },
        stateSnapshotId: null,
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.deepEqual(writes, { payoff: 0, dynamics: 0, knowledge: 0 });

    const characterProjection = new ChapterCharacterProjection();
    await assert.rejects(
      characterProjection.projectDynamics({
        owner,
        chapterOrder: 1,
        characters: [],
        output: {
          characterCandidates: [],
          factionUpdates: [],
          relationDynamics: [],
        },
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.deepEqual(writes, { payoff: 0, dynamics: 0, knowledge: 0 });

    await assert.rejects(
      characterProjection.projectKnowledge({
        owner,
        characters: [{
          id: "character-1",
          name: "主角",
          role: "protagonist",
          castRole: null,
          currentGoal: null,
          currentState: null,
        }],
        output: {
          characterKnowledgeStates: [{
            characterName: "主角",
            knownFacts: ["已知事实"],
            hiddenFacts: ["隐藏事实"],
          }],
        },
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.deepEqual(writes, { payoff: 0, dynamics: 0, knowledge: 0 });
  } finally {
    prisma.payoffLedgerItem.findMany = originals.payoffFindMany;
    prisma.volumePlan.findFirst = originals.volumeFindFirst;
    prisma.characterRelation.findMany = originals.relationFindMany;
    prisma.$transaction = originals.transaction;
  }
});
