# Novel Production Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the novel production execution plane and fix every confirmed review finding without splitting the canonical chapter runtime or weakening AI-first and quality-debt semantics.

**Architecture:** Keep current public facades stable while moving implementation into responsibility-owned Prompt, content commit, pipeline state, director policy, shared-type, and frontend-controller modules. Every behavioral repair starts with a failing regression test, then applies the smallest fix inside the newly owned boundary. Chapter-derived projections consume only committed content snapshots, while task state transitions use explicit actions and CAS.

**Tech Stack:** TypeScript 5.9, Node.js 24/26, Express, Prisma 7, React 19, TanStack Query, LangChain, Node test runner, pnpm workspace.

## Global Constraints

- Work only on `codex/fix-novel-production-review-findings` in the existing linked worktree.
- Do not edit or clean `.data/` or `server/.data/`.
- No destructive database command or migration.
- Preserve `novelProductionOrchestrator + ChapterExecutionStageRunner + ChapterRuntimeCoordinator` as the single content-changing chain.
- Product-level prompts must live under `server/src/prompting/prompts/<family>/` and be registered.
- Local quality debt must continue the global chain unless structured output explicitly requests replan/stop.
- Write a failing regression test before each behavior change and observe the expected failure.
- Each completed phase receives a focused commit after the relevant verification.
- Before every commit, use `readme-release-updater`; skip release notes for internal-only structural phases and update them for the final user-visible behavior phase.
- Update durable wiki rules when Prompt, content commit, recovery, quality debt, or task projection contracts change.
- UI verification is limited to code-level tests/typecheck; the user owns browser acceptance.

---

### Task 1: Capture the clean baseline and freeze public contracts

**Files:**
- Modify: none
- Test: existing server/shared/client suites

**Interfaces:**
- Consumes: current branch at `8fec349`
- Produces: recorded baseline commands and a list of currently failing governance tests

- [ ] **Step 1: Verify branch and tracked cleanliness**

Run:

```bash
git branch --show-current
git status --short
git rev-parse HEAD
```

Expected: branch is `codex/fix-novel-production-review-findings`; only `.data/` and `server/.data/` are untracked.

- [ ] **Step 2: Build shared and server baseline**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server build
```

Expected: PASS.

- [ ] **Step 3: Run the focused baseline tests**

Run:

```bash
cd server
node --test tests/chapterGenerationAbortSignal.test.js tests/finalizeStyleReviewWiring.test.js tests/replanDecision.test.js tests/volumeReadinessRunStore.test.js
node --test tests/prompting-governance.test.js
```

Expected: focused runtime tests pass; governance reproduces the existing inline Prompt violations.

- [ ] **Step 4: Record existing public exports**

Run:

```bash
rg -n '^export (async )?function|^export class|^export interface' \
  server/src/prompting/core/promptRunner.ts \
  server/src/services/novel/pipelineExecute.ts \
  server/src/services/novel/director/automation/novelDirectorAutoExecutionRuntime.ts \
  server/src/services/novel/runtime/ChapterContentFinalizationService.ts \
  server/src/services/novel/runtime/repair/ChapterRepairStreamRuntime.ts
```

Expected: export list matches the design facades and is retained during structural moves.

---

### Task 2: Extract Prompt stream ownership and fix unhandled rejection

**Files:**
- Create: `server/src/prompting/streaming/PromptStreamCapture.ts`
- Modify: `server/src/prompting/core/promptRunner.ts`
- Create: `server/tests/promptStreamAbortOwnership.test.js`

**Interfaces:**
- Consumes: `BaseMessageChunk`, `LlmTokenUsageSnapshot`, `AbortSignal`
- Produces: `capturePromptStream(rawStream, options): CapturedPromptStream`

```ts
export interface PromptStreamCompletion {
  text: string;
  usage: LlmTokenUsageSnapshot | null;
}

export interface CapturedPromptStream {
  stream: AsyncIterable<BaseMessageChunk>;
  completion: Promise<PromptStreamCompletion>;
}
```

- [ ] **Step 1: Write the child-process regression test**

The test must spawn Node with default unhandled-rejection behavior, inject an abortable fake LLM stream through `setPromptRunnerLLMFactoryForTests`, abort after `streamTextPrompt` returns, consume/await the public result, and assert exit code `0` with no `unhandledRejection` marker.

- [ ] **Step 2: Run the test and observe RED**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/promptStreamAbortOwnership.test.js
```

Expected: FAIL because the child exits non-zero on the orphaned usage rejection.

- [ ] **Step 3: Extract the stream capture implementation**

Move iterator consumption, deadline timer, abort listener, usage merging, live delta and iterator cleanup into `PromptStreamCapture.ts`. Replace `completedText` and `completedUsage` with one `completion` Promise.

- [ ] **Step 4: Adapt text and structured stream executors**

Both paths must await the same `completion` object and read `completion.usage`; no secondary Promise may reject independently.

- [ ] **Step 5: Run RED test to GREEN**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/promptStreamAbortOwnership.test.js tests/chapterGenerationAbortSignal.test.js tests/streamingSSEAbort.test.js
```

Expected: PASS with clean output and child exit code 0.

- [ ] **Step 6: Commit the Prompt stream ownership phase**

Use `readme-release-updater`; this is internal reliability infrastructure, so skip user release notes for this commit.

```bash
git add server/src/prompting/streaming/PromptStreamCapture.ts server/src/prompting/core/promptRunner.ts server/tests/promptStreamAbortOwnership.test.js
git commit -m "fix(prompting): own stream completion rejection"
```

---

### Task 3: Split Prompt execution responsibilities and migrate governed prompts

**Files:**
- Create: `server/src/prompting/execution/PromptExecutionPreparation.ts`
- Create: `server/src/prompting/execution/TextPromptExecutor.ts`
- Create: `server/src/prompting/execution/StructuredPromptExecutor.ts`
- Create: `server/src/prompting/streaming/TextPromptStreamExecutor.ts`
- Create: `server/src/prompting/streaming/StructuredPromptStreamExecutor.ts`
- Create: `server/src/prompting/validation/PromptPostValidation.ts`
- Create: `server/src/prompting/validation/StructuredOutputResolution.ts`
- Create: `server/src/prompting/observability/PromptExecutionRecorder.ts`
- Modify: `server/src/prompting/core/promptRunner.ts`
- Create: `server/src/prompting/prompts/novel/openingDiversity.prompts.ts`
- Create: `server/src/prompting/prompts/audiobook/voiceDesignRewrite.prompts.ts`
- Modify: `server/src/services/novel/runtime/openingDiversity.ts`
- Modify: `server/src/services/audiobook/voiceDesignRewriteService.ts`
- Modify: `server/src/prompting/registry.ts`
- Modify: `server/scripts/run-tests.cjs`
- Test: `server/tests/prompting-governance.test.js`

**Interfaces:**
- `promptRunner.ts` keeps all current public exports.
- `openingDiversityRewritePrompt` keeps ID/version `novel.chapter.opening_diversity_rewrite@v1`.
- Audio prompt keeps existing rendered semantics but becomes a registered asset.

- [ ] **Step 1: Add registry assertions for both prompts**

Extend governance tests to resolve both IDs from the registry and assert the service/runtime files contain no inline `new SystemMessage` or direct `getLLM` calls.

- [ ] **Step 2: Run governance test and observe RED**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/prompting-governance.test.js
```

Expected: FAIL on the current inline Prompt locations.

- [ ] **Step 3: Extract Prompt Runner by responsibility without changing public behavior**

Move private functions into the owned files above. `promptRunner.ts` becomes a facade that imports implementations and owns only test injection wiring where required.

- [ ] **Step 4: Move opening diversity and audiobook assets into the registry**

Service files pass structured prompt input into `runTextPrompt`; no allowlist expansion is permitted.

- [ ] **Step 5: Move governance test from integration to fast**

Remove `prompting-governance.test.js` from the integration-only set in `server/scripts/run-tests.cjs`.

- [ ] **Step 6: Verify Prompt structure and governance**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/prompting-governance.test.js tests/openingDiversity.test.js tests/voiceDesignRewriteService.test.js
wc -l src/prompting/core/promptRunner.ts src/prompting/execution/*.ts src/prompting/streaming/*.ts src/prompting/validation/*.ts
```

Expected: tests PASS; implementation files remain below 700 lines and facade is substantially smaller.

- [ ] **Step 7: Update Prompt durable documentation**

Modify `server/src/prompting/README.md` or a focused `docs/wiki/prompts/` page to document single stream completion ownership and fast governance.

- [ ] **Step 8: Commit Prompt platform convergence**

Use `readme-release-updater`; skip user release notes because this commit is internal architecture/governance.

```bash
git add server/src/prompting server/src/services/novel/runtime/openingDiversity.ts server/src/services/audiobook/voiceDesignRewriteService.ts server/scripts/run-tests.cjs server/tests/prompting-governance.test.js
git commit -m "refactor(prompting): converge execution and registry boundaries"
```

---

### Task 4: Introduce the committed chapter content boundary

**Files:**
- Create: `server/src/services/novel/runtime/content/ChapterContentCommitTypes.ts`
- Create: `server/src/services/novel/runtime/content/ChapterContentCommitService.ts`
- Create: `server/tests/chapterContentCommitService.test.js`
- Modify: `server/src/services/novel/runtime/ChapterRuntimeDefaultDeps.ts`

**Interfaces:**

```ts
export interface CommittedChapterContent {
  novelId: string;
  chapterId: string;
  content: string;
  contentRevision: number;
}

export interface CommitChapterContentInput {
  novelId: string;
  chapterId: string;
  content: string;
  expectedContentRevision: number;
  statePatch?: Record<string, unknown>;
  source: "style_rewrite" | "repair_adopt";
}

export class ChapterContentCommitService {
  commit(input: CommitChapterContentInput): Promise<CommittedChapterContent>;
}
```

- [ ] **Step 1: Write CAS success/conflict/not-found tests**

Tests must assert the exact `updateMany` where clause, revision increment, reload behavior, conflict error details and absence of unconditional `chapter.update`.

- [ ] **Step 2: Run tests and observe RED**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterContentCommitService.test.js
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement minimal commit service**

Reuse `createChapterContentConflictError` and `createChapterNotFoundError`. Do not create a second conflict type.

- [ ] **Step 4: Verify service tests and content CAS regression**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterContentCommitService.test.js tests/chapterContentCas.test.js tests/chapterContentUpdateCas.test.js
```

Expected: PASS.

---

### Task 5: Split repair runtime and protect repair adoption with revision CAS

**Files:**
- Create: `server/src/services/novel/runtime/repair/concurrency/ChapterRepairLock.ts`
- Create: `server/src/services/novel/runtime/repair/evaluation/ChapterRepairIssueResolver.ts`
- Create: `server/src/services/novel/runtime/repair/evaluation/ChapterRepairBaselineEvaluator.ts`
- Create: `server/src/services/novel/runtime/repair/application/ChapterRepairStreamOrchestrator.ts`
- Create: `server/src/services/novel/runtime/repair/application/ChapterRepairFinalizer.ts`
- Modify: `server/src/services/novel/runtime/repair/ChapterRepairStreamRuntime.ts`
- Create: `server/tests/chapterRepairContentCas.test.js`
- Modify: `server/tests/chapterRepairLockLifecycle.test.js`
- Modify: `server/tests/loadLatestQualityReportIssues.test.js`
- Modify: `server/tests/volumeReadinessExecutorChain.test.js`

**Interfaces:**
- Existing `ChapterRepairStreamRuntime.createRepairStream()` signature remains stable.
- `ChapterRepairFinalizer.finalize()` consumes the baseline `contentRevision` captured before generation.
- CAS conflict emits a completed failure/concurrency frame and never an adopted frame.

- [ ] **Step 1: Write the repair/manual-edit race test**

Start repair at revision N, mutate the Prisma fake to revision N+1 before `onDone`, then assert content remains the manual value, artifact sync is not called and output is not adopted.

- [ ] **Step 2: Run race test and observe RED**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterRepairContentCas.test.js
```

Expected: FAIL because current finalizer performs unconditional update.

- [ ] **Step 3: Move existing responsibilities into owned repair modules**

First preserve existing tests. Keep `ChapterRepairStreamRuntime.ts` as the facade and move lock table, issue parsing, baseline evaluation, stream orchestration and finalization without behavior changes.

- [ ] **Step 4: Use ChapterContentCommitService for adoption**

Capture `contentRevision` in the initial chapter query. On adopt, call commit with `source: "repair_adopt"`. Conflict stops recheck/artifact projection and produces structured recoverable output.

- [ ] **Step 5: Verify repair tests**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterRepairContentCas.test.js tests/chapterRepairLockLifecycle.test.js tests/loadLatestQualityReportIssues.test.js tests/volumeReadinessExecutorChain.test.js
wc -l src/services/novel/runtime/repair/ChapterRepairStreamRuntime.ts src/services/novel/runtime/repair/application/*.ts src/services/novel/runtime/repair/evaluation/*.ts
```

Expected: PASS; facade and implementation files below 700 lines.

---

### Task 6: Split finalization and enforce committed-content projections

**Files:**
- Create: `server/src/services/novel/runtime/finalization/ChapterContentFinalizationOrchestrator.ts`
- Create: `server/src/services/novel/runtime/finalization/ChapterStyleReviewFinalizer.ts`
- Create: `server/src/services/novel/runtime/finalization/ChapterQualityProjectionService.ts`
- Create: `server/src/services/novel/runtime/finalization/ChapterFactProjectionService.ts`
- Create: `server/src/services/novel/runtime/finalization/ChapterTimelineProjectionService.ts`
- Modify: `server/src/services/novel/runtime/ChapterContentFinalizationService.ts`
- Modify: `server/src/services/novel/runtime/ChapterArtifactSyncService.ts`
- Modify: `server/src/services/novel/runtime/ChapterStreamGenerationOrchestrator.ts`
- Modify: `server/src/services/novel/runtime/ChapterPipelineRuntimeAdapter.ts`
- Modify: `server/src/services/novel/runtime/chapterRuntimePipeline.ts`
- Create: `server/tests/chapterFinalizationCommitFailure.test.js`
- Modify: `server/tests/finalizeStyleReviewWiring.test.js`

**Interfaces:**
- Draft save returns or exposes the persisted `contentRevision` needed by style rewrite.
- Finalization returns content from `CommittedChapterContent`, never an uncommitted candidate.
- Existing public `ChapterContentFinalizationService` remains injectable and stable.

- [ ] **Step 1: Write the persistence-failure side-effect test**

Force style rewrite commit to reject and assert finalization rejects, while acceptance, timeline, facts and artifact sync remain uncalled.

- [ ] **Step 2: Run test and observe RED**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterFinalizationCommitFailure.test.js
```

Expected: FAIL because current implementation logs and continues.

- [ ] **Step 3: Extract finalization responsibilities**

Move style review/commit, quality/runtime package, fact projection and timeline scheduling into the owned services. Keep orchestration order explicit.

- [ ] **Step 4: Thread draft revision into finalization**

`saveDraftAndArtifacts` must expose the saved revision or a stable snapshot. Style rewrite uses it for CAS through `ChapterContentCommitService`.

- [ ] **Step 5: Make commit failure fail before all projections**

No warning-only continuation is allowed when the final candidate has not committed. Existing best-effort behavior may remain for projection failures after a successful commit.

- [ ] **Step 6: Repair the existing wiring tests**

Tests must provide real persistence stubs and assert committed content, instead of passing while Prisma prints required-record errors.

- [ ] **Step 7: Verify finalization and runtime paths**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/chapterFinalizationCommitFailure.test.js tests/finalizeStyleReviewWiring.test.js tests/chapterRuntimeCoordinator.test.js tests/chapterRuntimePipeline.test.js tests/sameChapterWriteFeedbackStream.test.js
```

Expected: PASS with no Prisma error output.

- [ ] **Step 8: Update chapter production wiki and commit phase**

Document committed snapshot ordering in `docs/wiki/workflows/chapter-production-chain.md`. Use release updater; skip user release notes until final combined behavior commit.

```bash
git add server/src/services/novel/runtime server/tests docs/wiki/workflows/chapter-production-chain.md
git commit -m "fix(novel): commit chapter content before projections"
```

---

### Task 7: Extract pipeline state repository and fix cancel/terminal CAS

**Files:**
- Create: `server/src/services/novel/pipeline/state/PipelineJobStateRepository.ts`
- Create: `server/src/services/novel/pipeline/state/PipelineJobLeaseService.ts`
- Create: `server/src/services/novel/pipeline/state/PipelineJobCancellationService.ts`
- Create: `server/src/services/novel/pipeline/execution/PipelineChapterExecution.ts`
- Create: `server/src/services/novel/pipeline/execution/PipelineJobExecutor.ts`
- Create: `server/src/services/novel/pipeline/quality/PipelineChapterQualityPolicy.ts`
- Create: `server/src/services/novel/pipeline/quality/PipelineReplanPolicy.ts`
- Create: `server/src/services/novel/pipeline/recovery/PipelineJobRecoveryPolicy.ts`
- Modify: `server/src/services/novel/pipelineExecute.ts`
- Modify: `server/src/services/novel/novelCorePipelineService.ts`
- Create: `server/tests/pipelineCancelTerminalRace.test.js`

**Interfaces:**
- Existing `executePipelineJob(host, jobId, novelId, options)` remains exported.
- Cancellation service returns the canonical row after CAS or reload.

- [ ] **Step 1: Write cancel-versus-success race test**

The first read returns running; before cancel update, the fake transitions to succeeded. Assert the cancellation CAS count is zero and succeeded/finishedAt remain unchanged.

- [ ] **Step 2: Run test and observe RED**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/pipelineCancelTerminalRace.test.js
```

Expected: FAIL because current running branch uses unconditional `update`.

- [ ] **Step 3: Move state and lease transitions into repositories**

Preserve current terminal-guard helpers but centralize every database write that changes job lifecycle.

- [ ] **Step 4: Implement running cancellation CAS**

Use `updateMany({ id, status: "running" })` when leases are disabled. When `leaseOwner` is present, compose the existing `buildPipelineJobLeaseOwnedCasWhere(jobId, leaseOwner)` predicate with `status: "running"`. On miss, reload and do not overwrite terminal fields.

- [ ] **Step 5: Split execution and quality logic from facade**

`pipelineExecute.ts` retains only public types/export and delegates to `PipelineJobExecutor`.

- [ ] **Step 6: Verify pipeline state tests**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/pipelineCancelTerminalRace.test.js tests/pipelineJobTerminalGuard.test.js tests/novelPipelineState.test.js tests/pipelineJobAutoRetry.test.js
wc -l src/services/novel/pipelineExecute.ts src/services/novel/pipeline/**/*.ts
```

Expected: PASS; facade and owned files below 700 lines.

---

### Task 8: Extract director policies and fix local quality-debt semantics

**Files:**
- Create: `server/src/services/novel/director/automation/domain/AutoExecutionProgressPolicy.ts`
- Create: `server/src/services/novel/director/automation/domain/AutoExecutionQualityDebtPolicy.ts`
- Create: `server/src/services/novel/director/automation/domain/AutoExecutionStopPolicy.ts`
- Create: `server/src/services/novel/director/automation/application/AutoExecutionRangeRunner.ts`
- Create: `server/src/services/novel/director/automation/projections/AutoExecutionTaskProjector.ts`
- Modify: `server/src/services/novel/director/automation/novelDirectorAutoExecutionRuntime.ts`
- Create: `server/src/services/planner/shouldExecutePlannerReplan.ts`
- Modify: `server/src/services/novel/novelCoreReviewService.ts`
- Create: `server/tests/novelDirectorConsecutiveQualityDebt.test.js`
- Create: `server/tests/manualReviewReplanAction.test.js`

**Interfaces:**

```ts
export function didAutoExecutionAdvance(before: AutoExecutionCursor, after: AutoExecutionCursor): boolean;
export function shouldExecutePlannerReplan(decision: Pick<ReplanDecision, "action">): boolean;
```

- [ ] **Step 1: Write six-defer continuation test**

Simulate six usable chapters with `defer_and_continue` and advancing cursor. Assert no `markTaskFailed`, all debts retained and the seventh chapter starts.

- [ ] **Step 2: Write no-progress guard test**

Simulate repeated defer with unchanged cursor/remaining/checkpoint and assert a runtime safety failure containing cursor evidence.

- [ ] **Step 3: Write local-patch review test**

Return `recommended=true, action=local_patch_plan`; assert Planner is not called. Add a separate `stop_for_replan` case that calls it once.

- [ ] **Step 4: Run tests and observe RED**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/novelDirectorConsecutiveQualityDebt.test.js tests/manualReviewReplanAction.test.js
```

Expected: FAIL on current `MAX_CONSECUTIVE_DEFERS` and boolean replan gate.

- [ ] **Step 5: Extract pure policies and range runner**

Move cursor comparison, debt classification and stop reasons out of the orchestration class before changing behavior.

- [ ] **Step 6: Replace defer-count failure with no-progress policy**

Any advancing cursor resets no-progress count. Quality-debt count remains observability only.

- [ ] **Step 7: Gate Planner by explicit action**

Use `shouldExecutePlannerReplan`. Do not swallow Planner errors with `.catch(() => null)`; surface them through the existing review error contract.

- [ ] **Step 8: Verify director and planner tests**

Run:

```bash
pnpm --filter @ai-novel/server build
cd server && node --test tests/novelDirectorConsecutiveQualityDebt.test.js tests/manualReviewReplanAction.test.js tests/novelDirectorAutoExecutionRuntime.test.js tests/novelDirectorAutoExecutionRuntime.batchRoll.test.js tests/replanDecision.test.js tests/novelPipelineState.test.js
wc -l src/services/novel/director/automation/novelDirectorAutoExecutionRuntime.ts src/services/novel/director/automation/domain/*.ts src/services/novel/director/automation/application/*.ts
```

Expected: PASS; no `MAX_CONSECUTIVE_DEFERS` remains.

- [ ] **Step 9: Update director quality-debt/recovery wiki and commit**

Use release updater; this behavior is user-visible but defer release-note writing until the final merged daily entry.

```bash
git add server/src/services/novel/director server/src/services/novel/novelCoreReviewService.ts server/src/services/planner server/tests docs/wiki
git commit -m "fix(novel): preserve local quality debt progression"
```

---

### Task 9: Split shared director runtime types behind a stable facade

**Files:**
- Create: `shared/types/director/artifacts.ts`
- Create: `shared/types/director/runtime.ts`
- Create: `shared/types/director/projections.ts`
- Create: `shared/types/director/dashboard.ts`
- Create: `shared/types/director/commands.ts`
- Create: `shared/types/director/workspace.ts`
- Create: `shared/types/director/index.ts`
- Modify: `shared/types/directorRuntime.ts`

**Interfaces:**
- Existing `@ai-novel/shared/types/directorRuntime` exports and serialized shapes remain unchanged.
- `directorRuntime.ts` becomes re-export only.

- [ ] **Step 1: Add a compile-time export contract test**

Create or extend a shared type test that imports representative artifact, runtime, projection, dashboard, command and workspace types from both the old facade and new owned modules.

- [ ] **Step 2: Run shared build before split**

Run:

```bash
pnpm --filter @ai-novel/shared build
```

Expected: PASS baseline.

- [ ] **Step 3: Move types by ownership and re-export**

Avoid duplicate declarations. Each type has one defining file; facade exports from `./director`.

- [ ] **Step 4: Verify shared/server/client compilation**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server typecheck
pnpm --filter @ai-novel/client typecheck
wc -l shared/types/directorRuntime.ts shared/types/director/*.ts
```

Expected: PASS; facade is re-export only and every owned file below 700 lines.

---

### Task 10: Extract NovelEdit director task controller and page controllers

**Files:**
- Create: `client/src/pages/novels/automation/directorTaskSelection.ts`
- Create: `client/src/pages/novels/automation/directorTaskActions.ts`
- Create: `client/src/pages/novels/hooks/useNovelWorkspaceQueries.ts`
- Create: `client/src/pages/novels/hooks/useNovelPipelineController.ts`
- Create: `client/src/pages/novels/hooks/useNovelDirectorTaskController.ts`
- Create: `client/src/pages/novels/hooks/useNovelTaskDrawerController.ts`
- Create: `client/src/pages/novels/hooks/useNovelEditPresentationModel.ts`
- Modify: `client/src/pages/novels/NovelEdit.tsx`
- Create: `client/src/pages/novels/automation/directorTaskSelection.test.mjs`

**Interfaces:**
- `resolveCanonicalDirectorTask(input)` accepts URL director task, active task, book projection and requested task only.
- No parameter named `workspaceTaskId` exists in the director selection API.
- `NovelEditView` props remain stable.

- [ ] **Step 1: Write canonical task selection tests**

Cover failed/blocked/waiting-recovery latest task without URL, explicit URL task, cancelled task suppression and projection fallback. Add a type-level assertion that workspace task cannot be supplied.

- [ ] **Step 2: Run client test/typecheck and observe RED**

Run:

```bash
cd client && node --experimental-strip-types --test src/pages/novels/automation/directorTaskSelection.test.mjs
cd ..
pnpm --filter @ai-novel/client typecheck
```

Expected: test fails because resolver does not exist.

- [ ] **Step 3: Implement pure task selection module**

Move existing selection helpers from `NovelEdit.tsx` without behavior changes, then make the canonical task rule explicit.

- [ ] **Step 4: Extract director/task drawer controllers**

Move queries, mutations, action target selection, invalidation and drawer state out of the page.

- [ ] **Step 5: Extract workspace, pipeline and presentation controllers**

Keep user-facing copy unchanged. Do not introduce a new UI workflow.

- [ ] **Step 6: Verify client compilation and file boundaries**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/client typecheck
wc -l client/src/pages/novels/NovelEdit.tsx client/src/pages/novels/hooks/useNovel*Controller.ts client/src/pages/novels/hooks/useNovelWorkspaceQueries.ts
```

Expected: PASS; `NovelEdit.tsx` below 700 lines and owned hook files below 700 lines.

- [ ] **Step 7: Commit shared/frontend convergence**

Use release updater; skip release notes because this commit preserves UI behavior and is internal structure.

```bash
git add shared/types client/src/pages/novels
git commit -m "refactor(novel): centralize director task projection"
```

---

### Task 11: Delete confirmed dead compatibility facades

**Files:**
- Delete: `server/src/services/novel/NovelReviewService.ts`
- Delete: `server/src/services/novel/NovelArtifactService.ts`
- Modify: `server/tests/novelServiceBoundary.test.js`
- Modify: `docs/wiki/architecture/novel-application-services.md`

**Interfaces:**
- No replacement wrapper is created.
- Application capabilities remain the only production entrypoint.

- [ ] **Step 1: Reconfirm no consumers**

Run:

```bash
git grep -n 'NovelReviewService\|NovelArtifactService' -- ':!docs/archive/**'
```

Expected: only the two files, current wiki and boundary-test file list.

- [ ] **Step 2: Delete files and clean boundary documentation**

Remove the files, remove filename expectations and update the current wiki enumeration.

- [ ] **Step 3: Verify no live references and build**

Run:

```bash
git grep -n 'NovelReviewService\|NovelArtifactService' -- server client shared || true
pnpm --filter @ai-novel/server build
cd server && node --test tests/novelServiceBoundary.test.js
```

Expected: no source references; build and boundary test PASS.

- [ ] **Step 4: Commit dead-code deletion**

Use release updater; skip release notes because this is internal removal.

```bash
git add -A server/src/services/novel/NovelReviewService.ts server/src/services/novel/NovelArtifactService.ts server/tests/novelServiceBoundary.test.js docs/wiki/architecture/novel-application-services.md
git commit -m "refactor(novel): remove unused compatibility facades"
```

---

### Task 12: Final verification, durable documentation and release notes

**Files:**
- Modify: `docs/wiki/architecture/module-boundaries.md`
- Modify: `docs/wiki/workflows/chapter-production-chain.md`
- Modify: `docs/wiki/workflows/auto-director-runtime.md`
- Modify: `docs/wiki/workflows/quality-debt-attribution.md`
- Modify: Prompt README/wiki
- Modify: `docs/releases/release-notes.md`
- Modify: `README.md`

**Interfaces:**
- User-visible release summary uses the existing date heading `### 2026-07-26`.
- README shows only the newest merged date block plus release-history link.

- [ ] **Step 1: Run formatting and scope checks**

Run:

```bash
git diff --check
git status --short
rg -n 'MAX_CONSECUTIVE_DEFERS|openingDiversityRewritePrompt: PromptAsset|class NovelReviewService|class NovelArtifactService' server/src
```

Expected: no whitespace errors; forbidden legacy patterns absent.

- [ ] **Step 2: Run focused regression tests**

Run:

```bash
cd server
node --test \
  tests/promptStreamAbortOwnership.test.js \
  tests/prompting-governance.test.js \
  tests/chapterContentCommitService.test.js \
  tests/chapterRepairContentCas.test.js \
  tests/chapterFinalizationCommitFailure.test.js \
  tests/pipelineCancelTerminalRace.test.js \
  tests/novelDirectorConsecutiveQualityDebt.test.js \
  tests/manualReviewReplanAction.test.js \
  tests/chapterGenerationAbortSignal.test.js \
  tests/chapterRepairLockLifecycle.test.js \
  tests/finalizeStyleReviewWiring.test.js \
  tests/pipelineJobTerminalGuard.test.js \
  tests/replanDecision.test.js \
  tests/novelDirectorAutoExecutionRuntime.test.js
cd ../client
node --experimental-strip-types --test src/pages/novels/automation/directorTaskSelection.test.mjs
```

Expected: PASS with no Prisma required-record warnings and no unhandled rejection.

- [ ] **Step 3: Run workspace verification**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server typecheck
pnpm --filter @ai-novel/server build
pnpm --filter @ai-novel/client typecheck
```

Expected: PASS.

- [ ] **Step 4: Run server fast and governance/integration checks**

Run:

```bash
pnpm --filter @ai-novel/server test:node
cd server && node --test tests/prompting-governance.test.js
```

Run the narrow integration tests affected by Prompt/runtime changes; do not rerun unrelated packaging or UI browser verification.

- [ ] **Step 5: Verify file and directory boundaries**

Run:

```bash
wc -l \
  server/src/prompting/core/promptRunner.ts \
  server/src/services/novel/pipelineExecute.ts \
  server/src/services/novel/director/automation/novelDirectorAutoExecutionRuntime.ts \
  server/src/services/novel/runtime/repair/ChapterRepairStreamRuntime.ts \
  client/src/pages/novels/NovelEdit.tsx \
  shared/types/directorRuntime.ts
find server/src/services/novel -maxdepth 1 -type f -name '*.ts' | wc -l
find server/src/services/novel/director/runtime -maxdepth 1 -type f -name '*.ts' | wc -l
```

Expected: touched facades below 700 lines; no new peer file is added to already dense roots.

- [ ] **Step 6: Update durable wiki knowledge**

Document the final module ownership, committed-content ordering, explicit replan gate, no-progress guard and Prompt completion ownership. Do not write a changelog-style wiki entry.

- [ ] **Step 7: Use release updater and write the user-facing daily entry**

Describe outcomes such as:

- 后台修文不会覆盖编辑中的章节正文。
- 自动成书遇到局部质量问题仍会继续完成后续章节。
- 章节任务取消、超时和恢复更加稳定。

Merge into the existing `### 2026-07-26` block if present; keep README to the newest date block only.

- [ ] **Step 8: Commit final verification/docs phase**

```bash
git add docs README.md server/tests client/src shared/types server/src
git commit -m "fix(novel): harden production generation state contracts"
```

- [ ] **Step 9: Inspect final branch history and status**

Run:

```bash
git status --short
git log --oneline --decorate origin/main..HEAD
```

Expected: only preserved `.data/` directories remain untracked; branch contains intentional phase commits and is ready for review. Do not merge or push without a separate user request.
