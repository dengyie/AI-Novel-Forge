# Auto-Execution Ownership CAS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale auto-execution attempts from committing workflow projections or pending-review proposals after cancellation, retry, abort, or lease loss, while preserving infrastructure failures for command recovery.

**Architecture:** Bind each auto-execution run to the workflow task's stable `attemptCount` ownership snapshot. Route bootstrap, running, checkpoint, failure, and terminal projections through workflow-owned conditional updates whose final database predicate includes that snapshot plus active cancellation state; translate a zero-row result into ownership loss before notification or stale seed merge. Keep pending-review promotion inside the awaited command path and guard it immediately before commit through the same ownership fence and `AbortSignal`.

**Tech Stack:** TypeScript, Prisma, Node test runner, pnpm workspace builds.

## Global Constraints

- Do not edit, merge, or push `main`.
- Do not restructure `novelDirectorAutoExecution.ts`; add only responsibility-owned ownership/CAS modules when required.
- Preserve AI-first routing, Prompt Registry, unified chapter runtime, and chapter quality-debt continuation rules.
- Run changed tests serially and finish with shared build, server build, full fast suite, and `git diff --check`.
- Review release notes and stable wiki knowledge before every phase commit.

---

### Task 1: Baseline Test Contract And Failing Regressions

**Files:**
- Modify: `server/tests/retryTaskClaim.test.js`
- Modify: `server/tests/autoDirectorFollowUpActionExecutor.test.js`
- Modify: `server/tests/novelDirectorAutoExecutionRuntime.test.js`
- Modify: `server/tests/pendingReviewAutoPromotionRuntime.test.js`

**Interfaces:**
- Consumes: `NovelWorkflowStoreService.getTaskByIdWithoutHealing(taskId)` as the raw lookup contract.
- Produces: replayable failures for check-then-write cancellation/retry, workflow CAS miss, lookup infrastructure errors, cancellation infrastructure errors, and post-loss proposal commit prevention.

- [ ] Replace healing lookup stubs with `getTaskByIdWithoutHealing` in the two existing failing test files.
- [ ] Run both files serially and confirm their baseline failures are removed without restoring the healing facade.
- [ ] Add regression tests that pause after `assertActive`, mutate ownership before the database write, and assert no workflow notification, seed merge, cleanup, or proposal commit occurs.
- [ ] Add regression tests proving raw lookup and pipeline cancellation infrastructure errors reject instead of becoming ownership loss.
- [ ] Run the new tests before implementation and record their exact failure messages.
- [ ] Inspect the Git scope, use `readme-release-updater`, decide wiki/release-note impact, and commit the test phase.

### Task 2: Workflow Ownership CAS And Fence Error Semantics

**Files:**
- Create: `server/src/services/novel/workflow/ownership/WorkflowTaskOwnership.ts`
- Modify: `server/src/services/novel/workflow/NovelWorkflowStoreService.ts`
- Modify: `server/src/services/novel/workflow/NovelWorkflowApplicationService.ts`
- Modify: `server/src/services/novel/workflow/NovelWorkflowService.ts`
- Modify: `server/src/services/novel/director/automation/domain/AutoExecutionOwnershipFence.ts`
- Modify: `server/src/services/novel/director/automation/novelDirectorAutoExecutionRuntimePorts.ts`

**Interfaces:**
- Consumes: raw workflow task `{ id, lane, status, cancelRequestedAt, attemptCount }`.
- Produces: `WorkflowTaskOwnershipSnapshot`, ownership-aware workflow writes, and an explicit CAS-miss signal that auto-execution treats as ownership loss.

- [ ] Define the stable ownership snapshot around `taskId` and `attemptCount`; keep it workflow-owned so the persistence layer does not depend on director modules.
- [ ] Add a workflow conditional update path whose final Prisma `updateMany` predicate checks `id`, `lane=auto_director`, `attemptCount`, `cancelRequestedAt=null`, and an active status.
- [ ] Build seed/checkpoint updates from the current raw row inside the owned write transaction; fetch and notify only after the CAS succeeds.
- [ ] Extend bootstrap/running/checkpoint/failed application operations with optional ownership context while preserving existing callers.
- [ ] Make `AutoExecutionOwnershipFence` use raw lookup, preserve lookup/cancellation errors, bind the first active read to an attempt snapshot, and classify only missing/cancelled/cancel-requested/aborted or explicit CAS miss as ownership loss.
- [ ] Run targeted ownership and workflow tests until green.
- [ ] Inspect release-note/wiki scope and commit the ownership CAS phase.

### Task 3: Route Every Auto-Execution Projection Through CAS

**Files:**
- Modify: `server/src/services/novel/director/automation/novelDirectorAutoExecutionCheckpointRuntime.ts`
- Modify: `server/src/services/novel/director/automation/application/AutoExecutionRangeRunner.ts`
- Modify: `server/src/services/novel/director/automation/application/AutoExecutionBatchRollCoordinator.ts`
- Modify: `server/src/services/novel/director/automation/application/AutoExecutionFailureHandler.ts`
- Modify: `server/src/services/novel/director/automation/novelDirectorAutoExecutionCircuitBreakerRuntime.ts`
- Modify: `server/src/services/novel/director/automation/projections/AutoExecutionTaskProjector.ts`
- Modify: `server/src/services/novel/director/automation/projections/AutoExecutionRunSafetyProjector.ts`

**Interfaces:**
- Consumes: `AutoExecutionOwnershipFence.runOwnedWorkflowWrite(...)` and ownership-aware workflow port methods.
- Produces: database-fenced bootstrap, running, checkpoint, failure, and terminal projections.

- [ ] Replace read-check plus unowned workflow writes with fence-owned write calls at every auto-execution projection site.
- [ ] On ownership loss return without notification, stale seed merge, pipeline cancellation, runtime cleanup, or task cleanup.
- [ ] On infrastructure failure preserve the original error so command failure/retry/recovery can act.
- [ ] Run serial targeted auto-execution tests and server typecheck/build.
- [ ] Inspect release-note/wiki scope and commit the projection phase.

### Task 4: Awaited Pending-Review Promotion

**Files:**
- Modify: `server/src/services/novel/director/automation/projections/AutoExecutionTaskProjector.ts`
- Modify: `server/src/services/novel/director/automation/application/AutoExecutionRangeRunner.ts`
- Modify: `server/src/services/novel/director/automation/novelDirectorAutoExecutionRuntimePorts.ts`
- Modify: `server/src/services/novel/state/PendingReviewAutoPromotionService.ts` if the commit boundary needs an ownership callback.
- Modify: `docs/wiki/workflows/pending-review-auto-promotion.md`

**Interfaces:**
- Consumes: command `AbortSignal` through `AutoExecutionOwnershipFence`.
- Produces: an awaited promotion operation that cannot commit after cancellation or ownership loss and does not swallow errors.

- [ ] Change the scheduler helper to return `Promise<void>` and await enablement, ownership checks, and promotion.
- [ ] Pass a pre-commit ownership assertion into the promotion transaction when required so loss during proposal evaluation cannot commit afterward.
- [ ] Remove detached `.catch(() => null)` behavior and let infrastructure failures reach command failure handling.
- [ ] Update the durable wiki rule from fire-and-forget to command-owned awaited maintenance.
- [ ] Run promotion and auto-execution regression tests.
- [ ] Inspect release-note/wiki scope and commit the promotion phase.

### Task 5: Final Verification

**Files:**
- Modify: `docs/wiki/workflows/auto-director-runtime.md` when the final CAS contract is stable.
- Modify: `docs/releases/release-notes.md` and `README.md` only if `readme-release-updater` classifies the scope as user-facing.

**Interfaces:**
- Consumes: all prior phase commits.
- Produces: fresh evidence for the original failures and requested regression surface.

- [ ] Run `pnpm --filter @ai-novel/shared build`.
- [ ] Run `pnpm --filter @ai-novel/server prisma:generate` and `pnpm --filter @ai-novel/server build`.
- [ ] Run all changed test files serially.
- [ ] Run `pnpm --filter @ai-novel/server test:node` and record the exact pass/fail count.
- [ ] Run `git diff --check`, inspect commit history and worktree cleanliness, and confirm no main merge/push occurred.
- [ ] Use `readme-release-updater`, finalize durable wiki notes, and create the final phase commit.
