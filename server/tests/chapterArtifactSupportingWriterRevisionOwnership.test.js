const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  openConflictService,
} = require("../dist/services/state/OpenConflictService.js");
const {
  characterResourceStaleScanService,
} = require("../dist/services/novel/characterResource/CharacterResourceStaleScanService.js");
const {
  StateCommitService,
} = require("../dist/services/novel/state/StateCommitService.js");
const {
  StateVersionLog,
  stateVersionLog,
} = require("../dist/services/novel/state/StateVersionLog.js");
const {
  canonicalStateService,
} = require("../dist/services/novel/state/CanonicalStateService.js");
const {
  payoffLedgerSyncService,
} = require("../dist/services/payoff/PayoffLedgerSyncService.js");
const {
  stateService,
} = require("../dist/services/state/StateService.js");
const {
  ChapterProjectionSupersededError,
} = require("../dist/services/novel/runtime/projections/index.js");

const owner = {
  novelId: "novel-1",
  chapterId: "chapter-1",
  expectedContentRevision: 7,
};

test("open-conflict and resource-stale writers lock revision before side effects", async () => {
  const originals = {
    transaction: prisma.$transaction,
    resourceFindMany: prisma.characterResourceLedgerItem.findMany,
  };
  const writes = { conflicts: 0, resources: 0, events: 0 };
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async () => 0,
    openConflict: {
      updateMany: async () => {
        writes.conflicts += 1;
        return { count: 0 };
      },
      upsert: async () => {
        writes.conflicts += 1;
      },
    },
    characterResourceLedgerItem: {
      update: async () => {
        writes.resources += 1;
      },
    },
    characterResourceEvent: {
      create: async () => {
        writes.events += 1;
      },
    },
  });
  prisma.characterResourceLedgerItem.findMany = async () => [{
    id: "resource-1",
    status: "available",
    expectedUseEndChapterOrder: 3,
    lastTouchedChapterOrder: 1,
    holderCharacterId: "character-1",
    riskSignalsJson: "[]",
  }];

  try {
    await assert.rejects(
      openConflictService.syncFromStateDiff({
        novelId: "novel-1",
        chapterId: "chapter-1",
        chapterOrder: 8,
        trackedConflictKeys: ["state:old"],
        conflicts: [],
        expectedContentRevision: 7,
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.deepEqual(writes, { conflicts: 0, resources: 0, events: 0 });

    await assert.rejects(
      characterResourceStaleScanService.scanAfterChapter({
        novelId: "novel-1",
        chapterId: "chapter-1",
        chapterOrder: 8,
        projectionOwner: owner,
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.deepEqual(writes, { conflicts: 0, resources: 0, events: 0 });
  } finally {
    prisma.$transaction = originals.transaction;
    prisma.characterResourceLedgerItem.findMany = originals.resourceFindMany;
  }
});

test("state version creation locks revision before allocating a version", async () => {
  const originalTransaction = prisma.$transaction;
  let creates = 0;
  prisma.$transaction = async (callback) => callback({
    $executeRaw: async () => 0,
    canonicalStateVersion: {
      findFirst: async () => ({ version: 3 }),
      create: async () => {
        creates += 1;
        return {};
      },
    },
  });

  try {
    await assert.rejects(
      new StateVersionLog().createVersion({
        novelId: "novel-1",
        chapterId: "chapter-1",
        sourceType: "chapter_background_sync",
        sourceStage: "chapter_execution",
        summary: "旧 revision state version",
        acceptedProposalIds: ["proposal-1"],
        snapshot: {},
        projectionOwner: owner,
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.equal(creates, 0);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test("state commit version link rechecks revision in its own transaction", async () => {
  const originals = {
    transaction: prisma.$transaction,
    getSnapshot: canonicalStateService.getSnapshot,
    createVersion: stateVersionLog.createVersion,
  };
  let transactionNo = 0;
  let linkWrites = 0;
  prisma.$transaction = async (callback) => {
    transactionNo += 1;
    if (transactionNo === 1) {
      return callback({
        $executeRaw: async () => 1,
        stateChangeProposal: {
          create: async (input) => ({
            id: "proposal-1",
            novelId: input.data.novelId,
            chapterId: input.data.chapterId,
            sourceSnapshotId: input.data.sourceSnapshotId,
            sourceType: input.data.sourceType,
            sourceStage: input.data.sourceStage,
            proposalType: input.data.proposalType,
            riskLevel: input.data.riskLevel,
            status: input.data.status,
            summary: input.data.summary,
            payloadJson: input.data.payloadJson,
            evidenceJson: input.data.evidenceJson,
            validationNotesJson: input.data.validationNotesJson,
          }),
        },
        character: { update: async () => ({}) },
      });
    }
    return callback({
      $executeRaw: async () => 0,
      stateChangeProposal: {
        updateMany: async () => {
          linkWrites += 1;
          return { count: 1 };
        },
      },
    });
  };
  canonicalStateService.getSnapshot = async () => ({});
  stateVersionLog.createVersion = async () => ({ id: "version-1" });

  try {
    await assert.rejects(
      new StateCommitService().proposeAndCommit({
        novelId: "novel-1",
        chapterId: "chapter-1",
        chapterOrder: 1,
        content: "旧正文",
        skipFactExtraction: true,
        projectionOwner: owner,
        proposals: [{
          novelId: "novel-1",
          chapterId: "chapter-1",
          sourceSnapshotId: null,
          sourceType: "chapter_background_sync",
          sourceStage: "chapter_execution",
          proposalType: "character_state_update",
          riskLevel: "low",
          status: "validated",
          summary: "旧 revision 角色状态",
          payload: { characterId: "character-1", currentState: "旧状态" },
          evidence: ["旧正文证据"],
          validationNotes: [],
        }],
      }),
      { name: "ChapterProjectionSupersededError" },
    );
    assert.equal(transactionNo, 2);
    assert.equal(linkWrites, 0);
  } finally {
    prisma.$transaction = originals.transaction;
    canonicalStateService.getSnapshot = originals.getSnapshot;
    stateVersionLog.createVersion = originals.createVersion;
  }
});

test("state snapshot forwards revision ownership to non-artifact payoff sync", async () => {
  const originals = {
    chapterFindFirst: prisma.chapter.findFirst,
    chapterFindMany: prisma.chapter.findMany,
    characterFindMany: prisma.character.findMany,
    snapshotFindFirst: prisma.storyStateSnapshot.findFirst,
    snapshotFindUnique: prisma.storyStateSnapshot.findUnique,
    transaction: prisma.$transaction,
    previousSnapshot: stateService.getLatestSnapshotBeforeChapter,
    syncConflicts: openConflictService.syncFromStateDiff,
    syncLedger: payoffLedgerSyncService.syncLedger,
  };
  let payoffOwner;
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
  openConflictService.syncFromStateDiff = async () => {};
  payoffLedgerSyncService.syncLedger = async (_novelId, options) => {
    payoffOwner = options.projectionOwner;
    throw new ChapterProjectionSupersededError(owner);
  };

  try {
    await assert.rejects(
      stateService.persistExtractedChapterSnapshot({
        novelId: "novel-1",
        chapterId: "chapter-1",
        expectedContentRevision: 7,
        skipPayoffLedgerSync: false,
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
    assert.deepEqual(payoffOwner, owner);
  } finally {
    prisma.chapter.findFirst = originals.chapterFindFirst;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.character.findMany = originals.characterFindMany;
    prisma.storyStateSnapshot.findFirst = originals.snapshotFindFirst;
    prisma.storyStateSnapshot.findUnique = originals.snapshotFindUnique;
    prisma.$transaction = originals.transaction;
    stateService.getLatestSnapshotBeforeChapter = originals.previousSnapshot;
    openConflictService.syncFromStateDiff = originals.syncConflicts;
    payoffLedgerSyncService.syncLedger = originals.syncLedger;
  }
});
