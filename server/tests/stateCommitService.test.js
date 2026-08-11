const test = require("node:test");
const assert = require("node:assert/strict");

const {
  StateCommitService,
} = require("../dist/services/novel/state/StateCommitService.js");
const { prisma } = require("../dist/db/prisma.js");
const { canonicalStateService } = require("../dist/services/novel/state/CanonicalStateService.js");
const { stateVersionLog } = require("../dist/services/novel/state/StateVersionLog.js");
const {
  AutoExecutionOwnershipFence,
} = require("../dist/services/novel/director/automation/domain/AutoExecutionOwnershipFence.js");

function makeResourceProposal(overrides = {}) {
  const { payload: payloadOverrides = {}, ...proposalOverrides } = overrides;
  return {
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "chapter_background_sync",
    sourceStage: "chapter_execution",
    proposalType: "character_resource_update",
    riskLevel: "low",
    status: "validated",
    summary: "hero acquires the service tunnel key",
    payload: {
      resourceKey: "service_tunnel_key:char-1",
      resourceName: "service tunnel key",
      chapterOrder: 5,
      resourceType: "credential",
      narrativeFunction: "key",
      updateType: "acquired",
      ownerType: "character",
      ownerId: "char-1",
      ownerName: "Hero",
      holderCharacterId: "char-1",
      holderCharacterName: "Hero",
      statusAfter: "available",
      visibilityAfter: {
        readerKnows: true,
        holderKnows: true,
        knownByCharacterIds: ["char-1"],
      },
      narrativeImpact: "Hero can enter the service tunnel but cannot bypass the vault door.",
      expectedFutureUse: "reach the underground corridor",
      constraints: ["only opens the service tunnel"],
      confidence: 0.86,
      ...payloadOverrides,
    },
    evidence: ["Hero puts the service tunnel key in his inner pocket."],
    validationNotes: [],
    ...proposalOverrides,
  };
}

function makePersistedPendingProposal(overrides = {}) {
  const now = new Date("2026-08-11T00:00:00.000Z");
  return {
    id: "proposal-1",
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "chapter_background_sync",
    sourceStage: "chapter_execution",
    proposalType: "information_disclosure",
    riskLevel: "medium",
    status: "pending_review",
    summary: "reader learns the hidden employer",
    payloadJson: JSON.stringify({ fact: "the employer is the prince" }),
    evidenceJson: JSON.stringify(["the reveal is on page"]),
    validationNotesJson: JSON.stringify(["requires manual review"]),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function assertOwnedCommitPostFailurePreservesOwnership(failAt) {
  const service = new StateCommitService();
  const originalTransaction = prisma.$transaction;
  const originalProposalUpdateMany = prisma.stateChangeProposal.updateMany;
  const originalGetSnapshot = canonicalStateService.getSnapshot;
  const originalCreateVersion = stateVersionLog.createVersion;
  const postCommitError = new Error(`${failAt} unavailable after task CAS`);
  const proposalRow = makePersistedPendingProposal();
  let persistedOwnershipVersion = 7;

  prisma.$transaction = async (callback) => callback({
    novelWorkflowTask: {
      async updateMany() {
        persistedOwnershipVersion = 8;
        return { count: 1 };
      },
      async findUnique() {
        return {
          id: "task-1",
          attemptCount: 3,
          ownershipVersion: persistedOwnershipVersion,
        };
      },
    },
    stateChangeProposal: {
      async findMany({ where }) {
        return where.id?.in?.includes("proposal-1") ? [proposalRow] : [];
      },
      async update() {
        return proposalRow;
      },
      async updateMany() {
        return { count: 1 };
      },
    },
  });
  prisma.stateChangeProposal.updateMany = async () => ({ count: 1 });
  canonicalStateService.getSnapshot = async () => {
    if (failAt === "snapshot") {
      throw postCommitError;
    }
    return { novelId: "novel-1", snapshot: true };
  };
  stateVersionLog.createVersion = async () => {
    if (failAt === "version") {
      throw postCommitError;
    }
    return { id: "version-1" };
  };

  try {
    const fence = new AutoExecutionOwnershipFence({
      workflowService: {
        async getTaskByIdWithoutHealing() {
          return {
            status: "running",
            attemptCount: 3,
            ownershipVersion: persistedOwnershipVersion,
            cancelRequestedAt: null,
            updatedAt: new Date(),
          };
        },
      },
      novelService: { async cancelPipelineJob() {} },
    }, "task-1");

    await assert.rejects(() => fence.runOwnedOperation((ownership) => (
      service.commitExistingProposals({
        novelId: "novel-1",
        proposalIds: ["proposal-1"],
        reason: `post-cas-${failAt}-failure`,
        ownership,
      })
    )), (error) => error === postCommitError);

    const current = await fence.assertActive();
    assert.equal(current.ownershipVersion, 8);
  } finally {
    prisma.$transaction = originalTransaction;
    prisma.stateChangeProposal.updateMany = originalProposalUpdateMany;
    canonicalStateService.getSnapshot = originalGetSnapshot;
    stateVersionLog.createVersion = originalCreateVersion;
  }
}

test("StateCommitService validate auto-commits low-risk runtime updates", () => {
  const service = new StateCommitService();
  const result = service.validate([
    {
      novelId: "novel-1",
      chapterId: "chapter-5",
      sourceSnapshotId: "snapshot-5",
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "character_state_update",
      riskLevel: "low",
      status: "validated",
      summary: "hero state advanced",
      payload: {
        characterId: "char-1",
        currentState: "takes initiative",
        currentGoal: "push the counterattack",
      },
      evidence: ["hero finally starts moving"],
      validationNotes: [],
    },
  ]);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.pendingReview.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].status, "committed");
});

test("StateCommitService scopes an owned proposal commit to the workflow task novel", async () => {
  const service = new StateCommitService();
  const originalTransaction = prisma.$transaction;
  let ownershipWhere;

  prisma.$transaction = async (callback) => callback({
    novelWorkflowTask: {
      async updateMany({ where }) {
        ownershipWhere = where;
        return { count: 0 };
      },
    },
  });

  try {
    await assert.rejects(() => service.commitExistingProposals({
      novelId: "novel-1",
      proposalIds: ["proposal-1"],
      reason: "owned-scope-regression",
      ownership: {
        taskId: "task-1",
        attemptCount: 2,
        ownershipVersion: 7,
      },
    }), (error) => error?.code === "WORKFLOW_TASK_OWNERSHIP_LOST");

    assert.equal(ownershipWhere.novelId, "novel-1");
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test("StateCommitService fences the active command before task and proposal mutation", { concurrency: false }, async () => {
  const service = new StateCommitService();
  const originalTransaction = prisma.$transaction;
  let taskClaims = 0;
  let proposalReads = 0;

  prisma.$transaction = async (callback) => callback({
    directorRunCommand: {
      async updateMany() {
        return { count: 0 };
      },
    },
    novelWorkflowTask: {
      async updateMany() {
        taskClaims += 1;
        return { count: 1 };
      },
    },
    stateChangeProposal: {
      async findMany() {
        proposalReads += 1;
        return [];
      },
    },
  });

  try {
    const fence = new AutoExecutionOwnershipFence({
      workflowService: {
        async getDirectorCommandLeaseWithoutHealing() {
          return {
            id: "command-1",
            taskId: "task-1",
            status: "running",
            leaseOwner: "worker-a:slot-1",
            leaseExpiresAt: new Date("2099-08-11T00:00:00.000Z"),
            attempt: 3,
          };
        },
        async getTaskByIdWithoutHealing() {
          return {
            status: "running",
            attemptCount: 2,
            ownershipVersion: 7,
            cancelRequestedAt: null,
            updatedAt: new Date(),
          };
        },
      },
      novelService: { async cancelPipelineJob() {} },
    }, "task-1", undefined, null, {
      commandId: "command-1",
      leaseOwner: "worker-a:slot-1",
      leaseAttempt: 3,
      leaseMs: 120_000,
    });

    await assert.rejects(() => fence.runOwnedOperation((ownership) => (
      service.commitExistingProposals({
        novelId: "novel-1",
        proposalIds: ["proposal-1"],
        reason: "command-takeover-before-state-commit",
        ownership,
      })
    )), (error) => error?.code === "AUTO_EXECUTION_OWNERSHIP_LOST");
    assert.equal(taskClaims, 0);
    assert.equal(proposalReads, 0);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test("StateCommitService validate routes debt runtime updates into pending review", () => {
  const service = new StateCommitService();
  const result = service.validate([
    {
      novelId: "novel-1",
      chapterId: "chapter-5",
      sourceSnapshotId: "snapshot-5",
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "character_state_update",
      riskLevel: "low",
      status: "validated",
      sourceQuality: "debt",
      summary: "hero state advanced from degraded chapter content",
      payload: {
        characterId: "char-1",
        currentState: "takes initiative",
        currentGoal: "push the counterattack",
      },
      evidence: ["hero finally starts moving"],
      validationNotes: [],
    },
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.pendingReview[0].status, "pending_review");
  assert.match(result.pendingReview[0].validationNotes.join(" "), /source_quality:debt/);
  assert.match(result.pendingReview[0].validationNotes.join(" "), /quality debt source requires manual review/);
});

test("StateCommitService validate auto-commits low-risk character resource updates", () => {
  const service = new StateCommitService();
  const result = service.validate([makeResourceProposal()]);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.pendingReview.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].status, "committed");
});

test("StateCommitService validate auto-commits medium background character resource updates", () => {
  const service = new StateCommitService();
  const result = service.validate([
    makeResourceProposal({
      riskLevel: "medium",
      payload: {
        narrativeImpact: "Hero can use the marked sword in the next escape beat.",
      },
    }),
  ]);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.pendingReview.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].status, "committed");
  assert.match(result.accepted[0].validationNotes.join(" "), /auto-committed background resource update/);
});

test("StateCommitService validate routes debt resource updates around background auto-commit", () => {
  const service = new StateCommitService();
  const result = service.validate([
    makeResourceProposal({
      riskLevel: "medium",
      sourceQuality: "debt",
      payload: {
        narrativeImpact: "Hero can use the marked sword in the next escape beat.",
      },
    }),
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.pendingReview[0].status, "pending_review");
  assert.match(result.pendingReview[0].validationNotes.join(" "), /source_quality:debt/);
});

test("StateCommitService validate routes manual medium character resource updates into pending review", () => {
  const service = new StateCommitService();
  const result = service.validate([
    makeResourceProposal({
      sourceType: "manual_resource_extract",
      riskLevel: "medium",
    }),
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.pendingReview[0].status, "pending_review");
});

test("StateCommitService validate routes risky character resource updates into pending review", () => {
  const service = new StateCommitService();
  const result = service.validate([
    makeResourceProposal({
      riskLevel: "high",
      payload: {
        resourceName: "villain hidden ledger",
        narrativeFunction: "hidden_card",
        updateType: "destroyed",
        statusAfter: "destroyed",
        confidence: 0.42,
        narrativeImpact: "The villain loses a core blackmail resource.",
      },
    }),
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.pendingReview[0].status, "pending_review");
  assert.match(result.pendingReview[0].validationNotes.join(" "), /low confidence|manual review/);
});

test("StateCommitService validate rejects character resource updates without evidence", () => {
  const service = new StateCommitService();
  const result = service.validate([
    makeResourceProposal({
      evidence: [],
    }),
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].validationNotes.join(" "), /missing evidence/);
});

test("StateCommitService validate routes disclosure and relation drift into pending review", () => {
  const service = new StateCommitService();
  const result = service.validate([
    {
      novelId: "novel-1",
      chapterId: "chapter-5",
      sourceSnapshotId: "snapshot-5",
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "information_disclosure",
      riskLevel: "medium",
      status: "validated",
      summary: "reader now knows the hidden employer",
      payload: {
        fact: "the employer is the prince",
      },
      evidence: ["the reveal is on page"],
      validationNotes: [],
    },
    {
      novelId: "novel-1",
      chapterId: "chapter-5",
      sourceSnapshotId: "snapshot-5",
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "relation_state_update",
      riskLevel: "medium",
      status: "validated",
      summary: "trust shifts between leads",
      payload: {
        sourceCharacterId: "char-1",
        targetCharacterId: "char-2",
      },
      evidence: ["they finally exchange the evidence"],
      validationNotes: [],
    },
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 2);
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(
    result.pendingReview.map((item) => item.status),
    ["pending_review", "pending_review"],
  );
});

test("StateCommitService validate rejects malformed character updates", () => {
  const service = new StateCommitService();
  const result = service.validate([
    {
      novelId: "novel-1",
      chapterId: "chapter-5",
      sourceSnapshotId: "snapshot-5",
      sourceType: "chapter_background_sync",
      sourceStage: "chapter_execution",
      proposalType: "character_state_update",
      riskLevel: "low",
      status: "validated",
      summary: "missing character id",
      payload: {
        currentState: "unstable",
      },
      evidence: [],
      validationNotes: [],
    },
  ]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.pendingReview.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].validationNotes.join(" "), /missing characterId/);
});

test("StateCommitService conflict check routes holder mismatch into pending review", async () => {
  const service = new StateCommitService();
  const originalFindUnique = prisma.characterResourceLedgerItem.findUnique;

  try {
    prisma.characterResourceLedgerItem.findUnique = async () => ({
      holderCharacterId: "char-9",
      ownerCharacterId: "char-1",
      status: "available",
      readerKnows: true,
      holderKnows: true,
    });

    const validation = service.validate([
      makeResourceProposal({
        payload: {
          updateType: "transferred",
          previousHolderCharacterId: "char-1",
          holderCharacterId: "char-2",
          ownerId: "char-1",
        },
      }),
    ]);
    const checked = await service.applyCharacterResourceConflictChecks("novel-1", validation);

    assert.equal(checked.accepted.length, 0);
    assert.equal(checked.pendingReview.length, 1);
    assert.equal(checked.pendingReview[0].status, "pending_review");
    assert.equal(checked.pendingReview[0].riskLevel, "high");
    assert.match(checked.pendingReview[0].validationNotes.join(" "), /resource_conflict/);
  } finally {
    prisma.characterResourceLedgerItem.findUnique = originalFindUnique;
  }
});

test("StateCommitService commitExistingProposals applies ledger update and writes committed version", async () => {
  const service = new StateCommitService();
  const now = new Date();
  const proposalRow = {
    id: "proposal-1",
    novelId: "novel-1",
    chapterId: "chapter-5",
    sourceSnapshotId: null,
    sourceType: "manual_resource_extract",
    sourceStage: "chapter_resource_review",
    proposalType: "character_resource_update",
    riskLevel: "medium",
    status: "pending_review",
    summary: "confirm resource update",
    payloadJson: JSON.stringify(makeResourceProposal().payload),
    evidenceJson: JSON.stringify(["Hero puts the service tunnel key in his inner pocket."]),
    validationNotesJson: JSON.stringify(["medium risk resource update"]),
    createdAt: now,
    updatedAt: now,
  };
  const calls = {
    upsert: 0,
    eventCreate: 0,
    proposalUpdate: 0,
    updateMany: 0,
    version: 0,
  };
  const originals = {
    proposalFindMany: prisma.stateChangeProposal.findMany,
    transaction: prisma.$transaction,
    proposalUpdateMany: prisma.stateChangeProposal.updateMany,
    getSnapshot: canonicalStateService.getSnapshot,
    createVersion: stateVersionLog.createVersion,
  };

  try {
    prisma.stateChangeProposal.findMany = async () => [proposalRow];
    prisma.$transaction = async (callback) => callback({
      characterResourceLedgerItem: {
        findUnique: async () => null,
        upsert: async () => {
          calls.upsert += 1;
          return { id: "resource-1" };
        },
      },
      characterResourceEvent: {
        create: async () => {
          calls.eventCreate += 1;
        },
      },
      stateChangeProposal: {
        findMany: async () => [proposalRow],
        updateMany: async (args) => {
          calls.proposalUpdate += 1;
          assert.equal(args.where.id, "proposal-1");
          assert.equal(args.where.novelId, "novel-1");
          assert.equal(args.where.status, "pending_review");
          assert.equal(args.data.status, "committed");
          return { count: 1 };
        },
      },
    });
    prisma.stateChangeProposal.updateMany = async (args) => {
      calls.updateMany += 1;
      assert.deepEqual(args.where.id.in, ["proposal-1"]);
      assert.equal(args.data.committedVersionId, "version-1");
    };
    canonicalStateService.getSnapshot = async () => ({ novelId: "novel-1", snapshot: true });
    stateVersionLog.createVersion = async (input) => {
      calls.version += 1;
      assert.deepEqual(input.acceptedProposalIds, ["proposal-1"]);
      return { id: "version-1" };
    };

    const result = await service.commitExistingProposals({
      novelId: "novel-1",
      proposalIds: ["proposal-1"],
      chapterId: "chapter-5",
      chapterOrder: 5,
      reason: "test_confirm",
    });

    assert.equal(result.committed.length, 1);
    assert.equal(result.versionRecord.id, "version-1");
    assert.deepEqual(calls, {
      upsert: 1,
      eventCreate: 1,
      proposalUpdate: 1,
      updateMany: 1,
      version: 1,
    });
  } finally {
    prisma.stateChangeProposal.findMany = originals.proposalFindMany;
    prisma.$transaction = originals.transaction;
    prisma.stateChangeProposal.updateMany = originals.proposalUpdateMany;
    canonicalStateService.getSnapshot = originals.getSnapshot;
    stateVersionLog.createVersion = originals.createVersion;
  }
});

test("StateCommitService preserves committed ownership when canonical snapshot fails after CAS", { concurrency: false }, async () => {
  await assertOwnedCommitPostFailurePreservesOwnership("snapshot");
});

test("StateCommitService preserves committed ownership when version logging fails after CAS", { concurrency: false }, async () => {
  await assertOwnedCommitPostFailurePreservesOwnership("version");
});

test("StateCommitService cannot overwrite a concurrent manual proposal decision", { concurrency: false }, async () => {
  const service = new StateCommitService();
  const originalTransaction = prisma.$transaction;
  const originalProposalUpdateMany = prisma.stateChangeProposal.updateMany;
  const originalGetSnapshot = canonicalStateService.getSnapshot;
  const originalCreateVersion = stateVersionLog.createVersion;
  const proposalRow = makePersistedPendingProposal({
    proposalType: "character_state_update",
    payloadJson: JSON.stringify({
      characterId: "character-1",
      currentState: "manual decision must win",
      currentGoal: "preserve reviewer choice",
    }),
  });
  const calls = {
    unconditionalProposalUpdate: 0,
    conditionalProposalClaim: 0,
    canonicalApply: 0,
    snapshot: 0,
    version: 0,
    versionLink: 0,
  };

  prisma.$transaction = async (callback) => callback({
    stateChangeProposal: {
      async findMany({ where }) {
        return where.id?.in?.includes("proposal-1") ? [proposalRow] : [];
      },
      async update() {
        calls.unconditionalProposalUpdate += 1;
        return proposalRow;
      },
      async updateMany({ where }) {
        calls.conditionalProposalClaim += 1;
        assert.equal(where.id, "proposal-1");
        assert.equal(where.novelId, "novel-1");
        assert.equal(where.status, "pending_review");
        return { count: 0 };
      },
    },
    character: {
      async update() {
        calls.canonicalApply += 1;
      },
    },
  });
  prisma.stateChangeProposal.updateMany = async () => {
    calls.versionLink += 1;
    return { count: 1 };
  };
  canonicalStateService.getSnapshot = async () => {
    calls.snapshot += 1;
    return { novelId: "novel-1" };
  };
  stateVersionLog.createVersion = async () => {
    calls.version += 1;
    return { id: "version-1" };
  };

  try {
    const result = await service.commitExistingProposals({
      novelId: "novel-1",
      proposalIds: ["proposal-1"],
      reason: "auto-promotion-manual-decision-race",
    });

    assert.equal(result.committed.length, 0);
    assert.deepEqual(calls, {
      unconditionalProposalUpdate: 0,
      conditionalProposalClaim: 1,
      canonicalApply: 0,
      snapshot: 0,
      version: 0,
      versionLink: 0,
    });
  } finally {
    prisma.$transaction = originalTransaction;
    prisma.stateChangeProposal.updateMany = originalProposalUpdateMany;
    canonicalStateService.getSnapshot = originalGetSnapshot;
    stateVersionLog.createVersion = originalCreateVersion;
  }
});
