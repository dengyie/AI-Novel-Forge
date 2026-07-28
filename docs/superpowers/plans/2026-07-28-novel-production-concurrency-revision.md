# Novel Production Concurrency And Revision Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a buildable server and make chapter content, pipeline cancellation, asynchronous projections, and director task selection obey one production-safe concurrency contract.

**Architecture:** `Chapter.contentRevision` becomes the mandatory write authority for generated content and chapter-derived projections. GenerationJob cancellation becomes job-scoped while lease ownership remains execution-scoped. Timeline and artifact writers validate the committed revision after LLM work and before every canonical side effect, with artifact responsibilities moved behind an owned `runtime/artifacts` facade.

**Tech Stack:** TypeScript, Prisma 7, Node test runner, React, TanStack Query, pnpm monorepo.

## Global Constraints

- Work only in the isolated `codex/fix-novel-production-review-findings` worktree; never edit `main` directly.
- Preserve AI-first routing, Prompt Registry, Context Broker, unified chapter runtime, local quality-debt continuation, cancellation, retry, recovery, lease and idempotency semantics.
- `Chapter.content + contentRevision` is the sole chapter content authority.
- Generated draft, style rewrite and repair adoption must all use expected-revision CAS.
- Projection supersession is chapter-local degraded work, never a global replan or full-book failure.
- User cancellation is GenerationJob-scoped; lease ownership only protects executor writes.
- No source file may remain over 700 lines after it is expanded; new runtime files belong in responsibility folders and are consumed through a facade.
- Tests must exercise the real modified path, not only compatibility exports or source-text assertions.
- Use TDD for every behavior change: RED, verify RED, GREEN, verify GREEN, refactor.
- Before every commit, apply the repository readme-release-updater workflow; internal-only phases skip release notes explicitly.
- Each task owns only the files listed for it and must not revert other agents' changes.

---

### Task 1: Restore Server Type Contracts And Build

**Files:**
- Modify: `server/src/services/novel/runtime/content/ChapterContentCommitTypes.ts`
- Modify: `server/src/services/novel/chapterWritingGraph.ts`
- Modify: `server/src/services/novel/volume/volumeReadinessPolicy.ts`
- Modify if required by the exact enum import: `server/src/services/novel/volume/readiness/application/ChapterReviewStatusReconciler.ts`
- Test: `server/tests/chapterContentCommitService.test.js`
- Test: `server/tests/volumeReadinessReconcileChapterStatus.test.js`

**Interfaces:**
- `CommitChapterContentInput.statePatch` consumes `ChapterStatePairPatch`, not `Record<string, unknown>`.
- `ChapterGraphDeps.saveDraftAndArtifacts` accepts generation state `"drafted"` only.
- `VolumeReadinessChapterSignals.chapterStatus` uses `OperationalChapterStatus | null`.

- [ ] **Step 1: Verify the build fails for the three reviewed contract errors**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server prisma:generate
pnpm --filter @ai-novel/server build
```

Expected: FAIL at `ChapterPipelineRuntimeAdapter.ts:69`, `ChapterRuntimeCoordinator.ts:169`, and `ChapterReviewStatusReconciler.ts:62`.

- [ ] **Step 2: Narrow the content commit state patch**

Implement:

```ts
import type { ChapterStatePairPatch } from "../../chapterLifecycleState";

export interface CommitChapterContentInput {
  novelId: string;
  chapterId: string;
  content: string;
  expectedContentRevision: number;
  statePatch?: ChapterStatePairPatch;
  source: "style_rewrite" | "repair_adopt" | "pipeline_repair" | "writer_draft";
}
```

Update the test fixture's invalid `generationState: "ready"` to a real state such as `"drafted"`.

- [ ] **Step 3: Synchronize the graph and readiness types**

Change the graph dependency to:

```ts
generationState: "drafted"
```

Change readiness signals to:

```ts
import type { OperationalChapterStatus } from "../chapterLifecycleState";
chapterStatus: OperationalChapterStatus | null;
```

- [ ] **Step 4: Verify focused tests and build**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterContentCommitService.test.js tests/volumeReadinessReconcileChapterStatus.test.js
```

Expected: build succeeds and both files pass.

- [ ] **Step 5: Commit the internal contract repair**

Release notes: skip because this phase only restores internal type consistency.

```bash
git add server/src/services/novel/runtime/content/ChapterContentCommitTypes.ts server/src/services/novel/chapterWritingGraph.ts server/src/services/novel/volume/volumeReadinessPolicy.ts server/src/services/novel/volume/readiness/application/ChapterReviewStatusReconciler.ts server/tests/chapterContentCommitService.test.js server/tests/volumeReadinessReconcileChapterStatus.test.js
git commit -m "fix(novel): restore production runtime type contracts"
```

### Task 2: Route Initial Draft Persistence Through Revision CAS

**Files:**
- Modify: `server/src/services/novel/runtime/ChapterArtifactSyncService.ts`
- Modify: `server/src/services/novel/runtime/ChapterRuntimeCoordinator.ts`
- Modify: `server/src/services/novel/runtime/ChapterPipelineRuntimeAdapter.ts`
- Modify: `server/src/services/novel/runtime/pipeline/ChapterPipelineContracts.ts`
- Modify: `server/src/services/novel/runtime/chapterRuntimePipeline.ts`
- Modify: `server/src/services/novel/chapterWritingGraph.ts`
- Modify: `server/src/services/novel/runtime/ChapterStreamGenerationOrchestrator.ts`
- Test: `server/tests/chapterInitialDraftContentCas.test.js`
- Test: `server/tests/chapterRuntimePipeline.test.js`
- Test: `server/tests/chapterRuntimeCoordinator.test.js`

**Interfaces:**
- `saveDraftAndArtifacts` requires `expectedContentRevision` in its options.
- `ChapterArtifactSyncService` receives `ChapterContentCommitService` by constructor injection.
- Writer draft uses `source: "writer_draft"` and `chapterStatePairAfterDraftSave("drafted")`.

- [ ] **Step 1: Write a failing initial-draft race test**

The test must simulate a row at revision 7, advance it to revision 8 with manual content before writer commit, call the real `ChapterArtifactSyncService.saveDraftAndArtifacts`, and assert:

```js
assert.equal(row.content, "人工保存的新正文");
assert.equal(row.contentRevision, 8);
assert.equal(error.details.code, CHAPTER_CONTENT_CONFLICT_CODE);
```

Do not assert only that a mock was called; the in-memory updateMany must evaluate the real `where.contentRevision`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterInitialDraftContentCas.test.js
```

Expected: FAIL because draft persistence still performs unconditional `chapter.update` or lacks the expected revision.

- [ ] **Step 3: Replace unconditional draft persistence**

Change the options contract to:

```ts
export interface ChapterDraftCommitOptions extends ChapterArtifactSyncOptions {
  expectedContentRevision: number;
}
```

Implement draft commit as:

```ts
const committed = await this.contentCommitService.commit({
  novelId,
  chapterId,
  content: safeContent,
  expectedContentRevision: options.expectedContentRevision,
  statePatch: chapterStatePairAfterDraftSave("drafted"),
  source: "writer_draft",
});
```

Remove the direct `prisma.chapter.update` content write from `saveDraftAndArtifacts`.

- [ ] **Step 4: Thread the baseline revision through both runtime paths**

Add `contentRevision: number` to `ChapterRef`. Every call to draft persistence must pass:

```ts
expectedContentRevision: input.chapter.contentRevision
```

or, inside the pipeline loop:

```ts
expectedContentRevision: contentRevision
```

No call site may invent revision `0`, reload after generation, or omit the field.

- [ ] **Step 5: Verify draft, repair and pipeline behavior**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterInitialDraftContentCas.test.js tests/chapterContentCommitService.test.js tests/chapterRepairContentCas.test.js tests/chapterRuntimePipeline.test.js tests/chapterRuntimeCoordinator.test.js
```

Expected: all pass. Search verification:

```bash
rg -n "prisma\.chapter\.update\(|saveDraftAndArtifacts" server/src/services/novel/runtime server/src/services/novel/chapterWritingGraph.ts
```

Expected: no initial generated-content write bypasses `ChapterContentCommitService`.

- [ ] **Step 6: Commit the user-visible data-loss fix**

Update the date-based release note and README latest block from the user's perspective: manual edits are protected when chapter generation finishes concurrently.

```bash
git add README.md docs/releases/release-notes.md server/src/services/novel/runtime server/src/services/novel/chapterWritingGraph.ts server/tests/chapterInitialDraftContentCas.test.js server/tests/chapterRuntimePipeline.test.js server/tests/chapterRuntimeCoordinator.test.js
git commit -m "fix(novel): protect manual edits from draft generation races"
```

### Task 3: Make Cancellation Job-Scoped Instead Of Lease-Scoped

**Files:**
- Modify: `server/src/services/novel/pipeline/state/PipelineJobStateRepository.ts`
- Modify: `server/src/services/novel/pipeline/state/PipelineJobCancellationService.ts`
- Modify: `server/tests/pipelineCancelTerminalRace.test.js`
- Test: `server/tests/pipelineLifecycleCas.test.js`
- Test: `server/tests/pipelineTaskCancellationProjection.test.js`

**Interfaces:**
- `requestRunningCancellation({ jobId, requestedAt })` returns `{ count }` and does not consume lease owner.
- Cancellation preserves `leaseOwner` and `leaseExpiresAt`.

- [ ] **Step 1: Reverse the incorrect lease-takeover expectation**

Change the race test so owner A to owner B takeover expects:

```js
assert.equal(outcome.row.status, "cancelled");
assert.equal(outcome.row.leaseOwner, "pipeline-owner-b");
assert.ok(outcome.row.cancelRequestedAt instanceof Date);
assert.equal(outcome.updateManyInputs[0].where.status, "running");
assert.equal("leaseOwner" in outcome.updateManyInputs[0].where, false);
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/pipelineCancelTerminalRace.test.js
```

Expected: FAIL because the current lease-owned CAS misses.

- [ ] **Step 3: Implement status-scoped cancellation CAS**

Repository where clause:

```ts
where: {
  id: input.jobId,
  status: "running",
  finishedAt: null,
}
```

Do not write lease fields. The service must inspect `count`; on zero, reload and return terminal/cancelled rows, or retry once against a canonical queued/running row. It must never return `running` with `cancelRequestedAt === null` as a successful cancellation result.

- [ ] **Step 4: Verify lifecycle regression coverage**

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/pipelineCancelTerminalRace.test.js tests/pipelineLifecycleCas.test.js tests/pipelineTaskCancellationProjection.test.js tests/pipelineJobTerminalGuard.test.js
```

Expected: all pass; succeeded/failed terminal rows remain untouched.

- [ ] **Step 5: Commit the user-visible cancellation fix**

Merge the release note into the same current date block: cancellation remains effective when a recovering worker takes over.

```bash
git add README.md docs/releases/release-notes.md server/src/services/novel/pipeline/state server/tests/pipelineCancelTerminalRace.test.js
git commit -m "fix(novel): preserve cancellation across lease takeover"
```

### Task 4: Add A Unified Projection Revision Guard And Protect Timeline Commits

**Files:**
- Create: `server/src/services/novel/runtime/projections/ChapterProjectionRevisionGuard.ts`
- Create: `server/src/services/novel/runtime/projections/index.ts`
- Modify: `server/src/services/novel/runtime/finalization/ChapterContentFinalizationOrchestrator.ts`
- Modify: `server/src/services/novel/runtime/finalization/ChapterTimelineProjectionService.ts`
- Modify: `server/src/services/novel/runtime/ChapterTimelineFinalizationService.ts`
- Modify: `server/src/modules/timeline/timeline.service.ts`
- Modify: `server/src/modules/timeline/timeline.repository.ts`
- Modify only if a source discriminator is required: both Prisma schemas and additive PostgreSQL/SQLite migrations
- Test: `server/tests/chapterTimelineRevisionOwnership.test.js`
- Test: `server/tests/chapterFinalizationCommitFailure.test.js`

**Interfaces:**
- Use the `ChapterProjectionOwner` and `ChapterProjectionSupersededError` signatures from the design spec.
- `timelineProjection.schedule` and `finalizeCurrentContent` require `expectedContentRevision`.
- Automatic timeline writes are replace-by-chapter; manual rows remain untouched.

- [ ] **Step 1: Write a failing post-LLM timeline race test**

The test must pause timeline extraction, advance the chapter revision, release extraction, and assert zero calls that create/update event, hook or anchor rows.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterTimelineRevisionOwnership.test.js
```

Expected: FAIL because current timeline finalization has no expected revision.

- [ ] **Step 3: Implement the reusable guard**

Guard query:

```ts
const current = await this.db.chapter.findFirst({
  where: {
    id: owner.chapterId,
    novelId: owner.novelId,
    contentRevision: owner.expectedContentRevision,
  },
  select: { id: true },
});
if (!current) throw new ChapterProjectionSupersededError(owner);
```

The error must carry novelId, chapterId and expected revision, but no chapter content.

- [ ] **Step 4: Thread committed revision into timeline finalization**

Pass:

```ts
expectedContentRevision: committed.contentRevision
```

from finalization orchestration through the timeline finalizer. Run the guard after extraction/check and immediately before timeline repository side effects.

- [ ] **Step 5: Make automatic timeline re-finalization idempotent**

Within one repository transaction, validate revision again, remove prior `source="chapter_extraction"` events for the same chapter, replace only automatically-created hooks/anchor data, and preserve manual rows. If hook source cannot be identified, add a nullable/defaulted source field with additive migrations; never infer source from titles.

- [ ] **Step 6: Treat supersession as local completion**

Mark the relevant checkpoint metadata as superseded and return without changing chapter status, director status or replan state.

- [ ] **Step 7: Verify timeline and finalization tests**

```bash
pnpm --filter @ai-novel/server prisma:generate
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterTimelineRevisionOwnership.test.js tests/chapterFinalizationCommitFailure.test.js tests/finalizeStyleReviewWiring.test.js tests/chapterStructuredOutputNormalization.test.js
```

- [ ] **Step 8: Commit**

Release notes: merge a user-facing statement that manual edits cannot leave old chapter events in later writing context.

```bash
git add README.md docs/releases/release-notes.md server/src/services/novel/runtime/projections server/src/services/novel/runtime/finalization server/src/services/novel/runtime/ChapterTimelineFinalizationService.ts server/src/modules/timeline server/src/prisma server/tests/chapterTimelineRevisionOwnership.test.js
git commit -m "fix(novel): bind timeline projections to chapter revisions"
```

### Task 5: Split Artifact Delta Ownership And Stop Stale Canonical Writes

**Files:**
- Create: `server/src/services/novel/runtime/artifacts/ChapterArtifactDeltaOrchestrator.ts`
- Create: `server/src/services/novel/runtime/artifacts/ChapterSummaryFactProjection.ts`
- Create: `server/src/services/novel/runtime/artifacts/ChapterStateSnapshotProjection.ts`
- Create: `server/src/services/novel/runtime/artifacts/ChapterPayoffProjection.ts`
- Create: `server/src/services/novel/runtime/artifacts/ChapterCharacterProjection.ts`
- Create: `server/src/services/novel/runtime/artifacts/ChapterArtifactProjectionGuard.ts`
- Create: `server/src/services/novel/runtime/artifacts/index.ts`
- Convert to facade under 200 lines: `server/src/services/novel/runtime/ChapterArtifactDeltaService.ts`
- Modify: `server/src/services/novel/runtime/ChapterArtifactBackgroundSyncService.ts`
- Modify if required for injected writers: state, payoff and character projection services used by the old file
- Test: `server/tests/chapterArtifactRevisionOwnership.test.js`
- Test: `server/tests/chapterArtifactBackgroundSyncScheduleCatch.test.js`
- Test: `server/tests/novelFactRevisionOwnership.test.js`

**Interfaces:**
- `ChapterArtifactDeltaSyncInput.contentRevision` remains mandatory.
- Every owned projection consumes `ChapterProjectionOwner`.
- `ChapterArtifactDeltaService` remains the stable external facade.

- [ ] **Step 1: Write a failing artifact race test**

Pause the registered artifact Prompt, advance chapter revision, release it, and assert no summary/fact/snapshot/payoff/character/RAG write. The test must call the public `ChapterArtifactDeltaService` facade.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterArtifactRevisionOwnership.test.js
```

- [ ] **Step 3: Extract modules without changing behavior**

Move existing functions by ownership. The facade may construct and call the orchestrator but must not retain persistence logic. No `utils`, `helpers` or unowned `shared` file is allowed.

- [ ] **Step 4: Guard every canonical writer**

After Prompt completion, call the common guard before the first side effect. Each projection module that starts its own transaction must repeat the revision match inside that transaction. On supersession, stop the remaining pipeline and skip RAG enqueue.

- [ ] **Step 5: Preserve current revision-owned fact behavior**

`ChapterSummaryFactProjection` must continue calling:

```ts
novelFactService.writeChapterFacts({
  novelId,
  chapterId,
  chapterOrder,
  contentRevision: expectedContentRevision,
  items,
});
```

Manual facts remain untouched.

- [ ] **Step 6: Verify size and dependency boundaries**

```bash
wc -l server/src/services/novel/runtime/ChapterArtifactDeltaService.ts server/src/services/novel/runtime/artifacts/*.ts
rg -n "runtime/artifacts/.+/.+|runtime/artifacts/(ChapterSummary|ChapterState|ChapterPayoff|ChapterCharacter)" server/src --glob '*.ts'
```

Expected: facade under 200 lines, owned files under 600, outside imports use `runtime/artifacts` facade/index rather than internals.

- [ ] **Step 7: Verify focused behavior**

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterArtifactRevisionOwnership.test.js tests/chapterArtifactBackgroundSyncScheduleCatch.test.js tests/novelFactRevisionOwnership.test.js tests/chapterRuntimeCoordinator.test.js
```

- [ ] **Step 8: Commit**

Release notes: no additional entry if Task 4 already describes stale derived context protection; this phase is an internal boundary implementation.

```bash
git add server/src/services/novel/runtime/ChapterArtifactDeltaService.ts server/src/services/novel/runtime/ChapterArtifactBackgroundSyncService.ts server/src/services/novel/runtime/artifacts server/tests/chapterArtifactRevisionOwnership.test.js server/tests/chapterArtifactBackgroundSyncScheduleCatch.test.js server/tests/novelFactRevisionOwnership.test.js
git commit -m "refactor(novel): own artifact projections by revision"
```

### Task 6: Preserve Explicit Cancelled Director Tasks And Ignore Runtime Snapshots

**Files:**
- Modify: `client/src/pages/novels/novelEditAutomationStatus.ts`
- Modify: `client/src/pages/novels/hooks/novelEdit/useNovelDirectorTaskController.ts`
- Modify: `client/src/pages/novels/automation/directorTaskSelection.ts`
- Modify: `client/src/pages/novels/automation/directorTaskSelection.test.mjs`
- Modify: `client/src/pages/novels/novelEditAutomationStatus.test.mjs`
- Create or modify hook-level test near `client/src/pages/novels/hooks/novelEdit/`
- Modify: `.gitignore`

**Interfaces:**
- Explicit successfully-loaded task ID wins for every terminal status.
- Cancelled suppression applies only when `directorTaskId` is empty.

- [ ] **Step 1: Add a failing controller-level test**

Given URL `?directorTaskId=task-cancelled`, `taskPanelOpen=false`, no active task and fetched cancelled detail, assert the controller does not call `setDirectorTaskId("")` and visible task remains `task-cancelled`.

- [ ] **Step 2: Verify RED**

```bash
cd client && node --experimental-strip-types --test src/pages/novels/automation/directorTaskSelection.test.mjs src/pages/novels/novelEditAutomationStatus.test.mjs src/pages/novels/hooks/novelEdit/*.test.mjs
```

- [ ] **Step 3: Remove the contradictory cancelled exception**

`shouldPreserveRequestedDirectorTaskId` returns true whenever a non-empty pinned ID matches a successfully loaded task. Keep cancelled auto-focus suppression in `resolveCanonicalDirectorTask` only when no explicit ID exists.

- [ ] **Step 4: Ignore generated runtime state**

Add:

```gitignore
server/.data/
.data/
```

Do not delete existing runtime snapshots; data retention/deletion requires a separate decision.

- [ ] **Step 5: Verify client contracts**

```bash
pnpm --filter @ai-novel/client typecheck
cd client && node --experimental-strip-types --test src/pages/novels/automation/directorTaskSelection.test.mjs src/pages/novels/novelEditAutomationStatus.test.mjs src/pages/novels/hooks/novelEdit/*.test.mjs
```

- [ ] **Step 6: Commit**

Merge the release note into the current date: cancelled workflows remain inspectable from direct links.

```bash
git add .gitignore README.md docs/releases/release-notes.md client/src/pages/novels
git commit -m "fix(novel): preserve pinned director task inspection"
```

### Task 7: Integration Verification And Durable Documentation

**Files:**
- Modify: `docs/wiki/workflows/chapter-production-chain.md`
- Modify: `docs/wiki/workflows/auto-director-runtime.md`
- Modify or create: `docs/wiki/workflows/chapter-projection-revision-ownership.md`
- Modify only for integration defects: files already owned by Tasks 1-6

**Interfaces:**
- Wiki documents content CAS, projection supersession and job-scoped cancellation as durable rules, not a changelog.

- [ ] **Step 1: Run complete type/build gates**

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server prisma:generate
pnpm --filter @ai-novel/server typecheck
pnpm --filter @ai-novel/client typecheck
```

Expected: all succeed.

- [ ] **Step 2: Run the production-chain regression set**

```bash
cd server && node --test tests/chapterInitialDraftContentCas.test.js tests/chapterContentCommitService.test.js tests/chapterRepairContentCas.test.js tests/chapterTimelineRevisionOwnership.test.js tests/chapterArtifactRevisionOwnership.test.js tests/pipelineCancelTerminalRace.test.js tests/pipelineLifecycleCas.test.js tests/chapterFinalizationCommitFailure.test.js tests/manualReviewReplanAction.test.js tests/novelDirectorConsecutiveQualityDebt.test.js tests/novelFactRevisionOwnership.test.js tests/promptStreamAbortOwnership.test.js tests/prompting-governance.test.js
```

Expected: all pass.

- [ ] **Step 3: Run official fast suites**

```bash
pnpm --filter @ai-novel/server test
pnpm --filter @ai-novel/client test
```

Expected: all current-scope tests pass. Pre-existing unrelated client failures must be documented with exact names and confirmed unchanged from the branch base; they may not be silently ignored.

- [ ] **Step 4: Update durable wiki knowledge**

Document:

```text
正文 revision 是生成与投影写权限；CAS miss 是 superseded，不是 replan。
取消是任务级意图；lease owner 只拥有执行写权限。
人工编辑触发当前 revision 的异步资产重建，旧提取不得提交 canonical state。
```

- [ ] **Step 5: Inspect scope and release surfaces**

```bash
git status --short
git diff --check
git log --oneline 72ac602..HEAD
```

Confirm README shows only the newest date block and release notes preserve older history.

- [ ] **Step 6: Commit integration documentation/fixes**

```bash
git add docs/wiki README.md docs/releases/release-notes.md
git commit -m "docs: record chapter revision and cancellation contracts"
```

After this commit, dispatch a whole-branch production review against `72ac602..HEAD`. Do not merge directly to main; rebase onto the latest main, merge to `beta`, and run integration verification there first.
