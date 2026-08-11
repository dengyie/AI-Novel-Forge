# Auto-Execution Ownership Handoff Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a stale auto-execution worker from adopting a replacement attempt, preserve committed workflow ownership across post-CAS failures, and stop auto-promotion from overwriting a concurrent manual proposal decision.

**Architecture:** Carry the worker's immutable command lease identity (`commandId + leaseOwner + leaseAttempt`) through the director execution context into `AutoExecutionOwnershipFence`. Validate that identity on every raw ownership read and again inside each workflow/proposal transaction before the task CAS. Treat a successful task CAS as a commit boundary: publish the returned `attemptCount + ownershipVersion` to the run-local fence before notification, snapshot/version creation, or automation-ledger writes. Extract existing-proposal commit orchestration into `state/commit/` so the 694-line state facade stays below the repository hard limit.

**Tech Stack:** TypeScript, Prisma 7, SQLite/PostgreSQL, Node `node:test`, pnpm workspaces.

## Global Constraints

- Start from `main@c67d20f2c2c94ff012f12d3ffd9fc1fc014e91f0` on `codex/fix-autoexecution-ownership-handoff`; never modify, merge, or push the protected main worktree.
- Add replayable failing tests before implementation and preserve raw infrastructure errors unchanged.
- AbortSignal remains a responsiveness aid, not the durable ownership authority.
- Workflow projection CAS must retain `taskId + lane + active status + cancelRequestedAt=null + attemptCount + ownershipVersion` and additionally fence the active command lease when command identity exists.
- Local chapter quality debt, Prompt Registry, Context Broker, unified chapter runtime, migrations, and recovery behavior remain out of scope except for regression verification.
- This is an internal correctness repair; release notes are updated only if final Git scope reveals a user-visible behavior note that is appropriate under the repository release workflow.
- Do not merge or push after the phase commit.

---

### Task 1: Reproduce Stable Command-Ownership Loss

**Files:**
- Modify: `server/tests/autoExecutionOwnershipFence.test.js`
- Modify: `server/tests/novelDirectorAutoExecutionRuntime.test.js`
- Modify: `server/tests/directorCommandExecutionContext.test.js`

**Interfaces:**
- Consumes: current `AutoExecutionOwnershipFence`, `NovelDirectorAutoExecutionRuntime`, and director command execution context.
- Produces: failing evidence for a fence created by worker A whose command is re-leased to worker B before the first raw task lookup.

- [x] **Step 1: Add the fence-level cross-worker takeover regression**

```js
const oldExecution = {
  commandId: "command-1",
  leaseOwner: "worker-a:slot-1",
  leaseAttempt: 3,
  leaseMs: 120_000,
};

// Construct the old fence, then expose a command row owned by worker B before
// the first assertActive(). The assertion must reject as ownership loss and
// must not invoke pipeline cleanup.
```

- [x] **Step 2: Add the runtime regression for stale seed/notification/cleanup suppression**

```js
assert.deepEqual(calls, [
  ["getDirectorCommandLeaseWithoutHealing", "command-1"],
]);
assert.equal(calls.some(([name]) => name === "bootstrapTask"), false);
assert.equal(calls.some(([name]) => name === "recordCheckpoint"), false);
assert.equal(calls.some(([name]) => name === "markTaskFailed"), false);
assert.equal(calls.some(([name]) => name === "cancelPipelineJob"), false);
```

- [x] **Step 3: Add an execution-context regression proving the worker lease attempt is propagated**

```js
await executor.execute("command-1", {
  leaseOwner: "worker-a:slot-1",
  leaseAttempt: 3,
  leaseMs: 120_000,
});
assert.deepEqual(observedExecution.commandExecution, {
  commandId: "command-1",
  leaseOwner: "worker-a:slot-1",
  leaseAttempt: 3,
  leaseMs: 120_000,
});
```

- [x] **Step 4: Build and run the three tests serially to capture RED evidence**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server build
node --test --test-concurrency=1 server/tests/autoExecutionOwnershipFence.test.js server/tests/novelDirectorAutoExecutionRuntime.test.js server/tests/directorCommandExecutionContext.test.js
```

Expected: the new takeover/context assertions fail because the fence currently adopts the replacement task version and the execution context carries only AbortSignal state.

### Task 2: Bind the Fence to the Immutable Command Lease

**Files:**
- Modify: `server/src/services/novel/director/commands/DirectorCommandLeaseGuard.ts`
- Modify: `server/src/services/novel/director/commands/DirectorCommandExecutor.ts`
- Modify: `server/src/workers/directorWorker.ts`
- Modify: `server/src/services/novel/director/runtime/DirectorExecutionContext.ts`
- Modify: `server/src/services/novel/director/automation/application/AutoExecutionRangeRunner.ts`
- Modify: `server/src/services/novel/director/automation/domain/AutoExecutionOwnershipFence.ts`
- Modify: `server/src/services/novel/director/automation/novelDirectorAutoExecutionRuntimePorts.ts`
- Modify: `server/src/services/novel/workflow/NovelWorkflowStoreService.ts`
- Modify: `server/src/services/novel/workflow/ownership/WorkflowTaskOwnership.ts`
- Create: `server/src/services/novel/workflow/ownership/WorkflowTaskExecutionFence.ts`

**Interfaces:**
- Consumes: the leased command snapshot returned by `DirectorTaskQueue.leaseNext()`.
- Produces: `WorkflowTaskCommandExecution` and a workflow ownership claim whose final transaction validates command id, task id, active status, owner, lease attempt, and unexpired lease.

- [x] **Step 1: Define the durable execution identity and run-local ownership commit observer**

```ts
export interface WorkflowTaskCommandExecution {
  commandId: string;
  leaseOwner: string;
  leaseAttempt: number;
  leaseMs: number;
}

export interface WorkflowTaskOwnershipRuntime {
  execution?: WorkflowTaskCommandExecution;
  onCommitted?: (ownership: WorkflowTaskOwnershipSnapshot) => void;
}
```

Store runtime metadata outside the serializable snapshot and expose functions to bind/read it.

- [x] **Step 2: Propagate the leased snapshot, not a later database reread**

```ts
const outcome = await this.commandExecutor.execute(command.id, {
  signal: renewal.signal,
  leaseOwner: `${this.queue.workerId}:${slotId}`,
  leaseAttempt: command.attempt,
  leaseMs: this.queue.leaseMs,
});
```

`DirectorCommandExecutor` must place this identity in `DirectorExecutionContext`; `AutoExecutionRangeRunner` reads it when constructing the fence.

- [x] **Step 3: Add raw command ownership lookup to `NovelWorkflowStoreService`**

```ts
return prisma.directorRunCommand.findUnique({
  where: { id: commandId },
  select: {
    id: true,
    taskId: true,
    status: true,
    leaseOwner: true,
    leaseExpiresAt: true,
    attempt: true,
  },
});
```

`assertActive()` must propagate lookup errors unchanged and classify only a missing/mismatched/expired command as ownership loss without cancelling a pipeline owned by the replacement run.

- [x] **Step 4: Add the transactional command fence**

```ts
const fenced = await tx.directorRunCommand.updateMany({
  where: {
    id: execution.commandId,
    taskId: ownership.taskId,
    status: { in: ["leased", "running"] },
    leaseOwner: execution.leaseOwner,
    leaseExpiresAt: { gt: now },
    attempt: execution.leaseAttempt,
  },
  data: {
    leaseExpiresAt: new Date(now.getTime() + execution.leaseMs),
  },
});
if (fenced.count !== 1) {
  throw new WorkflowTaskOwnershipLostError(ownership.taskId);
}
```

Run this before the workflow task `updateMany` inside the same Prisma transaction.

- [x] **Step 5: Re-run Task 1 tests and confirm GREEN**

Expected: the old worker stops before task lookup/write side effects; raw lookup failures still propagate.

### Task 3: Publish Committed Ownership Before Post-CAS Side Effects

**Files:**
- Modify: `server/tests/autoExecutionOwnershipFence.test.js`
- Modify: `server/tests/stateCommitService.test.js`
- Modify: `server/tests/pendingReviewAutoPromotionService.test.js`
- Modify: `server/src/services/novel/workflow/NovelWorkflowStoreService.ts`
- Modify: `server/src/services/novel/workflow/ownership/WorkflowTaskOwnership.ts`
- Modify: `server/src/services/novel/state/StateCommitService.ts`
- Create: `server/src/services/novel/state/commit/ExistingProposalCommitService.ts`
- Create: `server/src/services/novel/state/commit/README.md`
- Modify: `server/src/services/novel/state/PendingReviewAutoPromotionService.ts`

**Interfaces:**
- Consumes: an owned task CAS result containing the committed `attemptCount + ownershipVersion`.
- Produces: a synchronous run-local `onCommitted` handoff that occurs before workflow notification, canonical snapshot/version work, and auto-promotion ledger work.

- [x] **Step 1: Add three post-CAS RED regressions**

```js
await assert.rejects(runWorkflowTransition, (error) => error === notificationError);
assert.equal((await fence.assertActive()).ownershipVersion, 8);

await assert.rejects(runStateCommit, (error) => error === snapshotOrVersionError);
assert.equal((await fence.assertActive()).ownershipVersion, 8);

await assert.rejects(runPromotion, (error) => error === ledgerError);
assert.equal((await fence.assertActive()).ownershipVersion, 8);
```

Use distinct snapshot and version-log subtests so both post-transaction paths are covered. Expected RED: the fence remains on version 7 and converts the next read into ownership loss.

- [x] **Step 2: Publish workflow CAS ownership before transition notification**

```ts
publishWorkflowTaskOwnershipCommitted(input.ownership, {
  taskId: next.id,
  attemptCount: next.attemptCount,
  ownershipVersion: next.ownershipVersion,
});
await this.notifyAutoDirectorTaskTransition({ before: input.before, after: next });
```

Do not catch or suppress the notification error.

- [x] **Step 3: Extract existing-proposal commit orchestration**

Move `commitExistingProposals` transaction/version orchestration into `state/commit/ExistingProposalCommitService.ts`. Keep `StateCommitService` as the stable facade and inject its canonical proposal application port into the extracted service. Document the responsibility boundary in `state/commit/README.md`.

- [x] **Step 4: Publish the state-task CAS ownership immediately after its transaction**

```ts
const transactionResult = await prisma.$transaction(/* ownership + proposal transaction */);
publishWorkflowTaskOwnershipCommitted(input.ownership, transactionResult.ownership);
// Only then run canonical snapshot, version creation, and version-link updates.
```

Snapshot/version/link errors must remain the original thrown values.

- [x] **Step 5: Publish the returned ownership before the auto-promotion ledger**

```ts
commitResult = await commitService.commitExistingProposals(input);
publishWorkflowTaskOwnershipCommitted(options.ownership, commitResult.ownership);
await this.recordLedgerEvent(/* actual claimed ids */);
```

Do not swallow ledger failures.

- [x] **Step 6: Re-run the post-CAS tests and confirm GREEN**

Expected: every real post-commit error propagates by identity while the next fence read accepts the committed ownership version.

### Task 4: CAS Final Proposal Decisions Against Manual Review

**Files:**
- Modify: `server/tests/stateCommitService.test.js`
- Modify: `server/tests/pendingReviewAutoPromotionService.test.js`
- Modify: `server/src/services/novel/state/commit/ExistingProposalCommitService.ts`
- Modify: `server/src/services/novel/state/PendingReviewAutoPromotionService.ts`

**Interfaces:**
- Consumes: proposal rows previewed as `pending_review`.
- Produces: per-proposal final-state CAS constrained by `id + novelId + status=pending_review`; only successfully claimed rows can mutate canonical state, create a version, or appear in the automation ledger.

- [x] **Step 1: Add the manual-decision race RED regression**

```js
stateChangeProposal.findMany = async () => [pendingRow];
stateChangeProposal.updateMany = async () => ({ count: 0 }); // human accepted/rejected first

assert.equal(canonicalApplyCalls, 0);
assert.equal(snapshotCalls, 0);
assert.equal(versionCalls, 0);
assert.equal(ledgerCalls, 0);
```

Expected RED: the current id-only `update()` overwrites the concurrent manual status and proceeds to canonical/version/ledger work.

- [x] **Step 2: Replace id-only writes with final-state `updateMany` claims**

```ts
const claimed = await tx.stateChangeProposal.updateMany({
  where: {
    id: proposal.id,
    novelId: input.novelId,
    status: "pending_review",
  },
  data: {
    status: "committed",
    validationNotesJson: JSON.stringify(proposal.validationNotes),
  },
});
if (claimed.count !== 1) {
  continue;
}
await applyCommittedProposal(tx, proposal);
```

Apply the same conditional claim to superseded rejection.

- [x] **Step 3: Build ledger payloads from actual claimed results**

If a preview found candidates but every final claim lost to a manual decision, do not write a promotion ledger. Preserve the existing zero-preview-candidate ledger path, fenced by `beforeCommit`, for operational audit.

- [x] **Step 4: Re-run state/promotion tests and confirm GREEN**

Expected: manual decisions win; no canonical proposal, state version, or promotion ledger is written for lost claims.

### Task 5: Durable Documentation and Verification

**Files:**
- Modify: `docs/wiki/workflows/auto-director-runtime.md`
- Modify: `docs/wiki/workflows/auto-director-command-lease.md`
- Modify: `docs/wiki/workflows/pending-review-auto-promotion.md`

**Interfaces:**
- Consumes: verified runtime/transaction behavior.
- Produces: durable Chinese rules describing command lease identity, ownership handoff timing, and manual-review CAS precedence.

- [x] **Step 1: Update the workflow wiki**

Document why task attempt/version alone cannot be first-read claimable, why the final transaction also fences the command lease, why post-CAS errors must still advance the run-local ownership snapshot, and why proposal status is conditionally claimed at the final write.

- [x] **Step 2: Run focused verification serially**

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server prisma:generate
pnpm --filter @ai-novel/server build
node --test --test-concurrency=1 server/tests/autoExecutionOwnershipFence.test.js server/tests/directorCommandExecutionContext.test.js server/tests/directorWorker.test.js server/tests/novelDirectorAutoExecutionRuntime.test.js server/tests/stateCommitService.test.js server/tests/pendingReviewAutoPromotionService.test.js server/tests/pendingReviewAutoPromotionRuntime.test.js server/tests/workflowOwnershipTelemetryPrisma.test.js
```

- [x] **Step 3: Run the full fast suite with one test worker**

```bash
TEST_CONCURRENCY=1 pnpm --filter @ai-novel/server test:node
```

- [x] **Step 4: Apply every SQLite migration to an isolated temporary database**

```bash
verification_dir="$(mktemp -d)"
sqlite3 "${verification_dir}/ownership.db" 'PRAGMA user_version;'
DATABASE_URL="file:${verification_dir}/ownership.db" AI_NOVEL_DATABASE_MODE=sqlite pnpm --filter @ai-novel/server exec prisma migrate deploy --config prisma.config.ts
sqlite3 "${verification_dir}/ownership.db" 'PRAGMA table_info("NovelWorkflowTask");'
```

Expected: migration deploy exits 0 and `ownershipVersion` is present with `NOT NULL` and default `0`. Remove only this explicit temporary directory after inspection.

- [x] **Step 5: Run final static checks**

```bash
git diff --check
git status --short --branch
```

- [x] **Step 6: Execute `readme-release-updater` before the commit**

Inspect the exact Git scope. The final scope has clear user-visible reliability impact in retry takeover, post-save recovery, and manual-review precedence, so record a date-based user-facing update without exposing internal ownership vocabulary.

- [ ] **Step 7: Commit the coherent phase**

```bash
git add docs/superpowers/plans/2026-08-11-autoexecution-ownership-handoff-race.md docs/wiki/workflows server/src server/tests
git commit -m "fix: fence autoexecution ownership handoff"
```

- [ ] **Step 8: Report without merge or push**

Report branch, commit, diff summary, RED/GREEN evidence, complete verification commands/results, migration proof, and residual risk. Do not merge into `main` and do not push.
