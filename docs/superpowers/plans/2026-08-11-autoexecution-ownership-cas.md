# Auto-Execution Ownership CAS Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make auto-execution task ownership durable and atomic across workflow projections, pending-review promotion, and background failure handling.

**Architecture:** Add a dedicated persisted ownership version to `NovelWorkflowTask`; ownership-changing task claims and fenced writes compare and increment that version while telemetry remains non-owning. Pending-review proposal writes will perform their ownership CAS inside the same transaction as canonical proposal mutations. Auto-execution failures will remain typed and will not fall through to an unfenced outer `markTaskFailed` projection after a retry takes the task.

**Tech Stack:** TypeScript, Prisma SQLite/PostgreSQL schemas and migrations, Node `node:test`, pnpm workspace builds.

## Global Constraints

- Preserve AI-first, Prompt Registry, unified runtime, and chapter quality-debt continuation rules.
- Do not refactor `novelDirectorAutoExecution.ts` or add generic `utils`, `shared`, or `runtime` files.
- Infrastructure errors must propagate; only explicit cancellation, retry/takeover, cancel request, or abort may produce ownership loss.
- Every phase must have failing evidence before implementation, focused verification, and its own commit.

### Task 1: Dedicated Ownership Version

**Files:**
- Modify: `server/src/prisma/schema.prisma`
- Modify: `server/src/prisma/schema.sqlite.prisma`
- Create: `server/src/prisma/migrations.sqlite/<timestamp>_workflow_task_ownership_version/migration.sql`
- Create: `server/src/prisma/migrations/<timestamp>_workflow_task_ownership_version/migration.sql`
- Modify: `server/src/services/novel/workflow/ownership/WorkflowTaskOwnership.ts`
- Modify: `server/src/services/novel/director/automation/domain/AutoExecutionOwnershipFence.ts`
- Modify: `server/src/services/novel/workflow/NovelWorkflowStoreService.ts`
- Modify: `server/src/services/novel/workflow/NovelWorkflowApplicationService.ts`
- Modify: `server/src/llm/usageTracking.ts`
- Test: `server/tests/autoExecutionOwnershipFence.test.js`

- [ ] Add a regression that claims a task, records tracked LLM usage, and proves the same owner still passes and can checkpoint.
- [ ] Run the regression against the current build and observe the ownership mismatch.
- [ ] Add `ownershipVersion Int @default(0)` to both Prisma schemas and compatible migrations.
- [ ] Include `ownershipVersion` in the ownership snapshot and every ownership-changing CAS predicate/data update; keep telemetry updates from changing it.
- [ ] Regenerate Prisma, run the focused fence/store tests, and commit the phase.

### Task 2: Atomic Pending-Review Promotion

**Files:**
- Modify: `server/src/services/novel/state/StateCommitService.ts`
- Modify: `server/src/services/novel/state/PendingReviewAutoPromotionService.ts`
- Modify: `server/src/services/novel/state/stateCommitTypes.ts` (or the existing owned input type location)
- Test: `server/tests/pendingReviewAutoPromotionService.test.js`
- Test: `server/tests/pendingReviewAutoPromotionRuntime.test.js`

- [ ] Add a latch-based regression where cancellation/retry wins after the old pre-commit read and before proposal transaction; assert no canonical or proposal commit/rejection.
- [ ] Run it against the current build and observe the stale proposal write.
- [ ] Pass the original ownership snapshot into commit/rejection operations and perform an atomic task CAS in the same Prisma transaction as proposal mutations.
- [ ] Return the post-CAS ownership snapshot to the caller's fence; propagate infrastructure errors unchanged.
- [ ] Run focused promotion/state tests and commit the phase.

### Task 3: Fenced Outer Failure Projection

**Files:**
- Modify: `server/src/services/novel/director/automation/application/AutoExecutionRangeRunner.ts`
- Modify: `server/src/services/novel/director/NovelDirectorService.ts`
- Modify: `server/src/services/novel/director/automation/domain/AutoExecutionOwnershipFence.ts` (only if typed error metadata is required)
- Test: `server/tests/novelDirectorAutoExecutionRuntime.test.js`
- Test: `server/tests/directorCommandExecutionContext.test.js`

- [ ] Add a regression where an auto-execution infrastructure failure is followed by a retry claim before the outer wrapper; assert the old run never calls unfenced `markTaskFailed`.
- [ ] Run it against the current build and observe the stale failure projection.
- [ ] Mark auto-execution runner errors with a typed no-outer-projection contract and skip only that typed class in the generic wrapper; preserve generic projection for non-auto-execution flows.
- [ ] Run focused command/runtime tests and commit the phase.

### Task 4: Documentation and Release Scope

**Files:**
- Modify: `docs/wiki/workflows/auto-director-runtime.md`
- Modify: `docs/wiki/workflows/pending-review-auto-promotion.md`

- [ ] Document the dedicated ownership version and transaction boundary as durable runtime rules.
- [ ] Run `readme-release-updater` against the exact diff and skip release notes if the scope remains internal-only.
- [ ] Commit documentation if it is a separate coherent phase.

### Task 5: Rebase, Verify, Merge, Notify

- [ ] Rebase the feature branch onto the latest clean `main` without touching unrelated worktrees.
- [ ] Run shared build, Prisma generate, server build, changed tests serially, full fast suite on a fresh disposable SQLite database, and `git diff --check`.
- [ ] Merge the feature branch into `main` from the protected main worktree only after rebase and verification.
- [ ] Notify the main-branch agent with merge hash, fixes, verification counts, and no-push status.
- [ ] Perform a final production review of the merged diff and report any residual risk.
