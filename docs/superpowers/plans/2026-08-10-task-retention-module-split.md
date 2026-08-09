# Task Retention Module Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 1,214-line `TaskRetentionService` into owned retention modules without changing runtime behavior or the stable import path.

**Architecture:** Keep `server/src/services/task/TaskRetentionService.ts` as the public lifecycle facade used by `app.ts`. Move deterministic retention rules into `retention/domain`, persistence and cleanup operations into `retention/infrastructure`, and auto-director plus run-level orchestration into `retention/application`; tests may import owned modules directly, while production callers must use the stable facade.

**Tech Stack:** TypeScript, Prisma, Node.js test runner, pnpm workspace scripts.

## Global Constraints

- Baseline commit is exactly `7d525a810fea118e848f4b6a3f7da8e9a1106593` on branch `codex/refactor-task-retention-modules-agent`.
- This phase is behavior-preserving structural cleanup only; do not add product behavior.
- Keep every source file below 600 lines where practical and below the 700-line hard threshold.
- Do not add generic `helpers`, `utils`, or `shared` modules.
- Production modules outside task retention must continue importing the stable `TaskRetentionService.ts` facade.
- Tests must exercise the real owned modules, not only facade forwarding.
- Report any real P1/P2 behavior defect before expanding scope.
- Update durable module-boundary documentation, run fresh targeted tests and a fresh server build, then create one independent commit.

---

### Task 1: Lock The Retention Domain Boundary

**Files:**
- Create: `server/src/services/task/retention/domain/retentionPolicy.ts`
- Create: `server/src/services/task/retention/domain/retentionTypes.ts`
- Modify: `server/src/services/task/TaskRetentionService.ts`
- Modify: `server/tests/taskRetention.test.js`
- Modify: `server/tests/taskRetentionPushdown.test.js`

**Interfaces:**
- Consumes: `TaskRetentionConfig` from `server/src/config/taskRetention.ts`.
- Produces: `selectDeletableTaskIds`, `selectSupersededTaskIds`, `selectSupersededGenerationJobIds`, row types, terminal/active status constants, `TaskRetentionSummary`, and `createTaskRetentionSummary`.

- [ ] **Step 1: Move deterministic selectors and their row contracts into `retention/domain/retentionPolicy.ts`.**

  Preserve bucket keys, timestamp fallback, keep-window behavior, min-age guards, lane filtering, and deterministic id ordering exactly.

- [ ] **Step 2: Move the run summary contract and zero-value factory into `retention/domain/retentionTypes.ts`.**

  The factory must return every existing counter with value `0` so all orchestrators share one summary shape.

- [ ] **Step 3: Re-export the existing public selector and type names from `TaskRetentionService.ts`.**

  Existing callers of `dist/services/task/TaskRetentionService.js` must keep working.

- [ ] **Step 4: Change policy tests to import the owned domain module directly.**

  Run: `pnpm --filter @ai-novel/server build && node --test server/tests/taskRetention.test.js server/tests/taskRetentionPushdown.test.js`

  Expected: all policy and pushdown tests pass.

### Task 2: Extract Persistence And Cleanup Adapters

**Files:**
- Create: `server/src/services/task/retention/infrastructure/TaskRetentionCleanupStore.ts`
- Create: `server/src/services/task/retention/infrastructure/TaskRetentionOrphanStore.ts`
- Modify: `server/tests/taskRetentionCasDeleteOrdering.test.js`
- Modify: `server/tests/taskRetentionAutopilot.test.js`

**Interfaces:**
- Consumes: Prisma singleton, `TaskRetentionConfig`, domain status constants, and `TaskRetentionSummary`.
- Produces: CAS-safe workflow/job deletion, SQL age selection, orphan follow-up cleanup, terminal auto-archive, stale null-novel purge, and orphan `AgentRun` reconciliation.

- [ ] **Step 1: Extract CAS-safe workflow and generation-job deletion into `TaskRetentionCleanupStore`.**

  Keep the transaction order unchanged: terminal recheck, main-row delete, runtime/follow-up cleanup, then archive cleanup.

- [ ] **Step 2: Extract SQL window selection, orphan follow-up-log cleanup, and auto-archive into `TaskRetentionCleanupStore`.**

  Preserve SQL ranking, exclusion filtering, per-row terminal recheck, and archive upsert behavior.

- [ ] **Step 3: Extract stale null-novel cleanup and stale orphan `AgentRun` reconciliation into `TaskRetentionOrphanStore`.**

  Preserve all age gates, status guards, approval expiry, hard-delete/cancel behavior, counters, and warning messages.

- [ ] **Step 4: Point CAS and orphan tests at the real infrastructure classes.**

  Run: `pnpm --filter @ai-novel/server build && node --test server/tests/taskRetentionCasDeleteOrdering.test.js server/tests/taskRetentionNullNovelOrphan.test.js server/tests/taskRetentionAutopilot.test.js`

  Expected: CAS ordering, null-novel cleanup, archive, and orphan reconciliation tests pass.

### Task 3: Extract Auto-Director Retention Orchestration

**Files:**
- Create: `server/src/services/task/retention/application/AutoDirectorRetentionCoordinator.ts`
- Modify: `server/tests/taskRetentionAutopilot.test.js`

**Interfaces:**
- Consumes: Prisma singleton, recovery predicates, transient retry classifier, `NovelWorkflowTaskAdapter`, `TaskRetentionConfig`, and `TaskRetentionSummary`.
- Produces: `cancelZombieRunningTasks`, `projectStaleActiveWorkflowTasks`, and `autoRetryTransientFailedWorkflowTasks`.

- [ ] **Step 1: Move zombie auto-resume/cancel logic into `AutoDirectorRetentionCoordinator`.**

  Keep command acceptance as the only successful resume projector and keep failed enqueue attempts write-free.

- [ ] **Step 2: Move stale active projection and transient retry logic into the coordinator.**

  Preserve lane restrictions, cooldown, token budget snapshot, max-per-run limit, manual-recovery flagging, and adapter-owned retry claim semantics.

- [ ] **Step 3: Update autopilot tests to instantiate the real coordinator and inject only its workflow adapter dependency.**

  Run: `pnpm --filter @ai-novel/server build && node --test server/tests/taskRetentionAutopilot.test.js`

  Expected: all auto-resume, projection, retry, archive, and orphan tests pass.

### Task 4: Build The Application Runner And Thin Facade

**Files:**
- Create: `server/src/services/task/retention/application/TaskRetentionRunner.ts`
- Modify: `server/src/services/task/TaskRetentionService.ts`
- Modify: `server/tests/taskRetentionRunOnce.test.js`

**Interfaces:**
- Consumes: domain selectors, cleanup/orphan stores, auto-director coordinator, `taskRetentionConfig`, and Prisma candidate queries.
- Produces: `TaskRetentionRunner.runOnce(now): Promise<TaskRetentionSummary>` and the stable `TaskRetentionService.start`, `stop`, and `runOnce` facade.

- [ ] **Step 1: Move the existing `runOnce` stage order into `TaskRetentionRunner`.**

  Preserve independent error boundaries for workflow cleanup, orphan follow-up logs, generation jobs, and auto-archive.

- [ ] **Step 2: Reduce `TaskRetentionService.ts` to timer lifecycle, runner delegation, singleton export, and compatibility re-exports.**

  `server/src/app.ts` must require no import change.

- [ ] **Step 3: Keep the real-SQLite behavior-equivalence test on the stable facade.**

  Run: `pnpm --filter @ai-novel/server build && node --test server/tests/taskRetentionRunOnce.test.js server/tests/taskRetentionNullNovelOrphan.test.js`

  Expected: real-database cleanup behavior and summary counters remain equivalent.

### Task 5: Document Boundaries, Verify, And Commit

**Files:**
- Create: `server/src/services/task/retention/README.md`
- Modify: `docs/wiki/architecture/module-boundaries.md`

**Interfaces:**
- Consumes: final module graph and verified import paths.
- Produces: durable ownership, dependency-direction, testing, and external-import rules.

- [ ] **Step 1: Document the retention module responsibilities and dependency direction.**

  State that production callers use `TaskRetentionService.ts`; domain has no application/infrastructure dependency; application may depend on domain/infrastructure; infrastructure may depend on domain and platform adapters; tests may import owned modules directly.

- [ ] **Step 2: Check file and directory density.**

  Run: `find server/src/services/task/retention -type f -name '*.ts' -maxdepth 4 -print -exec wc -l {} \;`

  Expected: every source file is below 600 lines and no new peer `.ts` file was added to the already dense task root.

- [ ] **Step 3: Run fresh targeted verification and server build.**

  Run: `pnpm --filter @ai-novel/server build`

  Run: `node --test server/tests/taskRetention.test.js server/tests/taskRetentionPushdown.test.js server/tests/taskRetentionCasDeleteOrdering.test.js server/tests/taskRetentionAutopilot.test.js server/tests/taskRetentionRunOnce.test.js server/tests/taskRetentionNullNovelOrphan.test.js`

  Expected: build exits 0 and all targeted tests pass.

- [ ] **Step 4: Use `readme-release-updater` before the Git write.**

  Inspect the exact diff. Because the phase is internal-only and behavior-preserving, skip `docs/releases/release-notes.md` and root `README.md` unless the final diff shows actual user-visible behavior.

- [ ] **Step 5: Commit the isolated phase.**

  Run: `git add server/src/services/task/TaskRetentionService.ts server/src/services/task/retention server/tests/taskRetention.test.js server/tests/taskRetentionPushdown.test.js server/tests/taskRetentionCasDeleteOrdering.test.js server/tests/taskRetentionAutopilot.test.js docs/wiki/architecture/module-boundaries.md docs/superpowers/plans/2026-08-10-task-retention-module-split.md`

  Run: `git commit -m "refactor: split task retention modules"`

  Expected: one commit containing only the retention structural split, direct module tests, and durable boundary documentation.
